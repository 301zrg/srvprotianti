'use strict';

const {EntitySchema} = require('typeorm');

const int = defaultValue => ({type: 'int', default: defaultValue});
const name = nullable => ({type: 'varchar', length: 64, nullable: !!nullable});

const LadderUser = new EntitySchema({
  name: 'LadderUser', tableName: 'ladder_user',
  columns: {
    name: {...name(false), primary: true},
    displayName: name(true),
    pass: {type: 'varchar', length: 128, nullable: true},
    createdAt: {type: Date, nullable: true},
    wins: int(0), losses: int(0), monthWins: int(0), monthLosses: int(0),
    duelPoints: int(1000), monthDuelPoints: int(1000),
    monthKey: {type: 'varchar', length: 8, nullable: true}
  }
});

const LadderMonthRecord = new EntitySchema({
  name: 'LadderMonthRecord', tableName: 'ladder_month_record',
  columns: {
    id: {type: Number, primary: true, generated: true},
    name: name(false), monthKey: {type: 'varchar', length: 8},
    duelPoints: int(1000), wins: int(0), losses: int(0), scoreDiff: int(0)
  },
  indices: [{name: 'uq_ladder_month_name_key', columns: ['name', 'monthKey'], unique: true}]
});

const LadderMatch = new EntitySchema({
  name: 'LadderMatch', tableName: 'ladder_match',
  columns: {
    id: {type: Number, primary: true, generated: true},
    matchKey: {type: 'varchar', length: 96},
    roomId: {type: Number, nullable: true},
    monthKey: {type: 'varchar', length: 8, nullable: true},
    winnerName: name(true), loserName: name(true),
    playerAName: name(true), playerBName: name(true),
    playerADisplayName: name(true), playerBDisplayName: name(true),
    playerADeckTypeId: int(4095), playerBDeckTypeId: int(4095),
    playerADuelPointsDelta: int(0), playerBDuelPointsDelta: int(0),
    playerADuelPointsBefore: int(1000), playerBDuelPointsBefore: int(1000),
    playerADuelPointsAfter: int(1000), playerBDuelPointsAfter: int(1000),
    g1FirstPlayer: name(true), coinWinner: name(true),
    duelLogId: {type: Number, nullable: true},
    createTime: {type: Date}
  },
  indices: [
    {name: 'uq_ladder_match_match_key', columns: ['matchKey'], unique: true},
    {name: 'ix_ladder_match_month_decks', columns: ['monthKey', 'playerADeckTypeId', 'playerBDeckTypeId']}
  ],
  relations: {
    games: {type: 'one-to-many', target: 'LadderMatchGame', inverseSide: 'match'}
  }
});

const LadderMatchGame = new EntitySchema({
  name: 'LadderMatchGame', tableName: 'ladder_match_game',
  columns: {
    id: {type: Number, primary: true, generated: true},
    matchId: {type: Number}, duelLogId: {type: Number, nullable: true},
    playerName: name(false), playerDisplayName: name(true),
    opponentName: name(false), opponentDisplayName: name(true),
    deckTypeId: int(4095), opponentDeckTypeId: int(4095),
    winnerName: name(true), duelCount: {type: 'smallint', default: 1},
    isFirst: {type: 'smallint', default: 0}, isMain: {type: 'smallint', default: 1},
    createTime: {type: Date}
  },
  indices: [
    {name: 'uq_ladder_game_identity', columns: ['matchId', 'duelCount', 'playerName'], unique: true},
    {name: 'ix_ladder_game_match', columns: ['matchId']},
    {name: 'ix_ladder_game_player', columns: ['playerName']},
    {name: 'ix_ladder_game_month_query', columns: ['createTime', 'deckTypeId', 'opponentDeckTypeId']}
  ],
  relations: {
    match: {type: 'many-to-one', target: 'LadderMatch', inverseSide: 'games', joinColumn: {name: 'matchId'}, nullable: false, onDelete: 'CASCADE'}
  }
});

module.exports = {LadderUser, LadderMonthRecord, LadderMatch, LadderMatchGame};
