'use strict';

// Keep private aggregates bounded independently of the public matrix cache.
const CACHE_BYTES = 2 * 1024 * 1024;
const CACHE_KEYS = 16;
const TTL = 30000;
const fields = ['matches', 'matchWins', 'firstMatches', 'firstWins', 'secondMatches', 'secondWins',
  'games', 'gameWins', 'firstGames', 'firstGameWins', 'secondGames', 'secondGameWins',
  'mainGames', 'mainGameWins', 'mainFirstGames', 'mainFirstGameWins', 'mainSecondGames', 'mainSecondGameWins',
  'sideGames', 'sideGameWins', 'sideFirstGames', 'sideFirstGameWins', 'sideSecondGames', 'sideSecondGameWins'];
const blank = () => Object.fromEntries(fields.map(key => [key, 0]));
const add = (target, source) => fields.forEach(key => { target[key] += Number(source[key] || 0); });
const fail = (statusCode, code) => Object.assign(new Error(code), {statusCode, code});

function createPlayerDuelStats({dataManager, ladderCore, classifier, monthNow}) {
  const cache = new Map(), pending = new Map();
  let cacheBytes = 0, active = 0, generation = 0;
  const remove = key => {
    const entry = cache.get(key);
    if (entry) cacheBytes -= entry.bytes;
    cache.delete(key);
  };
  // Requests after a commit must not join work that started before it.
  const invalidate = () => { generation++; cache.clear(); cacheBytes = 0; pending.clear(); };

  async function aggregate(player, scope, month) {
    const connection = dataManager.getConnection();
    const postgres = connection.options.type === 'postgres';
    const placeholder = index => postgres ? `$${index}` : '?';
    const start = new Date(`${month.slice(0, 4)}-${month.slice(4)}-01T00:00:00+08:00`);
    const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4)), 1));
    const end = new Date(`${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00+08:00`);
    const dates = [start, end];
    const prepareDate = date => postgres ? date : date.toISOString().replace('T', ' ').replace('Z', '');
    const validFirst = 'm."g1FirstPlayer" IS NOT NULL AND (LOWER(m."g1FirstPlayer") = LOWER(m."playerAName") OR LOWER(m."g1FirstPlayer") = LOWER(m."playerBName"))';
    const matchParams = [];
    const sides = ['A', 'B'].map(side => {
      const other = side === 'A' ? 'B' : 'A';
      const parameter = value => { matchParams.push(value); return placeholder(matchParams.length); };
      let where = `m."player${side}Name" = ${parameter(player)} AND ${validFirst}`;
      if (scope === 'month') where += ` AND m."createTime" >= ${parameter(prepareDate(dates[0]))} AND m."createTime" < ${parameter(prepareDate(dates[1]))}`;
      return `SELECT m."player${side}DeckTypeId" AS deck, m."player${other}DeckTypeId" AS opponent,
        CASE WHEN LOWER(m."winnerName") = LOWER(m."player${side}Name") THEN 1 ELSE 0 END AS won,
        CASE WHEN LOWER(m."g1FirstPlayer") = LOWER(m."player${side}Name") THEN 1 ELSE 0 END AS first
        FROM ladder_match m WHERE ${where}`;
    });
    const matchSql = `WITH v AS (${sides.join(' UNION ALL ')}) SELECT deck, opponent, COUNT(*) AS matches,
      SUM(won) AS wins, SUM(first) AS first_matches, SUM(first * won) AS first_wins,
      SUM(1 - first) AS second_matches, SUM((1 - first) * won) AS second_wins FROM v GROUP BY deck, opponent`;
    const gameParams = [player];
    let gameTime = '';
    if (scope === 'month') {
      gameParams.push(...dates.map(prepareDate));
      gameTime = ` AND m."createTime" >= ${placeholder(2)} AND m."createTime" < ${placeholder(3)}`;
    }
    // Materializing the indexed player subset prevents PostgreSQL from probing
    // every historical Match before applying the player predicate.
    const gameSql = `WITH mine AS ${postgres ? 'MATERIALIZED ' : ''}(SELECT * FROM ladder_match_game WHERE "playerName" = ${placeholder(1)})
      SELECT g."deckTypeId" AS deck, o."deckTypeId" AS opponent, g."isFirst" AS first, g."isMain" AS main,
      COUNT(*) AS games, SUM(CASE WHEN LOWER(g."winnerName") = LOWER(g."playerName") THEN 1 ELSE 0 END) AS wins
      FROM mine g INNER JOIN ladder_match m ON m.id = g."matchId"
      INNER JOIN ladder_match_game o ON o."matchId" = g."matchId" AND o."duelCount" = g."duelCount"
        AND LOWER(o."playerName") = LOWER(g."opponentName") AND LOWER(o."opponentName") = LOWER(g."playerName")
      WHERE ${validFirst} AND g."isFirst" IN (0,1) AND o."isFirst" IN (0,1) AND (g."isFirst" + o."isFirst") = 1${gameTime}
      GROUP BY g."deckTypeId", o."deckTypeId", g."isFirst", g."isMain"`;
    const runner = connection.createQueryRunner();
    let matches, games;
    try {
      await runner.connect();
      if (postgres) {
        await runner.startTransaction('REPEATABLE READ');
        await runner.query('SET TRANSACTION READ ONLY');
        await runner.query("SET LOCAL statement_timeout = '5s'");
        await runner.query("SET LOCAL lock_timeout = '1s'");
        await runner.query('SET LOCAL max_parallel_workers_per_gather = 0');
      }
      matches = await runner.query(matchSql, matchParams);
      games = await runner.query(gameSql, gameParams);
      if (postgres) await runner.commitTransaction();
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally { await runner.release(); }
    const matrix = new Map();
    const ensure = (deck, opponent) => {
      const key = `${Number(deck)}:${Number(opponent)}`;
      if (!matrix.has(key)) matrix.set(key, {deckTypeId: Number(deck), opponentId: Number(opponent), values: blank()});
      return matrix.get(key).values;
    };
    for (const row of matches) Object.assign(ensure(row.deck, row.opponent), {
      matches: Number(row.matches), matchWins: Number(row.wins), firstMatches: Number(row.first_matches),
      firstWins: Number(row.first_wins), secondMatches: Number(row.second_matches), secondWins: Number(row.second_wins)
    });
    for (const row of games) {
      const stat = ensure(row.deck, row.opponent), count = Number(row.games), wins = Number(row.wins);
      const first = Number(row.first) === 1, prefix = Number(row.main) === 1 ? 'main' : 'side';
      stat.games += count; stat.gameWins += wins;
      stat[first ? 'firstGames' : 'secondGames'] += count;
      stat[first ? 'firstGameWins' : 'secondGameWins'] += wins;
      stat[`${prefix}Games`] += count; stat[`${prefix}GameWins`] += wins;
      stat[`${prefix}${first ? 'First' : 'Second'}Games`] += count;
      stat[`${prefix}${first ? 'First' : 'Second'}GameWins`] += wins;
    }
    const names = new Map(classifier.listDeckMetadata().map(item => [Number(item.id), item.names]));
    const metadata = id => names.get(id) || {zh: String(id)};
    const overall = blank(), byDeck = new Map(), byOpponent = new Map();
    for (const row of matrix.values()) {
      if (!byDeck.has(row.deckTypeId)) byDeck.set(row.deckTypeId, {deckTypeId: row.deckTypeId, names: metadata(row.deckTypeId), overall: blank(), opponents: []});
      const deck = byDeck.get(row.deckTypeId);
      deck.opponents.push({deckTypeId: row.opponentId, names: metadata(row.opponentId), values: row.values});
      add(deck.overall, row.values); add(overall, row.values);
      if (!byOpponent.has(row.opponentId)) byOpponent.set(row.opponentId, {deckTypeId: row.opponentId, names: metadata(row.opponentId), values: blank()});
      add(byOpponent.get(row.opponentId).values, row.values);
    }
    const sort = rows => rows.sort((a, b) => a.deckTypeId === 4095 ? 1 : b.deckTypeId === 4095 ? -1 :
      Number((b.values || b.overall).matches) - Number((a.values || a.overall).matches) || a.deckTypeId - b.deckTypeId);
    for (const deck of byDeck.values()) sort(deck.opponents);
    return {available: true, scope, month: scope === 'month' ? month : null, overall,
      decks: sort([...byDeck.values()]), opponents: sort([...byOpponent.values()])};
  }

  async function query(input, password) {
    const player = String(input.player || '').split('$', 1)[0].trim().toLowerCase();
    if (!player || player.length > 64 || !await ladderCore.verifyExisting(player, String(password || ''))) {
      throw fail(403, 'authentication_required');
    }
    const scope = input.scope === 'all' ? 'all' : 'month';
    const requestedMonth = String(input.month || '');
    const month = /^\d{4}(0[1-9]|1[0-2])$/.test(requestedMonth) ? requestedMonth : monthNow();
    const key = `${player}:${scope}:${scope === 'all' ? '' : month}`;
    // Authenticate before looking at either cache or in-flight work.
    for (const [id, entry] of cache) if (Date.now() - entry.time >= TTL) remove(id);
    const hit = cache.get(key);
    if (hit) return JSON.parse(hit.json);
    if (pending.has(key)) return JSON.parse(await pending.get(key));
    if (active >= 2) throw fail(429, 'statistics_busy');
    const version = generation;
    active++;
    const work = aggregate(player, scope, month).then(value => {
      const json = JSON.stringify(value), bytes = Buffer.byteLength(json);
      if (generation === version && bytes <= CACHE_BYTES) {
        while (cache.size && (cache.size >= CACHE_KEYS || cacheBytes + bytes > CACHE_BYTES)) remove(cache.keys().next().value);
        cache.set(key, {json, bytes, time: Date.now()}); cacheBytes += bytes;
      }
      return json;
    });
    pending.set(key, work);
    try { return JSON.parse(await work); }
    finally { if (pending.get(key) === work) pending.delete(key); active--; }
  }
  return {query, invalidate};
}

module.exports = {createPlayerDuelStats};
