'use strict';

const assert = require('assert');
const path = require('path');
const {test} = require('node:test');
const {createService} = require('./index')._test;

function createMockService(probeColumn) {
  const calls = {created: 0, connected: 0, released: 0, probed: []};
  const selectedColumns = [];
  const makeQueryBuilder = () => {
    const qb = {
      select() { return qb; },
      addSelect(expr) { selectedColumns.push(expr); return qb; },
      leftJoin() { return qb; },
      where() { return qb; },
      orderBy() { return qb; },
      addOrderBy() { return qb; },
      async getRawMany() {
        return [{name: 'alice', displayName: 'Alice', wins: 3, losses: 1, duelPoints: 1020}];
      }
    };
    return qb;
  };
  const services = {
    ladderCore: {entities: {
      LadderUser: 'LadderUser',
      LadderMonthRecord: 'LadderMonthRecord',
      LadderMatch: 'LadderMatch',
      LadderMatchGame: 'LadderMatchGame'
    }},
    deckClassifier: {},
    cardCatalog: {}
  };
  const service = createService({
    config: {},
    rootDir: path.join(__dirname, '__nonexistent_config_dir__'),
    log: {warn() {}},
    get: name => services[name],
    dataManager: {
      getRepository: () => ({createQueryBuilder: makeQueryBuilder}),
      getConnection: () => ({
        createQueryRunner() {
          calls.created++;
          return {
            async connect() { calls.connected++; },
            async hasColumn(table, column) {
              calls.probed.push(`${table}.${column}`);
              return probeColumn(table, column, calls.probed.length);
            },
            async release() { calls.released++; }
          };
        }
      })
    }
  });
  return {service, calls, selectedColumns};
}

test('hasColumn caches positive and negative probes per table and column', async () => {
  const present = createMockService(async () => true);
  const first = await present.service.ranking({});
  const second = await present.service.ranking({});
  assert.strictEqual(first.ladder[0].name, 'Alice');
  assert.strictEqual(second.ladder[0].name, 'Alice');
  assert.strictEqual(present.calls.created, 1, 'same table/column should only create one query runner');
  assert.strictEqual(present.calls.connected, 1);
  assert.strictEqual(present.calls.released, 1);
  assert.deepStrictEqual(present.calls.probed, ['ladder_user.displayName']);

  const missing = createMockService(async () => false);
  await missing.service.ranking({});
  await missing.service.ranking({});
  assert.strictEqual(missing.calls.created, 1, 'false column probe results should also be cached');
  assert.ok(!missing.selectedColumns.includes('u.displayName'));
});

test('hasColumn coalesces concurrent probes for the same table and column', async () => {
  let releaseProbe;
  const gate = new Promise(resolve => { releaseProbe = resolve; });
  const {service, calls} = createMockService(async () => {
    await gate;
    return true;
  });
  const pending = Promise.all([service.ranking({}), service.ranking({})]);
  releaseProbe();
  const [first, second] = await pending;
  assert.strictEqual(first.ladder[0].name, 'Alice');
  assert.strictEqual(second.ladder[0].name, 'Alice');
  assert.strictEqual(calls.created, 1, 'concurrent callers must share one in-flight column probe');
  assert.strictEqual(calls.released, 1);
});

test('hasColumn does not cache failed probes and retries on the next call', async () => {
  const {service, calls} = createMockService(async (_table, _column, attempt) => {
    if (attempt === 1) throw new Error('temporary database error');
    return true;
  });
  await assert.rejects(() => service.ranking({}), /temporary database error/);
  assert.strictEqual(calls.created, 1);
  assert.strictEqual(calls.released, 1, 'failed probes must still release the query runner');

  const recovered = await service.ranking({});
  assert.strictEqual(recovered.ladder[0].name, 'Alice');
  assert.strictEqual(calls.created, 2, 'next call after failure must probe again');
  assert.strictEqual(calls.released, 2);

  await service.ranking({});
  assert.strictEqual(calls.created, 2, 'successful retry should be cached for subsequent calls');
});
