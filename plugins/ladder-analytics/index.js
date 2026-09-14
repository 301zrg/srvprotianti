'use strict';

const fs = require('fs');
const path = require('path');
const {LadderUser, LadderMonthRecord, LadderMatch, LadderMatchGame} = require('../ladder-core/entities');

const compactMonth = value => {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 6);
  if (digits.length === 6) return digits;
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
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

function loadDisplayGroups(metadataFilename, displayFilename) {
  const metadata = readJson(metadataFilename);
  // Keep the old embedded shape readable during rolling deployments, while
  // preferring the independently editable display file.
  const display = displayFilename ? readJson(displayFilename) : metadata.display;
  const archetypes = metadata.archetypes || {};
  const families = metadata.families || {};
  const groups = (display?.groups || []).filter(group => group.isDisplayed !== false).sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
  for (const group of groups) {
    if (Array.isArray(group.archetypeIds)) {
      group.members = group.archetypeIds.map(Number).filter(id => Object.prototype.hasOwnProperty.call(archetypes, id));
    } else if (group.type === 'single') group.members = [Number(group.archetypeId)];
    else {
      const familyCode = Object.keys(families).find(key => Number(families[key].id) === Number(group.familyId)) || '';
      const members = Object.keys(archetypes).filter(id => archetypes[id].code === familyCode || archetypes[id].code?.startsWith(`${familyCode}_`)).map(Number);
      group.members = group.type === 'custom' && Array.isArray(group.includeBranches)
        ? group.includeBranches.map(index => members[index]).filter(Number.isFinite)
        : members;
    }
  }
  return groups.map(group => ({id: group.id, name: group.name, members: group.members}));
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
  const configuredBasis = current => ['points', 'diff', 'winRate'].includes(current.rankingBasis) ? current.rankingBasis : 'points';
  const validBasis = (value, current = config()) => ['points', 'diff', 'winRate'].includes(value) ? value : configuredBasis(current);
  const hasColumn = async (table, column) => {
    const runner = api.dataManager.getConnection().createQueryRunner();
    try {
      await runner.connect();
      return await runner.hasColumn(table, column);
    } finally {
      await runner.release();
    }
  };

  async function ranking(query) {
    const currentConfig = config();
    const type = query.type === 'month' ? 'month' : 'total';
    const month = compactMonth(query.month);
    const basis = validBasis(query.rankingBasis, currentConfig);
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(Number(currentConfig.maxPageSize) || 100, Math.max(1, Number(query.pageSize) || 50));
    const search = String(query.search || '').trim().toLowerCase();
    let rows;
    const includeDisplayName = await hasColumn('ladder_user', 'displayName');
    if (type === 'total') {
      const qb = repo(LadderUser).createQueryBuilder('u');
      const order = basis === 'diff' ? '(u.wins - u.losses)' : basis === 'winRate' ? '(1.0 * u.wins / CASE WHEN (u.wins + u.losses) = 0 THEN 1 ELSE (u.wins + u.losses) END)' : 'u.duelPoints';
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
      const order = basis === 'diff' ? '(m.wins - m.losses)' : basis === 'winRate' ? '(1.0 * m.wins / CASE WHEN (m.wins + m.losses) = 0 THEN 1 ELSE (m.wins + m.losses) END)' : 'm.duelPoints';
      rows = (await qb.orderBy(order, 'DESC').addOrderBy('m.name', 'ASC').getRawMany()).map(row => ({
        accountName: row.name,
        name: row.displayName || row.displayname || row.name,
        wins: Number(row.wins), losses: Number(row.losses), duelPoints: Number(row.duelPoints ?? row.duelpoints)
      }));
    }

    // Rank against the complete selected leaderboard before applying search.
    // Otherwise a searched player would incorrectly become rank 1 among only
    // the matching rows instead of retaining their real global position.
    const ranked = rows.map((row, index) => ({...row, rank: index + 1}));
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
    const groups = loadDisplayGroups(
      path.resolve(api.rootDir, currentConfig.metadataFile),
      path.resolve(api.rootDir, currentConfig.displayFile)
    );
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
  return {ranking, deckStats, rankingBasis: () => validBasis(), invalidate: month => cache.delete(compactMonth(month))};
}

module.exports.init = api => {
  if (!api.dataManager) return;
  const service = createService(api);
  api.provide('ladderAnalytics', service);
  api.hook('ladder_match_committed', event => service.invalidate(event?.monthKey));
  // Warm asynchronously: restart discards only this cache, never source data.
  setImmediate(() => service.deckStats({}).catch(error => api.log.warn({err: error}, 'Ladder statistics warm-up failed')));
};

module.exports._test = {compactMonth, blankStat, loadPluginConfig, loadDisplayGroups};
