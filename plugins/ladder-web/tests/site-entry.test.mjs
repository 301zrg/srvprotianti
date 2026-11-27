import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/assets/site-shell.js', import.meta.url), 'utf8');
test('shared pages contain no inline HTML event attributes, including translated markup', () => {
  for (const name of ['intro','rooms','replays','ladder','deck-stats','player-stats','usage-stats','deck-detail']) {
    assert.doesNotMatch(readFileSync(new URL('../web/'+name+'.html', import.meta.url), 'utf8'), /<[^>]*\son[a-z]+\s*=/i, name);
  }
});
function storage() {
  const values = new Map();
  return {getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values};
}
function setup({local = storage(), session = storage()} = {}) {
  const listeners = new Map(), timers = new Map(), sent = [], opened = [];
  const child = {closed: false, postMessage: (...args) => sent.push(args)};
  const window = {
    location: new URL('http://website.test/rooms.html?L=en'), localStorage: local, sessionStorage: session,
    SRVPRO_WEB_CLIENT_URL: 'https://client.test/sub/index.html?fixed=1',
    crypto: {getRandomValues: bytes => bytes.fill(17)},
    addEventListener: (type, fn) => {if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn);},
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    open: (...args) => {opened.push(args); return window.popupBlocked ? null : child;},
    setTimeout: fn => {timers.set('timeout', fn); return 'timeout';}, clearTimeout: id => timers.delete(id),
    setInterval: fn => {timers.set('interval', fn); return 'interval';}, clearInterval: id => timers.delete(id),
    history: {replaceState() {}},
  };
  const document = {addEventListener() {}, querySelector: () => null};
  runInNewContext(source, {window, document, URL, URLSearchParams, Uint8Array, Set, Number});
  const emit = data => [...(listeners.get('message') || [])].forEach(fn => fn(data));
  return {api: window.SrvproWeb, window, local, session, listeners, timers, sent, opened, child, emit};
}

test('account defaults to persistent username and per-tab password; opt-in and clear work', () => {
  const x = setup();
  assert.equal(typeof x.api.saveAccount, 'function', 'shared account cache is available');
  x.api.saveAccount({username: 'Fake', password: 'secret', rememberPassword: false});
  assert.equal([...x.local.values.values()].join('').includes('secret'), false);
  assert.equal(setup({local: x.local, session: x.session}).api.getAccount().password, 'secret');
  assert.equal(setup({local: x.local}).api.getAccount().password, '');
  x.api.saveAccount({username: 'Fake', password: 'secret', rememberPassword: true});
  assert.equal(setup({local: x.local}).api.getAccount().password, 'secret');
  x.api.saveAccount({username: 'Fake', password: 'new', rememberPassword: false});
  assert.equal([...x.local.values.values()].join('').includes('secret'), false);
  x.api.clearAccount();
  assert.equal(x.api.getAccount().username, '');
  assert.equal(x.local.values.size + x.session.values.size, 0);
});

test('blocked storage safely keeps credentials in memory', () => {
  const blocked = new Proxy({}, {get() {throw Error('blocked');}});
  const x = setup({local: blocked, session: blocked});
  x.api.saveAccount({username: 'Fake', password: 'secret', rememberPassword: false});
  assert.equal(x.api.getAccount().password, 'secret');
  x.api.clearAccount();
  assert.equal(x.api.getAccount().password, '');
});

test('mistyped username cannot turn a password suffix into a public query or URL', () => {
  const x = setup();
  assert.throws(() => x.api.saveAccount({username:'Fake$secret',password:''}), /Invalid account/);
  x.window.SRVPRO_WEB_CLIENT_URL = 'https://client.test/?password=secret';
  assert.throws(() => x.api.entryUrl('ladder'), /credentials/);
});

test('public intents preserve base path and language without identity or opener', () => {
  const x = setup();
  x.api.openClient('ladder');
  const url = new URL(x.opened[0][0]);
  assert.equal(url.pathname, '/sub/index.html');
  assert.equal(url.searchParams.get('lang'), 'en');
  assert.equal(url.searchParams.get('intent'), 'ladder');
  assert.equal(x.opened[0][2], 'noopener,noreferrer');
  assert.equal(x.listeners.get('message')?.size || 0, 0);
});

