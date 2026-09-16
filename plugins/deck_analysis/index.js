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
  return containsCardCounts(countCards(actualCards), countCards(requiredCards));
}

function countCards(cards) {
  const counts = new Map();
  for (const card of cards || []) counts.set(Number(card), (counts.get(Number(card)) || 0) + 1);
  return counts;
}

function containsCardCounts(actualCounts, requiredCounts) {
  for (const [card, copies] of requiredCounts) {
    if ((actualCounts.get(card) || 0) < copies) return false;
  }
  return true;
}

function parseTemplateFilename(filename) {
  const match = String(filename).match(/^(\d+)(?:[-_](\d+))?\.ydk$/i);
  if (!match) return null;
  return {id: Number(match[1]), variant: match[2] == null ? null : Number(match[2])};
}

function loadDeckMetadata(filename, otherDeckTypeId = 4095) {
  const source = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const result = new Map();
  for (const [id, item] of Object.entries(source.archetypes || {})) {
    result.set(Number(id), Object.freeze({
      id: Number(id),
      code: item.code || String(id),
      names: Object.freeze({...item.name || {zh: item.code || String(id)}})
    }));
  }
  if (!result.has(otherDeckTypeId)) {
    result.set(otherDeckTypeId, Object.freeze({
      id: otherDeckTypeId,
      code: 'OTHER',
      names: Object.freeze({zh: '其他', ja: 'その他', en: 'Other', ko: '기타'})
    }));
  }
  return {source, items: result};
}

function buildDisplayGroups(metadata, display) {
  const archetypes = metadata.archetypes || {};
  const families = metadata.families || {};
  const groups = (display?.groups || []).filter(group => group.isDisplayed !== false)
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
  return groups.map(group => {
    let members;
    if (Array.isArray(group.archetypeIds)) {
      members = group.archetypeIds.map(Number).filter(id => Object.prototype.hasOwnProperty.call(archetypes, id));
    } else if (group.type === 'single') {
      members = [Number(group.archetypeId)];
    } else {
      const familyCode = Object.keys(families).find(key => Number(families[key].id) === Number(group.familyId)) || '';
      const familyMembers = Object.keys(archetypes)
        .filter(id => archetypes[id].code === familyCode || archetypes[id].code?.startsWith(`${familyCode}_`))
        .map(Number);
      members = group.type === 'custom' && Array.isArray(group.includeBranches)
        ? group.includeBranches.map(index => familyMembers[index]).filter(Number.isFinite)
        : familyMembers;
    }
    return Object.freeze({id: group.id, name: Object.freeze({...group.name}), members: Object.freeze(members)});
  });
}

module.exports.register = api => {
  const directory = path.resolve(api.rootDir, api.config.templateDirectory || 'deck_templates');
  const otherDeckTypeId = Number(api.config.otherDeckTypeId) || 4095;
  const metadataFilename = path.resolve(api.rootDir, api.config.metadataFile || 'deck_analysis.json');
  const displayFilename = path.resolve(api.rootDir, api.config.displayFile || 'deck_display.json');
  let taxonomy;
  const loadTaxonomy = () => {
    const metadataStamp = fs.statSync(metadataFilename).mtimeMs;
    const displayStamp = fs.statSync(displayFilename).mtimeMs;
    if (taxonomy && taxonomy.metadataStamp === metadataStamp && taxonomy.displayStamp === displayStamp) return taxonomy;
    const {source, items} = loadDeckMetadata(metadataFilename, otherDeckTypeId);
    const display = JSON.parse(fs.readFileSync(displayFilename, 'utf8'));
    taxonomy = {
      metadataStamp,
      displayStamp,
      metadata: items,
      displayGroups: Object.freeze(buildDisplayGroups(source, display))
    };
    return taxonomy;
  };
  loadTaxonomy();
  const templates = [];
  const templatesById = new Map();
  if (fs.existsSync(directory)) {
    for (const filename of fs.readdirSync(directory).sort()) {
      const parsedFilename = parseTemplateFilename(filename);
      if (!parsedFilename) continue;
      const deck = parseYdk(fs.readFileSync(path.join(directory, filename), 'utf8'));
      // UPDATE_DECK stores main and extra together in client.main. The side
      // section is intentionally ignored according to the classifier contract.
      const requiredCards = deck.main.concat(deck.extra);
      if (!requiredCards.length) continue;
      const template = {
        id: parsedFilename.id,
        variant: parsedFilename.variant,
        requiredCounts: countCards(requiredCards),
        filename: path.join(directory, filename),
        basename: filename
      };
      templates.push(template);
      const variants = templatesById.get(template.id) || [];
      variants.push(template);
      templatesById.set(template.id, variants);
    }
  }
  for (const variants of templatesById.values()) {
    variants.sort((left, right) => left.variant == null ? -1 : right.variant == null ? 1 :
      left.variant - right.variant || left.basename.localeCompare(right.basename));
  }
  api.provide('deckClassifier', Object.freeze({
    classify(actualMainAndExtra) {
      const actualCounts = countCards(actualMainAndExtra);
      // Preserve the established filename-order priority if templates from
      // different deck types overlap; variants only add OR rules to one ID.
      const template = templates.find(item => containsCardCounts(actualCounts, item.requiredCounts));
      return template ? template.id : otherDeckTypeId;
    },
    getTemplate(deckTypeId) {
      const id = Number(deckTypeId);
      const template = Number.isInteger(id) ? templatesById.get(id)?.[0] : null;
      return template ? {filename: template.basename, contents: fs.readFileSync(template.filename)} : null;
    },
    hasTemplate(deckTypeId) {
      const id = Number(deckTypeId);
      return Number.isInteger(id) && templatesById.has(id);
    },
    getDeckMetadata(deckTypeId) {
      const id = Number(deckTypeId);
      return Number.isInteger(id) ? loadTaxonomy().metadata.get(id) || null : null;
    },
    listDeckMetadata() {
      return [...loadTaxonomy().metadata.values()].sort((a, b) => a.id === otherDeckTypeId ? 1 : b.id === otherDeckTypeId ? -1 : a.id - b.id);
    },
    searchDeckMetadata(query, limit = 20) {
      const value = String(query || '').trim().toLowerCase().slice(0, 64);
      if (!value) return [];
      return [...loadTaxonomy().metadata.values()].filter(item => item.id !== otherDeckTypeId &&
        (String(item.id) === value || item.code.toLowerCase().includes(value) ||
          Object.values(item.names).some(name => String(name).toLowerCase().includes(value))))
        .slice(0, Math.max(1, Number(limit) || 20));
    },
    getDisplayGroups() {
      return loadTaxonomy().displayGroups;
    },
    parseYdk,
    templateCount: templates.length,
    templateDeckTypeCount: templatesById.size,
    otherDeckTypeId
  }));
};

module.exports.parseTemplateFilename = parseTemplateFilename;
module.exports._test = {parseYdk, containsCards, parseTemplateFilename, loadDeckMetadata, buildDisplayGroups};
