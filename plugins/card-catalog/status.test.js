'use strict';

const assert = require('assert');
const plugin = require('./index');

(async () => {
  let handler;
  await plugin.init({rootDir: __dirname, config: {databaseDirectory: 'missing-synthetic-status-fixture'},
    log: {warn() {}, info() {}}, provide() {}, hook(name, callback) { handler = callback; }});
  let status, payload;
  const response = {writeHead(code) {status = code;}, end(value) {payload = JSON.parse(value);}};
  assert.equal(handler({method: 'GET'}, response, {pathname: '/api/card-catalog/status'}), true);
  assert.equal(status, 503);
  assert.deepStrictEqual(payload, {ok: false, metadataAvailable: false, cardCount: 0, languagesLoaded: 0});
  assert.equal(handler({method: 'POST'}, response, {pathname: '/api/card-catalog/status'}), false);
  assert.equal(handler({method: 'GET'}, response, {pathname: '/unrelated'}), false);
  console.log('Runtime catalog status: missing resources fail readiness without player data');
})().catch(error => {console.error(error); process.exitCode = 1;});
