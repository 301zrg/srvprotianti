'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const plugin = require('./index');
const {loadCatalog} = require('../card-catalog')._test;

const snapshotPattern = /(<script id="embeddedRules" type="application\/json">)(.*?)(<\/script>)/s;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function refresh({check = false, catalogDirectory} = {}) {
  // This offline development tool uses defaults only, never instance config or PostgreSQL.
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
  const catalogRoot = path.resolve(__dirname, '../card-catalog');
  const catalogConfig = JSON.parse(fs.readFileSync(path.join(catalogRoot, 'config.default.json'), 'utf8'));
  if (catalogDirectory) catalogConfig.databaseDirectory = path.resolve(catalogDirectory);
  const catalog = await loadCatalog(catalogRoot, catalogConfig, {
    warn({language, err}) { throw new Error(`Cannot refresh ${language} catalog: ${err.message}`); }
  });
  if (!catalog.metadataAvailable) throw new Error('Chinese card metadata is required.');
  const canonicalize = id => catalog.cards.get(Number(id))?.canonicalId || Number(id);
  const metadataBytes = fs.readFileSync(path.resolve(__dirname, config.metadataFile));
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  const directory = path.resolve(__dirname, config.templateDirectory);
  const templateSources = new Map();
  const templateHash = crypto.createHash('sha256');
  for (const filename of fs.readdirSync(directory).filter(plugin.parseTemplateFilename).sort()) {
    const bytes = fs.readFileSync(path.join(directory, filename));
    templateSources.set(filename, bytes);
    templateHash.update(filename).update('\0').update(bytes).update('\0');
  }
  const classifier = plugin.createClassifier({rootDir: __dirname, config, templateSources}, canonicalize);
  const templates = [], cardNames = {};
  for (const [filename, bytes] of templateSources) {
    const deck = plugin._test.parseYdk(bytes.toString('utf8'));
    const counts = new Map();
    for (const rawId of deck.main.concat(deck.extra)) {
      const id = canonicalize(rawId);
      counts.set(id, (counts.get(id) || 0) + 1);
      cardNames[id] = catalog.cards.get(id)?.names.zh || String(id);
    }
    if (!counts.size) continue;
    templates.push({filename, id: plugin.parseTemplateFilename(filename).id, required: [...counts]});
  }
  if (templates.length !== classifier.templateCount) throw new Error('Template snapshot differs from the classifier.');
  const aliases = Object.fromEntries([...catalog.cards.values()]
    .filter(card => card.id !== card.canonicalId).map(card => [card.id, card.canonicalId]));
  const snapshot = {
    source: 'embedded', generatedAt: new Date().toISOString(),
    algorithmVersion: plugin.ALGORITHM_VERSION,
    templateSha256: templateHash.digest('hex'), metadataSha256: sha256(metadataBytes),
    catalogFingerprint: catalog.fingerprint, aliases, cardNames,
    otherDeckTypeId: classifier.otherDeckTypeId, archetypes: metadata.archetypes, templates
  };
  const filename = path.join(__dirname, 'check-deck.html');
  const html = fs.readFileSync(filename, 'utf8');
  const match = html.match(snapshotPattern);
  if (!match) throw new Error('Embedded rules block is missing.');
  if (check) {
    const previous = JSON.parse(match[2]);
    snapshot.generatedAt = previous.generatedAt;
    if (JSON.stringify(previous) !== JSON.stringify(snapshot)) throw new Error('Offline snapshot is stale; run refresh-check-deck.js.');
  } else {
    const json = JSON.stringify(snapshot).replace(/</g, '\\u003c');
    fs.writeFileSync(filename, html.replace(snapshotPattern, (_match, start, _data, end) => start + json + end));
  }
  return {templates: templates.length, deckTypes: classifier.templateDeckTypeCount, aliases: Object.keys(aliases).length, check};
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let check = false, catalogDirectory;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true;
    else if (args[i] === '--catalog-directory' && args[i + 1]) catalogDirectory = args[++i];
    else throw new Error('Usage: node refresh-check-deck.js [--check] [--catalog-directory <directory>]');
  }
  refresh({check, catalogDirectory}).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = {refresh};
