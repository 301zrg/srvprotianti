'use strict';

const fs = require('fs');
const path = require('path');
const {decodeDeck} = require('../../data-manager/DeckEncoder');

const compactMonth = value => {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 6);
  if (digits.length === 6) return digits;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit'})
    .formatToParts(new Date()).filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
  return `${parts.year}${parts.month}`;
};
const blankStat = () => ({
  matches: 0, matchWins: 0, firstMatches: 0, firstWins: 0, secondMatches: 0, secondWins: 0,
  games: 0, gameWins: 0, firstGames: 0, firstGameWins: 0, secondGames: 0, secondGameWins: 0,
  mainGames: 0, mainGameWins: 0, mainFirstGames: 0, mainFirstGameWins: 0, mainSecondGames: 0, mainSecondGameWins: 0,
  sideGames: 0, sideGameWins: 0, sideFirstGames: 0, sideFirstGameWins: 0, sideSecondGames: 0, sideSecondGameWins: 0
});
const add = (target, source) => Object.keys(target).forEach(key => { target[key] += Number(source?.[key] || 0); });

const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const readOptionalJson = filename => {
  try {
    return readJson(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
};

function loadPluginConfig(rootDir, fallback = {}) {
  return {
    ...fallback,
    ...readOptionalJson(path.join(rootDir, 'config.default.json')),
    ...readOptionalJson(path.join(rootDir, 'config.json'))
  };
}

function recentMatchLimit(current) {
  const value = Number(current.recentMatchLimit);
  return Number.isInteger(value) ? Math.max(10, Math.min(20, value)) : 10;
}

function createService(api) {
  const cache = new Map();
  let lastConfig = {...api.config};
  const config = () => {
    try {
      lastConfig = loadPluginConfig(api.rootDir, api.config);
    } catch (error) {
      api.log.warn({err: error}, 'Ladder analytics live config reload failed');
    }
    return lastConfig;
  };
  const repo = entity => api.dataManager.getRepository(entity);
  const ladderCore = api.get('ladderCore');
  const {LadderUser, LadderMonthRecord, LadderMatch, LadderMatchGame} = ladderCore.entities;
  const classifier = api.get('deckClassifier');
  const cardCatalog = api.get('cardCatalog');
  const normalizeName = value => String(value || '').split('$', 1)[0].trim().toLowerCase();
  const configuredBasis = current => ['points', 'wins', 'diff', 'winRate'].includes(current.rankingBasis) ? current.rankingBasis : 'points';
  const validBasis = (value, current = config()) => ['points', 'wins', 'diff', 'winRate'].includes(value) ? value : configuredBasis(current);
  const hasColumn = async (table, column) => {
    const runner = api.dataManager.getConnection().createQueryRunner();
    try {
      await runner.connect();
      return await runner.hasColumn(table, column);
    } finally {
      await runner.release();
    }
  };

  async function rankedRows(type, month, basis) {
    let rows;
    const includeDisplayName = await hasColumn('ladder_user', 'displayName');
    if (type === 'total') {
      const qb = repo(LadderUser).createQueryBuilder('u');
      const order = basis === 'wins' ? 'u.wins' : basis === 'diff' ? '(u.wins - u.losses)' : basis === 'winRate' ? '(1.0 * u.wins / CASE WHEN (u.wins + u.losses) = 0 THEN 1 ELSE (u.wins + u.losses) END)' : 'u.duelPoints';
      qb.select('u.name', 'name').addSelect('u.wins', 'wins').addSelect('u.losses', 'losses').addSelect('u.duelPoints', 'duelPoints');
      if (includeDisplayName) qb.addSelect('u.displayName', 'displayName');
      rows = (await qb.orderBy(order, 'DESC').addOrderBy('u.name', 'ASC').getRawMany()).map(row => ({
        accountName: row.name,
        name: row.displayName || row.displayname || row.name,
        wins: Number(row.wins), losses: Number(row.losses), duelPoints: Number(row.duelPoints ?? row.duelpoints)
      }));
    } else {
      const qb = repo(LadderMonthRecord).createQueryBuilder('m').leftJoin(LadderUser, 'u', 'u.name = m.name')
        .select('m.name', 'name').addSelect('m.wins', 'wins').addSelect('m.losses', 'losses').addSelect('m.duelPoints', 'duelPoints')
        .where('m.monthKey = :month', {month});
      if (includeDisplayName) qb.addSelect('u.displayName', 'displayName');
      const order = basis === 'wins' ? 'm.wins' : basis === 'diff' ? '(m.wins - m.losses)' : basis === 'winRate' ? '(1.0 * m.wins / CASE WHEN (m.wins + m.losses) = 0 THEN 1 ELSE (m.wins + m.losses) END)' : 'm.duelPoints';
      rows = (await qb.orderBy(order, 'DESC').addOrderBy('m.name', 'ASC').getRawMany()).map(row => ({
        accountName: row.name,
        name: row.displayName || row.displayname || row.name,
        wins: Number(row.wins), losses: Number(row.losses), duelPoints: Number(row.duelPoints ?? row.duelpoints)
      }));
    }

    // Rank against the complete selected leaderboard before applying search.
    // Otherwise a searched player would incorrectly become rank 1 among only
    // the matching rows instead of retaining their real global position.
    return rows.map((row, index) => ({...row, rank: index + 1}));
  }

  async function ranking(query) {
    const currentConfig = config();
    const type = query.type === 'month' ? 'month' : 'total';
    const month = compactMonth(query.month);
    const basis = validBasis(query.rankingBasis, currentConfig);
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(Number(currentConfig.maxPageSize) || 100, Math.max(1, Number(query.pageSize) || 50));
    const search = String(query.search || '').trim().toLowerCase();
    const ranked = await rankedRows(type, month, basis);
    const filtered = search
      ? ranked.filter(row => String(row.accountName || '').toLowerCase().includes(search))
      : ranked;
    const total = filtered.length;
    const ladder = filtered.slice((page - 1) * pageSize, page * pageSize).map(row => {
      const {accountName, ...publicRow} = row;
      return {...publicRow, diff: row.wins - row.losses};
    });
    return {type, month: type === 'month' ? month : null, rankingBasis: basis, total, ladder};
  }

  async function aggregateDeckStats(month, groups) {
    const matrix = {};
    const ensure = (deck, opponent) => matrix[`${deck}::${opponent}`] || (matrix[`${deck}::${opponent}`] = blankStat());
    const validMatchFirst = [
      'm.g1FirstPlayer IS NOT NULL',
      '(LOWER(m.g1FirstPlayer) = LOWER(m.playerAName) OR LOWER(m.g1FirstPlayer) = LOWER(m.playerBName))'
    ].join(' AND ');
    for (const side of ['A', 'B']) {
      const other = side === 'A' ? 'B' : 'A';
      const player = `m.player${side}Name`;
      const opponent = `m.player${other}Name`;
      const won = `LOWER(m.winnerName) = LOWER(${player})`;
      const wentFirst = `LOWER(m.g1FirstPlayer) = LOWER(${player})`;
      const wentSecond = `LOWER(m.g1FirstPlayer) = LOWER(${opponent})`;
      const rows = await repo(LadderMatch).createQueryBuilder('m')
        .select(`m.player${side}DeckTypeId`, 'deck').addSelect(`m.player${other}DeckTypeId`, 'opponent')
        .addSelect('COUNT(*)', 'matches')
        .addSelect(`SUM(CASE WHEN ${won} THEN 1 ELSE 0 END)`, 'wins')
        .addSelect(`SUM(CASE WHEN ${wentFirst} THEN 1 ELSE 0 END)`, 'firstMatches')
        .addSelect(`SUM(CASE WHEN ${wentFirst} AND ${won} THEN 1 ELSE 0 END)`, 'firstWins')
        .addSelect(`SUM(CASE WHEN ${wentSecond} THEN 1 ELSE 0 END)`, 'secondMatches')
        .addSelect(`SUM(CASE WHEN ${wentSecond} AND ${won} THEN 1 ELSE 0 END)`, 'secondWins')
        .where('m.monthKey = :month', {month})
        // A missing/foreign G1 first-player marker makes the whole Match
        // unsuitable for deck statistics, including any attached game rows.
        .andWhere(validMatchFirst)
        .groupBy(`m.player${side}DeckTypeId`).addGroupBy(`m.player${other}DeckTypeId`).getRawMany();
      for (const row of rows) {
        const item = ensure(row.deck, row.opponent);
        item.matches += Number(row.matches); item.matchWins += Number(row.wins);
        item.firstMatches += Number(row.firstMatches ?? row.firstmatches); item.firstWins += Number(row.firstWins ?? row.firstwins);
        item.secondMatches += Number(row.secondMatches ?? row.secondmatches); item.secondWins += Number(row.secondWins ?? row.secondwins);
      }
    }
    const gameQuery = repo(LadderMatchGame).createQueryBuilder('g')
      .innerJoin(LadderMatch, 'm', 'm.id = g.matchId')
      // Validate first/second from both player perspectives. Checking only
      // g.isFirst=0 would mistake legacy rows with both sides marked second for
      // valid games.
      .innerJoin(LadderMatchGame, 'opponentGame', [
        'opponentGame.matchId = g.matchId',
        'opponentGame.duelCount = g.duelCount',
        'LOWER(opponentGame.playerName) = LOWER(g.opponentName)',
        'LOWER(opponentGame.opponentName) = LOWER(g.playerName)'
      ].join(' AND '));
    let opponentDeck = 'g.opponentDeckTypeId';
    if (!await hasColumn('ladder_match_game', 'opponentDeckTypeId')) {
      // Historical rows already contain both player perspectives, but lack an
      // explicit opponent deck column. Resolve it from the counterpart row of
      // the same match and duel without modifying historical data.
      opponentDeck = 'opponentGame.deckTypeId';
    }
    const games = await gameQuery
      .select('g.deckTypeId', 'deck').addSelect(opponentDeck, 'opponent').addSelect('g.isFirst', 'isFirst').addSelect('g.isMain', 'isMain')
      .addSelect('COUNT(*)', 'games').addSelect('SUM(CASE WHEN LOWER(g.winnerName) = LOWER(g.playerName) THEN 1 ELSE 0 END)', 'wins')
      .where('m.monthKey = :month', {month})
      .andWhere(validMatchFirst)
      .andWhere('g.isFirst IN (0, 1)')
      .andWhere('opponentGame.isFirst IN (0, 1)')
      .andWhere('(g.isFirst + opponentGame.isFirst) = 1')
      .groupBy('g.deckTypeId').addGroupBy(opponentDeck).addGroupBy('g.isFirst').addGroupBy('g.isMain').getRawMany();
    for (const row of games) {
      const item = ensure(row.deck, row.opponent);
      const count = Number(row.games); const wins = Number(row.wins); const first = Number(row.isFirst ?? row.isfirst) === 1; const main = Number(row.isMain ?? row.ismain) === 1;
      item.games += count; item.gameWins += wins;
      item[first ? 'firstGames' : 'secondGames'] += count;
      item[first ? 'firstGameWins' : 'secondGameWins'] += wins;
      const prefix = main ? 'main' : 'side';
      item[`${prefix}Games`] += count; item[`${prefix}GameWins`] += wins;
      item[`${prefix}${first ? 'First' : 'Second'}Games`] += count;
      item[`${prefix}${first ? 'First' : 'Second'}GameWins`] += wins;
    }
    const stats = {};
    for (const rowGroup of groups) {
      for (const columnGroup of groups) {
        const item = blankStat();
        for (const rowId of rowGroup.members) for (const columnId of columnGroup.members) add(item, matrix[`${rowId}::${columnId}`]);
        stats[`${rowGroup.id}::${columnGroup.id}`] = item;
      }
      // The overall denominator includes opponents hidden by display grouping,
      // including "Others". Summing only visible matrix columns would not match
      // the user-facing win-rate definition.
      const overall = blankStat();
      for (const [key, item] of Object.entries(matrix)) {
        if (rowGroup.members.includes(Number(key.split('::', 1)[0]))) add(overall, item);
      }
      stats[`${rowGroup.id}::all`] = overall;
    }
    return {monthKey: month, decks: groups, stats};
  }

  async function deckStats(query) {
    const currentConfig = config();
    const month = compactMonth(query.month);
    const groups = classifier.getDisplayGroups();
    const displayKey = JSON.stringify(groups);
    const ttl = Math.max(1, Number(currentConfig.cacheTtlSeconds) || 45) * 1000;
    const cached = cache.get(month);
    if (cached && cached.displayKey === displayKey && Date.now() - cached.time < ttl) return cached.value;
    const promise = aggregateDeckStats(month, groups);
    cache.set(month, {time: Date.now(), displayKey, value: promise});
    try {
      const value = await promise;
      cache.set(month, {time: Date.now(), displayKey, value});
      return value;
    } catch (error) {
      cache.delete(month);
      throw error;
    }
  }

  const deckMetadata = () => {
    return new Map(classifier.listDeckMetadata().map(item => [item.id, item.names]));
  };
  const monthNow = () => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit'})
      .formatToParts(new Date()).filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
    return `${parts.year}${parts.month}`;
  };
  const matchSide = (match, player) => normalizeName(match.playerAName) === player ? 'A' : normalizeName(match.playerBName) === player ? 'B' : null;
  const safeRate = (wins, losses) => wins + losses ? wins / (wins + losses) : 0;

  async function playerDeckStats(player, month) {
    const rowsBySide = await Promise.all(['A', 'B'].map(side => {
      const deck = `m.player${side}DeckTypeId`;
      const won = `m.winnerName = m.player${side}Name`;
      return repo(LadderMatch).createQueryBuilder('m')
        .select(deck, 'deckTypeId')
        .addSelect('COUNT(*)', 'totalMatches')
        .addSelect(`SUM(CASE WHEN ${won} THEN 1 ELSE 0 END)`, 'totalWins')
        .addSelect('SUM(CASE WHEN m.monthKey = :month THEN 1 ELSE 0 END)', 'monthMatches')
        .addSelect(`SUM(CASE WHEN m.monthKey = :month AND ${won} THEN 1 ELSE 0 END)`, 'monthWins')
        .where(`m.player${side}Name = :player`, {player, month})
        .groupBy(deck).getRawMany();
    }));
    const combined = new Map();
    for (const row of rowsBySide.flat()) {
      const deckTypeId = Number(row.deckTypeId ?? row.decktypeid);
      const current = combined.get(deckTypeId) || {totalMatches: 0, totalWins: 0, monthMatches: 0, monthWins: 0};
      for (const key of Object.keys(current)) current[key] += Number(row[key] ?? row[key.toLowerCase()] ?? 0);
      combined.set(deckTypeId, current);
    }
    const names = deckMetadata();
    const makeRows = scope => [...combined].map(([deckTypeId, value]) => {
      const matches = value[`${scope}Matches`], wins = value[`${scope}Wins`];
      return {deckTypeId, names: names.get(deckTypeId) || {zh: String(deckTypeId)}, matches, wins,
        losses: matches - wins, winRate: matches ? wins / matches : 0};
    }).filter(row => row.matches > 0)
      .sort((a, b) => b.matches - a.matches || b.winRate - a.winRate || a.deckTypeId - b.deckTypeId);
    return {total: makeRows('total'), month: makeRows('month')};
  }

  async function snapshotsFor(matches) {
    const ids = [...new Set(matches.map(match => Number(match.duelLogId)).filter(Number.isFinite))];
    if (!ids.length) return new Map();
    const players = await repo('DuelLogPlayer').createQueryBuilder('p')
      .select('p.duelLogId', 'duelLogId').addSelect('p.realName', 'realName').addSelect('p.name', 'name')
      .addSelect('p.startDeckBuffer', 'startDeckBuffer').where('p.duelLogId IN (:...ids)', {ids}).getRawMany();
    const result = new Map();
    for (const player of players) {
      const duelLogId = player.duelLogId ?? player.duellogid;
      const realName = player.realName ?? player.realname;
      const startDeckBuffer = player.startDeckBuffer ?? player.startdeckbuffer;
      result.set(`${duelLogId}:${normalizeName(realName || player.name)}`, startDeckBuffer || null);
    }
    return result;
  }

  async function gamesFor(matches) {
    const ids = matches.map(match => Number(match.id));
    if (!ids.length) return new Map();
    const rows = await repo(LadderMatchGame).createQueryBuilder('g').where('g.matchId IN (:...ids)', {ids})
      .orderBy('g.matchId', 'ASC').addOrderBy('g.duelCount', 'ASC').getMany();
    const result = new Map();
    for (const row of rows) {
      const list = result.get(Number(row.matchId)) || [];
      list.push(row); result.set(Number(row.matchId), list);
    }
    return result;
  }

  function formatMatch(match, player, games, snapshots, names) {
    const side = matchSide(match, player), other = side === 'A' ? 'B' : 'A';
    if (!side) return null;
    const opponent = normalizeName(match[`player${other}Name`]);
    const physical = new Map();
    for (const game of games.get(Number(match.id)) || []) {
      const key = Number(game.duelCount), winners = physical.get(key) || new Set();
      winners.add(normalizeName(game.winnerName)); physical.set(key, winners);
    }
    let playerScore = 0, opponentScore = 0;
    const hasScore = physical.size > 0 && [...physical.values()].every(winners => winners.size === 1 && [player, opponent].includes([...winners][0]));
    for (const winners of hasScore ? physical.values() : []) {
      const winner = [...winners][0];
      if (winner === player) playerScore++;
      else if (winner === opponent) opponentScore++;
    }
    const deckTypeId = Number(match[`player${side}DeckTypeId`]);
    const opponentDeckTypeId = Number(match[`player${other}DeckTypeId`]);
    return {
      matchId: Number(match.id), rpsWon: match.coinWinner ? normalizeName(match.coinWinner) === player : null,
      g1First: [player, opponent].includes(normalizeName(match.g1FirstPlayer)) ? normalizeName(match.g1FirstPlayer) === player : null,
      won: [player, opponent].includes(normalizeName(match.winnerName)) ? normalizeName(match.winnerName) === player : null,
      score: hasScore ? `${playerScore}-${opponentScore}` : null,
      pointsDelta: Number(match[`player${side}DuelPointsDelta`] || 0), opponentPointsDelta: Number(match[`player${other}DuelPointsDelta`] || 0),
      pointsBefore: Number(match[`player${side}DuelPointsBefore`] || 0), pointsAfter: Number(match[`player${side}DuelPointsAfter`] || 0),
      opponentPointsAfter: Number(match[`player${other}DuelPointsAfter`] || 0),
      deckTypeId, deckNames: names.get(deckTypeId) || {zh: String(deckTypeId)},
      opponent: match[`player${other}DisplayName`] || match[`player${other}Name`], opponentDeckTypeId,
      opponentDeckNames: names.get(opponentDeckTypeId) || {zh: String(opponentDeckTypeId)},
      settledAt: match.createTime, playerDeckAvailable: !!snapshots.get(`${match.duelLogId}:${player}`),
      opponentDeckAvailable: !!snapshots.get(`${match.duelLogId}:${opponent}`)
    };
  }

  async function profile(query, password) {
    const player = normalizeName(query.player);
    if (!player || player.length > 64) return {found: false};
    const user = await repo(LadderUser).findOne(player);
    if (!user) return {found: false};
    const month = compactMonth(query.month), authenticated = await ladderCore.verifyExisting(player, String(password || ''));
    const currentConfig = config(), limit = recentMatchLimit(currentConfig), basis = validBasis(null, currentConfig);
    const [monthRow, decks] = await Promise.all([
      repo(LadderMonthRecord).findOne({where: {name: player, monthKey: month}}),
      playerDeckStats(player, month)
    ]);
    // Match account keys are already normalized at write/migration time. Avoid
    // LOWER(column) so PostgreSQL can use the two player/time indexes.
    const base = repo(LadderMatch).createQueryBuilder('m').where('(m.playerAName = :player OR m.playerBName = :player)', {player});
    const latest = await base.clone().orderBy('m.createTime', 'DESC').addOrderBy('m.id', 'DESC').limit(limit).getMany();
    let history = [], total = 0;
    if (authenticated) {
      const page = Math.max(1, Number(query.page) || 1), pageSize = 20;
      const filtered = base.clone().andWhere('m.monthKey = :month', {month});
      total = await filtered.getCount();
      history = await filtered.orderBy('m.createTime', 'DESC').addOrderBy('m.id', 'DESC').skip((page - 1) * pageSize).take(pageSize).getMany();
    } else if (month === monthNow()) {
      history = await base.clone().andWhere('m.monthKey = :month', {month}).orderBy('m.createTime', 'DESC').addOrderBy('m.id', 'DESC').limit(limit).getMany();
      total = history.length;
    }
    const all = [...new Map(latest.concat(history).map(match => [Number(match.id), match])).values()];
    const [games, snapshots, totalRanks, monthRanks] = await Promise.all([
      gamesFor(all), snapshotsFor(all), rankedRows('total', month, basis), rankedRows('month', month, basis)
    ]), names = deckMetadata();
    const totalWins = Number(user.wins || 0), totalLosses = Number(user.losses || 0);
    const monthWins = Number(monthRow?.wins || 0), monthLosses = Number(monthRow?.losses || 0);
    return {
      found: true, authenticated, player: user.displayName || user.name, month, recentMatchLimit: limit, rankingBasis: basis,
      summary: {
        total: {rank: totalRanks.find(row => row.accountName === player)?.rank ?? null,
          points: Number(user.duelPoints ?? ladderCore.initialPoints), wins: totalWins, losses: totalLosses, diff: totalWins - totalLosses,
          winRate: safeRate(totalWins, totalLosses), decks: decks.total},
        month: {rank: monthRanks.find(row => row.accountName === player)?.rank ?? null,
          points: Number(monthRow?.duelPoints ?? ladderCore.initialPoints), wins: monthWins, losses: monthLosses, diff: monthWins - monthLosses,
          winRate: safeRate(monthWins, monthLosses), decks: decks.month}
      },
      chart: latest.slice().reverse().map(match => {
        const side = matchSide(match, player);
        return {matchId: Number(match.id), settledAt: match.createTime, pointsBefore: Number(match[`player${side}DuelPointsBefore`]), pointsAfter: Number(match[`player${side}DuelPointsAfter`])};
      }),
      page: authenticated ? Math.max(1, Number(query.page) || 1) : 1, pageSize: authenticated ? 20 : limit, total,
      matches: history.map(match => formatMatch(match, player, games, snapshots, names)).filter(Boolean)
    };
  }

  function deckToYdk(encoded) {
    const deck = decodeDeck(Buffer.from(encoded, 'base64'));
    const combined = (deck.main || []).concat(deck.extra || []), main = [], extra = [];
    for (const id of combined) (cardCatalog?.classifyZone(id) === 'extra' ? extra : main).push(id);
    const lines = ['#created by srvprotianti', '#main', ...main.map(String), '#extra', ...extra.map(String), '!side', ...(deck.side || []).map(String)];
    return `${lines.join('\r\n')}\r\n`;
  }

  async function profileDeck(query, password) {
    const player = normalizeName(query.player), match = await repo(LadderMatch).findOne(Number(query.matchId));
    const requestedSide = query.side === 'opponent' ? 'opponent' : 'player';
    const side = match && matchSide(match, player);
    if (!match || !side) return null;
    const authenticated = await ladderCore.verifyExisting(player, String(password || ''));
    if (!authenticated) {
      const limit = recentMatchLimit(config());
      if (match.monthKey !== monthNow()) return null;
      const visible = await repo(LadderMatch).createQueryBuilder('m').select('m.id', 'id')
        .where('(m.playerAName = :player OR m.playerBName = :player)', {player})
        .andWhere('m.monthKey = :month', {month: monthNow()}).orderBy('m.createTime', 'DESC').addOrderBy('m.id', 'DESC').limit(limit).getRawMany();
      if (!visible.some(row => Number(row.id) === Number(match.id))) return null;
    }
    const targetSide = requestedSide === 'player' ? side : side === 'A' ? 'B' : 'A';
    const targetName = normalizeName(match[`player${targetSide}Name`]);
    const snapshots = await snapshotsFor([match]), encoded = snapshots.get(`${match.duelLogId}:${targetName}`);
    if (!encoded) return null;
    const safeName = String(targetName || 'deck').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 48) || 'deck';
    return {filename: `${safeName}-${match.id}.ydk`, contents: deckToYdk(encoded)};
  }

  return {ranking, deckStats, profile, profileDeck, rankingBasis: () => validBasis(), invalidate: month => cache.delete(compactMonth(month))};
}

module.exports.init = api => {
  if (!api.dataManager) return;
  const service = createService(api);
  api.provide('ladderAnalytics', service);
  api.hook('ladder_match_committed', event => service.invalidate(event?.monthKey));
  // Maintenance CLIs do not serve web traffic and should not issue unrelated
  // warm-up queries or obscure their own database errors.
  if (!api.runtime?.maintenanceTool) {
    // Warm asynchronously: restart discards only this cache, never source data.
    setImmediate(() => service.deckStats({}).catch(error => api.log.warn({err: error}, 'Ladder statistics warm-up failed')));
  }
};

module.exports._test = {compactMonth, blankStat, loadPluginConfig, recentMatchLimit};
