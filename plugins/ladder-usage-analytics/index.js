'use strict';

const fs = require('fs');
const path = require('path');
const {decodeDeck} = require('../../data-manager/DeckEncoder');
const E = require('./entities');

const LANGUAGES = ['zh', 'ja', 'en', 'ko'];
const METRICS = ['monster', 'spell', 'trap', 'extra', 'side'];
const normalizeName = value => String(value || '').split('$', 1)[0].trim().toLowerCase();
const pad = value => String(value).padStart(2, '0');
const chinaParts = (date = new Date()) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
}).formatToParts(date).filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
const chinaDayKey = date => { const p = chinaParts(date); return `${p.year}${p.month}${p.day}`; };
const compactMonth = value => /^\d{4}(0[1-9]|1[0-2])$/.test(String(value || '')) ? String(value) : chinaDayKey().slice(0, 6);
const chinaMidnight = key => new Date(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T00:00:00+08:00`);
const dateKey = date => `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
const addDaysKey = (key, days) => dateKey(new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)) + days)));

function periodBounds(period, month) {
  const kind = ['today', 'week', 'month', 'all'].includes(period) ? period : 'month';
  if (kind === 'all') return {period: kind, month: null, startDay: null, endDay: null, start: null, end: null};
  const today = chinaDayKey();
  let startDay;
  let endDay;
  if (kind === 'today') {
    startDay = today;
    endDay = addDaysKey(today, 1);
  } else if (kind === 'week') {
    const weekday = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(4, 6)) - 1, Number(today.slice(6, 8)))).getUTCDay() || 7;
    startDay = addDaysKey(today, -(weekday - 1));
    endDay = addDaysKey(startDay, 7);
  } else {
    const selected = compactMonth(month);
    startDay = `${selected}01`;
    const next = new Date(Date.UTC(Number(selected.slice(0, 4)), Number(selected.slice(4, 6)), 1));
    endDay = `${next.getUTCFullYear()}${pad(next.getUTCMonth() + 1)}01`;
  }
  return {period: kind, month: kind === 'month' ? startDay.slice(0, 6) : null, startDay, endDay,
    start: chinaMidnight(startDay), end: chinaMidnight(endDay)};
}

function buildCardFacts(deck, catalog) {
  const source = {
    main: Array.isArray(deck?.main) ? deck.main : [],
    extra: Array.isArray(deck?.extra) ? deck.extra : [],
    side: Array.isArray(deck?.side) ? deck.side : []
  };
  if (!source.main.length && !source.extra.length) return null;
  const allCounts = new Map();
  for (const id of source.main.concat(source.extra, source.side)) {
    const card = catalog.get(id, 'zh');
    if (!card) return null;
    allCounts.set(card.canonicalId, (allCounts.get(card.canonicalId) || 0) + 1);
  }
  if ([...allCounts.values()].some(count => count > 3)) return null;
  const facts = new Map();
  const add = (id, zone) => {
    const card = catalog.get(id, 'zh');
    if (!card || !zone) return;
    const key = `${zone}:${card.canonicalId}`;
    const fact = facts.get(key) || {cardId: card.canonicalId, zone, copies: 0};
    fact.copies++;
    facts.set(key, fact);
  };
  for (const id of source.main) {
    const zone = catalog.classifyZone(id);
    add(id, zone === 'monster' || zone === 'spell' || zone === 'trap' || zone === 'extra' ? zone : null);
  }
  for (const id of source.extra) add(id, 'extra');
  for (const id of source.side) add(id, 'side');
  return [...facts.values()];
}

const blankStat = () => ({
  matches: 0, matchWins: 0, firstMatches: 0, firstWins: 0, secondMatches: 0, secondWins: 0,
  games: 0, gameWins: 0, firstGames: 0, firstGameWins: 0, secondGames: 0, secondGameWins: 0,
  mainGames: 0, mainGameWins: 0, mainFirstGames: 0, mainFirstGameWins: 0, mainSecondGames: 0, mainSecondGameWins: 0,
  sideGames: 0, sideGameWins: 0, sideFirstGames: 0, sideFirstGameWins: 0, sideSecondGames: 0, sideSecondGameWins: 0
});
const addStat = (target, source) => Object.keys(target).forEach(key => { target[key] += Number(source?.[key] || 0); });

const readOptionalJson = filename => {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
};

