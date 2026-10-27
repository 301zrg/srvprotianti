'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const plugin = require('./index');

function fixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-artwork-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(rootDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(rootDir).startsWith('deck-artwork-'));
    fs.rmSync(rootDir, {recursive: true, force: true});
  });
  fs.mkdirSync(path.join(rootDir, 'deck_templates'));
  fs.writeFileSync(path.join(rootDir, 'deck_analysis.json'), JSON.stringify({archetypes: {
    100: {code: 'FIRST', name: {zh: '首类'}}, 200: {code: 'SECOND', name: {zh: '次类'}}
  }}));
  fs.writeFileSync(path.join(rootDir, 'deck_display.json'), '{"groups":[]}');
  const templates = {'100.ydk': '#main\n10\n10\n#extra\n20\n!side\n99\n',
    '100-1.ydk': '#main\n50\n#extra\n', '200.ydk': '#main\n31\n32\n#extra\n41\n'};
  for (const [name, body] of Object.entries(templates)) fs.writeFileSync(path.join(rootDir, 'deck_templates', name), body);
  const aliases = new Map([[11, 10], [12, 10], [21, 20], [31, 30], [32, 30], [41, 40], [51, 50]]);
  const normalize = id => aliases.get(Number(id)) || Number(id);
  return {api: {rootDir, config: {}}, normalize, templates};
}

test('canonical multiset matching combines original and alternate copies in main and extra', t => {
  const f = fixture(t), classifier = plugin.createClassifier(f.api, f.normalize);
  for (const cards of [[10, 10, 20], [10, 11, 21], [11, 12, 20], [11, 11, 21, 999]]) {
    assert.equal(classifier.classify(cards), 100);
  }
  assert.equal(classifier.classify([11, 21]), 4095, 'a second canonical copy remains required');
  assert.equal(classifier.classify([10, 11]), 4095, 'extra requirements remain mandatory');
});

test('alternate IDs in templates normalize too and downloads preserve their source bytes', t => {
  const f = fixture(t), classifier = plugin.createClassifier(f.api, f.normalize);
  assert.equal(classifier.classify([30, 30, 40]), 200);
  assert.equal(classifier.classify([31, 30, 41]), 200);
  assert.equal(classifier.classify([30, 40]), 4095);
  assert.equal(classifier.getTemplate(200).contents.toString(), f.templates['200.ydk']);
});

test('normalization preserves filename priority, variants, raw arrays and unknown IDs', t => {
  const f = fixture(t), classifier = plugin.createClassifier(f.api, f.normalize);
  const cards = [11, 10, 21, 30, 30, 40, 999], original = cards.slice();
  assert.equal(classifier.classify(cards), 100);
  assert.deepEqual(cards, original);
  assert.equal(classifier.classify([51]), 100);
  assert.equal(classifier.classify([999]), 4095);
});

test('template counts are precomputed and normalization happens only once per actual card', t => {
  const f = fixture(t); let calls = 0;
  const classifier = plugin.createClassifier(f.api, id => { calls++; return f.normalize(id); });
  assert.ok(calls > 0);
  calls = 0;
  classifier.classify([10, 11, 21]); classifier.classify([11, 12, 20]);
  assert.equal(calls, 6);
});

test('runtime initializes from the declared ready catalog service', async t => {
  const f = fixture(t); let service;
  await plugin.init({...f.api, get(name) {
    assert.equal(name, 'cardCatalog');
    return {metadataAvailable: true, canonicalize: f.normalize};
  }, provide(name, value) { assert.equal(name, 'deckClassifier'); service = value; }});
  assert.equal(service.classify([10, 11, 21]), 100);
  assert.ok(require('./plugin.json').dependencies.includes('card-catalog'));
});

test('missing or unusable Chinese catalog never registers a misleading classifier', async t => {
  const f = fixture(t);
  for (const catalog of [undefined, {metadataAvailable: false, canonicalize: f.normalize}, {metadataAvailable: true}]) {
    let provided = false;
    await assert.rejects(async () => plugin.init({...f.api, get() { return catalog; }, provide() { provided = true; }}), /card catalog.*metadata/i);
    assert.equal(provided, false);
  }
});

test('host waits for catalog init and isolates a metadata failure from independent plugins', async t => {
  const {PluginHost} = require('../../plugin-system');
  for (const metadataAvailable of [true, false]) {
    const f = fixture(t), plugins = path.join(f.api.rootDir, 'host-plugins');
    const classifierDir = path.join(plugins, 'deck_analysis'); fs.mkdirSync(classifierDir, {recursive: true});
    for (const name of ['index.js', 'plugin.json']) fs.copyFileSync(path.join(__dirname, name), path.join(classifierDir, name));
    for (const name of ['deck_analysis.json', 'deck_display.json']) fs.copyFileSync(path.join(f.api.rootDir, name), path.join(classifierDir, name));
    fs.cpSync(path.join(f.api.rootDir, 'deck_templates'), path.join(classifierDir, 'deck_templates'), {recursive: true});
    function add(name, dependencies, source) {
      const directory = path.join(plugins, name); fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({name, main: 'index.js', dependencies}));
      fs.writeFileSync(path.join(directory, 'index.js'), source);
    }
    add('card-catalog', [], `module.exports.init = async api => { await new Promise(resolve => setImmediate(resolve));
      api.provide('cardCatalog', {metadataAvailable: ${metadataAvailable}, canonicalize(id) { return ({11:10,21:20})[id] || Number(id); }}); };`);
    add('dependent', ['deck-classifier'], "module.exports.init = api => api.provide('dependentProof', api.get('deckClassifier').classify([10,11,21]));");
    add('independent', [], "module.exports.init = api => api.provide('independentProof', true);");
    const log = {info() {}, warn() {}, error() {}}, context = {settings: {}, runtime: {}, log};
    const host = new PluginHost(plugins, log); await host.register(context);
    assert.equal(host.services.has('deckClassifier'), false);
    await host.init(context);
    assert.equal(host.services.get('independentProof'), true);
    assert.equal(host.services.get('dependentProof'), metadataAvailable ? 100 : undefined);
    assert.equal(host.services.has('deckClassifier'), metadataAvailable);
  }
});
