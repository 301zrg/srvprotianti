const fs = require('fs');
const path = require('path');
const {EntitySchema} = require('typeorm');
const {decodeDeck} = require('../data-manager/DeckEncoder');

const intColumn = (defaultValue) => ({type: 'int', default: defaultValue});
const LadderUser = new EntitySchema({
  name: 'LadderUser', tableName: 'ladder_user',
  columns: {
    name: {type: 'varchar', length: 64, primary: true}, pass: {type: 'varchar', length: 128, nullable: true},
    createdAt: {type: 'timestamp', nullable: true}, wins: intColumn(0), losses: intColumn(0),
    monthWins: intColumn(0), monthLosses: intColumn(0), duelPoints: intColumn(1000),
    monthDuelPoints: intColumn(1000), monthKey: {type: 'varchar', length: 8, nullable: true}
  }
});
const LadderMatch = new EntitySchema({
  name: 'LadderMatch', tableName: 'ladder_match',
  columns: {
    id: {type: 'int', primary: true, generated: true}, monthKey: {type: 'varchar', length: 8, nullable: true},
    winnerName: {type: 'varchar', length: 64, nullable: true}, loserName: {type: 'varchar', length: 64, nullable: true},
    playerAName: {type: 'varchar', length: 64, nullable: true}, playerBName: {type: 'varchar', length: 64, nullable: true},
    playerADeckTypeId: intColumn(4095), playerBDeckTypeId: intColumn(4095),
    playerADuelPointsDelta: intColumn(0), playerBDuelPointsDelta: intColumn(0),
    playerADuelPointsBefore: intColumn(1000), playerBDuelPointsBefore: intColumn(1000),
    playerADuelPointsAfter: intColumn(1000), playerBDuelPointsAfter: intColumn(1000),
    g1FirstPlayer: {type: 'varchar', length: 64, nullable: true}, coinWinner: {type: 'varchar', length: 64, nullable: true},
    duelLogId: {type: 'int', nullable: true}, createTime: {type: 'timestamp', nullable: true}
  }
});
const LadderMatchGame = new EntitySchema({
  name: 'LadderMatchGame', tableName: 'ladder_match_game',
  columns: {
    id: {type: 'int', primary: true, generated: true}, matchId: {type: 'int', nullable: true}, duelLogId: {type: 'int', nullable: true},
    playerName: {type: 'varchar', length: 64}, opponentName: {type: 'varchar', length: 64, nullable: true},
    deckTypeId: intColumn(4095), opponentDeckTypeId: intColumn(4095), winnerName: {type: 'varchar', length: 64, nullable: true},
    gNumber: intColumn(1), isFirst: intColumn(0), isMain: intColumn(1), isSide: intColumn(0), duelCount: intColumn(1),
    createTime: {type: 'timestamp', nullable: true}
  }
});
const LadderMonthRecord = new EntitySchema({
  name: 'LadderMonthRecord', tableName: 'ladder_month_record',
  columns: {
    id: {type: 'int', primary: true, generated: true}, name: {type: 'varchar', length: 64}, monthKey: {type: 'varchar', length: 8},
    duelPoints: intColumn(1000), wins: intColumn(0), losses: intColumn(0), scoreDiff: intColumn(0)
  },
  indices: [{name: 'ladder_month_name_key', columns: ['name', 'monthKey'], unique: true}]
});

