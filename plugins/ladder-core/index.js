'use strict';

const crypto = require('crypto');
const {LadderUser, LadderMonthRecord, LadderMatch, LadderMatchGame} = require('./entities');

const normalizeName = value => String(value || '').trim().toLowerCase();
const monthKey = date => {
  const value = date || new Date();
  return `${value.getFullYear()}${String(value.getMonth() + 1).padStart(2, '0')}`;
};
const passwordFromKey = key => String(key || '').split('$').slice(1).join('$') || null;

function calculateDelta(playerPoints, opponentPoints, won, config) {
  if (!config.useDynamic) return won ? Number(config.fixedDelta) : -Number(config.fixedDelta);
  const expected = 1 / (1 + Math.pow(10, (opponentPoints - playerPoints) / 400));
  const raw = Math.round(Number(config.kFactor) * ((won ? 1 : 0) - expected));
  const magnitude = Math.max(Number(config.minDelta), Math.min(Number(config.maxDelta), Math.abs(raw)));
  return won ? magnitude : -magnitude;
}

function createService(api) {
  const states = new Map();
  const classifier = api.get('deckClassifier');
  const initialPoints = Number(api.config.rating.initialPoints) || 1000;
  const repo = entity => api.dataManager.getRepository(entity);

  const ensureState = roomId => {
    let state = states.get(roomId);
    if (!state) {
      state = {matchKey: `${Date.now()}-${roomId}-${crypto.randomBytes(8).toString('hex')}`, games: new Map(), duelLogs: new Map(), coinWinner: null};
      states.set(roomId, state);
    }
    return state;
  };

  async function authenticate(displayName, password) {
    const key = normalizeName(displayName);
    if (!key || (api.config.requirePassword && !password)) return false;
    let user = await repo(LadderUser).findOne(key);
    if (user) return !user.pass || user.pass === password;
    user = repo(LadderUser).create({
      name: key,
      displayName: String(displayName).trim(),
      pass: password || null,
      createdAt: new Date(),
      duelPoints: initialPoints,
      monthDuelPoints: initialPoints
    });
    try {
      await repo(LadderUser).save(user);
      return true;
    } catch (error) {
      // A simultaneous first login may have inserted the same normalized key.
      user = await repo(LadderUser).findOne(key);
      return !!user && (!user.pass || user.pass === password);
    }
  }

  async function getMonthlyProfile(displayName) {
    const key = normalizeName(displayName);
    const record = await repo(LadderMonthRecord).findOne({where: {name: key, monthKey: monthKey()}});
    return {
      points: Number(record?.duelPoints ?? initialPoints),
      wins: Number(record?.wins || 0),
      losses: Number(record?.losses || 0)
    };
  }

  function captureGame(event) {
    if (!event || event.randomType !== api.config.mode || event.players.length !== 2) return;
    const immutable = {
      ...event,
      players: event.players.map(player => ({
        ...player,
        name: normalizeName(player.name),
        displayName: player.name,
        main: player.main.slice(),
        side: player.side.slice(),
        deckTypeId: classifier.classify(player.main)
      }))
    };
    ensureState(event.roomId).games.set(Number(event.duelCount), immutable);
  }

  function linkDuelLog(event) {
    if (!event || event.randomType !== api.config.mode || event.duelLogId == null) return;
    ensureState(event.roomId).duelLogs.set(Number(event.duelCount), event.duelLogId);
  }

  function captureRpsWinner(event) {
    if (!event || event.randomType !== api.config.mode || !event.playerName) return;
    // RPS happens once before G1. SELECT_TP is sent only to its winner, so the
    // host event is more reliable than reimplementing rock-paper-scissors.
    const state = ensureState(event.roomId);
    if (!state.coinWinner) state.coinWinner = normalizeName(event.playerName);
  }

  async function settle(room, scores, outcome) {
    if (!room || room.random_type !== api.config.mode || !Array.isArray(scores) || scores.length !== 2) return;
    const terminal = !!outcome && (!!outcome.matchCompleted || !!outcome.explicitForfeit);
    if (!terminal) {
      states.delete(room.process_pid);
      api.log.warn({
        event: 'ladder_settlement_skipped',
        roomId: room.process_pid,
        cause: outcome?.cause || 'missing_terminal_outcome',
        duelEndSeen: !!outcome?.duelEndSeen
      }, 'Ladder settlement skipped because the room had no confirmed terminal result.');
      return;
    }
    const scoreA = Number(scores[0].score);
    const scoreB = Number(scores[1].score);
    if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA === scoreB) return;
    const state = ensureState(room.process_pid);
    if (state.settled || state.settling) return;
    const orderedGames = [...state.games.values()].sort((a, b) => a.duelCount - b.duelCount);
    // For an ordinary completed Match, the host scoreboard and immutable
    // per-game WIN events must describe exactly the same result. Refuse to
    // award points if an upstream protocol regression makes them disagree.
    // Negative disconnect penalties and MATCH_KILL's sentinel score are not
    // ordinary game-win counters, so they are intentionally excluded.
    if (scoreA >= 0 && scoreA <= 3 && scoreB >= 0 && scoreB <= 3) {
      const capturedWins = new Map();
      for (const game of orderedGames) {
        const winner = normalizeName(game.winnerName);
        capturedWins.set(winner, (capturedWins.get(winner) || 0) + 1);
      }
      const expectedScores = scores.map(form => capturedWins.get(normalizeName(form.name)) || 0);
      // Drawn games legitimately make orderedGames longer than scoreA+scoreB.
      if (expectedScores[0] !== scoreA || expectedScores[1] !== scoreB) {
        throw new Error(`Ladder settlement rejected: scoreboard ${scoreA}-${scoreB} disagrees with captured games ${expectedScores[0]}-${expectedScores[1]}.`);
      }
    }
    state.settling = true;
    try {
      await api.dataManager.pluginTransaction(async manager => {
        // The unique matchKey makes a repeated room cleanup idempotent.
        if (await manager.findOne(LadderMatch, {where: {matchKey: state.matchKey}})) return;
        const forms = scores.map(form => ({
          key: normalizeName(form.name),
          displayName: String(form.name || '').trim(),
          password: passwordFromKey(form.name_vpass),
          score: Number(form.score)
        }));
        const now = new Date();
        const month = monthKey(now);
        const users = [];
        const monthRows = [];
        const driver = api.dataManager.getConnection().options.type;
        let lockedUsers = [];
        if (driver !== 'sqlite' && driver !== 'sqljs') {
          // Serialize simultaneous matches that update the same account so an
          // older points value cannot overwrite a just-committed result.
          lockedUsers = await manager.getRepository(LadderUser).createQueryBuilder('u')
            .where('u.name IN (:...names)', {names: forms.map(form => form.key).sort()})
            .setLock('pessimistic_write').getMany();
        }
        for (const form of forms) {
          let user = lockedUsers.find(item => item.name === form.key) || await manager.findOne(LadderUser, form.key);
          if (!user) user = manager.create(LadderUser, {name: form.key, displayName: form.displayName, pass: form.password, createdAt: now});
          if (!user.displayName) user.displayName = form.displayName;
          if (user.pass && user.pass !== form.password) throw new Error(`Ladder password changed during match for ${form.key}.`);
          user.duelPoints = Number(user.duelPoints ?? initialPoints);
          user.wins = Number(user.wins || 0);
          user.losses = Number(user.losses || 0);
          let record = await manager.findOne(LadderMonthRecord, {where: {name: form.key, monthKey: month}});
          if (!record) record = manager.create(LadderMonthRecord, {name: form.key, monthKey: month, duelPoints: initialPoints, wins: 0, losses: 0, scoreDiff: 0});
          users.push(user);
          monthRows.push(record);
        }

        const winnerIndex = scoreA > scoreB ? 0 : 1;
        const before = users.map(user => Number(user.duelPoints ?? initialPoints));
        const deltas = users.map((user, index) => calculateDelta(before[index], before[1 - index], index === winnerIndex, api.config.rating));
        for (let index = 0; index < 2; index++) {
          const won = index === winnerIndex;
          users[index].duelPoints = Math.max(0, before[index] + deltas[index]);
          users[index].wins += won ? 1 : 0;
          users[index].losses += won ? 0 : 1;
          monthRows[index].duelPoints = Math.max(0, Number(monthRows[index].duelPoints ?? initialPoints) + deltas[index]);
          monthRows[index].wins = Number(monthRows[index].wins || 0) + (won ? 1 : 0);
          monthRows[index].losses = Number(monthRows[index].losses || 0) + (won ? 0 : 1);
          monthRows[index].scoreDiff = monthRows[index].wins - monthRows[index].losses;
          // Keep compatibility fields current; historical ranking reads the month table.
          Object.assign(users[index], {monthKey: month, monthDuelPoints: monthRows[index].duelPoints, monthWins: monthRows[index].wins, monthLosses: monthRows[index].losses});
        }
        await manager.save(LadderUser, users);
        await manager.save(LadderMonthRecord, monthRows);

        const firstGame = orderedGames[0];
        const deckFor = key => {
          const player = firstGame && firstGame.players.find(item => item.name === key);
          return player ? player.deckTypeId : classifier.otherDeckTypeId;
        };
        const match = await manager.save(LadderMatch, manager.create(LadderMatch, {
          matchKey: state.matchKey,
          roomId: room.process_pid,
          monthKey: month,
          winnerName: forms[winnerIndex].key,
          loserName: forms[1 - winnerIndex].key,
          playerAName: forms[0].key,
          playerBName: forms[1].key,
          playerADisplayName: forms[0].displayName,
          playerBDisplayName: forms[1].displayName,
          playerADeckTypeId: deckFor(forms[0].key),
          playerBDeckTypeId: deckFor(forms[1].key),
          playerADuelPointsBefore: before[0], playerBDuelPointsBefore: before[1],
          playerADuelPointsDelta: deltas[0], playerBDuelPointsDelta: deltas[1],
          playerADuelPointsAfter: users[0].duelPoints, playerBDuelPointsAfter: users[1].duelPoints,
          g1FirstPlayer: firstGame ? firstGame.players.find(player => player.isFirst)?.name || null : null,
          coinWinner: state.coinWinner,
          duelLogId: state.duelLogs.get(1) || null,
          createTime: now
        }));

        const gameRows = [];
        for (const game of orderedGames) {
          const winner = normalizeName(game.winnerName);
          for (let index = 0; index < 2; index++) {
            const player = game.players[index];
            const opponent = game.players[1 - index];
            gameRows.push(manager.create(LadderMatchGame, {
              matchId: match.id,
              duelLogId: state.duelLogs.get(Number(game.duelCount)) || null,
              playerName: player.name,
              playerDisplayName: player.displayName,
              opponentName: opponent.name,
              opponentDisplayName: opponent.displayName,
              // A deck's type is defined by its pre-side G1 list. G2/G3 side
              // changes must not change either player's archetype.
              deckTypeId: deckFor(player.name),
              opponentDeckTypeId: deckFor(opponent.name),
              winnerName: winner,
              duelCount: Number(game.duelCount),
              isFirst: player.isFirst ? 1 : 0,
              isMain: Number(game.duelCount) === 1 ? 1 : 0,
              createTime: game.capturedAt || now
            }));
          }
        }
        if (gameRows.length) await manager.save(LadderMatchGame, gameRows);
      });
      state.settled = true;
      await api.emit('ladder_match_committed', {monthKey: monthKey()});
    } finally {
      state.settling = false;
      if (state.settled) states.delete(room.process_pid);
    }
  }

  return {authenticate, getMonthlyProfile, captureGame, captureRpsWinner, linkDuelLog, settle, ensureState};
}

