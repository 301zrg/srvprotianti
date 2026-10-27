'use strict';

const assert = require('assert');
const {chooseG1Reference, buildPlan, parseArgs} = require('./reclassify-database');

assert.deepStrictEqual(chooseG1Reference({matchDuelLogId: '8', g1GameDuelLogIds: ['8']}), {duelLogId: '8'});
assert.deepStrictEqual(chooseG1Reference({matchDuelLogId: null, g1GameDuelLogIds: []}), {reason: 'missing_g1_reference'});
assert.deepStrictEqual(chooseG1Reference({matchDuelLogId: '8', g1GameDuelLogIds: ['9']}), {reason: 'conflicting_g1_references'});
assert.throws(() => parseArgs(['node', 'tool', 'apply']), /APPLY-DECK-RECLASSIFICATION/);

const matches = [
  {id: '1', playerAName: 'Alice', playerBName: 'BOB', playerADeckTypeId: 4095, playerBDeckTypeId: 20,
    matchDuelLogId: '101', g1GameDuelLogIds: ['101']},
  {id: '2', playerAName: 'Carol', playerBName: 'Dave', playerADeckTypeId: 30, playerBDeckTypeId: 40,
    matchDuelLogId: null, g1GameDuelLogIds: []},
  {id: '3', playerAName: 'Eve', playerBName: 'Frank', playerADeckTypeId: 50, playerBDeckTypeId: 60,
    matchDuelLogId: '103', g1GameDuelLogIds: ['104']},
  {id: '4', playerAName: 'Grace', playerBName: 'Heidi', playerADeckTypeId: 70, playerBDeckTypeId: 80,
    matchDuelLogId: '105', g1GameDuelLogIds: ['105']}
];
const games = [
  {matchId: '1', playerName: 'alice', opponentName: 'Bob', deckTypeId: 4095, opponentDeckTypeId: 20},
  {matchId: '1', playerName: 'bob', opponentName: 'ALICE', deckTypeId: 20, opponentDeckTypeId: 4095},
  {matchId: '4', playerName: 'intruder', opponentName: 'heidi', deckTypeId: 70, opponentDeckTypeId: 80}
];
const players = [
  {duelLogId: '101', duelCount: 1, name: 'ALICE', pos: 0, startDeckBuffer: 'deck-a', currentDeckBuffer: null},
  {duelLogId: '101', duelCount: 1, name: 'bob', pos: 1, startDeckBuffer: 'deck-b', currentDeckBuffer: null}
];
const usageSamples = [
  {matchId: '1', playerName: ' Alice ', deckTypeId: 4095},
  {matchId: '1', playerName: 'bob', deckTypeId: 20},
  {matchId: '4', playerName: 'grace', deckTypeId: 70}
];
const plan = buildPlan(matches, games, players, encoded => ({'deck-a': 10, 'deck-b': 20})[encoded], usageSamples);
assert.deepStrictEqual(plan.updates, [{matchId: '1', aType: 10, bType: 20}]);
assert.strictEqual(plan.changedMatches, 1);
assert.strictEqual(plan.changedGameRows, 2);
assert.strictEqual(plan.changedUsageSampleRows, 1);
assert.deepStrictEqual(plan.transitions, [{from: 4095, to: 10, playerSides: 1}]);
assert.deepStrictEqual(plan.skipped, [
  {matchId: '2', reason: 'missing_g1_reference'},
  {matchId: '3', reason: 'conflicting_g1_references'},
  {matchId: '4', reason: 'invalid_game_players'}
]);

console.log('deck database reclassification tests passed');

const test = require('node:test');
const {execute} = require('./reclassify-database');

function executionFixture(failure) {
  const events = [];
  const client = {
    async connect() { events.push('connect'); },
    async end() { events.push('end'); },
    async query(sql) {
      events.push(sql.trim());
      if (sql === 'COMMIT' && failure === 'commit') throw Error('connection ended');
      if (/to_regclass\('public.ladder_match'\)/.test(sql)) return {rows: [{matches: true, games: true, logs: true, players: true}]};
      if (/information_schema.columns/.test(sql)) return {rows: [], rowCount: 8};
      if (/to_regclass\('public.ladder_usage_sample'\)/.test(sql)) return {rows: [{samples: false, daily_decks: false, total_decks: false}]};
      if (/AS match_mismatches/.test(sql)) return {rows: [{match_mismatches: 0, game_mismatches: 0}]};
      return {rows: [], rowCount: 0};
    }
  };
  return {events, options: {mode: 'apply', queryTimeoutMs: 1000, createClient: () => client,
    loadClassifier: () => ({classifier: {templateCount: 0, templateDeckTypeCount: 0, otherDeckTypeId: 4095},
      templateDirectory: __dirname, templateSha256: 'a'.repeat(64)})}};
}

