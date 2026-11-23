import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';

const require = createRequire(import.meta.url);
const ladderCore = require('../../ladder-core');
const calculator = require('../web/assets/rating-calculator.js');

const coreDelta = ladderCore._test.calculateDelta;
const defaultConfig = {
  initialPoints: 1000,
  useDynamic: true,
  minDelta: 8,
  maxDelta: 15,
  fixedDelta: 12,
  kFactor: 20,
  totalWeight: 0.6,
  monthWeight: 0.4,
  minimumPoints: 0
};

test('frontend calculateDelta matches ladder-core across dynamic, clamped, half-rounding, and fixed configs', () => {
  const configs = [
    defaultConfig,
    {...defaultConfig, useDynamic: false, fixedDelta: 12},
    {...defaultConfig, useDynamic: false, fixedDelta: 0},
    {...defaultConfig, kFactor: 19, minDelta: 1, maxDelta: 30}, // hits exact .5 rounding asymmetry
    {...defaultConfig, kFactor: 32, minDelta: 5, maxDelta: 25},
    {...defaultConfig, kFactor: 10, minDelta: 8, maxDelta: 15},
    {...defaultConfig, totalWeight: 1, monthWeight: 0},
    {...defaultConfig, totalWeight: 0, monthWeight: 1}
  ];
  const pointPairs = [
    [1000, 1000],
    [1200, 1000],
    [1000, 1200],
    [1800, 900],
    [900, 1800],
    [1050.4, 1049.6],
    [1123.2, 987.8],
    [0, 1000],
    [1000, 0],
    [0, 0],
    [1015, 1015],
    [1350, 1150],
    [1150, 1350]
  ];

  for (const config of configs) {
    for (const [playerPoints, opponentPoints] of pointPairs) {
      for (const won of [true, false]) {
        const expected = coreDelta(playerPoints, opponentPoints, won, config);
        const actual = calculator.calculateDelta(playerPoints, opponentPoints, won, config);
        assert.equal(
          actual,
          expected,
          `mismatch for (${playerPoints}, ${opponentPoints}, won=${won}, config=${JSON.stringify(config)})`
        );
      }
    }
  }
});

test('calculateMatchOutcomes combines total/month ratings and computes both win outcomes matching ladder-core', () => {
  const playerA = {totalPoints: 1250, monthPoints: 1100};
  const playerB = {totalPoints: 950, monthPoints: 1020};
  const outcomes = calculator.calculateMatchOutcomes(playerA, playerB, defaultConfig);

  const expectedCombinedA = defaultConfig.totalWeight * 1250 + defaultConfig.monthWeight * 1100;
  const expectedCombinedB = defaultConfig.totalWeight * 950 + defaultConfig.monthWeight * 1020;
  assert.equal(outcomes.combinedA, expectedCombinedA);
  assert.equal(outcomes.combinedB, expectedCombinedB);

  assert.equal(outcomes.aWins.aDelta, coreDelta(expectedCombinedA, expectedCombinedB, true, defaultConfig));
  assert.equal(outcomes.aWins.bDelta, coreDelta(expectedCombinedB, expectedCombinedA, false, defaultConfig));
  assert.equal(outcomes.bWins.aDelta, coreDelta(expectedCombinedA, expectedCombinedB, false, defaultConfig));
  assert.equal(outcomes.bWins.bDelta, coreDelta(expectedCombinedB, expectedCombinedA, true, defaultConfig));
  // Higher-rated player A gains fewer points than lower-rated player B when winning.
  assert.ok(outcomes.aWins.aDelta < outcomes.bWins.bDelta);
});

test('calculateMatchOutcomes preserves .5 rounding asymmetry when kFactor is odd', () => {
  const oddK = {...defaultConfig, kFactor: 19, minDelta: 1, maxDelta: 30};
  const same = {totalPoints: 1000, monthPoints: 1000};
  const outcomes = calculator.calculateMatchOutcomes(same, same, oddK);
  assert.equal(outcomes.aWins.aDelta, coreDelta(1000, 1000, true, oddK));
  assert.equal(outcomes.aWins.bDelta, coreDelta(1000, 1000, false, oddK));
  assert.equal(outcomes.aWins.aDelta, 10);
  assert.equal(outcomes.aWins.bDelta, -9);
});

test('calculateMatchOutcomes respects fixed scoring mode', () => {
  const fixedConfig = {...defaultConfig, useDynamic: false, fixedDelta: 14};
  const outcomes = calculator.calculateMatchOutcomes(
    {totalPoints: 1500, monthPoints: 1400},
    {totalPoints: 800, monthPoints: 900},
    fixedConfig
  );
  assert.deepEqual(outcomes.aWins, {aDelta: 14, bDelta: -14});
  assert.deepEqual(outcomes.bWins, {aDelta: -14, bDelta: 14});
});

test('resolvePlayerPoints falls back to initialPoints when account is not found or fields are missing', () => {
  const missing = calculator.resolvePlayerPoints({found: false}, 'Newcomer', defaultConfig);
  assert.deepEqual(missing, {name: 'Newcomer', found: false, totalPoints: 1000, monthPoints: 1000});

  const existing = calculator.resolvePlayerPoints(
    {found: true, player: 'Alice', summary: {total: {points: 1180}, month: {points: 1045}}},
    'alice',
    defaultConfig
  );
  assert.deepEqual(existing, {name: 'Alice', found: true, totalPoints: 1180, monthPoints: 1045});

  const partial = calculator.resolvePlayerPoints(
    {found: true, player: 'Bob', summary: {total: {points: 1120}}},
    'bob',
    {...defaultConfig, initialPoints: 1200}
  );
  assert.deepEqual(partial, {name: 'Bob', found: true, totalPoints: 1120, monthPoints: 1200});
});

test('sanitizeNickname strips whitespace and accidental password suffix', () => {
  assert.equal(calculator.sanitizeNickname('  Alice$secret  '), 'Alice');
  assert.equal(calculator.sanitizeNickname('  Bob  '), 'Bob');
  assert.equal(calculator.sanitizeNickname('$onlypass'), '');
  assert.equal(calculator.sanitizeNickname(null), '');
});

test('all four languages define the exact same non-empty translation keys', () => {
  const zhKeys = Object.keys(calculator.TEXT.zh).sort();
  for (const lang of ['zh', 'ja', 'en', 'ko']) {
    assert.deepEqual(Object.keys(calculator.TEXT[lang]).sort(), zhKeys, `keys mismatch for ${lang}`);
    for (const key of zhKeys) {
      assert.equal(typeof calculator.TEXT[lang][key], 'string', `${lang}.${key}`);
      assert.ok(calculator.TEXT[lang][key].trim().length > 0, `${lang}.${key} should be non-empty`);
    }
  }
});
