'use strict';

const fs = require('fs');
const path = require('path');

function parseYdk(text) {
  const sections = {main: [], extra: [], side: []};
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '#main') current = 'main';
    else if (line === '#extra') current = 'extra';
    else if (line === '!side') current = 'side';
    else if (/^\d+$/.test(line) && current) sections[current].push(Number(line));
  }
  return sections;
}

function containsCards(actualCards, requiredCards) {
  const counts = new Map();
  for (const card of actualCards || []) counts.set(Number(card), (counts.get(Number(card)) || 0) + 1);
  for (const card of requiredCards) {
    const remaining = counts.get(card) || 0;
    if (!remaining) return false;
    counts.set(card, remaining - 1);
  }
  return true;
}

module.exports.register = api => {
  const directory = path.resolve(api.rootDir, api.config.templateDirectory || 'deck_templates');
  const otherDeckTypeId = Number(api.config.otherDeckTypeId) || 4095;
  const templates = [];
  if (fs.existsSync(directory)) {
    for (const filename of fs.readdirSync(directory).sort()) {
      const match = filename.match(/^(\d+)\.ydk$/i);
      if (!match) continue;
      const deck = parseYdk(fs.readFileSync(path.join(directory, filename), 'utf8'));
      // UPDATE_DECK stores main and extra together in client.main. The side
      // section is intentionally ignored according to the classifier contract.
      const requiredCards = deck.main.concat(deck.extra);
      if (requiredCards.length) templates.push({id: Number(match[1]), requiredCards});
    }
  }
  api.provide('deckClassifier', Object.freeze({
    classify(actualMainAndExtra) {
      const template = templates.find(item => containsCards(actualMainAndExtra, item.requiredCards));
      return template ? template.id : otherDeckTypeId;
    },
    parseYdk,
    templateCount: templates.length,
    otherDeckTypeId
  }));
};

module.exports._test = {parseYdk, containsCards};
