'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {EventEmitter} = require('node:events');
const path = require('node:path');
const crypto = require('node:crypto');
const {validateStoppedApps, createBackup, queryAppsReadOnly} = require('../scripts/windows-backup.cjs');
const expected = [{name: 'game', script: 'C:/srvpro/ygopro-server.js'}];
const app = () => ({name: 'game', pid: 0, pm2_env: {status: 'stopped', pm_exec_path: expected[0].script,
  watch: false, exec_mode: 'fork_mode'}});
test('only an explicitly stopped matching PM2 application proves offline', () => {
  assert.deepEqual(validateStoppedApps([app()], expected), [{name: 'game', status: 'stopped'}]);
  for (const status of ['online', 'errored', 'stopping', 'launching', 'waiting restart']) {
    const value = app(); value.pm2_env.status = status;
    assert.throws(() => validateStoppedApps([value], expected));
  }
  for (const modify of [v => {v.pid = 23;}, v => {v.pm2_env.watch = true;},
    v => {v.pm2_env.pm_exec_path = 'C:/other/server.js';}, v => {v.pm2_env.exec_mode = 'cluster_mode';}]) {
    const value = app(); modify(value); assert.throws(() => validateStoppedApps([value], expected));
  }
  assert.throws(() => validateStoppedApps([], expected));
  assert.throws(() => validateStoppedApps([app(), app()], expected));
  assert.throws(() => validateStoppedApps([app()], []));
  assert.throws(() => validateStoppedApps([app()], [expected[0], expected[0]]));
});

function fixture(changes = {}) {
  const filename = path.resolve('fixture-plan.json'), queueRoot = path.resolve('fixture-queue');
  let plan = Buffer.from(JSON.stringify({writerGuard: {manager: 'pm2', writerInventoryReviewed: true,
    pm2Home: path.resolve('fixture-pm2'), pm2Script: path.resolve('fixture-pm2/bin/pm2'),
    coordinatorLock: path.join(queueRoot, 'coordinator.lock'), apps: expected}}));
  let owner, released = 0, spawned = 0, queries = 0;
  const stamp = '2026-11-12T00:00:00.000Z';
  const fakeFs = {lstatSync: () => ({isSymbolicLink: () => false, isDirectory: () => true, isFile: () => true}),
    readFileSync: name => name === filename ? plan : path.basename(name) === 'pm2.pid' ? Buffer.from('45') : Buffer.from(JSON.stringify(owner))};
  const gate = createBackup({fs: fakeFs, platform: 'win32', pid: 100, processStart: () => stamp,
    acquireGlobalLock: (name, identity) => { owner = {...identity, token: 'fixture-token'}; return {owner, release: () => {released++;}}; },
    queryApps: async () => {queries++; return [app()];},
    spawnSync: () => {spawned++; return {status: 0};}, log: () => {}, ...changes});
  return {gate, filename, queueRoot, run: () => gate.main(['backup', filename, path.resolve('fixture-output'), 'python', '--queue-root', queueRoot]),
    planHash: () => crypto.createHash('sha256').update(plan).digest('hex'),
    setPlan: fn => {plan = Buffer.from(JSON.stringify(fn(JSON.parse(plan))));},
    setOwner: fn => {owner = fn(owner);}, state: () => ({owner, released, spawned, queries})};
}

test('operator queue root is required and a different same-named lock is rejected before acquisition', async () => {
  const f = fixture();
  await assert.rejects(f.gate.main(['backup', f.filename, 'output', 'python']), /queue_root_required/);
  f.setPlan(p => {p.writerGuard.coordinatorLock = path.resolve('other-queue/coordinator.lock'); return p;});
  await assert.rejects(f.run(), /canonical_coordinator_lock_required/);
  assert.equal(f.state().owner, undefined);
});

test('normal child exit releases lock and check returns the hash of parsed plan bytes', async () => {
  const f = fixture(); await f.run();
  assert.equal(f.state().released, 1);
  assert.equal(f.state().spawned, 1);
  const evidence = await f.gate.inspect(f.filename, 'fixture-token', f.queueRoot);
  assert.equal(evidence.planSha256, f.planHash());
});

test('pre-child query failure releases the lock and never launches Python', async () => {
  const f = fixture({queryApps: async () => {throw Error('pm2_query_failed');}});
  await assert.rejects(f.run(), /pm2_query_failed/);
  assert.equal(f.state().released, 1); assert.equal(f.state().spawned, 0);
});

test('failed child creation releases lock; uncertain child termination retains it', async () => {
  const missing = fixture({spawnSync: () => ({error: Object.assign(Error('missing'), {code: 'ENOENT'})})});
  await assert.rejects(missing.run(), /offline_backup_failed/); assert.equal(missing.state().released, 1);
  const interrupted = fixture({spawnSync: () => ({status: null, signal: 'SIGTERM'})});
  await assert.rejects(interrupted.run(), /offline_backup_failed/); assert.equal(interrupted.state().released, 0);
});

test('changed daemon, owner or parsed plan is refused before child start', async () => {
  for (const kind of ['daemon', 'owner', 'plan']) {
    let f;
    f = fixture({queryApps: async () => {
      if (kind === 'daemon') f.setOwner(o => ({...o, pm2Daemon: {pid: 99, started: 'other'}}));
      if (kind === 'owner') f.setOwner(o => ({...o, token: 'replacement'}));
      if (kind === 'plan') f.setPlan(p => ({...p, changed: true}));
      return [app()];
    }});
    await assert.rejects(f.run(), /backup_lock_mismatch|pm2_daemon_changed/);
    assert.equal(f.state().spawned, 0);
  }
});

function transport(options = {}) {
  const sock = new EventEmitter(), calls = [];
  let closed = 0;
  sock.set = (key, value) => {assert.equal(key, 'retry timeout'); assert.equal(value, 0);};
  sock.close = () => {closed++;};
  sock.connect = endpoint => {assert.equal(endpoint, 'fixture-pipe'); queueMicrotask(() => sock.emit(options.disconnect ? 'close' : 'connect'));};
  const rpc = {Client: function () { this.call = (method, args, cb) => {
    calls.push(method);
    if (options.neverReply) return;
    if (options.rpcError) return cb(Error('private environment must not leak'));
    cb(null, method === 'getReport' ? {pid: options.wrongPid ? 99 : 45, env: {PM2_HOME: expected[0].script}} : [app()]);
  };}};
  return {axon: {socket: kind => {assert.equal(kind, 'req'); return sock;}}, rpc, endpoint: 'fixture-pipe',
    state: () => ({closed, calls})};
}

test('read-only RPC calls only identity report and monitor data, then closes socket', async () => {
  const t = transport();
  assert.deepEqual(await queryAppsReadOnly({pm2Home: expected[0].script}, {pid: 45}, t, 20), [app()]);
  assert.deepEqual(t.state(), {closed: 1, calls: ['getReport', 'getMonitorData']});
});

test('read-only RPC fails closed and cleans up on disconnect, timeout, wrong daemon and RPC error', async () => {
  for (const options of [{disconnect: true}, {neverReply: true}, {wrongPid: true}, {rpcError: true}]) {
    const t = transport(options);
    await assert.rejects(queryAppsReadOnly({pm2Home: expected[0].script}, {pid: 45}, t, 10), /pm2_query_failed|pm2_daemon_changed/);
    assert.equal(t.state().closed, 1);
    assert.ok(t.state().calls.every(m => ['getReport', 'getMonitorData'].includes(m)));
  }
});
