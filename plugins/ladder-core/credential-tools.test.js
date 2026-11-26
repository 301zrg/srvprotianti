'use strict';

// Offline credential tools: reset, bulk conversion, realName scrub.
// Synthetic data only.
require('reflect-metadata');
global.PrimaryKeyType = 'integer';
global.DbDateType = 'datetime';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {MoreThan} = require('typeorm');
const {DataManager} = require('../../data-manager/DataManager');
const {LadderUser, LadderMonthRecord, LadderMatch, LadderMatchGame} = require('./entities');
const core = require('./index')._test;
const hash = require('./password-hash');
const credentials = require('./credentials');
const tools = require('./credential-tools');
const migrate = require('./migrations/2027xx-hash-passwords/migrate');
const scrubScript = require('./migrations/2027xx-scrub-realname/scrub');
const resetCli = require('./reset-password');

const FAST = {N: 1 << 10, r: 8, p: 1};
let openDataManager = null;

async function harness(mode = 'hashed') {
  if (openDataManager?.getConnection()?.isConnected) await openDataManager.getConnection().close();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-cred-tools-'));
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'config.default.json'), JSON.stringify(config));
  const setMode = value => fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({passwordHash: {mode: value}, passwordChange: {enabled: true}}));
  setMode(mode);
  const dataManager = new DataManager({type: 'sqljs'}, {warn() {}, info() {}});
  dataManager.registerEntities([LadderUser, LadderMonthRecord, LadderMatch, LadderMatchGame]);
  await dataManager.init();
  openDataManager = dataManager;
  const users = dataManager.getRepository(LadderUser);
  const ladder = core.createService({rootDir: root, config, dataManager, log: {warn() {}, info() {}}, passwordHashParams: FAST,
    get: () => null, emit: async () => {}});
  // The same store interface the PostgreSQL scripts use, over this database.
  const store = {
    writes: 0,
    beforeWrite: null,
    get: async key => (await users.findOne(key)) || null,
    page: async (after, limit) => users.find({where: {name: MoreThan(after)}, order: {name: 'ASC'}, take: limit}),
    async compareAndSet(key, expected, next) {
      if (this.beforeWrite) await this.beforeWrite(key);
      this.writes++;
      return credentials.compareAndSetPass(users.manager, key, expected, next);
    },
    anyHashed: () => credentials.anyHashedCredential(users.manager),
    close: async () => {}
  };
  return {root, users, ladder, store, setMode, opts: {params: FAST, pluginDir: root}};
}

test('reset refuses outside hashed mode and never overwrites a concurrent change', async () => {
  for (const mode of ['legacy', 'frozen']) {
    const h = await harness(mode);
    await h.users.save(h.users.create({name: 'player', displayName: 'Player', pass: 'pw'}));
    await assert.rejects(tools.resetPassword(h.store, 'Player', h.opts), error => error.code === 'mode_not_hashed', mode);
    assert.strictEqual((await h.users.findOne('player')).pass, 'pw');
  }
  const h = await harness();
  await assert.rejects(tools.resetPassword(h.store, 'Nobody', h.opts), error => error.code === 'account_not_found');
  await h.users.save(h.users.create({name: 'player', displayName: 'Player', pass: 'pw'}));
  h.store.beforeWrite = async () => {
    h.store.beforeWrite = null;
    await h.users.update('player', {pass: 'changed-meanwhile'});
  };
  await assert.rejects(tools.resetPassword(h.store, 'Player', h.opts), error => error.code === 'credential_changed');
  assert.strictEqual((await h.users.findOne('player')).pass, 'changed-meanwhile');
});

