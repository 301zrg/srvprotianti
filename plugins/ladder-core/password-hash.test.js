'use strict';

// Synthetic credentials only.
const assert = require('assert');
const test = require('node:test');
const hash = require('./password-hash');
const {FixedWindowLimiter, ScryptGate, VerifyCache, clientIpOf} = require('./password-guard');

const FAST = {N: 1 << 10, r: 8, p: 1};

test('strict parsing accepts only well-formed in-bounds hashes', async () => {
  const good = await hash.hashPassword('synthetic-pw', {params: FAST});
  assert.ok(hash.parseHash(good));
  assert.strictEqual(hash.classifyStored(good), 'hash');
  const temp = await hash.hashPassword('tmp-pw', {params: FAST, temporary: true});
  assert.strictEqual(hash.classifyStored(temp), 'temp');
  assert.ok(good.length <= 128, 'fits varchar(128)');
  // Legacy passwords that merely look like the marker remain plaintext.
  for (const legacy of ['scrypt', 'scrypt$', 'Scrypt$16384$8$1$x$y', '12345', 'abc$def']) {
    assert.ok(!hash.parseHash(legacy), legacy);
    assert.ok(hash.isLegacyPlaintext(legacy), legacy);
  }
  assert.strictEqual(hash.classifyStored('scrypt'), 'legacy');
  assert.strictEqual(hash.classifyStored('scrypt$1$2$3$bad$bad'), 'damaged');
  assert.strictEqual(hash.classifyStored(null), 'empty');
  assert.strictEqual(hash.classifyStored(''), 'empty');
  const parts = good.split('$');
  const withParams = (N, r, p) => ['scrypt', N, r, p, parts[4], parts[5]].join('$');
  assert.ok(hash.parseHash(withParams(1 << 16, 16, 4)), 'upper bounds accepted');
  assert.strictEqual(hash.parseHash(withParams(1 << 17, 8, 1)), null, 'N too large');
  assert.strictEqual(hash.parseHash(withParams(3000, 8, 1)), null, 'N not a power of two');
  assert.strictEqual(hash.parseHash(withParams(1024, 17, 1)), null, 'r too large');
  assert.strictEqual(hash.parseHash(withParams(1024, 8, 5)), null, 'p too large');
  assert.strictEqual(hash.parseHash(withParams(1024, 0, 1)), null, 'r zero');
  assert.strictEqual(hash.classifyStored(withParams(1 << 17, 8, 1)), 'damaged');
  assert.strictEqual(hash.parseHash(good + 'x'), null, 'trailing garbage');
});

test('verification supports both stored formats and never needs a rewrite', async () => {
  const stored = await hash.hashPassword('right', {params: FAST});
  assert.deepStrictEqual(await hash.verifyPassword(stored, 'right'), {ok: true, kind: 'hash'});
  assert.deepStrictEqual(await hash.verifyPassword(stored, 'wrong'), {ok: false, kind: 'hash'});
  assert.deepStrictEqual(await hash.verifyPassword('plain1', 'plain1'), {ok: true, kind: 'legacy'});
  assert.deepStrictEqual(await hash.verifyPassword('plain1', 'plain2'), {ok: false, kind: 'legacy'});
  assert.deepStrictEqual(await hash.verifyPassword('scrypt', 'scrypt'), {ok: true, kind: 'legacy'});
  assert.strictEqual((await hash.verifyPassword(null, 'x')).ok, false);
  assert.strictEqual((await hash.verifyPassword('', '')).ok, false);
  assert.strictEqual((await hash.verifyPassword('x', '')).ok, false);
  const temp = await hash.hashPassword('t3mp', {params: FAST, temporary: true});
  assert.deepStrictEqual(await hash.verifyPassword(temp, 't3mp'), {ok: true, kind: 'temp'});
  // A stored hash string typed as the password does not authenticate.
  assert.strictEqual((await hash.verifyPassword(stored, stored)).ok, false);
});

