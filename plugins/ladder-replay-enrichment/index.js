'use strict';

const path = require('path');
const {decodeDeck} = require('../../data-manager/DeckEncoder');

const DuelLog = 'DuelLog';

module.exports.init = api => {
  if (!api.dataManager) return;
  const replayWeb = api.get('publicReplayWeb');
  const ladderCore = api.get('ladderCore');
  const classifier = api.get('deckClassifier');
  const usage = api.get('ladderUsageAnalytics');
  const games = () => ladderCore.getRepository('LadderMatchGame');
  const filterCache = new Map();

  const classifyPlayer = player => {
    if (!player?.startDeckBuffer) return null;
    try {
      const deck = decodeDeck(Buffer.from(player.startDeckBuffer, 'base64'));
      const deckTypeId = classifier.classify((deck.main || []).concat(deck.extra || []));
      return {deckTypeId, deckNames: usage.getDeckMetadata(deckTypeId)?.names || {zh: String(deckTypeId)}};
    } catch (error) {
      return null;
    }
  };

  const replayNamesForDeck = async deckTypeId => {
    const cached = filterCache.get(deckTypeId);
    if (cached && Date.now() - cached.time < 60000) return cached.names;
    // Reuse the stored G1 classification. Do not parse every historical deck
    // buffer and do not introduce another replay/index table.
    const rows = await games().createQueryBuilder('game')
      .innerJoin(DuelLog, 'log', 'log.id = game.duelLogId')
      .select('log.replayFileName', 'replayFileName')
      .where('game.deckTypeId = :deckTypeId', {deckTypeId})
      .andWhere('game.duelLogId IS NOT NULL')
      .distinct(true)
      .getRawMany();
    const names = new Set(rows.map(row => path.basename(row.replayFileName ?? row.replayfilename ?? '')));
    filterCache.set(deckTypeId, {time: Date.now(), names});
    return names;
  };

  replayWeb.registerEnrichment({
    async prepareList(query) {
      const requested = Number(query.deckTypeId);
      const deckTypeId = Number.isInteger(requested) && requested > 0 ? requested : null;
      return {
        matchingReplayNames: deckTypeId ? await replayNamesForDeck(deckTypeId) : null,
        response: {deckTypeId, deckTypes: usage.listDeckMetadata()}
      };
    },
    enrichPlayer: classifyPlayer
  });

  api.hook('ladder_match_committed', () => filterCache.clear());
};