test('reset, login with the temporary password, then change it: 13- and 16-unit nicknames', async () => {
  const h = await harness();
  for (const [nickname, options, expectedLength] of [['N'.repeat(13), {}, 5], ['M'.repeat(16), {length: 2}, 2], ['Short', {}, 8]]) {
    await h.users.save(h.users.create({name: nickname.toLowerCase(), displayName: nickname, pass: 'old-plain'}));
    const result = await tools.resetPassword(h.store, nickname, {...h.opts, ...options});
    assert.strictEqual(result.temporaryPassword.length, expectedLength);
    assert.ok(nickname.length + 1 + result.temporaryPassword.length <= 19, 'fits the client login field');
    assert.strictEqual(!!result.warning, expectedLength < 3);
    const stored = (await h.users.findOne(nickname.toLowerCase())).pass;
    assert.strictEqual(hash.classifyStored(stored), 'temp');
    assert.ok(!stored.includes(result.temporaryPassword));
    assert.ok(!(await h.ladder.authenticate(nickname, 'old-plain')), 'the old password stops working');
    const login = await h.ladder.authenticateAccount(nickname, result.temporaryPassword);
    assert.ok(login.ok && login.temporary, 'temporary login is flagged for the reminder');
    const next = 'n'.repeat(Math.min(3, 18 - nickname.length) || 1);
    if (nickname.length + 1 + next.length <= 19) {
      h.ladder._resetAdmissionForTests();
      const change = await h.ladder.changePassword({player: nickname, oldPassword: result.temporaryPassword, newPassword: next});
      assert.strictEqual(change.status, 200, nickname);
      assert.strictEqual(hash.classifyStored((await h.users.findOne(nickname.toLowerCase())).pass), 'hash');
    }
  }
  assert.throws(() => hash.temporaryPasswordLength('M'.repeat(16)), RangeError, 'a 16-unit nickname needs an explicit --length');
  assert.deepStrictEqual(resetCli.parseArgs(['node', 'x', 'Name', '--length', '2']), {nickname: 'Name', length: 2});
  assert.throws(() => resetCli.parseArgs(['node', 'x', 'Name', '--length', 'x']));
});

test('bulk conversion: dry-run, apply, idempotent rerun, damaged rows reported', async () => {
  const h = await harness();
  const already = await hash.hashPassword('done-pw', {params: FAST});
  await h.users.save([
    {name: 'a', displayName: 'A', pass: 'plain-a'},
    {name: 'b', displayName: 'B', pass: 'scrypt'},
    {name: 'c', displayName: 'C', pass: already},
    {name: 'd', displayName: 'D', pass: null},
    {name: 'e', displayName: 'E', pass: 'scrypt$16384$8$1$broken$value'},
    {name: 'f', displayName: 'F', pass: '12345'}
  ].map(row => h.users.create(row)));
  const dry = await tools.convertPasswords(h.store, {...h.opts, batchSize: 2});
  assert.deepStrictEqual([dry.scanned, dry.legacy, dry.hashed, dry.empty, dry.converted, dry.damaged], [6, 3, 1, 1, 0, ['e']]);
  assert.strictEqual(h.store.writes, 0, 'dry-run writes nothing');
  const applied = await tools.convertPasswords(h.store, {...h.opts, apply: true, batchSize: 2});
  assert.strictEqual(applied.converted, 3);
  assert.deepStrictEqual(applied.damaged, ['e'], 'damaged rows are reported, not skipped silently');
  assert.deepStrictEqual(await tools.remainingLegacy(h.store), {legacy: 0, damaged: 1});
  for (const [name, password] of [['A', 'plain-a'], ['B', 'scrypt'], ['F', '12345'], ['C', 'done-pw']]) {
    assert.ok(await h.ladder.authenticate(name, password), `${name} still logs in after conversion`);
  }
  assert.strictEqual((await h.users.findOne('c')).pass, already, 'existing hashes are untouched');
  const writes = h.store.writes;
  const again = await tools.convertPasswords(h.store, {...h.opts, apply: true});
  assert.strictEqual(again.converted, 0);
  assert.strictEqual(h.store.writes, writes, 'second apply is a no-op');
  const text = migrate.report(applied, {legacy: 0, damaged: 1});
  for (const secret of ['plain-a', '12345', already]) assert.ok(!text.includes(secret), 'report has no credentials');
  assert.throws(() => migrate.parseArgs(['node', 'x', '--apply']), /--confirm/);
  assert.throws(() => migrate.parseArgs(['node', 'x']), /exactly one/);
  assert.strictEqual(migrate.parseArgs(['node', 'x', '--apply', '--confirm', migrate.CONFIRMATION]).apply, true);
});

