'use strict';

const {fail, runReadOnly, createAggregateCache, validatePeriod} = require('./read-only-aggregate');

const ZONES = ['monster', 'spell', 'trap', 'extra', 'side'];
const LANGUAGES = ['zh', 'ja', 'en', 'ko'];
const OTHERS = 4095;

// Splits one card's usage across the deck types that played it. Shares use
// the card's own valid decks as denominator, so every listed type sums to 1;
// "Others" stays a normal row but is never linked to a deck detail page.
function createCardDeckUsage({dataManager, classifier, catalog, periodBounds}) {
  const cache = createAggregateCache({maxKeys:64, maxBytes:1024 * 1024});

  async function aggregate(zone, cardId, bounds) {
    const {cardRows, deckRows} = await runReadOnly(dataManager, async (query, placeholder) => {
      const range = bounds.period === 'all' ? [] : [bounds.startDay, bounds.endDay];
      const dayFilter = offset => range.length ? ` AND s."dayKey" >= ${placeholder(offset + 1)} AND s."dayKey" < ${placeholder(offset + 2)}` : '';
      // Starts from the (zone, cardId) fact index; samples are joined by key.
      const cardSql = `SELECT s."deckTypeId", COUNT(*) AS "deckCount" FROM ladder_deck_card_fact f JOIN ladder_usage_sample s ON s.id = f."sampleId" WHERE f.zone = ${placeholder(1)} AND f."cardId" = ${placeholder(2)} AND s."cardValid" = 1${dayFilter(2)} GROUP BY s."deckTypeId"`;
      const deckSql = `SELECT s."deckTypeId", COUNT(*) AS "validDecks" FROM ladder_usage_sample s WHERE s."cardValid" = 1${dayFilter(0)} GROUP BY s."deckTypeId"`;
      return {cardRows:await query(cardSql, [zone, cardId, ...range]), deckRows:await query(deckSql, range)};
    });
    const validByDeck = new Map(deckRows.map(row => [Number(row.deckTypeId), Number(row.validDecks)]));
    const validCardDecks = [...validByDeck.values()].reduce((sum, count) => sum + count, 0);
    const deckCount = cardRows.reduce((sum, row) => sum + Number(row.deckCount), 0);
    const decks = cardRows.map(row => {
      const deckTypeId = Number(row.deckTypeId), count = Number(row.deckCount), validDecks = validByDeck.get(deckTypeId) || 0;
      return {deckTypeId, deckCount:count, share:deckCount ? count / deckCount : 0, validDecks, adoptionRate:validDecks ? count / validDecks : 0};
    }).sort((a, b) => a.deckTypeId === OTHERS ? 1 : b.deckTypeId === OTHERS ? -1 : b.deckCount - a.deckCount || a.deckTypeId - b.deckTypeId);
    return {coverage:{validCardDecks}, deckCount, usageRate:validCardDecks ? deckCount / validCardDecks : 0, decks, generatedAt:new Date().toISOString()};
  }

  async function query(input = {}) {
    const zone = input.metric;
    if (!ZONES.includes(zone)) throw fail(400, 'invalid_zone');
    const cardId = /^[1-9]\d{0,9}$/.test(String(input.cardId ?? '')) ? Number(input.cardId) : NaN;
    if (!(cardId > 0 && cardId <= 4294967295)) throw fail(400, 'invalid_card');
    validatePeriod(input);
    const bounds = periodBounds(input.period, input.month);
    const value = await cache.get(`${zone}:${cardId}:${bounds.period}:${bounds.startDay || 'all'}`, () => aggregate(zone, cardId, bounds));
    const language = LANGUAGES.includes(input.lang) ? input.lang : 'zh';
    const metadata = new Map(classifier.listDeckMetadata().map(item => [Number(item.id), item]));
    const decks = value.decks.map((deck, index) => {
      const known = metadata.get(deck.deckTypeId);
      return {rank:index + 1, deckTypeId:deck.deckTypeId, names:known ? {...known.names} : {zh:String(deck.deckTypeId)},
        deckCount:deck.deckCount, share:deck.share, validDecks:deck.validDecks, adoptionRate:deck.adoptionRate,
        linkable:!!known && deck.deckTypeId !== OTHERS};
    });
    return {available:true, card:{cardId, zone, name:catalog.get(cardId, language)?.name || String(cardId)}, ...bounds,
      coverage:value.coverage, deckCount:value.deckCount, usageRate:value.usageRate, decks, generatedAt:value.generatedAt};
  }

  return {query, invalidate:cache.invalidate};
}

module.exports = {createCardDeckUsage};