test('execute awaits an asynchronous classifier before opening the database and records its identity', async () => {
  const f = executionFixture(); f.options.mode = 'audit';
  const loaded = f.options.loadClassifier();
  loaded.classification = {algorithmVersion: 'canonical-multiset-v1', catalogFingerprint: 'zh:test', sha256: 'c'.repeat(64)};
  f.options.loadClassifier = async () => { await Promise.resolve(); f.events.push('catalog-ready'); return loaded; };
  const report = await execute(f.options);
  assert.ok(f.events.indexOf('catalog-ready') < f.events.indexOf('connect'));
  assert.deepStrictEqual(report.classification, loaded.classification);
});

test('an unavailable catalog rejects before any database connection', async () => {
  const f = executionFixture();
  const rejected = Promise.reject(Error('Card catalog Chinese metadata is required.')); rejected.catch(() => {});
  f.options.loadClassifier = () => rejected;
  await assert.rejects(execute(f.options), /Card catalog Chinese metadata/);
  assert.deepStrictEqual(f.events, []);
});

test('apply rejects changed classification or template identity on its own execution load before connecting', async () => {
  for (const field of ['expectedClassificationSha256', 'expectedTemplateSha256']) {
    const f = executionFixture(), loaded = f.options.loadClassifier();
    loaded.classification = {sha256: 'b'.repeat(64)};
    f.options.loadClassifier = async () => loaded;
    f.options[field] = 'c'.repeat(64);
    await assert.rejects(execute(f.options), /identity changed before execution/i);
    assert.deepStrictEqual(f.events, []);
  }
});

function classifierFixture(t) {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-loader-'));
  t.after(() => {
    assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('deck-loader-')); fs.rmSync(directory, {recursive: true, force: true});
  });
  fs.mkdirSync(path.join(directory, 'deck_templates'));
  fs.writeFileSync(path.join(directory, 'deck_analysis.json'), '{"archetypes":{"1026":{"code":"TEST","name":{"zh":"测试"}}}}');
  fs.writeFileSync(path.join(directory, 'deck_display.json'), '{"groups":[]}');
  fs.writeFileSync(path.join(directory, 'deck_templates/1026.ydk'), '#main\n97268402\n97268402\n#extra\n52687916\n');
  return {classifierDirectory: directory, catalog: {metadataAvailable: true, fingerprint: 'zh:' + 'a'.repeat(64),
    canonicalize(id) { return ({97268403: 97268402, 52687917: 52687916})[id] || Number(id); }}};
}

test('standalone and legacy-history loaders share canonical classification and an auditable identity', async t => {
  const {loadClassifier} = require('./reclassify-database');
  const options = classifierFixture(t), loaded = await loadClassifier(options);
  assert.strictEqual(loaded.classifier.classify([97268402, 97268403, 52687917]), 1026);
  assert.strictEqual(loaded.classification.algorithmVersion, 'canonical-multiset-v1');
  assert.strictEqual(loaded.classification.catalogFingerprint, options.catalog.fingerprint);
  assert.match(loaded.classification.sha256, /^[a-f0-9]{64}$/);
  const changed = await loadClassifier({...options, catalog: {...options.catalog, fingerprint: 'zh:' + 'b'.repeat(64)}});
  assert.strictEqual(changed.templateSha256, loaded.templateSha256);
  assert.notStrictEqual(changed.classification.sha256, loaded.classification.sha256);
  const legacy = await require('../ladder-core/migrations/202609-history-repair/migrate').createDeckClassifier(options);
  assert.strictEqual(legacy.classify([97268403, 97268403, 52687917]), 1026);
});

test('standalone classifier refuses metadata-free catalog input', async t => {
  const options = classifierFixture(t); options.catalog.metadataAvailable = false;
  await assert.rejects(require('./reclassify-database').loadClassifier(options), /Card catalog.*metadata/i);
});

