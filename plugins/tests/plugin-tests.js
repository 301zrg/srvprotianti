'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const deckClassifierPlugin = require('../deck_analysis');
const classifier = deckClassifierPlugin._test;
const ladder = require('../ladder-core')._test;
const analytics = require('../ladder-analytics')._test;
const ladderWeb = require('../ladder-web')._test;
const usage = require('../ladder-usage-analytics')._test;
const usageEntities = require('../ladder-usage-analytics/entities');
const cardCatalog = require('../card-catalog')._test;
const usageBackfill = require('../ladder-usage-analytics/backfill');
const postgresCompat = require('../postgres-compat');
const {LadderMatchGame} = require('../ladder-core/entities');
const migration = require('../ladder-core/migrations/202609-history-repair/migrate');

const parsed = classifier.parseYdk('#main\n1\n1\n#extra\n2\n!side\n3\n');
assert.deepStrictEqual(parsed, {main: [1, 1], extra: [2], side: [3]});
assert.strictEqual(classifier.containsCards([1, 2, 1, 99], parsed.main.concat(parsed.extra)), true);
assert.strictEqual(classifier.containsCards([1, 2, 99], parsed.main.concat(parsed.extra)), false, 'duplicate template cards must be counted');
assert.deepStrictEqual(classifier.parseTemplateFilename('1027.ydk'), {id: 1027, variant: null});
assert.deepStrictEqual(classifier.parseTemplateFilename('1027-1.YDK'), {id: 1027, variant: 1});
assert.deepStrictEqual(classifier.parseTemplateFilename('1027_2.ydk'), {id: 1027, variant: 2});
assert.strictEqual(classifier.parseTemplateFilename('1027-copy.ydk'), null);

const multiTemplateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-multi-template-'));
fs.mkdirSync(path.join(multiTemplateRoot, 'deck_templates'));
fs.writeFileSync(path.join(multiTemplateRoot, 'deck_analysis.json'), JSON.stringify({archetypes: {
  100: {code: 'MULTI', name: {zh: '多模板'}}, 200: {code: 'VARIANT_ONLY', name: {zh: '仅变体'}}
}}));
fs.writeFileSync(path.join(multiTemplateRoot, 'deck_display.json'), JSON.stringify({groups: []}));
fs.writeFileSync(path.join(multiTemplateRoot, 'deck_templates', '100.ydk'), '#main\n1\n#extra\n');
fs.writeFileSync(path.join(multiTemplateRoot, 'deck_templates', '100-1.ydk'), '#main\n2\n#extra\n3\n');
fs.writeFileSync(path.join(multiTemplateRoot, 'deck_templates', '100_2.ydk'), '#main\n4\n#extra\n');
fs.writeFileSync(path.join(multiTemplateRoot, 'deck_templates', '200-1.ydk'), '#main\n9\n9\n#extra\n');
fs.writeFileSync(path.join(multiTemplateRoot, 'deck_templates', 'ignored-copy.ydk'), '#main\n8\n#extra\n');
const multiTemplateClassifier = deckClassifierPlugin.createClassifier({rootDir: multiTemplateRoot, config: {}}, Number);
assert.strictEqual(multiTemplateClassifier.classify([2, 3, 99]), 100, 'hyphen variants must map to their numeric deck type');
assert.strictEqual(multiTemplateClassifier.classify([4]), 100, 'underscore variants must map to their numeric deck type');
assert.strictEqual(multiTemplateClassifier.classify([9]), 4095, 'variant templates must retain duplicate-card requirements');
assert.strictEqual(multiTemplateClassifier.classify([9, 9]), 200);
assert.strictEqual(multiTemplateClassifier.templateCount, 4);
assert.strictEqual(multiTemplateClassifier.templateDeckTypeCount, 2);
assert.deepStrictEqual(multiTemplateClassifier.listTemplates(100), ['100.ydk', '100-1.ydk', '100_2.ydk']);
assert.strictEqual(multiTemplateClassifier.getTemplate(100).filename, '100.ydk', 'the base template is the canonical download');
assert.strictEqual(multiTemplateClassifier.getTemplate(100, '100-1.ydk').filename, '100-1.ydk');
assert.strictEqual(multiTemplateClassifier.getTemplate(100, '200-1.ydk'), null, 'a template from another deck type must be rejected');
assert.strictEqual(multiTemplateClassifier.getTemplate(100, '../100.ydk'), null, 'template downloads must not accept paths');
assert.strictEqual(multiTemplateClassifier.getTemplate(200).filename, '200-1.ydk', 'a variant is downloadable when no base template exists');
fs.rmSync(multiTemplateRoot, {recursive: true, force: true});

