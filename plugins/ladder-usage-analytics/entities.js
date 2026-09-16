'use strict';

const {EntitySchema} = require('typeorm');
const int = value => ({type: 'int', default: value});

// Every table owned by this plugin must have an EntitySchema in this file and
// be exported below. Production DDL remains explicit in migrations; entities
// provide runtime metadata and never replace the migration when synchronize=false.

const LadderUsageSample = new EntitySchema({
  name: 'LadderUsageSample', tableName: 'ladder_usage_sample',
  columns: {
    id: {type: Number, primary: true, generated: true}, matchId: {type: Number},
    playerName: {type: 'varchar', length: 64}, dayKey: {type: 'varchar', length: 8},
    monthKey: {type: 'varchar', length: 6}, deckTypeId: int(4095), cardValid: int(0),
    status: {type: 'varchar', length: 16, default: 'missing'}, reason: {type: 'varchar', length: 64, nullable: true},
    algorithmVersion: {type: 'varchar', length: 32, default: '1'}, catalogVersion: {type: 'varchar', length: 280, nullable: true}, projectedAt: {type: Date}
  },
  indices: [
    {name: 'uq_ladder_usage_match_player', columns: ['matchId', 'playerName'], unique: true},
    {name: 'ix_ladder_usage_sample_day', columns: ['dayKey']},
    {name: 'ix_ladder_usage_sample_deck', columns: ['deckTypeId', 'dayKey']}
  ]
});

const LadderDeckCardFact = new EntitySchema({
  name: 'LadderDeckCardFact', tableName: 'ladder_deck_card_fact',
  columns: {
    id: {type: Number, primary: true, generated: true}, sampleId: {type: Number},
    cardId: {type: Number}, zone: {type: 'varchar', length: 12}, copies: {type: 'smallint'}
  },
  indices: [
    {name: 'uq_ladder_card_fact', columns: ['sampleId', 'cardId', 'zone'], unique: true},
    {name: 'ix_ladder_card_fact_lookup', columns: ['zone', 'cardId']}
  ]
});

const LadderUsageDailySample = new EntitySchema({
  name: 'LadderUsageDailySample', tableName: 'ladder_usage_daily_sample',
  columns: {dayKey: {type: 'varchar', length: 8, primary: true}, allDecks: int(0), validCardDecks: int(0)}
});
const LadderUsageDailyDeck = new EntitySchema({
  name: 'LadderUsageDailyDeck', tableName: 'ladder_usage_daily_deck',
  columns: {
    id: {type: Number, primary: true, generated: true}, dayKey: {type: 'varchar', length: 8},
    deckTypeId: {type: Number}, deckCount: int(0)
  },
  indices: [{name: 'uq_ladder_usage_daily_deck', columns: ['dayKey', 'deckTypeId'], unique: true}]
});
const LadderUsageDailyCard = new EntitySchema({
  name: 'LadderUsageDailyCard', tableName: 'ladder_usage_daily_card',
  columns: {
    id: {type: Number, primary: true, generated: true}, dayKey: {type: 'varchar', length: 8},
    zone: {type: 'varchar', length: 12}, cardId: {type: Number}, deckCount: int(0),
    copies1: int(0), copies2: int(0), copies3: int(0)
  },
  indices: [{name: 'uq_ladder_usage_daily_card', columns: ['dayKey', 'zone', 'cardId'], unique: true}]
});
const LadderUsageTotalSample = new EntitySchema({
  name: 'LadderUsageTotalSample', tableName: 'ladder_usage_total_sample',
  columns: {id: {type: Number, primary: true}, allDecks: int(0), validCardDecks: int(0)}
});
const LadderUsageTotalDeck = new EntitySchema({
  name: 'LadderUsageTotalDeck', tableName: 'ladder_usage_total_deck',
  columns: {deckTypeId: {type: Number, primary: true}, deckCount: int(0)}
});
const LadderUsageTotalCard = new EntitySchema({
  name: 'LadderUsageTotalCard', tableName: 'ladder_usage_total_card',
  columns: {
    id: {type: Number, primary: true, generated: true}, zone: {type: 'varchar', length: 12},
    cardId: {type: Number}, deckCount: int(0), copies1: int(0), copies2: int(0), copies3: int(0)
  },
  indices: [{name: 'uq_ladder_usage_total_card', columns: ['zone', 'cardId'], unique: true}]
});

module.exports = {LadderUsageSample, LadderDeckCardFact, LadderUsageDailySample, LadderUsageDailyDeck,
  LadderUsageDailyCard, LadderUsageTotalSample, LadderUsageTotalDeck, LadderUsageTotalCard};