test('new password rules', () => {
  assert.strictEqual(hash.validateNewPassword('Me', ''), 'password_empty');
  for (const bad of ['a$b', 'a＄b', 'a﹩b', 'a\0b', 'a\rb', 'a\nb', 'a\\b']) {
    assert.strictEqual(hash.validateNewPassword('Me', bad), 'password_invalid_chars', JSON.stringify(bad));
  }
  assert.strictEqual(hash.validateNewPassword('Me', 'x'.repeat(16)), null, '2 + 1 + 16 = 19');
  assert.strictEqual(hash.validateNewPassword('Me', 'x'.repeat(17)), 'password_too_long');
  assert.ok(hash.containsLookalikeDollar('ab＄cd'));
  assert.ok(hash.containsLookalikeDollar('ab﹩cd'));
  assert.ok(!hash.containsLookalikeDollar('abcd'));
});

test('temporary password length fits the login field', () => {
  assert.strictEqual(hash.temporaryPasswordLength('abc'), 8);
  assert.strictEqual(hash.temporaryPasswordLength('a'.repeat(13)), 5);
  assert.strictEqual(hash.temporaryPasswordLength('a'.repeat(15)), 3);
  assert.throws(() => hash.temporaryPasswordLength('a'.repeat(16)), RangeError);
  assert.strictEqual(hash.temporaryPasswordLength('a'.repeat(16), 2), 2);
  assert.throws(() => hash.temporaryPasswordLength('a'.repeat(16), 3), RangeError);
  const value = hash.generateTemporaryPassword(8);
  assert.match(value, /^[a-hjkmnp-z2-9]{8}$/);
});

test('fixed window limiter counts before work and resets per window', () => {
  let time = 0;
  const limiter = new FixedWindowLimiter({limit: 2, windowMs: 1000, now: () => time});
  assert.ok(limiter.take('a'));
  assert.ok(limiter.take('a'));
  assert.ok(!limiter.take('a'));
  assert.ok(limiter.exhausted('a'));
  assert.ok(limiter.take('b'));
  time = 1000;
  assert.ok(!limiter.exhausted('a'));
  assert.ok(limiter.take('a'));
});

test('scrypt gate keeps join capacity and fails fast on overflow', async () => {
  const gate = new ScryptGate({slots: 3, webSlots: 1, webQueue: 1, webWaitMs: 50, joinQueue: 1, joinWaitMs: 50});
  const releases = [];
  const blocker = () => new Promise(resolve => releases.push(resolve));
  const web1 = gate.run('web', blocker);
  const web2 = gate.run('web', async () => 'queued');
  await assert.rejects(gate.run('web', blocker), error => error.code === 'busy' && error.statusCode === 503);
  // Joins still get the two reserved slots while the web lane is saturated.
  const join1 = gate.run('join', blocker);
  const join2 = gate.run('join', blocker);
  assert.strictEqual(gate.active.join, 2);
  const join3 = gate.run('join', async () => 'late');
  await Promise.all([
    assert.rejects(join3, error => error.code === 'timeout'),
    assert.rejects(web2, error => error.code === 'timeout')
  ]);
  releases.forEach(release => release('done'));
  assert.strictEqual(await web1, 'done');
  await join1; await join2;
  assert.strictEqual(await gate.run('web', async () => 7), 7);
});

test('verify cache is invalidated by a changed stored hash and expires', () => {
  let time = 0;
  const cache = new VerifyCache({ttlMs: 1000, now: () => time});
  cache.remember('me', 'pw', 'H1');
  assert.ok(cache.hit('me', 'pw', 'H1'));
  assert.ok(!cache.hit('me', 'other', 'H1'));
  assert.ok(!cache.hit('me', 'pw', 'H2'), 'reset or change invalidates');
  cache.remember('me', 'pw', 'H1');
  time = 1000;
  assert.ok(!cache.hit('me', 'pw', 'H1'));
  assert.ok(![...cache.entries.keys()].some(key => key.includes('pw')));
});

test('proxy headers are trusted only from a trusted peer', () => {
  const trusted = ip => ip === '127.0.0.1';
  const fromProxy = {socket: {remoteAddress: '127.0.0.1'}, headers: {'x-forwarded-for': '203.0.113.9, 10.0.0.1'}};
  const direct = {socket: {remoteAddress: '198.51.100.4'}, headers: {'x-forwarded-for': '203.0.113.9'}};
  assert.strictEqual(clientIpOf(fromProxy, trusted), '203.0.113.9');
  assert.strictEqual(clientIpOf(direct, trusted), '198.51.100.4');
  assert.strictEqual(clientIpOf(fromProxy, null), '127.0.0.1');
});
