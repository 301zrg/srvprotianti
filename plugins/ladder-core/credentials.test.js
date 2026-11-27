'use strict';

// Credential, password-change, seat-binding and log tests. Synthetic data only.
require('reflect-metadata');
global.PrimaryKeyType = 'integer';
global.DbDateType = 'datetime';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {DataManager} = require('../../data-manager/DataManager');
const {LadderUser, LadderMonthRecord, LadderMatch, LadderMatchGame} = require('./entities');
const core = require('./index')._test;
const hash = require('./password-hash');
const credentials = require('./credentials');
const {ScryptGate} = require('./password-guard');

const FAST = {N: 1 << 10, r: 8, p: 1};

class CountingGate extends ScryptGate {
  constructor() { super(); this.calls = 0; }
  run(lane, task) { this.calls++; return super.run(lane, task); }
}

// TypeORM 0.2 allows one "default" connection: each harness replaces the last.
let openDataManager = null;
async function harness(security = {}, extra = {}) {
  if (openDataManager?.getConnection()?.isConnected) await openDataManager.getConnection().close();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-cred-'));
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
  const writeConfig = local => fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(local));
  fs.writeFileSync(path.join(root, 'config.default.json'), JSON.stringify(config));
  writeConfig(security);
  const dataManager = new DataManager({type: 'sqljs'}, {warn() {}, info() {}});
  dataManager.registerEntities([LadderUser, LadderMonthRecord, LadderMatch, LadderMatchGame]);
  await dataManager.init();
  openDataManager = dataManager;
  dataManager.pluginTransaction = callback => dataManager.getConnection().transaction(callback);
  const logs = [];
  const log = {warn: (...args) => logs.push(['warn', ...args]), info: (...args) => logs.push(['info', ...args])};
  const gate = new CountingGate();
  const api = {rootDir: root, config, dataManager, log, passwordHashParams: FAST, scryptGate: gate,
    get: name => name === 'deckClassifier' ? {classify() { return 4095; }, otherDeckTypeId: 4095} : null,
    emit: async () => {}, ...extra};
  const ladder = core.createService(api);
  const users = dataManager.getRepository(LadderUser);
  return {root, ladder, users, logs, gate, dataManager, writeConfig};
}

const hashed = {passwordHash: {mode: 'hashed'}};
const changeOn = {passwordHash: {mode: 'hashed'}, passwordChange: {enabled: true}};

test('legacy mode stores plaintext, hashed mode stores a hash, login never rewrites', async () => {
  const legacy = await harness();
  assert.ok(await legacy.ladder.authenticate('Plain-User', 'pw-1'));
  assert.strictEqual((await legacy.users.findOne('plain-user')).pass, 'pw-1');
  const h = await harness(hashed);
  const result = await h.ladder.authenticateAccount('Hash-User', 'pw-2');
  assert.ok(result.ok);
  const stored = (await h.users.findOne('hash-user')).pass;
  assert.strictEqual(hash.classifyStored(stored), 'hash');
  assert.strictEqual(result.credentialVersion, stored);
  // A legacy row stays legacy after a successful login.
  await h.users.save(h.users.create({name: 'old-user', displayName: 'Old-User', pass: 'old-pw'}));
  assert.ok(await h.ladder.authenticate('Old-User', 'old-pw'));
  assert.ok(!(await h.ladder.authenticate('Old-User', 'wrong')));
  assert.strictEqual((await h.users.findOne('old-user')).pass, 'old-pw');
  assert.ok(await h.ladder.authenticate('HASH-USER', 'pw-2'));
  assert.ok(!(await h.ladder.authenticate('hash-user', 'pw-x')));
  assert.strictEqual((await h.users.findOne('hash-user')).pass, stored);
});

