'use strict';

const assert = require('assert');
const {test} = require('node:test');
const {createPlayerDuelStats} = require('./player-duel-stats');

function fixture() {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const calls = {auth: 0, connections: 0, released: 0, statements: []};
  const service = createPlayerDuelStats({
    monthNow: () => '202610',
    classifier: {listDeckMetadata: () => [{id: 1, names: {zh: '测试'}}]},
    ladderCore: {async verifyExisting(player, password) { calls.auth++; return password === 'correct'; }},
    dataManager: {getConnection: () => ({options: {type: 'postgres'}, createQueryRunner() {
      calls.connections++;
      return {
        isTransactionActive: false,
        async connect() {},
        async startTransaction(level) { assert.strictEqual(level, 'REPEATABLE READ'); this.isTransactionActive = true; },
        async query(sql) {
          calls.statements.push(sql);
          if (sql.startsWith('WITH v')) {
            await barrier;
            return [{deck: 1, opponent: 1, matches: 1, wins: 1, first_matches: 1, first_wins: 1, second_matches: 0, second_wins: 0}];
          }
          return [];
        },
        async commitTransaction() { this.isTransactionActive = false; },
        async rollbackTransaction() { this.isTransactionActive = false; },
        async release() { calls.released++; }
      };
    }})}
  });
  return {service, calls, release};
}

test('private statistics authenticate cached and coalesced reads and bound distinct concurrent queries', async () => {
  const {service, calls, release} = fixture();
  const first = service.query({player: 'a', scope: 'all'}, 'correct');
  const same = service.query({player: 'a', scope: 'all'}, 'correct');
  const second = service.query({player: 'b', scope: 'all'}, 'correct');
  await assert.rejects(service.query({player: 'a', scope: 'all'}, 'wrong'), error => error.statusCode === 403);
  await assert.rejects(service.query({player: 'c', scope: 'all'}, 'correct'), error => error.statusCode === 429);
  assert.strictEqual(calls.connections, 2, 'same-key requests must share one SQL aggregation');
  release();
  const [a, duplicate] = await Promise.all([first, same, second]);
  assert.deepStrictEqual(a, duplicate);
  duplicate.overall.matches = 999;
  await assert.rejects(service.query({player: 'a', scope: 'all'}, 'wrong'), error => error.statusCode === 403);
  const cached = await service.query({player: 'a', scope: 'all'}, 'correct');
  assert.strictEqual(cached.overall.matches, 1, 'callers cannot mutate cached results');
  assert.strictEqual(calls.connections, 2);
  assert.strictEqual(calls.auth, 7, 'every request must verify the password');
  assert.strictEqual(calls.released, 2);
  assert.ok(calls.statements.includes('SET TRANSACTION READ ONLY'));
  assert.ok(calls.statements.includes("SET LOCAL statement_timeout = '5s'"));
  assert.ok(calls.statements.includes('SET LOCAL max_parallel_workers_per_gather = 0'));
  service.invalidate();
  await service.query({player: 'a', scope: 'all'}, 'correct');
  assert.strictEqual(calls.connections, 3, 'committed matches invalidate private aggregates');
  const numericMonth = await service.query({player: 'a', month: 202610}, 'correct');
  assert.strictEqual(numericMonth.month, '202610', 'accepted numeric month input must normalize before date arithmetic');
});