let enabled = false;
module.exports.register = api => {
  enabled = !!api.settings.modules.mysql?.enabled;
  if (!enabled) return;
  [LadderUser, LadderMonthRecord, LadderMatch, LadderMatchGame].forEach(api.registerEntity);
  api.hook('random_mode', type => type === api.config.mode ? {
    type: api.config.mode,
    max_player: 2,
    name_prefix: 'M#',
    no_rematch_check: !api.config.preventSameIpRematch,
    separate_restricted_players: !!api.config.separateRestrictedPlayers,
    welcome: api.config.welcome
  } : null);
};

module.exports.init = api => {
  if (!enabled || !api.dataManager) return;
  const service = createService(api);
  api.provide('ladderCore', service);
  api.hook('resolve_room_join', async (client, room, requestedRoom) => {
    if (room?.random_type !== api.config.mode || String(requestedRoom).toUpperCase() === api.config.mode) return false;
    // A concrete TT room name is spectator-only. It cannot be used to bypass
    // random matchmaking and choose an opponent.
    if (room.duel_stage === global.ygopro.constants.DUEL_STAGE.BEGIN) {
      global.ygopro.stoc_die(client, '该房间是天梯对局，无法直接加入；对局开始后可输入房名观战。');
    } else {
      await room.join_post_watch(client);
    }
    return true;
  });
  api.hook('before_join_room', async (client, room) => {
    if (!room || room.random_type !== api.config.mode) return null;
    if ((room.players || []).some(player => player && normalizeName(player.name) === normalizeName(client.name))) {
      return {error: '同一天梯账号不能同时占用两个对战席。'};
    }
    let authenticated = false;
    try {
      authenticated = await service.authenticate(client.name, client.vpass || null);
    } catch (error) {
      api.log.warn({err: error, roomId: room.process_pid}, 'Ladder authentication failed unexpectedly.');
      return {error: '天梯认证服务暂时不可用，请稍后再试。'};
    }
    if (!authenticated) return {error: '天梯用户名或密码错误。'};
    room.plugin_hide_names = !!api.config.hideNamesBeforeStart;
    // The generic core flag means this mode is exempt from early-surrender denial.
    room.plugin_no_early_surrender = !!api.config.allowEarlySurrender;
    return null;
  });
  api.hook('room_started', room => {
    if (room?.random_type === api.config.mode) service.ensureState(room.process_pid);
  });
  api.hook('client_joined_game', async (client, room) => {
    if (room?.random_type !== api.config.mode) return;
    const profile = await service.getMonthlyProfile(client.name);
    const total = profile.wins + profile.losses;
    const winRate = total ? ((profile.wins / total) * 100).toFixed(2) : '0.00';
    global.ygopro.stoc_send_chat(client, `${client.name}你好，你的本月等级分为${profile.points}，胜场为${profile.wins}，胜率为${winRate}%`, global.ygopro.constants.COLORS.PINK);
  });
  api.hook('duel_result', event => service.captureGame(event));
  api.hook('rps_winner', event => service.captureRpsWinner(event));
  api.hook('duel_log_saved', event => service.linkDuelLog(event));
  api.hook('room_deleted', (room, scores, outcome) => service.settle(room, scores, outcome));
  if (!api.settings.modules.reconnect?.enabled) {
    api.log.warn('Ladder plugin: reconnect is disabled in the host configuration; TT cannot provide disconnect recovery.');
  }
};

module.exports._test = {normalizeName, monthKey, calculateDelta};