test('temporary hashes are recognised and flagged', async () => {
  const h = await harness(hashed);
  await h.users.save(h.users.create({name: 'temp-user', displayName: 'Temp-User',
    pass: await hash.hashPassword('tmp12', {params: FAST, temporary: true})}));
  const result = await h.ladder.authenticateAccount('Temp-User', 'tmp12');
  assert.ok(result.ok && result.temporary);
});

test('empty passwords and password-less accounts are rejected before any write', async () => {
  const h = await harness(hashed);
  for (const password of [null, '', undefined]) {
    assert.deepStrictEqual(await h.ladder.authenticateAccount('Nobody', password), {ok: false, reason: 'mismatch'});
  }
  assert.strictEqual(await h.users.count(), 0, 'no password-less account is created');
  await h.users.save(h.users.create({name: 'blank', displayName: 'Blank', pass: null}));
  assert.deepStrictEqual(await h.ladder.authenticateAccount('Blank', 'anything'), {ok: false, reason: 'no_password_account'});
  await h.users.save(h.users.create({name: 'blank2', displayName: 'Blank2', pass: ''}));
  assert.strictEqual((await h.ladder.authenticateAccount('Blank2', 'x')).reason, 'no_password_account');
  assert.strictEqual(await h.ladder.verifyExisting('Blank', 'anything'), false);
});

test('plan C: new nicknames with full-width or small dollar are refused, existing ones still log in', async () => {
  const h = await harness(hashed);
  assert.strictEqual((await h.ladder.authenticateAccount('Name＄abc', 'pw')).reason, 'lookalike_dollar');
  assert.strictEqual((await h.ladder.authenticateAccount('Name﹩abc', 'pw')).reason, 'lookalike_dollar');
  // "name＄password" typed without any ASCII "$" arrives with no password.
  assert.strictEqual((await h.ladder.authenticateAccount('Name＄abc', null)).reason, 'lookalike_dollar');
  assert.strictEqual((await h.ladder.authenticateAccount('Plainname', null)).reason, 'mismatch');
  assert.strictEqual(await h.users.count(), 0);
  await h.users.save(h.users.create({name: 'old＄abc', displayName: 'Old＄abc', pass: 'pw9'}));
  assert.ok(await h.ladder.authenticate('Old＄abc', 'pw9'));
});

test('frozen pauses account creation and credential changes but keeps both formats working', async () => {
  const h = await harness({passwordHash: {mode: 'frozen'}, passwordChange: {enabled: true}});
  assert.strictEqual((await h.ladder.authenticateAccount('Fresh', 'pw')).reason, 'registration_paused');
  await h.users.save(h.users.create({name: 'p', displayName: 'P', pass: 'plain'}));
  await h.users.save(h.users.create({name: 'q', displayName: 'Q', pass: await hash.hashPassword('hpw', {params: FAST})}));
  assert.ok(await h.ladder.authenticate('P', 'plain'));
  assert.ok(await h.ladder.authenticate('Q', 'hpw'));
  const change = await h.ladder.changePassword({player: 'Q', oldPassword: 'hpw', newPassword: 'new1'});
  assert.strictEqual(change.status, 503);
  assert.ok(h.logs.some(entry => entry[1]?.event === 'ladder_password_frozen_quiesced'), 'frozen confirms that no write is in flight');
});

test('legacy cannot come back once hashes exist', async () => {
  const h = await harness();
  await h.users.save(h.users.create({name: 'q', displayName: 'Q', pass: await hash.hashPassword('hpw', {params: FAST})}));
  await h.ladder.checkStoredHashes();
  assert.strictEqual((await h.ladder.readSecurity()).mode, 'frozen');
  assert.strictEqual((await h.ladder.authenticateAccount('Fresh', 'pw')).reason, 'registration_paused');
  // In-process too: after hashed was seen, a later legacy edit means frozen.
  const g = await harness(hashed);
  await g.ladder.readSecurity();
  g.writeConfig({passwordHash: {mode: 'legacy'}});
  assert.strictEqual((await g.ladder.readSecurity()).mode, 'frozen');
});

