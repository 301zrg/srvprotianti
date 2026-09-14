'use strict';

const assert = require('assert');
const {chooseG1Reference, buildPlan, parseArgs} = require('./reclassify-database');

assert.deepStrictEqual(chooseG1Reference({matchDuelLogId: '8', g1GameDuelLogIds: ['8']}), {duelLogId: '8'});
assert.deepStrictEqual(chooseG1Reference({matchDuelLogId: null, g1GameDuelLogIds: []}), {reason: 'missing_g1_reference'});
assert.deepStrictEqual(chooseG1Reference({matchDuelLogId: '8', g1GameDuelLogIds: ['9']}), {reason: 'conflicting_g1_references'});
assert.throws(() => parseArgs(['node', 'tool', 'apply']), /APPLY-DECK-RECLASSIFICATION/);

const matches = [
  {id: '1', playerAName: 'Alice', playerBName: 'BOB', playerADeckTypeId: 4095, playerBDeckTypeId: 20,
    matchDuelLogId: '101', g1GameDuelLogIds: ['101']},
  {id: '2', playerAName: 'Carol', playerBName: 'Dave', playerADeckTypeId: 30, playerBDeckTypeId: 40,
    matchDuelLogId: null, g1GameDuelLogIds: []},
  {id: '3', playerAName: 'Eve', playerBName: 'Frank', playerADeckTypeId: 50, playerBDeckTypeId: 60,
    matchDuelLogId: '103', g1GameDuelLogIds: ['104']},
  {id: '4', playerAName: 'Grace', playerBName: 'Heidi', playerADeckTypeId: 70, playerBDeckTypeId: 80,
    matchDuelLogId: '105', g1GameDuelLogIds: ['105']}
];
const games = [
  {matchId: '1', playerName: 'alice', opponentName: 'Bob', deckTypeId: 4095, opponentDeckTypeId: 20},
  {matchId: '1', playerName: 'bob', opponentName: 'ALICE', deckTypeId: 20, opponentDeckTypeId: 4095},
  {matchId: '4', playerName: 'intruder', opponentName: 'heidi', deckTypeId: 70, opponentDeckTypeId: 80}
];
const players = [
  {duelLogId: '101', duelCount: 1, name: 'ALICE', pos: 0, startDeckBuffer: 'deck-a', currentDeckBuffer: null},
  {duelLogId: '101', duelCount: 1, name: 'bob', pos: 1, startDeckBuffer: 'deck-b', currentDeckBuffer: null}
];
const plan = buildPlan(matches, games, players, encoded => ({'deck-a': 10, 'deck-b': 20})[encoded]);
assert.deepStrictEqual(plan.updates, [{matchId: '1', aType: 10, bType: 20}]);
assert.strictEqual(plan.changedMatches, 1);
assert.strictEqual(plan.changedGameRows, 2);
assert.deepStrictEqual(plan.transitions, [{from: 4095, to: 10, playerSides: 1}]);
assert.deepStrictEqual(plan.skipped, [
  {matchId: '2', reason: 'missing_g1_reference'},
  {matchId: '3', reason: 'conflicting_g1_references'},
  {matchId: '4', reason: 'invalid_game_players'}
]);

console.log('deck database reclassification tests passed');
