import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const calculator = require('../web/assets/rating-calculator.js');
const plugin = require('../index.js');

test('the page keeps no copy of the settlement formula', () => {
  for (const name of ['calculateDelta', 'calculateCombined', 'calculateMatchOutcomes']) {
    assert.equal(calculator[name], undefined, `${name} must stay server-side in ladder-core/rating-formula.js`);
  }
});

test('nickname cleanup and same-account detection follow server name normalization', () => {
  assert.equal(calculator.sanitizeNickname('  Alice$secret '), 'Alice');
  assert.equal(calculator.sanitizeNickname(null), '');
  assert.equal(calculator.sameAccount(' Alice ', 'alice$pw'), true);
  assert.equal(calculator.sameAccount('Alice', 'Bob'), false);
});

test('floor detection flags either balance being clipped', () => {
  const player = {total: 5, month: 1000};
  assert.equal(calculator.hitsFloor(player, -15, {total: 0, month: 985}), true);
  assert.equal(calculator.hitsFloor({total: 1000, month: 3}, -8, {total: 992, month: 0}), true);
  assert.equal(calculator.hitsFloor({total: 1000, month: 1000}, -8, {total: 992, month: 992}), false);
});

test('all four languages define the exact same non-empty translation keys', () => {
  const keys = Object.keys(calculator.TEXT.zh).sort();
  for (const lang of ['ja', 'en', 'ko']) {
    assert.deepEqual(Object.keys(calculator.TEXT[lang]).sort(), keys, `${lang} keys differ from zh`);
    for (const key of keys) assert.ok(String(calculator.TEXT[lang][key]).trim(), `${lang}.${key} is empty`);
  }
});

function route(analytics) {
  const warnings = [];
  let handler;
  plugin.init({
    rootDir: fileURLToPath(new URL('..', import.meta.url)),
    config: {routesFile: 'routes.json', exampleDecksFile: 'example-decks.json'},
    log: {warn: (...args) => warnings.push(args)},
    get: name => ({ladderAnalytics: analytics, deckClassifier: {}, ladderUsageAnalytics: {}})[name],
    hook: (name, fn) => { if (name === 'http_request') handler = fn; }
  });
  return async (body, method = 'POST') => {
    const {Readable} = await import('node:stream');
    const request = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    request.method = method;
    const response = {headers: {}, setHeader(name, value) { this.headers[name] = value; },
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(text) { this.body = text; }};
    const handled = await handler(request, response, {pathname: '/api/ladder/rating-preview', query: {}});
    return {handled, status: response.status, headers: response.headers, body: response.body && JSON.parse(response.body), warnings};
  };
}

test('rating preview route passes both names to ladder-core and returns its result unchanged', async () => {
  const seen = [];
  const call = route({ratingPreview: async names => { seen.push(names); return {players: [], outcomes: [], rules: {}}; }});
  const result = await call({playerA: 'Alice', playerB: 'Bob', extra: 'ignored'});
  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.deepEqual(seen, [['Alice', 'Bob']]);
  assert.deepEqual(result.body, {players: [], outcomes: [], rules: {}});
});

test('rating preview route exposes only coarse error codes', async () => {
  const fail = error => route({ratingPreview: async () => { throw error; }});
  const cases = [
    [Object.assign(new Error('x'), {statusCode: 400, code: 'same_player'}), 400, 'same_player'],
    [Object.assign(new Error('x'), {statusCode: 400, code: 'invalid_player'}), 400, 'invalid_player'],
    [Object.assign(new Error('x'), {statusCode: 400, code: 'something_internal'}), 400, 'invalid_request'],
    [new Error('private database details'), 500, 'request_failed']
  ];
  for (const [error, status, code] of cases) {
    const result = await fail(error)({playerA: 'A', playerB: 'B'});
    assert.equal(result.status, status);
    assert.deepEqual(result.body, {error: code});
    assert.equal(result.warnings.length, status === 500 ? 1 : 0, 'only unexpected failures are logged');
  }
  const malformed = await route({ratingPreview: async () => ({})})('{not json');
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body, {error: 'invalid_request'});
  const oversized = await route({ratingPreview: async () => ({})})({playerA: 'x'.repeat(2000), playerB: 'y'});
  assert.equal(oversized.status, 400);
  const missing = await route({})({playerA: 'A', playerB: 'B'});
  assert.equal(missing.status, 503);
  assert.deepEqual(missing.body, {error: 'unavailable'});
});