test('standalone initializes the catalog plugin with its normal logging API', async t => {
  const options = classifierFixture(t), catalog = options.catalog;
  delete options.catalog;
  t.mock.method(require('../card-catalog'), 'init', async api => {
    api.log.info({cards: 3}, 'Card catalog loaded');
    api.provide('cardCatalog', catalog);
  });
  const loaded = await require('./reclassify-database').loadClassifier(options);
  assert.strictEqual(loaded.classifier.classify([97268403, 97268403, 52687917]), 1026);
});

test('template snapshot is taken after asynchronous catalog initialization', async t => {
  const fs = require('node:fs'), path = require('node:path'), tool = require('./reclassify-database');
  const options = classifierFixture(t), catalog = options.catalog;
  const before = tool.loadTemplateIdentity(options.classifierDirectory).templateSha256;
  delete options.catalog;
  t.mock.method(require('../card-catalog'), 'init', async api => {
    await Promise.resolve();
    fs.writeFileSync(path.join(options.classifierDirectory, 'deck_templates/1026.ydk'), '#main\n90\n#extra\n');
    api.provide('cardCatalog', catalog);
  });
  const loaded = await tool.loadClassifier(options);
  assert.notStrictEqual(loaded.templateSha256, before);
  assert.strictEqual(loaded.classifier.classify([90]), 1026);
});

test('classification consumes the exact template bytes included in its reported hash', async t => {
  const fs = require('node:fs'), path = require('node:path');
  const options = classifierFixture(t), target = path.join(options.classifierDirectory, 'deck_templates/1026.ydk');
  const read = fs.readFileSync; let templateReads = 0;
  t.mock.method(fs, 'readFileSync', function(filename, ...args) {
    if (typeof filename === 'string' && path.resolve(filename) === target && ++templateReads > 1) {
      const changed = '#main\n90\n#extra\n'; return args[0] === 'utf8' ? changed : Buffer.from(changed);
    }
    return read.call(this, filename, ...args);
  });
  const loaded = await require('./reclassify-database').loadClassifier(options);
  assert.strictEqual(templateReads, 1);
  assert.strictEqual(loaded.classifier.classify([97268403, 97268403, 52687917]), 1026);
  assert.strictEqual(loaded.classifier.classify([90]), 4095);
});

test('execute captures post-state before COMMIT and tags postcommit report failure as committed', async () => {
  const f = executionFixture(); f.options.report = __dirname; // Writing a report to a directory fails after COMMIT.
  f.options.beforeCommit = async () => { f.events.push('snapshot-durable'); };
  await assert.rejects(execute(f.options), error => error.commitState === 'committed');
  assert.ok(f.events.indexOf('snapshot-durable') < f.events.indexOf('COMMIT'));
  assert.strictEqual(f.events.at(-1), 'end');
});

test('execute distinguishes a rolled back precommit failure from an uncertain COMMIT', async () => {
  const before = executionFixture(); before.options.beforeCommit = async () => { throw Error('backup disk failed'); };
  await assert.rejects(execute(before.options), error => error.commitState === 'not_committed');
  assert.ok(before.events.includes('ROLLBACK')); assert.ok(!before.events.includes('COMMIT'));
  const uncertain = executionFixture('commit');
  await assert.rejects(execute(uncertain.options), error => error.commitState === 'unknown');
  assert.strictEqual(uncertain.events.at(-1), 'end');
});

test('beforeApply checks original state after write locks and before any plan writes', async () => {
  const f = executionFixture();
  f.options.beforeApply = async () => { f.events.push('original-state-check'); throw Error('external classification changed'); };
  await assert.rejects(execute(f.options), error => error.commitState === 'not_committed');
  const lock = f.events.findIndex(sql => sql.startsWith('LOCK TABLE ladder_match,'));
  assert.ok(lock >= 0 && lock < f.events.indexOf('original-state-check'));
  assert.ok(!f.events.some(sql => sql.startsWith('CREATE TEMP')));
});

test('an exclusive report never overwrites a prior uncertain report', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-report-test-'));
  const filename = path.join(directory, 'report.json'); fs.writeFileSync(filename, 'keep');
  try {
    const f = executionFixture(); f.options.report = filename; f.options.reportExclusive = true;
    await assert.rejects(execute(f.options), error => error.commitState === 'committed');
    assert.strictEqual(fs.readFileSync(filename, 'utf8'), 'keep');
  } finally {
    assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('deck-report-test-')); fs.rmSync(directory, {recursive: true, force: true});
  }
});

