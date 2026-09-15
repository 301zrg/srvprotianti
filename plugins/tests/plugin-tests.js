'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const classifier = require('../deck_analysis')._test;
const ladder = require('../ladder-core')._test;
const analytics = require('../ladder-analytics')._test;
const ladderWeb = require('../ladder-web')._test;
const usage = require('../ladder-usage-analytics')._test;
const cardCatalog = require('../card-catalog')._test;
const usageBackfill = require('../ladder-usage-analytics/backfill');
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

const groups = analytics.loadDisplayGroups(
  path.resolve(__dirname, '../deck_analysis/deck_analysis.json'),
  path.resolve(__dirname, '../deck_analysis/deck_display.json')
);
assert.ok(groups.length > 0, 'deck display metadata should be readable even with comment-only lines');
const deckNames = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../deck_analysis/deck_analysis.json'), 'utf8')).archetypes;
for (const [id, english] of Object.entries({
  514: 'Dino Rabbit', 579: 'Alive Hero', 581: 'Breaker Hero',
  770: 'Asceticism Six Samurai', 771: 'Non-Asceticism Six Samurai',
  1026: 'Plant Synchro', 1027: 'Quickdraw Junk Doppel', 1794: 'FTK Dark World',
  2306: 'Blackwing', 2307: 'Vayu', 2562: 'Frog Monarch',
  3074: 'Gravekeeper', 4866: 'Lightsworn'
})) assert.strictEqual(deckNames[id].name.en, english, `deck type ${id} must use the agreed English name`);

const liveDisplayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-live-display-'));
const liveDisplayFile = path.join(liveDisplayRoot, 'deck_display.json');
fs.writeFileSync(liveDisplayFile, JSON.stringify({groups: [{id: 'explicit', name: {zh: '测试'}, archetypeIds: [1026, 999999]}]}));
let liveGroups = analytics.loadDisplayGroups(path.resolve(__dirname, '../deck_analysis/deck_analysis.json'), liveDisplayFile);
assert.deepStrictEqual(liveGroups[0].members, [1026], 'explicit display members must ignore unknown deck type IDs');
fs.writeFileSync(liveDisplayFile, JSON.stringify({groups: [{id: 'explicit', name: {zh: '测试'}, archetypeIds: [1538]}]}));
liveGroups = analytics.loadDisplayGroups(path.resolve(__dirname, '../deck_analysis/deck_analysis.json'), liveDisplayFile);
assert.deepStrictEqual(liveGroups[0].members, [1538], 'display config edits must be visible without recreating the service');
fs.rmSync(liveDisplayRoot, {recursive: true, force: true});

const liveConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-live-config-'));
fs.writeFileSync(path.join(liveConfigRoot, 'config.default.json'), JSON.stringify({rankingBasis: 'points'}));
fs.writeFileSync(path.join(liveConfigRoot, 'config.json'), JSON.stringify({rankingBasis: 'diff'}));
assert.strictEqual(analytics.loadPluginConfig(liveConfigRoot).rankingBasis, 'diff');
fs.writeFileSync(path.join(liveConfigRoot, 'config.json'), JSON.stringify({rankingBasis: 'winRate'}));
assert.strictEqual(analytics.loadPluginConfig(liveConfigRoot).rankingBasis, 'winRate', 'runtime config edits must be visible without recreating the service');
fs.writeFileSync(path.join(liveConfigRoot, 'config.json'), JSON.stringify({rankingBasis: 'wins'}));
assert.strictEqual(analytics.loadPluginConfig(liveConfigRoot).rankingBasis, 'wins');
assert.strictEqual(cardCatalog.classifyZone(0x1), 'monster');
assert.strictEqual(cardCatalog.classifyZone(0x1 | 0x40), 'extra');
const fakeCards = new Map([[1, {canonicalId: 1, zone: 'monster'}], [2, {canonicalId: 1, zone: 'monster'}], [3, {canonicalId: 3, zone: 'spell'}]]);
const fakeCatalog = {get(id) { return fakeCards.get(id) || null; }, classifyZone(id) { return fakeCards.get(id)?.zone || null; }};
assert.deepStrictEqual(usage.buildCardFacts({main: [1, 2, 3], extra: [], side: []}, fakeCatalog), [
  {cardId: 1, zone: 'monster', copies: 2}, {cardId: 3, zone: 'spell', copies: 1}
]);
assert.strictEqual(usage.buildCardFacts({main: [1, 1, 1, 2], extra: [], side: []}, fakeCatalog), null, 'more than three canonical copies invalidates a snapshot');
assert.strictEqual(usageBackfill.parseArgs(['node', 'backfill', 'audit', '--use-host-config']).mode, 'audit');
fs.rmSync(liveConfigRoot, {recursive: true, force: true});

const exampleDecks = ladderWeb.loadExampleDecks(path.resolve(__dirname, '../ladder-web/example-decks.json'));
assert.strictEqual(exampleDecks.groups.length, 4);
assert.strictEqual(exampleDecks.groups.reduce((count, group) => count + group.decks.length, 0), 24);
assert.ok(exampleDecks.groups.flatMap(group => group.decks).some(deck => deck.name.en.includes('Quickdraw Junk Doppel')));

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
