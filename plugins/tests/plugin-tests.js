'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const classifier = require('../deck_analysis')._test;
const ladder = require('../ladder-core')._test;
const analytics = require('../ladder-analytics')._test;
const postgresCompat = require('../postgres-compat');
const {LadderMatchGame} = require('../ladder-core/entities');
const migration = require('../ladder-core/migrations/202609-history-repair/migrate');

const parsed = classifier.parseYdk('#main\n1\n1\n#extra\n2\n!side\n3\n');
assert.deepStrictEqual(parsed, {main: [1, 1], extra: [2], side: [3]});
assert.strictEqual(classifier.containsCards([1, 2, 1, 99], parsed.main.concat(parsed.extra)), true);
assert.strictEqual(classifier.containsCards([1, 2, 99], parsed.main.concat(parsed.extra)), false, 'duplicate template cards must be counted');

assert.strictEqual(ladder.normalizeName('  PlayerA '), 'playera');
assert.strictEqual(ladder.calculateDelta(1000, 1000, true, {useDynamic: true, minDelta: 8, maxDelta: 15, kFactor: 20}), 10);
assert.strictEqual(ladder.calculateDelta(1000, 1000, false, {useDynamic: true, minDelta: 8, maxDelta: 15, kFactor: 20}), -10);

const groups = analytics.loadDisplayGroups(path.resolve(__dirname, '../deck_analysis/deck_analysis.json'));
assert.ok(groups.length > 0, 'deck display metadata should be readable even with comment-only lines');

const columns = LadderMatchGame.options.columns;
assert.ok(columns.opponentDeckTypeId);
assert.ok(columns.duelCount && columns.isMain);
assert.strictEqual(columns.gNumber, undefined);
assert.strictEqual(columns.isSide, undefined);
assert.strictEqual(require('../ladder-core/entities').LadderMatch.options.columns.matchKey.nullable, undefined);

assert.strictEqual(migration.parseArgs(['node', 'migrate.js', 'audit']).mode, 'audit');
assert.strictEqual(migration.parseArgs(['node', 'migrate.js', 'simulate', '--use-host-config']).useHostConfig, true);
assert.throws(() => migration.parseArgs(['node', 'migrate.js', 'apply']), /requires/);
assert.strictEqual(migration.loadDisplayOverrides().get('hakushu'), 'hakushu');
assert.ok(migration.createDeckClassifier().templateCount > 0);

const legacyPostgresRuntime = {databaseConfig: {type: 'postgres', database: 'test', username: 'test', port: 5432}};
const legacyPostgresSettings = {modules: {mysql: {enabled: true}}};
postgresCompat.configure({
  config: {enabled: false, synchronize: false},
  runtime: legacyPostgresRuntime,
  settings: legacyPostgresSettings
});
assert.strictEqual(legacyPostgresRuntime.databaseConfig.synchronize, false, 'PostgreSQL startup must not perform implicit DDL');

const mysqlConnection = {type: 'mysql', database: 'test', username: 'test'};
const mysqlRuntime = {databaseConfig: mysqlConnection};
postgresCompat.configure({
  config: {enabled: false, synchronize: false},
  runtime: mysqlRuntime,
  settings: {modules: {mysql: {enabled: true}}}
});
assert.strictEqual(mysqlRuntime.databaseConfig, mysqlConnection, 'disabled PostgreSQL compatibility must not change the original database path');

// CoffeeScript makes functions containing `await` async automatically. Writing
// `async (args) ->` compiles as a call to an undefined variable named `async`.
const compiledServer = fs.readFileSync(path.resolve(__dirname, '../../ygopro-server.js'), 'utf8');
assert.doesNotMatch(compiledServer, /\basync\(async function/, 'compiled server contains an invalid CoffeeScript async wrapper');

console.log('plugin tests passed');