test('simultaneous first logins create exactly one account', async () => {
  const h = await harness(hashed);
  const results = await Promise.all([
    h.ladder.authenticateAccount('Twin', 'pw-a'),
    h.ladder.authenticateAccount('Twin', 'pw-a'),
    h.ladder.authenticateAccount('Twin', 'pw-b')
  ]);
  assert.strictEqual(await h.users.count(), 1);
  const stored = (await h.users.findOne('twin')).pass;
  const winnerPassword = (await hash.verifyPassword(stored, 'pw-a')).ok ? 'pw-a' : 'pw-b';
  for (const [index, password] of ['pw-a', 'pw-a', 'pw-b'].entries()) {
    assert.strictEqual(results[index].ok, password === winnerPassword);
  }
});

test('conditional updates: concurrent changes and a reset racing a change', async () => {
  const h = await harness(changeOn);
  await h.ladder.authenticate('Racer', 'start-pw');
  const outcomes = await Promise.all([
    h.ladder.changePassword({player: 'Racer', oldPassword: 'start-pw', newPassword: 'next-a'}),
    h.ladder.changePassword({player: 'Racer', oldPassword: 'start-pw', newPassword: 'next-b'})
  ]);
  const statuses = outcomes.map(outcome => outcome.status).sort();
  assert.strictEqual(statuses.filter(status => status === 200).length, 1, `exactly one change wins: ${statuses}`);
  assert.ok(statuses.some(status => status === 409 || status === 403));
  // A reset that read an older credential must not overwrite a newer one.
  const manager = h.users.manager;
  const current = (await h.users.findOne('racer')).pass;
  assert.strictEqual(await credentials.compareAndSetPass(manager, 'racer', 'start-pw', 'reset-value'), false);
  assert.strictEqual((await h.users.findOne('racer')).pass, current);
  assert.strictEqual(await credentials.compareAndSetPass(manager, 'racer', current, 'reset-value'), true);
});

test('password change endpoint rules', async () => {
  const h = await harness({passwordHash: {mode: 'hashed'}});
  await h.ladder.authenticate('Owner', 'old-pw');
  assert.strictEqual((await h.ladder.changePassword({player: 'Owner', oldPassword: 'old-pw', newPassword: 'n'})).status, 404, 'off by default');
  h.writeConfig(changeOn);
  const call = (body, ip = '198.51.100.1') => h.ladder.changePassword(body, {ip});
  assert.strictEqual((await call({player: 'Owner', oldPassword: 'old-pw', newPassword: ''})).body.error, 'password_empty');
  assert.strictEqual((await call({player: 'Owner', oldPassword: 'old-pw', newPassword: 'a$b'})).body.error, 'password_invalid_chars');
  assert.strictEqual((await call({player: 'Owner', oldPassword: 'old-pw', newPassword: 'x'.repeat(14)})).body.error, 'password_too_long');
  assert.strictEqual((await call({player: 'Owner', oldPassword: 'old-pw', newPassword: 'old-pw'})).body.error, 'password_unchanged');
  const unknown = await call({player: 'Ghost', oldPassword: 'x', newPassword: 'y'});
  const wrong = await call({player: 'Owner', oldPassword: 'x', newPassword: 'y'});
  assert.deepStrictEqual(unknown, wrong, 'unknown account and wrong password look identical');
  assert.strictEqual(wrong.status, 403);
  h.ladder._resetAdmissionForTests();
  assert.strictEqual((await call({player: 'Owner', oldPassword: 'old-pw', newPassword: 'new-pw'})).status, 200, 'live enable works without restart');
  assert.ok(await h.ladder.authenticate('Owner', 'new-pw'));
  assert.ok(!(await h.ladder.authenticate('Owner', 'old-pw')));
  assert.strictEqual(hash.classifyStored((await h.users.findOne('owner')).pass), 'hash');
  // Five failures lock the account for 15 minutes, from any address.
  h.ladder._resetAdmissionForTests();
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await call({player: 'Owner', oldPassword: `bad${i}`, newPassword: 'z'}, `203.0.113.${i}`)).status, 403);
  }
  assert.strictEqual((await call({player: 'Owner', oldPassword: 'new-pw', newPassword: 'z'}, '203.0.113.99')).status, 429);
  // Disabling again takes effect immediately.
  h.writeConfig(hashed);
  assert.strictEqual((await call({player: 'Owner', oldPassword: 'new-pw', newPassword: 'z'})).status, 404);
});

