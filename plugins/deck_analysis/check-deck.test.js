'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const plugin = require('./index');

const html = fs.readFileSync(path.join(__dirname, 'check-deck.html'), 'utf8');
const embedded = html.match(/<script id="embeddedRules" type="application\/json">(.*?)<\/script>/s)[1];
const snapshot = JSON.parse(embedded);
const script = [...html.matchAll(/<script>(.*?)<\/script>/gs)][0][1];
const templateDirectory = path.join(__dirname, 'deck_templates');
const filenames = fs.readdirSync(templateDirectory).filter(plugin.parseTemplateFilename).sort();
const templateText = name => fs.readFileSync(path.join(templateDirectory, name), 'utf8');
const file = (name, text, relativePath = '') => ({name, size: Buffer.byteLength(text),
  webkitRelativePath: relativePath, async text() { return text; }});

function page() {
  const nodes = new Map();
  function element() {
    return {textContent: '', children: [], handlers: {}, value: '',
      classList: {add() {}, remove() {}},
      appendChild(child) { this.children.push(child); },
      replaceChildren() { this.children = []; },
      addEventListener(name, handler) { this.handlers[name] = handler; }};
  }
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  get('embeddedRules').textContent = embedded;
  vm.runInNewContext(script, {document: {getElementById: get, createElement: element}});
  const text = node => node.textContent + node.children.map(text).join('\n');
  return {get, text,
    async inspect(contents) {
      get('deckFiles').files = [file('input.ydk', contents)];
      get('deckFiles').handlers.change();
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
      return text(get('results'));
    },
    async reload(files) {
      get('ruleDirectory').files = files;
      await get('ruleDirectory').handlers.change();
    }};
}

function directoryFiles() {
  return ['deck_analysis.json', 'config.default.json'].map(name =>
    file(name, fs.readFileSync(path.join(__dirname, name), 'utf8'), `deck_analysis/${name}`))
    .concat(filenames.map(name => file(name, templateText(name), `deck_analysis/deck_templates/${name}`)));
}

test('embedded snapshot includes every current template and its canonical requirements', () => {
  assert.deepEqual(snapshot.templates.map(item => item.filename), filenames);
  const normalize = id => Number(snapshot.aliases?.[id] || id);
  const classifier = plugin.createClassifier({rootDir: __dirname, config: {}}, normalize);
  for (const name of filenames) {
    const deck = plugin._test.parseYdk(templateText(name));
    const counts = new Map();
    for (const card of deck.main.concat(deck.extra)) {
      const id = normalize(card);
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    assert.deepEqual(snapshot.templates.find(item => item.filename === name).required, [...counts], name);
    assert.equal(classifier.classify(deck.main.concat(deck.extra)), plugin.parseTemplateFilename(name).id);
  }
});

test('original and alternate artworks match alike, including after directory reload', async () => {
  const p = page();
  const original = templateText('1026.ydk');
  const alternate = original.replaceAll('97268402', '97268403');
  assert.match(await p.inspect(original), /星骸植物 · 1026/);
  assert.match(await p.inspect(alternate), /星骸植物 · 1026/, 'alternate artwork must not become Other');
  await p.reload(directoryFiles());
  assert.match(await p.inspect(alternate), /星骸植物 · 1026/, 'manual reload must preserve canonicalization');
});

test('mixed original and alternate copies count together but side cards do not satisfy requirements', async () => {
  const p = page();
  const original = templateText('1026.ydk');
  assert.match(await p.inspect(original.replace('97268402', '97268403')), /星骸植物 · 1026/);
  const missing = original.replace(/97268402\r?\n/, '').replace('!side', '!side\n97268403');
  const result = await p.inspect(missing);
  assert.match(result, /4095/);
  assert.match(result, /97268402/);
});

test('extra-deck artwork and artwork IDs in manually loaded templates normalize too', async () => {
  const p = page();
  const original = templateText('1026.ydk');
  const extra = plugin._test.parseYdk(original).extra;
  const pair = Object.entries(snapshot.aliases).find(([, canonical]) => extra.includes(canonical));
  assert.ok(pair, 'fixture must have a known alternate-art extra card');
  assert.match(await p.inspect(original.replace(String(pair[1]), pair[0])), /星骸植物 · 1026/);
  const files = directoryFiles().filter(item => !item.name.endsWith('.ydk'));
  files.push(file('1026.ydk', original.replaceAll('97268402', '97268403'),
    'deck_analysis/deck_templates/1026.ydk'));
  await p.reload(files);
  assert.match(await p.inspect(original), /星骸植物 · 1026/);
});

test('conflicting types keep the server filename priority', async () => {
  const counts = new Map();
  for (const name of ['258_1.ydk', '259.ydk']) {
    const deck = plugin._test.parseYdk(templateText(name)), part = new Map();
    for (const id of deck.main.concat(deck.extra)) part.set(id, (part.get(id) || 0) + 1);
    for (const [id, count] of part) counts.set(id, Math.max(count, counts.get(id) || 0));
  }
  const cards = [...counts].flatMap(([id, count]) => Array(count).fill(id));
  const result = await page().inspect('#main\n' + cards.join('\n') + '\n#extra\n!side\n');
  assert.match(result, /代行 · 258\n/);
  assert.match(result, /259\.ydk/);
});

test('failed directory reload preserves the previous usable rules', async () => {
  const p = page();
  await p.reload([file('deck_analysis.json', '{broken', 'deck_analysis/deck_analysis.json'),
    file('1026.ydk', templateText('1026.ydk'), 'deck_analysis/deck_templates/1026.ydk')]);
  assert.match(await p.inspect(templateText('1026.ydk').replaceAll('97268402', '97268403')), /星骸植物 · 1026/);
});