test('bridge ignores forged messages, sends once to exact target, clears on matching result', () => {
  const x = setup();
  x.api.saveAccount({username: 'Fake', password: 'secret'});
  x.api.openClient('ladder');
  const url = new URL(x.opened[0][0]);
  assert.equal(url.href.includes('secret'), false);
  assert.equal(url.href.includes('Fake'), false);
  assert.equal(x.opened[0][2], undefined);
  const request = new URLSearchParams(url.hash.split('?')[1]).get('request');
  const message = {origin: 'https://client.test', source: x.child, data: {channel: 'srvprotiantiweb:entry', version: 1, intent: 'ladder', request, type: 'ready'}};
  for (const patch of [{origin: 'https://evil.test'}, {source: {}}, {data: {...message.data, request: 'forged'}}, {data: {...message.data, intent: 'regular'}}]) x.emit({...message, ...patch});
  assert.equal(x.sent.length, 0);
  x.emit(message); x.emit(message);
  assert.equal(x.sent.length, 1);
  assert.equal(x.sent[0][0].credentials.password, 'secret');
  assert.equal(x.sent[0][1], 'https://client.test');
  x.emit({...message, data: {...message.data, type: 'result', status: 'accepted'}});
  assert.equal(x.listeners.get('message').size, 0);
  assert.equal(x.timers.size, 0);
  x.emit(message);
  assert.equal(x.sent.length, 1);
});

test('partial account uses public link; blocked popup, timeout and rejection clean listeners', () => {
  const partial = setup(); partial.api.saveAccount({username: 'Fake', password: ''}); partial.api.openClient('regular');
  assert.equal(new URL(partial.opened[0][0]).searchParams.get('bridge'), null);
  for (const outcome of ['blocked', 'timeout', 'failed', 'cancelled', 'closed']) {
    const x = setup(); x.api.saveAccount({username: 'Fake', password: 'secret'});
    x.window.popupBlocked = outcome === 'blocked'; x.api.openClient('spectate', {room: 'Room'});
    if (outcome === 'timeout') x.timers.get('timeout')();
    if (outcome === 'closed') {x.child.closed = true; x.timers.get('interval')();}
    if (outcome === 'failed' || outcome === 'cancelled') {
      const url = new URL(x.opened[0][0]), request = new URLSearchParams(url.hash.split('?')[1]).get('request');
      x.emit({origin: url.origin, source: x.child, data: {channel: 'srvprotiantiweb:entry', version: 1, intent: 'spectate', request, type: 'result', status: outcome}});
    }
    assert.equal(x.listeners.get('message').size, 0, outcome);
    assert.equal(x.timers.size, 0, outcome);
  }
});

test('full-width or small dollar usernames are saved with a warning, not refused (design 6.3)', () => {
  const x = setup();
  for (const username of ['Name\uFF04pw', 'Name\uFE69pw']) {
    x.api.saveAccount({username, password: 'p', rememberPassword: false});
    assert.equal(x.api.getAccount().username, username, 'existing accounts keep working from the website');
    assert.match(x.api.lookalikeWarning(username), /full-width/, 'the page explains the half-width separator');
  }
  assert.equal(x.api.lookalikeWarning('Fine'), '');
  assert.throws(() => x.api.saveAccount({username: 'Name$pw', password: 'p', rememberPassword: false}), /Invalid account/);
});

test('change password validates locally, posts once and updates the saved account', async () => {
  const x = setup();
  const calls = [];
  let reply = {status: 200, body: {ok: true}};
  x.window.fetch = async (url, options) => {
    calls.push({url, options});
    return {ok: reply.status === 200, status: reply.status, json: async () => reply.body};
  };
  x.api.saveAccount({username: 'Fake', password: 'old-pw', rememberPassword: true});
  const change = input => x.api.changePassword({username: 'Fake', oldPassword: 'old-pw', newPassword: 'new-pw', confirmPassword: 'new-pw', ...input});
  assert.equal(await change({confirmPassword: 'other'}), 'mismatch');
  assert.equal(await change({newPassword: 'a＄b', confirmPassword: 'a＄b'}), 'chars');
  assert.equal(await change({newPassword: 'x'.repeat(15), confirmPassword: 'x'.repeat(15)}), 'long');
  assert.equal(await change({newPassword: 'old-pw', confirmPassword: 'old-pw'}), 'same');
  assert.equal(await change({oldPassword: ''}), 'empty');
  assert.equal(calls.length, 0, 'local mistakes never reach the server');
  assert.equal(await change({}), 'done');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/ladder/account/password');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {player: 'Fake', oldPassword: 'old-pw', newPassword: 'new-pw'});
  assert.equal(x.api.getAccount().password, 'new-pw', 'the saved account follows the change');
  for (const [status, body, expected] of [[403, {error: 'credentials_invalid'}, 'invalid'], [409, {error: 'credentials_changed'}, 'changed'],
    [429, {error: 'too_many_attempts'}, 'limited'], [404, {}, 'unavailable'], [503, {error: 'password_change_unavailable'}, 'unavailable'],
    [503, {}, 'busy'], [500, {error: 'request_failed'}, 'failed']]) {
    reply = {status, body};
    assert.equal(await change({oldPassword: 'new-pw', newPassword: 'n3', confirmPassword: 'n3'}), expected, `${status}`);
  }
  assert.equal(x.api.getAccount().password, 'new-pw', 'failures leave the saved account alone');
  x.window.fetch = async () => { throw new Error('offline'); };
  assert.equal(await change({oldPassword: 'new-pw', newPassword: 'n4', confirmPassword: 'n4'}), 'failed');
});