test('data-site verification: only scrypt work is counted, cache invalidated by a changed hash', async () => {
  const h = await harness(changeOn, {config: {...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8')),
    passwordSecurity: {webPerAccountPerMinute: 3, webPerIpPerMinute: 5}}});
  await h.ladder.authenticate('Viewer', 'view-pw');
  h.gate.calls = 0;
  assert.ok(await h.ladder.verifyExisting('Viewer', 'view-pw', {ip: '192.0.2.1'}));
  for (let i = 0; i < 10; i++) assert.ok(await h.ladder.verifyExisting('Viewer', 'view-pw', {ip: '192.0.2.1'}));
  assert.strictEqual(h.gate.calls, 1, 'repeat requests are cache hits');
  // An offline reset changes the row; the cache entry must not survive it.
  const manager = h.users.manager;
  const before = (await h.users.findOne('viewer')).pass;
  await credentials.compareAndSetPass(manager, 'viewer', before, await hash.hashPassword('reset-pw', {params: FAST, temporary: true}));
  assert.ok(!(await h.ladder.verifyExisting('Viewer', 'view-pw', {ip: '192.0.2.1'})), 'second scrypt');
  assert.ok(await h.ladder.verifyExisting('Viewer', 'reset-pw', {ip: '192.0.2.1'}), 'third scrypt');
  // Budget of 3 per account is now used up; a fourth scrypt is refused before any work.
  h.gate.calls = 0;
  await assert.rejects(h.ladder.verifyExisting('Viewer', 'guess', {ip: '192.0.2.9'}), error => error.statusCode === 429);
  assert.strictEqual(h.gate.calls, 0, 'refused before any scrypt');
  assert.ok(await h.ladder.verifyExisting('Viewer', 'reset-pw', {ip: '192.0.2.9'}), 'cache hits still pass while throttled');
  // Legacy plaintext accounts cost nothing and are never throttled.
  await h.users.save(h.users.create({name: 'plain', displayName: 'Plain', pass: 'plain-pw'}));
  for (let i = 0; i < 20; i++) await h.ladder.verifyExisting('Plain', `x${i}`, {ip: '192.0.2.50'});
  assert.ok(await h.ladder.verifyExisting('Plain', 'plain-pw', {ip: '192.0.2.50'}));
});

const playMatch = async (h, roomId, names, winner, {bind = true, outcome = {matchCompleted: true}} = {}) => {
  for (const [index, side] of [winner, winner].entries()) {
    h.ladder.captureGame({roomId, randomType: 'TT', duelCount: index + 1, winnerName: names[side], capturedAt: new Date(),
      players: names.map((name, i) => ({name, isFirst: i === 0, main: [], side: []}))});
  }
  if (bind) {
    h.ladder.registerSeats(roomId, names.map((name, index) => ({name, name_vpass: `${name}$seat-pw`, pos: index,
      account_binding: bind === 'partial' && index === 1 ? null : {key: core.normalizeName(name)}})));
  }
  await h.ladder.finishRoom({process_pid: roomId, random_type: 'TT'},
    names.map((name, index) => ({name, name_vpass: `${name}$seat-pw`, score: index === winner ? 2 : 0})), outcome);
};