test('conversion respects concurrent changes and stops when the mode leaves hashed', async () => {
  const h = await harness();
  await h.users.save(['p1', 'p2', 'p3'].map(name => h.users.create({name, displayName: name, pass: `${name}-pw`})));
  // A password change lands between the conversion's read and its write.
  h.store.beforeWrite = async key => {
    if (key !== 'p1') return;
    h.store.beforeWrite = null;
    h.ladder._resetAdmissionForTests();
    assert.strictEqual((await h.ladder.changePassword({player: 'p1', oldPassword: 'p1-pw', newPassword: 'p1-new'})).status, 200);
  };
  const summary = await tools.convertPasswords(h.store, {...h.opts, apply: true});
  assert.ok(summary.retried >= 1);
  assert.ok(await h.ladder.authenticate('p1', 'p1-new'), 'the owner\'s new password survives the conversion');
  assert.ok(!(await h.ladder.authenticate('p1', 'p1-pw')));
  assert.ok(await h.ladder.authenticate('p2', 'p2-pw'));
  // Switching to frozen stops a running conversion before its next write.
  const g = await harness();
  await g.users.save(['q1', 'q2', 'q3'].map(name => g.users.create({name, displayName: name, pass: `${name}-pw`})));
  g.store.beforeWrite = async () => { g.store.beforeWrite = null; g.setMode('frozen'); };
  const stopped = await tools.convertPasswords(g.store, {...g.opts, apply: true});
  assert.strictEqual(stopped.stoppedBecauseMode, 'frozen');
  assert.strictEqual(stopped.converted, 1);
  // Logins during and after a partial conversion work in both formats.
  for (const name of ['q1', 'q2', 'q3']) assert.ok(await g.ladder.authenticate(name, `${name}-pw`));
  await assert.rejects(tools.convertPasswords(g.store, {...g.opts, apply: true}), error => error.code === 'mode_not_hashed');
});

test('legacy configuration with hashes present is treated as frozen by the tools', async () => {
  const h = await harness('legacy');
  await h.users.save(h.users.create({name: 'x', displayName: 'X', pass: await hash.hashPassword('pw', {params: FAST})}));
  assert.strictEqual(await tools.currentMode(h.store, h.root), 'frozen');
});

test('script errors never echo driver details', () => {
  const secret = 'Synthetic-Secret-55';
  const driver = Object.assign(new Error(`duplicate key ${secret}`), {code: '23505', detail: secret});
  assert.ok(!tools.describeError(driver).includes(secret));
  assert.match(tools.describeError(Object.assign(new Error('mine'), {code: 'account_not_found'})), /account_not_found: mine/);
});

test('realName scrub runs in batches and reports counts only', async () => {
  const rows = new Map([[1, 'Alice$pw1'], [2, 'Bob'], [3, 'Carol$pw$x'], [4, 'Dan$pw4'], [5, 'Eve$pw5']]);
  const query = async (sql, params) => {
    if (sql === scrubScript.COUNT_SQL) return {rows: [{n: [...rows.values()].filter(value => value.includes('$')).length}]};
    assert.strictEqual(sql, scrubScript.BATCH_SQL);
    const [afterId, limit] = params;
    const ids = [...rows.keys()].filter(id => id > afterId && rows.get(id).includes('$')).sort((a, b) => a - b).slice(0, limit);
    for (const id of ids) rows.set(id, rows.get(id).split('$')[0]);
    return {rows: ids.map(id => ({id}))};
  };
  assert.deepStrictEqual(await scrubScript.scrub(query, {apply: false, batchSize: 2}), {before: 4, updated: 0, after: 4});
  assert.deepStrictEqual(await scrubScript.scrub(query, {apply: true, batchSize: 2}), {before: 4, updated: 4, after: 0});
  assert.deepStrictEqual([...rows.values()], ['Alice', 'Bob', 'Carol', 'Dan', 'Eve']);
  assert.throws(() => scrubScript.parseArgs(['node', 'x', '--apply']), /--confirm/);
  assert.match(scrubScript.BATCH_SQL, /split_part\("realName", '\$', 1\)/);
});
