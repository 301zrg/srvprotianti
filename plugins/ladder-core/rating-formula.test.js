'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const formula = require('./rating-formula');
const {createLiveRatingFormula, checkRatingFormula, normalizeRating} = require('./index')._test;

const source = fs.readFileSync(path.join(__dirname, 'rating-formula.js'), 'utf8');
const rating = normalizeRating();

test('the shipped formula passes the hot-reload self-check', () => {
  assert.equal(checkRatingFormula(formula), formula);
});

test('settleMatch applies the same delta to both balances and keeps the 0 floor', () => {
  const result = formula.settleMatch([{total: 5, month: 1000}, {total: 1000, month: 1000}], 1, rating);
  assert.deepEqual(result.deltas, [-8, 8]);
  assert.deepEqual(result.after, [{total: 0, month: 992}, {total: 1008, month: 1008}],
    'the Match keeps the raw delta while the balance stops at 0');
  assert.equal(result.combined[0], 0.6 * 5 + 0.4 * 1000);
});

function liveCopy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-rating-formula-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'rating-formula.js');
  const warnings = [];
  const write = (text, bump) => {
    fs.writeFileSync(file, text);
    // Make the change visible even on file systems with coarse mtimes.
    const when = new Date(Date.now() + bump * 1000);
    fs.utimesSync(file, when, when);
  };
  write(source, 0);
  const live = createLiveRatingFormula(file, {warn: (...args) => warnings.push(args), info() {}});
  return {live, write, warnings, file};
}

const fixedPair = [{total: 1000, month: 1000}, {total: 1000, month: 1000}];

test('an edited formula takes effect on the next call without a restart', t => {
  const {live, write} = liveCopy(t);
  assert.deepEqual(live().settleMatch(fixedPair, 0, rating).deltas, [10, -10]);
  write(source.replace('const ELO_SCALE = 400;', 'const ELO_SCALE = 400;\nconst BONUS = 1;')
    .replace('return won ? magnitude : -magnitude;', 'return won ? magnitude + BONUS : -magnitude;'), 5);
  assert.deepEqual(live().settleMatch(fixedPair, 0, rating).deltas, [11, -10]);
});

test('a half-written or implausible formula is rejected and the last good one keeps settling', t => {
  const {live, write, warnings} = liveCopy(t);
  const good = live();
  write(source.slice(0, source.length / 2), 5);
  assert.equal(live(), good, 'syntax error must keep the previous formula');
  assert.equal(warnings.length, 1);
  write(source.replace('return won ? magnitude : -magnitude;', 'return won ? -magnitude : magnitude;'), 10);
  assert.equal(live(), good, 'winner losing points must fail the self-check');
  write(source.replace('const MINIMUM_POINTS = 0;', 'const MINIMUM_POINTS = -1;'), 15);
  assert.equal(live(), good, 'a negative floor must fail the self-check');
  write(source.replace('Math.round(', '0.5 + Math.round('), 20);
  assert.equal(live(), good, 'fractional deltas must fail the self-check');
  assert.equal(warnings.length, 4);
  assert.ok(warnings.every(([fields]) => fields.event === 'ladder_rating_formula_invalid'));
  write(source, 25);
  assert.notEqual(live(), good, 'a repaired file is picked up again');
  assert.deepEqual(live().settleMatch(fixedPair, 0, rating).deltas, [10, -10]);
});

test('balances that contradict the delta are rejected', t => {
  const {live, write, warnings} = liveCopy(t);
  const good = live();
  // Winner's total moves the wrong way while the Match would record +delta.
  write(source.replace('total: applyDelta(player.total, deltas[index]),',
    'total: index === winnerIndex ? Math.max(0, player.total - deltas[index]) : applyDelta(player.total, deltas[index]),'), 5);
  assert.equal(live(), good);
  assert.equal(warnings.length, 1);
});

test('a formula that only fails on real input falls back to the trusted one and stays disabled', t => {
  const {live, write, warnings} = liveCopy(t);
  const trusted = live();
  // Passes every built-in sample (kFactor 20) but breaks with a custom kFactor.
  write(source.replace('const raw = Math.round(', 'const raw = rating.kFactor === 33 ? NaN : Math.round('), 5);
  const candidate = live();
  assert.notEqual(candidate, trusted, 'the candidate passes the sample self-check');
  const custom = normalizeRating({kFactor: 33});
  const run = live.run(fixedPair, 0, custom);
  assert.equal(run.formula, trusted, 'the same input is recomputed with the trusted formula');
  assert.deepEqual(run.result.deltas, [15, -15]);
  assert.ok(warnings.some(([fields]) => fields.event === 'ladder_rating_formula_runtime_invalid'));
  assert.equal(live(), trusted, 'the bad candidate stays disabled while the file is unchanged');
  write(source, 10);
  const repaired = live();
  assert.notEqual(repaired, trusted);
  assert.equal(live.run(fixedPair, 0, custom).formula, repaired, 'a repaired file is trusted after a valid real result');
});

test('if even the trusted formula fails, the settlement error propagates', t => {
  const {live} = liveCopy(t);
  assert.throws(() => live.run([{total: 'x', month: 1000}, {total: 1000, month: 1000}], 0, rating), RangeError);
});

test('a missing file keeps the last good formula', t => {
  const {live, file, warnings} = liveCopy(t);
  const good = live();
  fs.unlinkSync(file);
  assert.equal(live(), good);
  assert.equal(warnings.length, 1);
});