test('settlement trusts seats, runs no scrypt, survives a mid-match password change', async () => {
  const h = await harness(changeOn);
  await h.ladder.authenticate('Seat-A', 'seat-pw');
  await h.ladder.authenticate('Seat-B', 'seat-pw');
  // Seat-A changes the password during the match: the result still counts.
  assert.strictEqual((await h.ladder.changePassword({player: 'Seat-A', oldPassword: 'seat-pw', newPassword: 'changed'})).status, 200);
  h.gate.calls = 0;
  await playMatch(h, 501, ['Seat-A', 'Seat-B'], 0);
  assert.strictEqual(h.gate.calls, 0, 'no scrypt during settlement');
  assert.strictEqual(await h.dataManager.getRepository(LadderMatch).count(), 1);
  // Seats without a verified account are not settled, and leave no state.
  await playMatch(h, 502, ['Seat-A', 'Seat-B'], 1, {bind: 'partial'});
  await playMatch(h, 503, ['Seat-A', 'Seat-B'], 1, {bind: false});
  assert.strictEqual(await h.dataManager.getRepository(LadderMatch).count(), 1);
  assert.ok(h.logs.some(entry => entry[1]?.event === 'ladder_settlement_unbound'));
  // A missing account row is not rebuilt from the snapshot.
  await playMatch(h, 504, ['Seat-A', 'Ghost-C'], 0);
  assert.strictEqual(await h.dataManager.getRepository(LadderMatch).count(), 1);
  assert.strictEqual(await h.users.findOne('ghost-c'), undefined);
  // Early-return branches clean the room state too.
  h.ladder.ensureState(505);
  await h.ladder.finishRoom({process_pid: 505, random_type: 'TT'}, [{name: 'x', score: 1}, {name: 'y', score: 1}], {matchCompleted: true});
  for (const id of [501, 502, 503, 504, 505]) {
    assert.ok(!h.ladder.hasRoomState(id), `room ${id} state cleared`);
  }
});

test('password change is refused while the account has a live TT seat', async () => {
  const h = await harness(changeOn);
  await h.ladder.authenticate('Busy-A', 'a-pw');
  await h.ladder.authenticate('Busy-B', 'b-pw');
  h.ladder.registerSeats(601, [
    {name: 'Busy-A', name_vpass: 'Busy-A$a-pw', pos: 0, account_binding: {key: 'busy-a'}},
    {name: 'Busy-B', name_vpass: 'Busy-B$b-pw', pos: 1, account_binding: {key: 'busy-b'}}
  ]);
  const change = () => h.ladder.changePassword({player: 'BUSY-A', oldPassword: 'a-pw', newPassword: 'a-new'});
  assert.deepStrictEqual(await change(), {status: 409, body: {error: 'account_in_match'}});
  assert.ok(await h.ladder.authenticate('Busy-A', 'a-pw'), 'the password is unchanged');
  // Once the room is gone the change goes through.
  await h.ladder.finishRoom({process_pid: 601, random_type: 'TT'}, [{name: 'x', score: 0}, {name: 'y', score: 0}], {matchCompleted: false});
  assert.strictEqual((await change()).status, 200);
  assert.ok(await h.ladder.authenticate('Busy-A', 'a-new'));
  // A waiting room that has not started yet counts too; spectators do not.
  const previous = global.ROOM_all;
  try {
    const waiting = {random_type: 'TT', deleted: false, players: [{name: 'Busy-A', pos: 0}]};
    global.ROOM_all = [waiting];
    const again = () => h.ladder.changePassword({player: 'Busy-A', oldPassword: 'a-new', newPassword: 'a-3'});
    assert.deepStrictEqual(await again(), {status: 409, body: {error: 'account_in_match'}}, 'waiting room blocks the change');
    waiting.players = [{name: 'Busy-A', pos: 7}];
    global.ROOM_all = [waiting, {random_type: 'M', players: [{name: 'Busy-A', pos: 0}]}, {random_type: 'TT', deleted: true, players: [{name: 'Busy-A', pos: 0}]}];
    assert.strictEqual((await again()).status, 200, 'spectating, other modes and deleted rooms do not block');
  } finally {
    global.ROOM_all = previous;
  }
});