function createLiveConfig(rootDir, fallback = {}, log = null) {
  const files = ['config.default.json', 'config.json'].map(filename => path.join(rootDir, filename));
  let stamp = null;
  let current = {...fallback};
  return () => {
    try {
      const nextStamp = files.map(filename => {
        try {
          const stat = fs.statSync(filename);
          return `${stat.mtimeMs}:${stat.size}`;
        } catch (error) {
          if (error.code === 'ENOENT') return 'missing';
          throw error;
        }
      }).join('|');
      if (nextStamp !== stamp) {
        current = {...fallback, ...readOptionalJson(files[0]), ...readOptionalJson(files[1])};
        stamp = nextStamp;
      }
    } catch (error) {
      log?.warn?.({err: error}, 'Ladder usage analytics live config reload failed');
    }
    return current;
  };
}

function createService(api) {
  const catalog = api.get('cardCatalog');
  const classifier = api.get('deckClassifier');
  const ladderCore = api.get('ladderCore');
  const {LadderUser, LadderMatch, LadderMatchGame} = ladderCore.entities;
  const repos = name => api.dataManager.getRepository(name);
  const liveConfig = createLiveConfig(api.rootDir, api.config, api.log);
  let projectionQueue = Promise.resolve();
  const detailCache = new Map();

  async function findG1Players(match) {
    if (!match.duelLogId) return [];
    return repos('DuelLogPlayer').createQueryBuilder('p')
      .where('p.duelLogId = :duelLogId', {duelLogId: match.duelLogId}).getMany();
  }

  async function increment(manager, entity, where, changes, create) {
    const driver = api.dataManager.getConnection().options.type;
    if (driver === 'postgres' || driver === 'sqlite' || driver === 'sqljs') {
      const table = entity.options.tableName;
      const values = {...where, ...changes};
      const columns = Object.keys(values), conflict = Object.keys(where), update = Object.keys(changes);
      const quote = value => `"${value}"`;
      const placeholders = columns.map((_, index) => driver === 'postgres' ? `$${index + 1}` : '?');
      const current = driver === 'postgres' ? `${quote(table)}.` : '';
      const sql = `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${placeholders.join(', ')}) ` +
        `ON CONFLICT (${conflict.map(quote).join(', ')}) DO UPDATE SET ${update.map(key => `${quote(key)} = ${current}${quote(key)} + EXCLUDED.${quote(key)}`).join(', ')}`;
      await manager.query(sql, columns.map(key => values[key]));
      return;
    }
    let row = await manager.findOne(entity, {where});
    if (!row) row = manager.create(entity, create);
    for (const [key, amount] of Object.entries(changes)) row[key] = Number(row[key] || 0) + Number(amount || 0);
    return manager.save(entity, row);
  }

  async function incrementCardRows(manager, entity, dayKey, facts) {
    if (!facts?.length) return;
    const driver = api.dataManager.getConnection().options.type;
    if (!['postgres', 'sqlite', 'sqljs'].includes(driver)) {
      for (const fact of facts) {
        const where = dayKey ? {dayKey, zone: fact.zone, cardId: fact.cardId} : {zone: fact.zone, cardId: fact.cardId};
        await increment(manager, entity, where, {deckCount: 1, [`copies${fact.copies}`]: 1}, where);
      }
      return;
    }
    const table = entity.options.tableName, daily = !!dayKey;
    const columns = daily ? ['dayKey', 'zone', 'cardId', 'deckCount', 'copies1', 'copies2', 'copies3'] : ['zone', 'cardId', 'deckCount', 'copies1', 'copies2', 'copies3'];
    const conflict = daily ? ['dayKey', 'zone', 'cardId'] : ['zone', 'cardId'];
    const quote = value => `"${value}"`, params = [], rows = [];
    for (const fact of facts) {
      const values = daily ? [dayKey, fact.zone, fact.cardId, 1, 0, 0, 0] : [fact.zone, fact.cardId, 1, 0, 0, 0];
      values[columns.indexOf(`copies${fact.copies}`)] = 1;
      rows.push(`(${values.map(value => { params.push(value); return driver === 'postgres' ? `$${params.length}` : '?'; }).join(', ')})`);
    }
    const current = driver === 'postgres' ? `${quote(table)}.` : '';
    const update = ['deckCount', 'copies1', 'copies2', 'copies3'];
    const sql = `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES ${rows.join(', ')} ` +
      `ON CONFLICT (${conflict.map(quote).join(', ')}) DO UPDATE SET ${update.map(key => `${quote(key)} = ${current}${quote(key)} + EXCLUDED.${quote(key)}`).join(', ')}`;
    await manager.query(sql, params);
  }

  async function projectOneMatch(matchId) {
    if (!catalog?.metadataAvailable) return {projected: 0, skipped: 'card_catalog_unavailable'};
    const match = await repos(LadderMatch).findOne(Number(matchId));
    if (!match) return {projected: 0};
    const players = await findG1Players(match);
    const groupedPlayers = new Map();
    for (const player of players.filter(item => Number(item.pos) === 0 || Number(item.pos) === 1)) {
      const key = normalizeName(player.realName || player.name), list = groupedPlayers.get(key) || [];
      list.push(player); groupedPlayers.set(key, list);
    }
    const playerMap = new Map([...groupedPlayers].filter(([, list]) => list.length === 1).map(([key, list]) => [key, list[0]]));
    const sides = [
      {name: match.playerAName, deckTypeId: match.playerADeckTypeId},
      {name: match.playerBName, deckTypeId: match.playerBDeckTypeId}
    ];
    const dayKey = chinaDayKey(match.createTime);
    let projected = 0;
    for (const side of sides) {
      const name = normalizeName(side.name);
      if (!name || await repos(E.LadderUsageSample).findOne({where: {matchId: match.id, playerName: name}})) continue;
      const player = playerMap.get(name);
      let facts = null;
      if (player?.startDeckBuffer) {
        try { facts = buildCardFacts(decodeDeck(Buffer.from(player.startDeckBuffer, 'base64')), catalog); }
        catch (error) { facts = null; }
      }
      const status = facts ? 'success' : player?.startDeckBuffer ? 'invalid' : 'missing';
      const reason = status === 'success' ? null : status === 'invalid' ? 'invalid_deck_or_card' : 'missing_g1_deck';
      await api.dataManager.pluginTransaction(async manager => {
        const sample = await manager.save(E.LadderUsageSample, manager.create(E.LadderUsageSample, {
          matchId: match.id, playerName: name, dayKey, monthKey: dayKey.slice(0, 6),
          deckTypeId: Number(side.deckTypeId) || 4095, cardValid: facts ? 1 : 0,
          status, reason, algorithmVersion: String(api.config.algorithmVersion || '1').slice(0, 32),
          catalogVersion: String(catalog.fingerprint || '').slice(0, 280) || null, projectedAt: new Date()
        }));
        if (facts?.length) await manager.save(E.LadderDeckCardFact, facts.map(fact => manager.create(E.LadderDeckCardFact, {...fact, sampleId: sample.id})));
        await increment(manager, E.LadderUsageDailySample, {dayKey}, {allDecks: 1, validCardDecks: facts ? 1 : 0}, {dayKey});
        await increment(manager, E.LadderUsageTotalSample, {id: 1}, {allDecks: 1, validCardDecks: facts ? 1 : 0}, {id: 1});
        await increment(manager, E.LadderUsageDailyDeck, {dayKey, deckTypeId: sample.deckTypeId}, {deckCount: 1}, {dayKey, deckTypeId: sample.deckTypeId});
        await increment(manager, E.LadderUsageTotalDeck, {deckTypeId: sample.deckTypeId}, {deckCount: 1}, {deckTypeId: sample.deckTypeId});
        await incrementCardRows(manager, E.LadderUsageDailyCard, dayKey, facts);
        await incrementCardRows(manager, E.LadderUsageTotalCard, null, facts);
      });
      projected++;
    }
    if (projected) detailCache.clear();
    return {projected};
  }

  function enqueue(matchId) {
    projectionQueue = projectionQueue.then(() => projectOneMatch(matchId)).catch(error => {
      api.log.warn({err: error, matchId}, 'Ladder usage projection failed; run the explicit backfill after applying its migration');
    });
    return projectionQueue;
  }

  const dayFilter = (qb, alias, bounds) => bounds.period === 'all' ? qb : qb.where(`${alias}.dayKey >= :startDay AND ${alias}.dayKey < :endDay`, bounds);
  async function sampleTotals(bounds) {
    if (bounds.period === 'all') {
      const row = await repos(E.LadderUsageTotalSample).findOne(1);
      return {allDecks: Number(row?.allDecks || 0), validCardDecks: Number(row?.validCardDecks || 0)};
    }
    const row = await dayFilter(repos(E.LadderUsageDailySample).createQueryBuilder('s'), 's', bounds)
      .select('COALESCE(SUM(s.allDecks), 0)', 'allDecks').addSelect('COALESCE(SUM(s.validCardDecks), 0)', 'validCardDecks').getRawOne();
    return {allDecks: Number((row?.allDecks ?? row?.alldecks) || 0), validCardDecks: Number((row?.validCardDecks ?? row?.validcarddecks) || 0)};
  }

  async function cardUsage(query) {
    const metric = METRICS.includes(query.metric) ? query.metric : 'monster';
    const bounds = periodBounds(query.period, query.month);
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(api.config.cardPageSize) || 50));
    const limit = Math.min(200, Math.max(1, Number(api.config.cardLimit) || 200));
    let rows;
    if (bounds.period === 'all') {
      rows = await repos(E.LadderUsageTotalCard).createQueryBuilder('c').select('c.cardId', 'cardId')
        .addSelect('c.deckCount', 'deckCount').addSelect('c.copies1', 'copies1').addSelect('c.copies2', 'copies2').addSelect('c.copies3', 'copies3')
        .where('c.zone = :metric', {metric}).orderBy('c.deckCount', 'DESC').addOrderBy('c.cardId', 'ASC').limit(limit).getRawMany();
    } else {
      const qb = repos(E.LadderUsageDailyCard).createQueryBuilder('c').select('c.cardId', 'cardId')
        .addSelect('SUM(c.deckCount)', 'deckCount').addSelect('SUM(c.copies1)', 'copies1').addSelect('SUM(c.copies2)', 'copies2').addSelect('SUM(c.copies3)', 'copies3');
      rows = await dayFilter(qb, 'c', bounds).andWhere('c.zone = :metric', {metric}).groupBy('c.cardId')
        .orderBy('SUM(c.deckCount)', 'DESC').addOrderBy('c.cardId', 'ASC').limit(limit).getRawMany();
    }
    const totals = await sampleTotals(bounds);
    const language = LANGUAGES.includes(query.lang) ? query.lang : 'zh';
    const list = rows.map((row, index) => {
      const cardId = Number(row.cardId ?? row.cardid);
      const card = catalog.get(cardId, language);
      const deckCount = Number((row.deckCount ?? row.deckcount) || 0);
      return {rank: index + 1, cardId, name: card?.name || String(cardId), deckCount,
        usageRate: totals.validCardDecks ? deckCount / totals.validCardDecks : 0,
        copies1: Number(row.copies1 || 0), copies2: Number(row.copies2 || 0), copies3: Number(row.copies3 || 0)};
    });
    const total = list.length;
    return {...bounds, metric, page, pageSize, total, coverage: totals,
      cards: list.slice((page - 1) * pageSize, page * pageSize)};
  }

  async function deckUsage(query) {
    const bounds = periodBounds(query.period, query.month);
    let rows;
    if (bounds.period === 'all') rows = await repos(E.LadderUsageTotalDeck).find();
    else {
      rows = await dayFilter(repos(E.LadderUsageDailyDeck).createQueryBuilder('d'), 'd', bounds)
        .select('d.deckTypeId', 'deckTypeId').addSelect('SUM(d.deckCount)', 'deckCount')
        .groupBy('d.deckTypeId').getRawMany();
    }
    const totals = await sampleTotals(bounds);
    const metadata = new Map(classifier.listDeckMetadata().map(item => [item.id, item]));
    const list = rows.map(row => ({deckTypeId: Number(row.deckTypeId ?? row.decktypeid), count: Number(row.deckCount ?? row.deckcount),
      names: metadata.get(Number(row.deckTypeId ?? row.decktypeid))?.names || {zh: String(row.deckTypeId ?? row.decktypeid)}}));
    list.sort((a, b) => a.deckTypeId === 4095 ? 1 : b.deckTypeId === 4095 ? -1 : b.count - a.count || a.deckTypeId - b.deckTypeId);
    list.forEach((item, index) => { item.rank = index + 1; item.usageRate = totals.allDecks ? item.count / totals.allDecks : 0; });
    return {...bounds, metric: 'deck', total: list.length, coverage: totals, decks: list};
  }

  function searchDecks(query) {
    const q = String(query.q || '').trim().toLowerCase().slice(0, 64);
    if (!q) return [];
    return classifier.searchDeckMetadata(q, 20);
  }

  function listDeckMetadata() {
    return classifier.listDeckMetadata();
  }

  function getDeckMetadata(deckTypeId) {
    const id = Number(deckTypeId);
    return Number.isInteger(id) ? classifier.getDeckMetadata(id) : null;
  }

  async function deckDetailStats(deckTypeId, bounds) {
    const matrix = new Map();
    const ensure = opponent => matrix.get(Number(opponent)) || (matrix.set(Number(opponent), blankStat()), matrix.get(Number(opponent)));
    const validFirst = 'm.g1FirstPlayer IS NOT NULL AND (LOWER(m.g1FirstPlayer) = LOWER(m.playerAName) OR LOWER(m.g1FirstPlayer) = LOWER(m.playerBName))';
    for (const side of ['A', 'B']) {
      const other = side === 'A' ? 'B' : 'A';
      const player = `m.player${side}Name`, opponent = `m.player${other}Name`;
      const won = `LOWER(m.winnerName) = LOWER(${player})`, first = `LOWER(m.g1FirstPlayer) = LOWER(${player})`, second = `LOWER(m.g1FirstPlayer) = LOWER(${opponent})`;
      let qb = repos(LadderMatch).createQueryBuilder('m').select(`m.player${other}DeckTypeId`, 'opponent')
        .addSelect('COUNT(*)', 'matches').addSelect(`SUM(CASE WHEN ${won} THEN 1 ELSE 0 END)`, 'matchWins')
        .addSelect(`SUM(CASE WHEN ${first} THEN 1 ELSE 0 END)`, 'firstMatches').addSelect(`SUM(CASE WHEN ${first} AND ${won} THEN 1 ELSE 0 END)`, 'firstWins')
        .addSelect(`SUM(CASE WHEN ${second} THEN 1 ELSE 0 END)`, 'secondMatches').addSelect(`SUM(CASE WHEN ${second} AND ${won} THEN 1 ELSE 0 END)`, 'secondWins')
        .where(`m.player${side}DeckTypeId = :deckTypeId`, {deckTypeId}).andWhere(validFirst);
      if (bounds.period !== 'all') qb = qb.andWhere('m.createTime >= :start AND m.createTime < :end', bounds);
      for (const row of await qb.groupBy(`m.player${other}DeckTypeId`).getRawMany()) addStat(ensure(row.opponent), row);
    }
    let games = repos(LadderMatchGame).createQueryBuilder('g').innerJoin(LadderMatch, 'm', 'm.id = g.matchId')
      .innerJoin(LadderMatchGame, 'o', 'o.matchId = g.matchId AND o.duelCount = g.duelCount AND LOWER(o.playerName) = LOWER(g.opponentName) AND LOWER(o.opponentName) = LOWER(g.playerName)')
      .select('g.opponentDeckTypeId', 'opponent').addSelect('g.isFirst', 'isFirst').addSelect('g.isMain', 'isMain')
      .addSelect('COUNT(*)', 'games').addSelect('SUM(CASE WHEN LOWER(g.winnerName) = LOWER(g.playerName) THEN 1 ELSE 0 END)', 'gameWins')
      .where('g.deckTypeId = :deckTypeId', {deckTypeId}).andWhere(validFirst)
      .andWhere('g.isFirst IN (0,1) AND o.isFirst IN (0,1) AND (g.isFirst + o.isFirst) = 1');
    if (bounds.period !== 'all') games = games.andWhere('m.createTime >= :start AND m.createTime < :end', bounds);
    const gameRows = await games.groupBy('g.opponentDeckTypeId').addGroupBy('g.isFirst').addGroupBy('g.isMain').getRawMany();
    for (const row of gameRows) {
      const item = ensure(row.opponent), count = Number(row.games), wins = Number(row.gameWins ?? row.gamewins), first = Number(row.isFirst ?? row.isfirst) === 1, main = Number(row.isMain ?? row.ismain) === 1;
      item.games += count; item.gameWins += wins; item[first ? 'firstGames' : 'secondGames'] += count; item[first ? 'firstGameWins' : 'secondGameWins'] += wins;
      const prefix = main ? 'main' : 'side';
      item[`${prefix}Games`] += count; item[`${prefix}GameWins`] += wins;
      item[`${prefix}${first ? 'First' : 'Second'}Games`] += count; item[`${prefix}${first ? 'First' : 'Second'}GameWins`] += wins;
    }
    const overall = blankStat(); for (const item of matrix.values()) addStat(overall, item);
    return {matrix, overall};
  }

  async function deckTopPlayers(deckTypeId, bounds, minMatches) {
    const won = 'LOWER(m.winnerName) = LOWER(s.playerName)';
    const validFirst = 'm.g1FirstPlayer IS NOT NULL AND (LOWER(m.g1FirstPlayer) = LOWER(m.playerAName) OR LOWER(m.g1FirstPlayer) = LOWER(m.playerBName))';
    let qb = repos(E.LadderUsageSample).createQueryBuilder('s')
      .innerJoin(LadderMatch, 'm', 'm.id = s.matchId')
      .leftJoin(LadderUser, 'u', 'u.name = s.playerName')
      .select('s.playerName', 'accountName').addSelect('COALESCE(u.displayName, s.playerName)', 'name')
      .addSelect('COUNT(*)', 'matches').addSelect(`SUM(CASE WHEN ${won} THEN 1 ELSE 0 END)`, 'wins')
      .where('s.deckTypeId = :deckTypeId', {deckTypeId}).andWhere(validFirst);
    if (bounds.period !== 'all') qb = qb.andWhere('s.dayKey >= :startDay AND s.dayKey < :endDay', bounds);
    const rows = await qb.groupBy('s.playerName').addGroupBy('u.displayName')
      .having('COUNT(*) >= :minMatches', {minMatches})
      .orderBy(`1.0 * SUM(CASE WHEN ${won} THEN 1 ELSE 0 END) / COUNT(*)`, 'DESC')
      .addOrderBy('COUNT(*)', 'DESC').addOrderBy('s.playerName', 'ASC').limit(10).getRawMany();
    return rows.map((row, index) => {
      const matches = Number(row.matches || 0), wins = Number(row.wins || 0);
      return {rank: index + 1, accountName: row.accountName ?? row.accountname,
        name: row.name || row.accountName || row.accountname, matches, wins, losses: matches - wins,
        winRate: matches ? wins / matches : 0};
    });
  }

  async function deckDetail(query) {
    const candidates = searchDecks(query);
    let deckTypeId = Number(query.deckTypeId);
    if (!Number.isInteger(deckTypeId) || deckTypeId === 4095) deckTypeId = candidates.length === 1 ? candidates[0].id : null;
    if (!deckTypeId) return {selected: null, candidates, ...periodBounds(query.period, query.month)};
    const metadata = new Map(classifier.listDeckMetadata().map(item => [item.id, item])), selected = metadata.get(deckTypeId);
    if (!selected || deckTypeId === 4095) return {selected: null, candidates, ...periodBounds(query.period, query.month)};
    const bounds = periodBounds(query.period, query.month);
    const currentConfig = liveConfig();
    const minPlayerMatches = Math.min(100000, Math.max(1, Math.trunc(Number(currentConfig.minPlayerMatches) || 25)));
    const cacheKey = `${deckTypeId}:${bounds.period}:${bounds.month || bounds.startDay || 'all'}:${minPlayerMatches}`;
    const cached = detailCache.get(cacheKey), ttl = Math.max(1, Number(currentConfig.cacheTtlSeconds) || 60) * 1000;
    if (cached && Date.now() - cached.time < ttl) return {...cached.value, candidates};
    const [usage, stats, topPlayers] = await Promise.all([
      deckUsage({...query, period: bounds.period, month: bounds.month}),
      deckDetailStats(deckTypeId, bounds),
      deckTopPlayers(deckTypeId, bounds, minPlayerMatches)
    ]);
    const opponents = [...stats.matrix.entries()].map(([id, values]) => ({deckTypeId: id, names: metadata.get(id)?.names || {zh: String(id)}, values}))
      .sort((a, b) => a.deckTypeId === 4095 ? 1 : b.deckTypeId === 4095 ? -1 : b.values.matches - a.values.matches || a.deckTypeId - b.deckTypeId);
    const value = {...bounds, selected: {...selected, templateAvailable: !!classifier?.hasTemplate?.(deckTypeId)}, candidates,
      usage: usage.decks.find(item => item.deckTypeId === deckTypeId) || {count: 0, usageRate: 0},
      overall: stats.overall, opponents, minPlayerMatches, topPlayers};
    if (detailCache.size >= 64) detailCache.delete(detailCache.keys().next().value);
    detailCache.set(cacheKey, {time: Date.now(), value});
    return value;
  }

  return {enqueue, projectOneMatch, cardUsage, deckUsage, deckDetail, deckTopPlayers, searchDecks, listDeckMetadata, getDeckMetadata};
}

module.exports.register = api => Object.values(E).forEach(api.registerEntity);
module.exports.init = api => {
  if (!api.dataManager) return;
  const service = createService(api);
  api.provide('ladderUsageAnalytics', service);
  api.hook('ladder_match_committed', event => event?.matchId ? service.enqueue(event.matchId) : null);
};

module.exports._test = {chinaDayKey, compactMonth, periodBounds, buildCardFacts, createLiveConfig};
