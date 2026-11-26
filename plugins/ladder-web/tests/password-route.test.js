'use strict';

// POST /api/ladder/account/password and client address handling (design 2.5,
// 2.11). ladder-core is stubbed; its rules are covered by credentials.test.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {Readable} = require('stream');
const ladderWeb = require('../index');
const {clientIpOf} = require('../client-ip');

function makeRequest(body, {method = 'POST', peer = '127.0.0.1', forwarded} = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.socket = {remoteAddress: peer};
  request.headers = forwarded ? {'x-forwarded-for': forwarded} : {};
  return request;
}
function makeResponse() {
  return {headers: {}, setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; }};
}

function setup(changePassword) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-password-route-'));
  fs.writeFileSync(path.join(root, 'routes.json'), '{}');
  const logs = [];
  let handler;
  const services = {
    ladderAnalytics: {}, ladderUsageAnalytics: {}, deckClassifier: {},
    ladderCore: {changePassword}
  };
  ladderWeb.init({rootDir: root, config: {routesFile: 'routes.json'}, log: {warn: (...args) => logs.push(args), info() {}},
    get: name => services[name], hook: (name, fn) => { if (name === 'http_request') handler = fn; }});
  const call = async (request, pathname = '/api/ladder/account/password') => {
    const response = makeResponse();
    const handled = await handler(request, response, {pathname, query: {}});
    return {handled, response};
  };
  return {call, logs};
}

test('client address trusts proxy headers only from a trusted peer', () => {
  const trusted = ip => ip === '127.0.0.1';
  assert.strictEqual(clientIpOf(makeRequest({}, {peer: '127.0.0.1', forwarded: '203.0.113.9, 10.0.0.1'}), trusted), '203.0.113.9');
  assert.strictEqual(clientIpOf(makeRequest({}, {peer: '198.51.100.4', forwarded: '203.0.113.9'}), trusted), '198.51.100.4');
  assert.strictEqual(clientIpOf(makeRequest({}, {peer: '127.0.0.1', forwarded: '203.0.113.9'}), null), '127.0.0.1');
  assert.strictEqual(clientIpOf(makeRequest({}, {peer: '127.0.0.1', forwarded: '203.0.113.9'}), () => { throw new Error('x'); }), '127.0.0.1');
});

test('password route forwards to ladder-core with the trusted client address', async () => {
  const seen = [];
  const x = setup(async (input, context) => { seen.push({input, context}); return {status: 200, body: {ok: true}}; });
  global.isTrustedProxy = ip => ip === '127.0.0.1';
  try {
    const {handled, response} = await x.call(makeRequest({player: 'P', oldPassword: 'a', newPassword: 'b', extra: 'ignored'},
      {peer: '127.0.0.1', forwarded: '203.0.113.5'}));
    assert.strictEqual(handled, true);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers['Cache-Control'], 'no-store');
    assert.deepStrictEqual(seen[0], {input: {player: 'P', oldPassword: 'a', newPassword: 'b'}, context: {ip: '203.0.113.5'}});
    await x.call(makeRequest({player: 'P', oldPassword: 'a', newPassword: 'b'}, {peer: '198.51.100.8', forwarded: '203.0.113.5'}));
    assert.strictEqual(seen[1].context.ip, '198.51.100.8', 'a spoofed header from an untrusted peer is ignored');
  } finally {
    delete global.isTrustedProxy;
  }
});

test('disabled endpoint is not handled (404 upstream), other methods fall through', async () => {
  const x = setup(async () => ({status: 404, body: {error: 'not_found'}}));
  assert.strictEqual((await x.call(makeRequest({player: 'P'}))).handled, false);
  assert.strictEqual((await x.call(makeRequest({}, {method: 'GET'}))).handled, false);
});

test('status codes pass through and failures never log credentials', async () => {
  const secret = 'Synthetic-Secret-91';
  let answer = {status: 409, body: {error: 'credentials_changed'}};
  const x = setup(async () => { if (answer instanceof Error) throw answer; return answer; });
  let result = await x.call(makeRequest({player: 'P', oldPassword: secret, newPassword: 'n'}));
  assert.strictEqual(result.response.status, 409);
  assert.deepStrictEqual(JSON.parse(result.response.body), {error: 'credentials_changed'});
  answer = Object.assign(new Error(`insert failed for ${secret}`), {name: 'QueryFailedError', parameters: [secret]});
  result = await x.call(makeRequest({player: 'P', oldPassword: secret, newPassword: 'n'}));
  assert.strictEqual(result.response.status, 500);
  assert.ok(!String(result.response.body).includes(secret));
  assert.ok(!JSON.stringify(x.logs).includes(secret), 'logs carry a code only');
  answer = Object.assign(new Error('slots'), {statusCode: 503});
  result = await x.call(makeRequest({player: 'P', oldPassword: 'a', newPassword: 'b'}));
  assert.strictEqual(result.response.status, 503);
  const bad = Readable.from([Buffer.from('{not json')]);
  Object.assign(bad, {method: 'POST', socket: {remoteAddress: '127.0.0.1'}, headers: {}});
  assert.strictEqual((await x.call(bad)).response.status, 400);
});