const root = () => path.join(process.cwd(), 'plugins');
const normalize = name => String(name || '').trim().toLowerCase();
const currentMonth = () => { const d = new Date(); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const readConfig = () => {
  const defaults = {useDynamic: true, minDelta: 8, maxDelta: 15, fixedDelta: 12, K: 20, rankingBasis: 'diff'};
  try { return {...defaults, ...JSON.parse(fs.readFileSync(path.join(root(), 'ladder_score', 'ladder_score_config.json'), 'utf8'))}; }
  catch (_) { return defaults; }
};
const deckId = deck => {
  if (!deck) return 4095;
  const match = String(deck).match(/#main\s+([\s\S]*?)(?:\n!side|$)/i);
  if (!match) return 4095;
  const cards = new Set(match[1].trim().split(/\s+/).map(Number));
  const dir = path.join(root(), 'deck_analysis', 'deck_templates');
  if (!fs.existsSync(dir)) return 4095;
  for (const file of fs.readdirSync(dir)) {
    if (!/^\d+\.ydk$/.test(file)) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const template = text.split('#main')[1].split('!side')[0].trim().split(/\s+/).map(Number).filter(Boolean);
    if (template.length && template.every(card => cards.has(card))) return Number(file.slice(0, -4));
  }
  return 4095;
};
const encodedDeckId = encoded => {
  if (!encoded) return 4095;
  try {
    const deck = decodeDeck(Buffer.from(encoded, 'base64'));
    return deckId(`#main\n${(deck.main || []).join('\n')}\n!side\n${(deck.side || []).join('\n')}`);
  } catch (_) {
    return 4095;
  }
};

const publicRooms = () => {
  const rooms = [];
  for (const room of global.ROOM_all || []) {
    if (!room || !room.established) continue;
    rooms.push({
      roomid: room.process_pid.toString(),
      roomname: room.name.split('$')[0],
      roommode: room.hostinfo.mode,
      needpass: (room.name.indexOf('$') !== -1).toString(),
      users: room.players.filter(player => player.pos != null).map(player => ({
        id: '-1', name: player.name, ip: null,
        status: null, pos: player.pos
      })),
      istart: room.duel_stage !== global.ygopro.constants.DUEL_STAGE.BEGIN ? 'start' : 'wait'
    });
  }
  return {rooms};
};

function createService(dataManager, log) {
  const repository = name => dataManager.db.getRepository(name);
  const replayDirectory = () => path.resolve(process.cwd(), global.settings?.modules?.tournament_mode?.replay_path || './replays/');
  const getUser = name => repository('LadderUser').findOne(normalize(name));
  const ensureUser = async (name, pass) => {
    const key = normalize(name); let user = await repository('LadderUser').findOne(key);
    if (!user) user = repository('LadderUser').create({name: key, pass: pass || null, createdAt: new Date()});
    return user;
  };
  const delta = (player, opponent, win) => {
    const c = readConfig();
    if (!c.useDynamic) return win ? c.fixedDelta : -c.fixedDelta;
    const expected = 1 / (1 + Math.pow(10, (opponent - player) / 400));
    const value = Math.max(c.minDelta, Math.min(c.maxDelta, Math.abs(Math.round(c.K * ((win ? 1 : 0) - expected)))));
    return win ? value : -value;
  };
  const saveMonth = async user => {
    const repo = repository('LadderMonthRecord'); const key = user.monthKey || currentMonth();
    let row = await repo.findOne({where: {name: user.name, monthKey: key}});
    if (!row) row = repo.create({name: user.name, monthKey: key});
    Object.assign(row, {duelPoints: user.monthDuelPoints, wins: user.monthWins, losses: user.monthLosses, scoreDiff: user.monthWins - user.monthLosses});
    await repo.save(row);
  };
  const saveMatchGames = async (room, match, winnerName) => {
    const logs = await dataManager.getAllDuelLogs();
    const roomLogs = logs.filter(log => Number(log.roomId) === Number(room.process_pid)).sort((a, b) => Number(a.duelCount) - Number(b.duelCount));
    const rows = [];
    const savedDuelCounts = new Set();
    for (const log of roomLogs) {
      const players = (log.players || []).filter(player => player.pos < 2).sort((a, b) => a.pos - b.pos);
      if (players.length !== 2) continue;
      const duelCount = Number(log.duelCount) || 1;
      if (savedDuelCounts.has(duelCount)) continue;
      savedDuelCounts.add(duelCount);
      const player = players[0]; const opponent = players[1];
      const decks = players.map(item => encodedDeckId(item.currentDeckBuffer));
      const isMain = duelCount === 1 ? 1 : 0;
      rows.push({matchId: match.id, duelLogId: log.id, playerName: player.name, opponentName: opponent.name,
        deckTypeId: decks[0], opponentDeckTypeId: decks[1], winnerName, gNumber: duelCount,
        isFirst: Number(player.isFirst) || 0, isMain, isSide: isMain ? 0 : 1, duelCount, createTime: match.createTime});
    }
    if (rows.length) await repository('LadderMatchGame').save(rows);
  };
  const settle = async (room, scores) => {
    if (!room || room.random_type !== 'TT' || room.plugin_ladder_settled || room.plugin_ladder_settling) return;
    if (!scores || scores.length !== 2) return;
    const playerA = scores[0]; const playerB = scores[1];
    const scoreA = Number(playerA.score); const scoreB = Number(playerB.score);
    if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA === scoreB || (scoreA < 0 && scoreB < 0)) return;
    const winner = scoreA > scoreB ? playerA : playerB;
    const loser = winner === playerA ? playerB : playerA;
    room.plugin_ladder_settling = true;
    try {
      const winnerPass = winner.name_vpass.split('$')[1] || null; const loserPass = loser.name_vpass.split('$')[1] || null;
      const a = await ensureUser(winner.name, winnerPass); const b = await ensureUser(loser.name, loserPass);
      if ((a.pass && a.pass !== winnerPass) || (b.pass && b.pass !== loserPass)) return;
      const month = currentMonth(); const createTime = new Date(); const monthRepo = repository('LadderMonthRecord');
      const aMonth = await monthRepo.findOne({where: {name: a.name, monthKey: month}}); const bMonth = await monthRepo.findOne({where: {name: b.name, monthKey: month}});
      const ap = Number(a.duelPoints) || 1000; const bp = Number(b.duelPoints) || 1000; const ad = delta(ap, bp, true); const bd = delta(bp, ap, false);
      const aMonthPoints = aMonth ? Number(aMonth.duelPoints) || 1000 : 1000; const bMonthPoints = bMonth ? Number(bMonth.duelPoints) || 1000 : 1000;
      const aMonthWins = aMonth ? Number(aMonth.wins) || 0 : 0; const aMonthLosses = aMonth ? Number(aMonth.losses) || 0 : 0;
      const bMonthWins = bMonth ? Number(bMonth.wins) || 0 : 0; const bMonthLosses = bMonth ? Number(bMonth.losses) || 0 : 0;
      Object.assign(a, {duelPoints: ap + ad, wins: (Number(a.wins) || 0) + 1, monthDuelPoints: aMonthPoints + ad, monthWins: aMonthWins + 1, monthLosses: aMonthLosses, monthKey: month});
      Object.assign(b, {duelPoints: bp + bd, losses: (Number(b.losses) || 0) + 1, monthDuelPoints: bMonthPoints + bd, monthWins: bMonthWins, monthLosses: bMonthLosses + 1, monthKey: month});
      await repository('LadderUser').save([a, b]);
      await saveMonth(a); await saveMonth(b);
      const playerAIsWinner = winner === playerA; const playerAUser = playerAIsWinner ? a : b; const playerBUser = playerAIsWinner ? b : a;
      const playerADelta = playerAIsWinner ? ad : bd; const playerBDelta = playerAIsWinner ? bd : ad;
      const playerADeckTypeId = deckId(room.decks[playerA.name]); const playerBDeckTypeId = deckId(room.decks[playerB.name]);
      const match = await repository('LadderMatch').save({monthKey: month, winnerName: winner.name, loserName: loser.name, playerAName: playerA.name, playerBName: playerB.name,
        playerADeckTypeId, playerBDeckTypeId, playerADuelPointsDelta: playerADelta, playerBDuelPointsDelta: playerBDelta,
        playerADuelPointsBefore: playerAUser.duelPoints - playerADelta, playerBDuelPointsBefore: playerBUser.duelPoints - playerBDelta,
        playerADuelPointsAfter: playerAUser.duelPoints, playerBDuelPointsAfter: playerBUser.duelPoints, createTime});
      await saveMatchGames(room, match, winner.name);
      room.plugin_ladder_settled = true;
    } catch (error) {
      log.warn('Ladder settlement failed', error);
    } finally {
      room.plugin_ladder_settling = false;
    }
  };
  const ranking = async query => {
    const type = query.type === 'month' ? 'month' : 'total'; const page = Math.max(1, Number(query.page) || 1); const size = Math.min(100, Math.max(1, Number(query.pageSize) || 50)); const search = String(query.search || '').toLowerCase();
    const allUsers = await repository('LadderUser').find(); const basis = ['points', 'diff', 'winRate'].includes(query.rankingBasis) ? query.rankingBasis : readConfig().rankingBasis;
    const month = String(query.month || currentMonth()).replace(/[^0-9]/g, '').slice(0, 6);
    const monthRows = type === 'month' ? await repository('LadderMonthRecord').find({where: {monthKey: month}}) : [];
    const monthByName = new Map(monthRows.map(row => [normalize(row.name), row]));
    const values = user => {
      const row = type === 'month' ? monthByName.get(normalize(user.name)) : null;
      return {
        wins: row ? Number(row.wins || 0) : type === 'month' ? 0 : Number(user.wins || 0),
        losses: row ? Number(row.losses || 0) : type === 'month' ? 0 : Number(user.losses || 0),
        duelPoints: row ? Number(row.duelPoints || 1000) : type === 'month' ? 1000 : Number(user.duelPoints || 1000)
      };
    };
    const score = user => {
      const value = values(user);
      if (basis === 'diff') return value.wins - value.losses;
      if (basis === 'winRate') return value.wins / Math.max(1, value.wins + value.losses);
      return value.duelPoints;
    };
    allUsers.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
    const ranked = allUsers.map((user, index) => {
      const value = values(user);
      return {name: user.name, wins: value.wins, losses: value.losses, duelPoints: value.duelPoints, monthDuelPoints: Number(user.monthDuelPoints || 1000), diff: value.wins - value.losses, rank: index + 1};
    });
    const filtered = ranked.filter(user => !search || user.name.includes(search));
    return {type, month: type === 'month' ? month : null, ladder: filtered.slice((page - 1) * size, page * size), total: filtered.length, rankingBasis: basis};
  };
  const deckStats = async query => {
    const month = String(query.month || currentMonth()).replace(/[^0-9]/g, '').slice(0, 6); const rows = await repository('LadderMatch').find({where: {monthKey: month}}); const matrix = {};
    for (const row of rows) for (const item of [{deck: row.playerADeckTypeId, opponent: row.playerBDeckTypeId, name: row.playerAName}, {deck: row.playerBDeckTypeId, opponent: row.playerADeckTypeId, name: row.playerBName}]) { const key = `${item.deck}::${item.opponent}`; const stat = matrix[key] || (matrix[key] = {deckTypeId: item.deck, opponentDeckTypeId: item.opponent, matches: 0, matchWins: 0}); stat.matches++; if (row.winnerName === item.name) stat.matchWins++; }
    let metadata = {}; try { metadata = JSON.parse(fs.readFileSync(path.join(root(), 'deck_analysis', 'deck_analysis.json'), 'utf8')); } catch (_) {}
    return {monthKey: month, matrix, metadata};
  };
  const replays = async query => {
    const page = Math.max(1, Number(query.page) || 1);
    const size = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const search = String(query.search || '').toLowerCase();
    const rows = (await dataManager.getAllDuelLogs()).filter(row => {
      return !search || row.replayFileName.toLowerCase().includes(search) || row.name.toLowerCase().includes(search);
    });
    const files = (await Promise.all(rows.map(async row => {
      const filePath = path.join(replayDirectory(), path.basename(row.replayFileName));
      let size = 0;
      try { size = (await fs.promises.stat(filePath)).size; } catch (_) { return null; }
      const players = (row.players || []).sort((a, b) => a.pos - b.pos).slice(0, 2);
      return {
        name: row.replayFileName,
        url: '/api/public/replay/' + encodeURIComponent(path.basename(row.replayFileName)),
        size,
        gameNumber: row.duelCount,
        firstPlayer: (players.find(player => player.isFirst === 1) || {}).name || null,
        winner: (players.find(player => player.winner === 1) || {}).name || null,
        players: players.map(player => ({
          id: player.name,
          deckbuffer: player.currentDeckBuffer || null
        }))
      };
    }))).filter(Boolean);
    return {replays: files.slice((page - 1) * size, page * size), total: files.length, page, pageSize: size};
  };
  const replay = async filename => {
    const safeName = path.basename(String(filename || ''));
    if (!safeName || safeName !== filename) return null;
    const filePath = path.join(replayDirectory(), safeName);
    try { return await fs.promises.readFile(filePath); } catch (_) { return null; }
  };
  return {getUser, settle, ranking, deckStats, replays, replay, config: readConfig};
}

let service;
let enabled = false;
module.exports = {
  register(context) {
    enabled = !!(context.settings.modules.mysql && context.settings.modules.mysql.enabled);
    if (!enabled) return;
    [LadderUser, LadderMatch, LadderMatchGame, LadderMonthRecord].forEach(context.registerEntity);
    context.register('random_mode', type => type === 'TT' ? {type: 'TT', max_player: 2, name_prefix: 'M#', no_rematch_check: true, allow_disconnector: true, welcome: 'Ladder match'} : null);
  },
  async init(context) {
    if (!enabled || !context.dataManager) return;
    service = createService(context.dataManager, context.log);
    context.register('before_join_room', async (client, room) => { if (!room || room.random_type !== 'TT') return null; const user = await service.getUser(client.name); if (user && user.pass && user.pass !== (client.vpass || null)) return {error: 'Invalid ladder password.'}; room.plugin_hide_names = true; room.plugin_no_early_surrender = true; return null; });
    context.register('room_started', room => { if (room && room.random_type === 'TT') room.plugin_hide_names = true; });
    context.register('room_deleted', (room, scores) => service.settle(room, scores));
    context.register('http_request', async (request, response, url) => {
      if (request.method !== 'GET' || !service) return false;
      if (url.pathname === '/api/public/getrooms') {
        response.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
        response.end(JSON.stringify(publicRooms()));
        return true;
      }
      if (url.pathname === '/api/public/replays') {
        response.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
        response.end(JSON.stringify(await service.replays(url.query)));
        return true;
      }
      if (url.pathname.startsWith('/api/public/replay/')) {
        const filename = decodeURIComponent(url.pathname.slice('/api/public/replay/'.length));
        const buffer = await service.replay(filename);
        if (!buffer) { response.writeHead(404); response.end('Replay not found.'); return true; }
        const downloadName = path.basename(String(url.query.downloadName || filename));
        const fallbackName = downloadName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        response.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`});
        response.end(buffer);
        return true;
      }
      if (url.pathname === '/api/public/ladder' || url.pathname === '/api/ladder') { response.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'}); response.end(JSON.stringify(await service.ranking(url.query))); return true; }
      if (url.pathname === '/api/public/ladder-config' || url.pathname === '/api/ladder-config') { response.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'}); response.end(JSON.stringify(service.config())); return true; }
      if (url.pathname === '/api/public/ladder-deck-stats' || url.pathname === '/api/ladder-deck-stats') { response.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'}); response.end(JSON.stringify(await service.deckStats(url.query))); return true; }
      const pages = ['intro.html', 'rooms.html', 'replays.html', 'ladder.html', 'deck-stats.html'];
      const page = url.pathname.startsWith('/') ? url.pathname.slice(1) : '';
      if (pages.includes(page)) { response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); response.end(fs.readFileSync(path.join(root(), 'ladder_score', 'web', page))); return true; }
      if (url.pathname.startsWith('/example_decks/')) {
        const filename = path.basename(decodeURIComponent(url.pathname.slice('/example_decks/'.length)));
        const file = path.join(root(), 'ladder_score', 'web', 'example_decks', filename);
        if (fs.existsSync(file)) { response.writeHead(200, {'Content-Type': 'application/octet-stream'}); response.end(fs.readFileSync(file)); return true; }
      }
      return false;
    });
  }
};