test('real SQL includes Other in own-deck, opponent and all-deck totals for month and all time', async () => {
  const SQL = await require('sql.js')();
  const db = new SQL.Database();
  db.run(`CREATE TABLE ladder_match (id INTEGER, playerAName TEXT, playerBName TEXT,
    playerADeckTypeId INTEGER, playerBDeckTypeId INTEGER, winnerName TEXT, g1FirstPlayer TEXT, createTime TEXT);
    CREATE TABLE ladder_match_game (matchId INTEGER, duelCount INTEGER, playerName TEXT, opponentName TEXT,
    deckTypeId INTEGER, isFirst INTEGER, isMain INTEGER, winnerName TEXT);`);
  const fixtures = [
    [1, 4095, 100, true, false, '2026-09-30 16:00:00.000'],
    [2, 4095, 4095, false, true, '2026-10-12 12:00:00.000'],
    [3, 100, 4095, true, true, '2026-10-13 12:00:00.000'],
    [4, 4095, 100, false, false, '2026-09-30 15:59:59.000']
  ];
  for (const [id, deck, opponent, won, reverse, date] of fixtures) {
    const players = reverse ? ['rival', 'me'] : ['me', 'rival'];
    const decks = reverse ? [opponent, deck] : [deck, opponent];
    db.run('INSERT INTO ladder_match VALUES (?,?,?,?,?,?,?,?)',
      [id, ...players, ...decks, won ? 'me' : 'rival', reverse ? 'rival' : 'me', date]);
    for (let game = 1; game <= 3; game++) {
      const winner = (game === 2 ? !won : won) ? 'me' : 'rival';
      const first = game % 2;
      db.run('INSERT INTO ladder_match_game VALUES (?,?,?,?,?,?,?,?)', [id, game, 'me', 'rival', deck, first, game === 1 ? 1 : 0, winner]);
      db.run('INSERT INTO ladder_match_game VALUES (?,?,?,?,?,?,?,?)', [id, game, 'rival', 'me', opponent, 1 - first, game === 1 ? 1 : 0, winner]);
    }
  }
  const service = createPlayerDuelStats({
    monthNow: () => '202610',
    classifier: {listDeckMetadata: () => [{id: 100, names: {zh: 'A'}}, {id: 4095, names: {zh: '其他'}}]},
    ladderCore: {verifyExisting: async (player, password) => player === 'me' && password === 'correct'},
    dataManager: {getConnection: () => ({options: {type: 'sqljs'}, createQueryRunner: () => ({
      async connect() {}, async release() {},
      async query(sql, params) {
        const statement = db.prepare(sql);
        try {
          statement.bind(params);
          const rows = [];
          while (statement.step()) rows.push(statement.getAsObject());
          return rows;
        } finally { statement.free(); }
      }
    })})}
  });
  try {
    for (const scope of ['month', 'all']) {
      const stats = await service.query({player: 'me', scope, month: '202610'}, 'correct');
      const other = stats.decks.find(deck => deck.deckTypeId === 4095);
      const monthly = scope === 'month';
      assert.strictEqual(other.names.zh, '其他');
      assert.strictEqual(other.overall.matches, monthly ? 2 : 3);
      assert.strictEqual(other.overall.matchWins, 1);
      assert.strictEqual(other.overall.games, monthly ? 6 : 9);
      assert.strictEqual(other.overall.gameWins, monthly ? 3 : 4);
      assert.strictEqual(stats.overall.matches, monthly ? 3 : 4);
      assert.strictEqual(stats.overall.matchWins, 2);
      assert.strictEqual(stats.overall.games, monthly ? 9 : 12);
      assert.strictEqual(stats.overall.gameWins, monthly ? 5 : 6);
      assert.strictEqual(stats.opponents.find(deck => deck.deckTypeId === 4095).values.matches, 2);
      assert.strictEqual(other.opponents.find(deck => deck.deckTypeId === 4095).values.matches, 1);
      for (const key of Object.keys(stats.overall)) {
        assert.strictEqual(stats.overall[key], stats.decks.reduce((sum, deck) => sum + deck.overall[key], 0), `all own decks must include Other: ${scope}/${key}`);
        assert.strictEqual(stats.overall[key], stats.opponents.reduce((sum, deck) => sum + deck.values[key], 0), `all opponents must include Other: ${scope}/${key}`);
        assert.strictEqual(other.overall[key], other.opponents.reduce((sum, deck) => sum + deck.values[key], 0), `Other breakdown must sum: ${scope}/${key}`);
      }
    }
  } finally { db.close(); }
});
