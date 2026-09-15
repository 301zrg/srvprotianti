'use strict';

const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');

const TYPE_MONSTER = 0x1;
const TYPE_SPELL = 0x2;
const TYPE_TRAP = 0x4;
const EXTRA_MASK = 0x40 | 0x2000 | 0x800000 | 0x4000000;

function classifyZone(type) {
  const value = Number(type) || 0;
  if ((value & TYPE_MONSTER) && (value & EXTRA_MASK)) return 'extra';
  if (value & TYPE_MONSTER) return 'monster';
  if (value & TYPE_SPELL) return 'spell';
  if (value & TYPE_TRAP) return 'trap';
  return null;
}

async function loadCatalog(rootDir, config, log) {
  const cards = new Map();
  const fingerprints = [];
  const directory = path.resolve(rootDir, config.databaseDirectory || 'databases');
  for (const language of ['zh', 'ja', 'en', 'ko']) {
    const filename = path.join(directory, config.files?.[language] || `cards.${language}.cdb`);
    try {
      await fs.promises.access(filename, fs.constants.R_OK);
      const child = spawn(process.execPath, [path.join(__dirname, 'read-cdb.js'), filename, language === 'zh' ? 'metadata' : 'names'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
      const childClosed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      let stderr = '';
      const stdout = [];
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
      child.stdout.on('data', chunk => stdout.push(chunk));
      const exitCode = await childClosed;
      if (exitCode !== 0) throw new Error(stderr || `CDB reader exited with code ${exitCode}`);
      const payload = JSON.parse(Buffer.concat(stdout).toString('utf8'));
      fingerprints.push(`${language}:${payload.sha256}`);
      for (const row of payload.rows) {
        const id = Number(row[0]);
        let card = cards.get(id);
        if (!card) cards.set(id, card = {id, canonicalId: id, type: 0, zone: null, names: {}});
        if (language === 'zh') {
          card.type = Number(row[1]) || 0;
          card.canonicalId = Number(row[2]) || id;
          card.zone = classifyZone(card.type);
          card.names.zh = String(row[3] || id);
        } else card.names[language] = String(row[1] || id);
      }
    } catch (error) {
      log.warn({err: error, filename, language}, 'Card catalog database could not be loaded');
    }
  }
  // Alternate artworks inherit the canonical card's type and missing names.
  for (const card of cards.values()) {
    const canonical = cards.get(card.canonicalId);
    if (!canonical) continue;
    if (!card.type) card.type = canonical.type;
    if (!card.zone) card.zone = canonical.zone;
    for (const language of ['zh', 'ja', 'en', 'ko']) {
      if (!card.names[language]) card.names[language] = canonical.names[language] || canonical.names.zh || String(card.canonicalId);
    }
  }
  return {cards, fingerprint: fingerprints.join('|'), metadataAvailable: fingerprints.some(value => value.startsWith('zh:'))};
}

module.exports.init = async api => {
  const loaded = await loadCatalog(api.rootDir, api.config, api.log);
  const cards = loaded.cards;
  const fallback = api.config.fallbackLanguage || 'zh';
  api.provide('cardCatalog', {
    size: cards.size,
    fingerprint: loaded.fingerprint,
    metadataAvailable: loaded.metadataAvailable,
    get(id, language = fallback) {
      const raw = cards.get(Number(id));
      if (!raw) return null;
      const canonical = cards.get(raw.canonicalId) || raw;
      return {
        id: raw.id,
        canonicalId: canonical.id,
        type: canonical.type,
        zone: canonical.zone,
        name: canonical.names[language] || canonical.names[fallback] || canonical.names.zh || String(canonical.id),
        names: canonical.names
      };
    },
    canonicalize(id) {
      const card = cards.get(Number(id));
      return card ? card.canonicalId : Number(id);
    },
    classifyZone(id) {
      const card = cards.get(Number(id));
      return card ? (cards.get(card.canonicalId)?.zone || card.zone || null) : null;
    }
  });
  api.log.info({cards: cards.size}, 'Card catalog loaded');
};

module.exports._test = {classifyZone, loadCatalog};