async function whitespaceSqlFixture() {
  const SQL = await require('sql.js')();
  const database = new SQL.Database();
  database.run(`
    CREATE TABLE ladder_match (id INTEGER PRIMARY KEY, "playerAName" TEXT, "playerBName" TEXT,
      "playerADeckTypeId" INTEGER, "playerBDeckTypeId" INTEGER);
    CREATE TABLE ladder_match_game (id INTEGER PRIMARY KEY, "matchId" INTEGER, "playerName" TEXT,
      "opponentName" TEXT, "deckTypeId" INTEGER, "opponentDeckTypeId" INTEGER);
    CREATE TABLE deck_reclass_plan (match_id INTEGER PRIMARY KEY, a_type INTEGER, b_type INTEGER);
    INSERT INTO ladder_match VALUES (1, ' Alpha ', ' BETA ', 4095, 4095);
    INSERT INTO ladder_match_game VALUES (1, 1, 'alpha', ' beta ', 4095, 4095),
      (2, 1, 'beta', ' ALPHA', 4095, 4095);
  `);
  const client = {async query(sql) {
    // Execute production statements unchanged except PostgreSQL-specific spellings.
    const result = database.exec(sql.replace(/::int\b/g, '').replace(/\bBTRIM\(/g, 'TRIM(')
      .replace(/^(\s*UPDATE\s+\w+)\s+(\w+)\s+SET\b/, '$1 AS $2 SET'));
    const first = result[0];
    return {rows: first ? first.values.map(values => Object.fromEntries(first.columns.map((key, index) => [key, values[index]]))) : [],
      rowCount: database.getRowsModified()};
  }};
  const source = [
    {id: '1', playerAName: ' Alpha ', playerBName: ' BETA ', playerADeckTypeId: 4095, playerBDeckTypeId: 4095,
      matchDuelLogId: '101', g1GameDuelLogIds: ['101']}
  ];
  const gameRows = (await client.query('SELECT * FROM ladder_match_game')).rows;
  const g1 = [
    {duelLogId: '101', duelCount: 1, name: ' ALPHA ', pos: 0, startDeckBuffer: 'g1-a'},
    {duelLogId: '101', duelCount: 1, name: 'beta', pos: 1, startDeckBuffer: 'g1-b'}
  ];
  const plan = buildPlan(source, gameRows, g1, encoded => ({'g1-a': 10, 'g1-b': 20})[encoded]);
  assert.deepStrictEqual(plan.updates, [{matchId: '1', aType: 10, bType: 20}]);
  for (const update of plan.updates) database.run('INSERT INTO deck_reclass_plan VALUES (?, ?, ?)', [Number(update.matchId), update.aType, update.bType]);
  return {database, client, plan};
}

test('game SQL applies the G1 planner classifications when names differ by outer spaces and case', async () => {
  const {applyPlan, verifyPlan} = require('./reclassify-database');
  const f = await whitespaceSqlFixture();
  try {
    const written = await applyPlan(f.client, {usageProjections: false});
    assert.strictEqual(written.updatedMatches, f.plan.changedMatches);
    assert.strictEqual(written.updatedGameRows, f.plan.changedGameRows);
    const games = (await f.client.query('SELECT id, "deckTypeId", "opponentDeckTypeId" FROM ladder_match_game ORDER BY id')).rows;
    assert.deepStrictEqual(games, [
      {id: 1, deckTypeId: 10, opponentDeckTypeId: 20},
      {id: 2, deckTypeId: 20, opponentDeckTypeId: 10}
    ]);
    assert.deepStrictEqual(await verifyPlan(f.client, {usageProjections: false}), {matchMismatches: 0, gameMismatches: 0});
  } finally { f.database.close(); }
});

test('game SQL verification rejects all-B classifications that the untrimmed CASE previously accepted', async () => {
  const {verifyPlan} = require('./reclassify-database');
  const f = await whitespaceSqlFixture();
  try {
    f.database.run('UPDATE ladder_match SET "playerADeckTypeId" = 10, "playerBDeckTypeId" = 20');
    f.database.run('UPDATE ladder_match_game SET "deckTypeId" = 20, "opponentDeckTypeId" = 20');
    await assert.rejects(verifyPlan(f.client, {usageProjections: false}), /"match_mismatches":0,"game_mismatches":2/);
  } finally { f.database.close(); }
});