assert.strictEqual(ladder.normalizeName('  PlayerA '), 'playera');
assert.strictEqual(ladder.calculateDelta(1000, 1000, true, {useDynamic: true, minDelta: 8, maxDelta: 15, kFactor: 20}), 10);
assert.strictEqual(ladder.calculateDelta(1000, 1000, false, {useDynamic: true, minDelta: 8, maxDelta: 15, kFactor: 20}), -10);

const defaultRating = ladder.normalizeRating();
assert.deepStrictEqual(defaultRating, require('../ladder-core/config.default.json').rating,
  'missing rating settings must use the same defaults as config.default.json');
assert.strictEqual(defaultRating.totalWeight, 0.6);
assert.strictEqual(defaultRating.monthWeight, 0.4);
assert.strictEqual(ladder.normalizeRating({monthWeight: 0}).totalWeight, 1,
  'zero month weight must restore total-only scoring even when totalWeight is omitted');
assert.strictEqual(ladder.normalizeRating({totalWeight: 0}).monthWeight, 1);
assert.strictEqual(ladder.normalizeRating({totalWeight: 0.3, monthWeight: 0.2}).totalWeight, 0.6);
for (const invalid of [
  null, [], {totalWeight: -0.1}, {monthWeight: 1.1}, {monthWeight: NaN},
  {totalWeight: Infinity}, {monthWeight: '0.4'}, {monthWeight: null},
  {totalWeight: 0, monthWeight: 0}, {minDelta: 16, maxDelta: 15},
  {minDelta: -1}, {maxDelta: 1.5}, {fixedDelta: NaN}, {kFactor: 0},
  {initialPoints: 0}, {useDynamic: 'false'}
]) assert.throws(() => ladder.normalizeRating(invalid), TypeError);
assert.strictEqual(ladder.calculateDelta(3000, 1000, true, defaultRating), 8);
assert.strictEqual(ladder.calculateDelta(1000, 3000, true, defaultRating), 15);
assert.strictEqual(ladder.calculateDelta(3000, 1000, false, defaultRating), -15);
assert.strictEqual(ladder.calculateDelta(1000, 3000, false, defaultRating), -8);
assert.strictEqual(ladder.calculateDelta(1000, 3000, true, {...defaultRating, useDynamic: false}), 12);

const liveRatingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-live-rating-'));
try {
  const liveRatingFile = path.join(liveRatingRoot, 'config.json');
  const ratingWarnings = [];
  const readRating = ladder.createLiveRatingConfig(liveRatingRoot, {totalWeight: 0.8, monthWeight: 0.2}, {
    warn(...args) { ratingWarnings.push(args); }
  });
  assert.strictEqual(readRating().monthWeight, 0.4, 'missing files must restore built-in defaults, not stale startup overrides');
  fs.writeFileSync(path.join(liveRatingRoot, 'config.default.json'), JSON.stringify({rating: {totalWeight: 0.7, monthWeight: 0.3}}));
  assert.strictEqual(readRating().monthWeight, 0.3, 'default file changes must also hot-reload');
  fs.writeFileSync(liveRatingFile, JSON.stringify({rating: {monthWeight: 0}}));
  assert.strictEqual(readRating().totalWeight, 1);
  fs.writeFileSync(liveRatingFile, JSON.stringify({rating: {totalWeight: 0, monthWeight: 1, minDelta: 4, maxDelta: 6}}));
  const lastValidRating = readRating();
  assert.strictEqual(lastValidRating.monthWeight, 1);
  assert.strictEqual(lastValidRating.maxDelta, 6);
  for (const invalidJson of ['{ unfinished', '{"rating":{"totalWeight":0,"monthWeight":0}}', '{"rating":null}']) {
    fs.writeFileSync(liveRatingFile, invalidJson);
    assert.deepStrictEqual(readRating(), lastValidRating, 'invalid hot edits must retain the complete last valid rating config');
  }
  assert.strictEqual(ratingWarnings.length, 3);
  fs.writeFileSync(liveRatingFile, JSON.stringify({rating: {totalWeight: 0.6, monthWeight: 0.4}}));
  assert.strictEqual(readRating().monthWeight, 0.4, 'a valid config must recover after an invalid edit');
  fs.unlinkSync(liveRatingFile);
  assert.strictEqual(readRating().monthWeight, 0.3, 'deleting overrides must restore file defaults');
  fs.writeFileSync(path.join(liveRatingRoot, 'config.default.json'), '{}');
  assert.strictEqual(readRating().monthWeight, 0.4, 'omitted weights must restore 0.6/0.4');
} finally {
  fs.rmSync(liveRatingRoot, {recursive: true, force: true});
}

