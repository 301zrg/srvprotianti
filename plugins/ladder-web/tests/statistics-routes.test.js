'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {test} = require('node:test');
const plugin = require('../index');

function setup(usage) {
  const warnings = [];
  let handler;
  plugin.init({
    rootDir: path.join(__dirname, '..'),
    config: {routesFile: 'routes.json', exampleDecksFile: 'example-decks.json'},
    log: {warn: (...args) => warnings.push(args)},
    get: name => ({ladderAnalytics: {}, deckClassifier: {}, ladderUsageAnalytics: usage})[name],
    hook: (name, fn) => { if (name === 'http_request') handler = fn; }
  });
  const call = async query => {
    const response = {headers: {}, setHeader(name, value) { this.headers[name] = value; },
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; }};
    const handled = await handler({method: 'GET'}, response, {pathname: '/api/ladder/usage/cards', query});
    return {handled, status: response.status, headers: response.headers, body: JSON.parse(response.body)};
  };
  return {call, warnings};
}

test('deck distribution shares the card usage path without changing the ranking response', async () => {
  const seen = [];
  const {call} = setup({
    cardUsage: async query => { seen.push(['cards', query]); return {cards: []}; },
    cardDeckUsage: async query => { seen.push(['decks', query]); return {available: true, decks: []}; }
  });
  const ranking = await call({metric: 'monster', period: 'all'});
  assert.deepEqual(ranking.body, {cards: []});
  const split = await call({view: 'deck-distribution', metric: 'monster', cardId: '100', period: 'all'});
  assert.equal(split.handled, true);
  assert.equal(split.status, 200);
  assert.equal(split.headers['Cache-Control'], 'no-store');
  assert.deepEqual(split.body, {available: true, decks: []});
  assert.deepEqual(seen.map(([kind]) => kind), ['cards', 'decks']);
  assert.equal(seen[1][1].cardId, '100');
});

test('deck distribution failures expose only coarse retryable codes', async () => {
  for (const [statusCode, expected] of [[400, 'invalid_request'], [429, 'statistics_busy'], [503, 'statistics_unavailable'], [undefined, 'request_failed']]) {
    const {call, warnings} = setup({cardDeckUsage: async () => { throw Object.assign(new Error('private database details'), {statusCode}); }});
    const result = await call({view: 'deck-distribution', metric: 'monster', cardId: '100'});
    assert.equal(result.status, statusCode || 500);
    assert.deepEqual(result.body, {error: expected});
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.equal(warnings.length, statusCode ? 0 : 1, 'only unexpected failures are logged');
  }
});
