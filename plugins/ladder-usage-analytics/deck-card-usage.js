'use strict';

const {fail, runReadOnly, createAggregateCache, validatePeriod} = require('./read-only-aggregate');

const ZONES = ['monster', 'spell', 'trap', 'extra', 'side'];
const LANGUAGES = ['zh', 'ja', 'en', 'ko'];

function createDeckCardUsage({dataManager, classifier, catalog, periodBounds, cardLimit = 200, pageSize = 50}) {
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(cardLimit) || 200)));
  const size = Math.min(50, Math.max(1, Math.trunc(Number(pageSize) || 50)));
  const cache = createAggregateCache();

  async function aggregate(deckTypeId, bounds) {
    const postgres = dataManager.getConnection().options.type === 'postgres';
    const {totals, rows} = await runReadOnly(dataManager, async (query, placeholder) => {
      const params = [deckTypeId];
      let where = `s."deckTypeId" = ${placeholder(1)}`;
      if (bounds.period !== 'all') {
        params.push(bounds.startDay, bounds.endDay);
        where += ` AND s."dayKey" >= ${placeholder(2)} AND s."dayKey" < ${placeholder(3)}`;
      }
      const totalsSql = `SELECT COUNT(*) AS "allDecks", COALESCE(SUM(CASE WHEN s."cardValid" = 1 THEN 1 ELSE 0 END), 0) AS "validCardDecks" FROM ladder_usage_sample s WHERE ${where}`;
      const columns = 'f.zone, f."cardId", COUNT(*) AS "deckCount", SUM(CASE WHEN f.copies = 1 THEN 1 ELSE 0 END) AS copies1, SUM(CASE WHEN f.copies = 2 THEN 1 ELSE 0 END) AS copies2, SUM(CASE WHEN f.copies = 3 THEN 1 ELSE 0 END) AS copies3';
      const zones = "f.zone IN ('monster','spell','trap','extra','side')";
      // Retain the per-sample index lookup boundary. A plain JOIN can scan every
      // historical card fact even after filtering the indexed deck/date subset.
      const source = postgres ? `selected AS MATERIALIZED (SELECT s.id FROM ladder_usage_sample s WHERE ${where} AND s."cardValid" = 1), card_usage AS (SELECT ${columns} FROM selected s CROSS JOIN LATERAL (SELECT f.zone, f."cardId", f.copies FROM ladder_deck_card_fact f WHERE f."sampleId" = s.id AND ${zones} OFFSET 0) f GROUP BY f.zone, f."cardId")` :
        `card_usage AS (SELECT ${columns} FROM ladder_usage_sample s JOIN ladder_deck_card_fact f ON f."sampleId" = s.id WHERE ${where} AND s."cardValid" = 1 AND ${zones} GROUP BY f.zone, f."cardId")`;
      const cardsSql = `WITH ${source}, ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY zone ORDER BY "deckCount" DESC, "cardId" ASC) AS rank FROM card_usage) SELECT * FROM ranked WHERE rank <= ${placeholder(params.length + 1)} ORDER BY zone, rank`;
      return {totals:(await query(totalsSql, params))[0], rows:await query(cardsSql, [...params, limit])};
    });
    const coverage = {allDecks:Number(totals?.allDecks || 0),validCardDecks:Number(totals?.validCardDecks || 0)};
    const cards = Object.fromEntries(ZONES.map(zone => [zone, []]));
    for (const row of rows) {
      if (!cards[row.zone]) continue;
      const deckCount = Number(row.deckCount);
      cards[row.zone].push({rank:Number(row.rank),cardId:Number(row.cardId),deckCount,
        usageRate:coverage.validCardDecks ? deckCount / coverage.validCardDecks : 0,
        copies1:Number(row.copies1),copies2:Number(row.copies2),copies3:Number(row.copies3)});
    }
    return {coverage,cards,generatedAt:new Date().toISOString()};
  }

  async function query(input = {}) {
    const deckTypeId = Number(input.deckTypeId);
    const selected = classifier.listDeckMetadata().find(item => Number(item.id) === deckTypeId);
    if (!Number.isSafeInteger(deckTypeId) || deckTypeId <= 0 || deckTypeId === 4095 || !selected) throw fail(400, 'invalid_deck_type');
    validatePeriod(input);
    const bounds = periodBounds(input.period, input.month);
    const key = `${deckTypeId}:${bounds.period}:${bounds.startDay || 'all'}`;
    const value = await cache.get(key, () => aggregate(deckTypeId, bounds));
    const language = LANGUAGES.includes(input.lang) ? input.lang : 'zh';
    for (const rows of Object.values(value.cards)) for (const row of rows) row.name = catalog.get(row.cardId, language)?.name || String(row.cardId);
    return {available:true,selected:{id:deckTypeId,names:{...selected.names}},...bounds,cardLimit:limit,pageSize:size,...value};
  }

  return {query, invalidate:cache.invalidate};
}

module.exports = {createDeckCardUsage};
