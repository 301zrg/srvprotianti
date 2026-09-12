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

function loadDisplayGroups(filename) {
  const source = fs.readFileSync(filename, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const metadata = JSON.parse(source);
  const archetypes = metadata.archetypes || {};
  const families = metadata.families || {};
  const groups = (metadata.display?.groups || []).filter(group => group.isDisplayed !== false).sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
  for (const group of groups) {
    if (group.type === 'single') group.members = [Number(group.archetypeId)];
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
  const ttl = Math.max(1, Number(api.config.cacheTtlSeconds) || 45) * 1000;
  const groups = loadDisplayGroups(path.resolve(api.rootDir, api.config.metadataFile));
  const repo = entity => api.dataManager.getRepository(entity);
  const validBasis = value => ['points', 'diff', 'winRate'].includes(value) ? value : api.config.rankingBasis;
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
    const type = query.type === 'month' ? 'month' : 'total';
    const month = compactMonth(query.month);
    const basis = validBasis(query.rankingBasis);
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(Number(api.config.maxPageSize) || 100, Math.max(1, Number(query.pageSize) || 50));
    const search = String(query.search || '').trim().toLowerCase();
    let rows;
    let total;
    const includeDisplayName = await hasColumn('ladder_user', 'displayName');
    if (type === 'total') {
      const qb = repo(LadderUser).createQueryBuilder('u');
      if (search) qb.where('LOWER(u.name) LIKE :search', {search: `%${search}%`});
      const order = basis === 'diff' ? '(u.wins - u.losses)' : basis === 'winRate' ? '(1.0 * u.wins / CASE WHEN (u.wins + u.losses) = 0 THEN 1 ELSE (u.wins + u.losses) END)' : 'u.duelPoints';
      total = await qb.getCount();
      qb.select('u.name', 'name').addSelect('u.wins', 'wins').addSelect('u.losses', 'losses').addSelect('u.duelPoints', 'duelPoints');
      if (includeDisplayName) qb.addSelect('u.displayName', 'displayName');
      rows = (await qb.orderBy(order, 'DESC').addOrderBy('u.name', 'ASC').offset((page - 1) * pageSize).limit(pageSize).getRawMany()).map(row => ({
        name: row.displayName || row.displayname || row.name,
        wins: Number(row.wins), losses: Number(row.losses), duelPoints: Number(row.duelPoints ?? row.duelpoints)
      }));
    } else {
      const qb = repo(LadderMonthRecord).createQueryBuilder('m').leftJoin(LadderUser, 'u', 'u.name = m.name')
        .select('m.name', 'name').addSelect('m.wins', 'wins').addSelect('m.losses', 'losses').addSelect('m.duelPoints', 'duelPoints')
        .where('m.monthKey = :month', {month});
      if (includeDisplayName) qb.addSelect('u.displayName', 'displayName');
      if (search) qb.andWhere('LOWER(m.name) LIKE :search', {search: `%${search}%`});
      const order = basis === 'diff' ? '(m.wins - m.losses)' : basis === 'winRate' ? '(1.0 * m.wins / CASE WHEN (m.wins + m.losses) = 0 THEN 1 ELSE (m.wins + m.losses) END)' : 'm.duelPoints';
      total = await qb.getCount();
      rows = (await qb.orderBy(order, 'DESC').addOrderBy('m.name', 'ASC').offset((page - 1) * pageSize).limit(pageSize).getRawMany()).map(row => ({
        name: row.displayName || row.displayname || row.name,
        wins: Number(row.wins), losses: Number(row.losses), duelPoints: Number(row.duelPoints ?? row.duelpoints)
      }));
    }
    return {type, month: type === 'month' ? month : null, rankingBasis: basis, total, ladder: rows.map((row, index) => ({...row, diff: row.wins - row.losses, rank: (page - 1) * pageSize + index + 1}))};
  }

  async function aggregateDeckStats(month) {
    const matrix = {};
    const ensure = (deck, opponent) => matrix[`${deck}::${opponent}`] || (matrix[`${deck}::${opponent}`] = blankStat());
    for (const side of ['A', 'B']) {
      const other = side === 'A' ? 'B' : 'A';
      const player = `m.player${side}Name`;
      const rows = await repo(LadderMatch).createQueryBuilder('m')
        .select(`m.player${side}DeckTypeId`, 'deck').addSelect(`m.player${other}DeckTypeId`, 'opponent')
        .addSelect('COUNT(*)', 'matches')
        .addSelect(`SUM(CASE WHEN m.winnerName = ${player} THEN 1 ELSE 0 END)`, 'wins')
        .addSelect(`SUM(CASE WHEN m.g1FirstPlayer = ${player} THEN 1 ELSE 0 END)`, 'firstMatches')
        .addSelect(`SUM(CASE WHEN m.g1FirstPlayer = ${player} AND m.winnerName = ${player} THEN 1 ELSE 0 END)`, 'firstWins')
        .where('m.monthKey = :month', {month})
        .groupBy(`m.player${side}DeckTypeId`).addGroupBy(`m.player${other}DeckTypeId`).getRawMany();
      for (const row of rows) {
        const item = ensure(row.deck, row.opponent);
        item.matches += Number(row.matches); item.matchWins += Number(row.wins);
        item.firstMatches += Number(row.firstMatches ?? row.firstmatches); item.firstWins += Number(row.firstWins ?? row.firstwins);
        item.secondMatches += Number(row.matches) - Number(row.firstMatches ?? row.firstmatches);
        item.secondWins += Number(row.wins) - Number(row.firstWins ?? row.firstwins);
      }
    }
    const gameQuery = repo(LadderMatchGame).createQueryBuilder('g').innerJoin(LadderMatch, 'm', 'm.id = g.matchId');
    let opponentDeck = 'g.opponentDeckTypeId';
    if (!await hasColumn('ladder_match_game', 'opponentDeckTypeId')) {
      // Historical rows already contain both player perspectives, but lack an
      // explicit opponent deck column. Resolve it from the counterpart row of
      // the same match and duel without modifying historical data.
      gameQuery.innerJoin(LadderMatchGame, 'opponentGame', [
        'opponentGame.matchId = g.matchId',
        'opponentGame.duelCount = g.duelCount',
        'LOWER(opponentGame.playerName) = LOWER(g.opponentName)'
      ].join(' AND '));
      opponentDeck = 'opponentGame.deckTypeId';
    }
    const games = await gameQuery
      .select('g.deckTypeId', 'deck').addSelect(opponentDeck, 'opponent').addSelect('g.isFirst', 'isFirst').addSelect('g.isMain', 'isMain')
      .addSelect('COUNT(*)', 'games').addSelect('SUM(CASE WHEN g.winnerName = g.playerName THEN 1 ELSE 0 END)', 'wins')
      .where('m.monthKey = :month', {month}).groupBy('g.deckTypeId').addGroupBy(opponentDeck).addGroupBy('g.isFirst').addGroupBy('g.isMain').getRawMany();
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
    const month = compactMonth(query.month);
    const cached = cache.get(month);
    if (cached && Date.now() - cached.time < ttl) return cached.value;
    const promise = aggregateDeckStats(month);
    cache.set(month, {time: Date.now(), value: promise});
    try {
      const value = await promise;
      cache.set(month, {time: Date.now(), value});
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

module.exports._test = {compactMonth, blankStat, loadDisplayGroups};