const metadataFile = path.resolve(__dirname, '../deck_analysis/deck_analysis.json');
const displayFile = path.resolve(__dirname, '../deck_analysis/deck_display.json');
const groups = classifier.buildDisplayGroups(
  classifier.loadDeckMetadata(metadataFile).source,
  JSON.parse(fs.readFileSync(displayFile, 'utf8'))
);
assert.ok(groups.length > 0, 'deck display metadata should be readable even with comment-only lines');
const usageMigration = fs.readFileSync(path.resolve(__dirname, '../../migrations/202609-player-usage/001-create-usage-projections.sql'), 'utf8');
const migratedUsageTables = [...usageMigration.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi)].map(match => match[1]).sort();
const registeredUsageTables = Object.values(usageEntities).map(entity => entity.options.tableName).sort();
assert.deepStrictEqual(registeredUsageTables, migratedUsageTables,
  'every ladder-usage-analytics migration table must have exactly one exported plugin EntitySchema');
const deckNames = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../deck_analysis/deck_analysis.json'), 'utf8')).archetypes;
for (const [id, english] of Object.entries({
  514: 'Dino Rabbit', 579: 'Alive Hero', 581: 'Breaker Hero',
  770: 'Asceticism Six Samurai', 771: 'Non-Asceticism Six Samurai',
  1026: 'Plant Synchro', 1027: 'Quickdraw Junk Doppel', 1794: 'FTK Dark World',
  2306: 'Blackwing', 2307: 'Vayu', 2562: 'frog monarch', 2563: 'water synchro',
  3074: 'Gravekeeper', 4866: 'Lightsworn'
})) assert.strictEqual(deckNames[id].name.en, english, `deck type ${id} must use the agreed English name`);

const liveDisplayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-live-display-'));
const liveDisplayFile = path.join(liveDisplayRoot, 'deck_display.json');
fs.writeFileSync(liveDisplayFile, JSON.stringify({groups: [{id: 'explicit', name: {zh: '测试'}, archetypeIds: [1026, 999999]}]}));
let liveGroups = classifier.buildDisplayGroups(classifier.loadDeckMetadata(metadataFile).source, JSON.parse(fs.readFileSync(liveDisplayFile, 'utf8')));
assert.deepStrictEqual(liveGroups[0].members, [1026], 'explicit display members must ignore unknown deck type IDs');
fs.writeFileSync(liveDisplayFile, JSON.stringify({groups: [{id: 'explicit', name: {zh: '测试'}, archetypeIds: [1538]}]}));
liveGroups = classifier.buildDisplayGroups(classifier.loadDeckMetadata(metadataFile).source, JSON.parse(fs.readFileSync(liveDisplayFile, 'utf8')));
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
for (const [configured, expected] of [[9, 10], [15, 15], [21, 20], ['bad', 10]]) {
  fs.writeFileSync(path.join(liveConfigRoot, 'config.json'), JSON.stringify({recentMatchLimit: configured}));
  assert.strictEqual(analytics.recentMatchLimit(analytics.loadPluginConfig(liveConfigRoot)), expected);
}
const liveUsageConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-live-usage-config-'));
fs.writeFileSync(path.join(liveUsageConfigRoot, 'config.default.json'), JSON.stringify({minPlayerMatches: 25, cacheTtlSeconds: 60}));
const readUsageConfig = usage.createLiveConfig(liveUsageConfigRoot, {}, {warn() {}});
assert.strictEqual(readUsageConfig().minPlayerMatches, 25);
const liveUsageOverride = path.join(liveUsageConfigRoot, 'config.json');
fs.writeFileSync(liveUsageOverride, JSON.stringify({minPlayerMatches: 7}));
const future = new Date(Date.now() + 2000);
fs.utimesSync(liveUsageOverride, future, future);
assert.strictEqual(readUsageConfig().minPlayerMatches, 7, 'minimum player Match count must hot-reload without recreating the service');
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
fs.rmSync(liveUsageConfigRoot, {recursive: true, force: true});

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
const deckDetailPage = fs.readFileSync(path.resolve(__dirname, '../ladder-web/web/deck-detail.html'), 'utf8');
assert.match(deckDetailPage, /data\.selected\.templateFiles/, 'deck detail must render every loaded template filename');
assert.match(deckDetailPage, /&filename=/, 'each deck-detail template link must request its exact loaded filename');
assert.doesNotMatch(deckDetailPage, /download>'\+t\('templateLink'\)/,
  'the generic template label must not remain the download link');

console.log('plugin tests passed');