test('credential failures never put passwords into logs', async () => {
  const secret = 'Synthetic-Secret-77';
  const h = await harness(changeOn);
  await h.ladder.authenticate('Logged', secret);
  // Simulate the TypeORM error shape, which carries the SQL parameters.
  const failing = new Error(`update failed with ${secret}`);
  failing.name = 'QueryFailedError';
  failing.parameters = [secret];
  const original = h.users.manager.createQueryBuilder.bind(h.users.manager);
  h.users.manager.createQueryBuilder = () => { throw failing; };
  try {
    await assert.rejects(h.ladder.changePassword({player: 'Logged', oldPassword: secret, newPassword: 'other-1'}));
  } finally {
    h.users.manager.createQueryBuilder = original;
  }
  assert.strictEqual(credentials.safeErrorCode(failing), 'query_failed');
  const serialized = JSON.stringify(h.logs, (key, value) => value instanceof Error ? {message: value.message, ...value} : value);
  assert.ok(!serialized.includes(secret), 'no credential in service logs');
});

test('passwordSecurity tuning: defaults, valid overrides, invalid fields fall back by name', () => {
  const normalize = value => credentials.normalizePasswordSecurity(value, {paramsAllowed: hash.paramsAllowed});
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8')).passwordSecurity;
  assert.deepStrictEqual(normalize(shipped).invalid, [], 'the shipped defaults are valid');
  assert.deepStrictEqual(normalize(undefined).config, credentials.SECURITY_DEFAULTS);
  const tuned = normalize({scrypt: {N: 1 << 15}, webPerAccountPerMinute: 30, slots: 6});
  assert.deepStrictEqual([tuned.config.scrypt.N, tuned.config.webPerAccountPerMinute, tuned.config.slots, tuned.invalid], [1 << 15, 30, 6, []]);
  const bad = normalize({scrypt: {N: 3000}, webQueue: -1, webSlots: 9, slots: 4, webWaitMs: 'x'});
  assert.deepStrictEqual(bad.invalid.sort(), ['scrypt', 'webQueue', 'webSlots', 'webWaitMs']);
  assert.deepStrictEqual([bad.config.scrypt.N, bad.config.webQueue, bad.config.webSlots, bad.config.webWaitMs], [16384, 8, 4, 2000]);
});

test('admission budgets come from passwordSecurity', async () => {
  const h = await harness(changeOn, {config: {...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8')),
    passwordSecurity: {webPerIpPerMinute: 2}}});
  await h.ladder.authenticate('Budget', 'pw');
  await h.ladder.verifyExisting('Budget', 'wrong-1', {ip: '192.0.2.1'});
  await h.ladder.verifyExisting('Budget', 'wrong-2', {ip: '192.0.2.1'});
  await assert.rejects(h.ladder.verifyExisting('Budget', 'wrong-3', {ip: '192.0.2.1'}), error => error.statusCode === 429);
});

test('every four-language TT message fits one client chat packet', () => {
  // STOC_Chat holds at most 256 UTF-16 units including the "[Server]: "
  // prefix and the terminator; a longer message is dropped by the client
  // (found in lab testing 11-27). Keep a little headroom.
  const translations = require('./i18n.json');
  // Keys combined by fourLanguageMessage(), directly or via authFailureMessages.
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const keys = new Set([...source.matchAll(/fourLanguageMessage\('([a-z_]+)'\)/g), ...source.matchAll(/: '(ladder_[a-z_]+)'/g)].map(match => match[1]));
  assert.ok(keys.has('ladder_fullwidth_dollar') && keys.has('ladder_auth_mismatch'));
  for (const key of keys) {
    const combined = ['zh-cn', 'en-us', 'ja-jp', 'ko-kr'].map(language => translations[language][key]).join(' / ');
    assert.ok(combined.length + '[Server]: '.length < 250, `${key} is ${combined.length} characters`);
  }
});
