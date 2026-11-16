'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {EventEmitter} = require('node:events');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const {validateStoppedApps, createBackup, queryAppsReadOnly, pipeServerPid} = require('../scripts/windows-backup.cjs');
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
    // PM2 6.0.14 getReport has env and started_at, but no daemon pid.
    cb(null, method === 'getReport' ? {started_at: 1793464000000, env: {PM2_HOME: options.wrongHome ? 'other' : expected[0].script}} : [app()]);
  };}};
  let probes = 0;
  return {axon: {socket: kind => {assert.equal(kind, 'req'); return sock;}}, rpc, endpoint: 'fixture-pipe',
    serverPid: async () => { probes++; if (options.probeError) throw Error('private error'); return options.wrongPid || (options.changedPid && probes > 1) ? 99 : 45; },
    state: () => ({closed, calls})};
}

test('read-only RPC calls only identity report and monitor data, then closes socket', async () => {
  const t = transport();
  assert.deepEqual(await queryAppsReadOnly({pm2Home: expected[0].script}, {pid: 45}, t, 20), [app()]);
  assert.deepEqual(t.state(), {closed: 1, calls: ['getReport', 'getMonitorData']});
});

test('read-only RPC fails closed and cleans up on disconnect, timeout, wrong daemon and RPC error', async () => {
  for (const options of [{disconnect: true}, {neverReply: true}, {wrongPid: true}, {wrongHome: true}, {changedPid: true}, {probeError: true}, {rpcError: true}]) {
    const t = transport(options);
    await assert.rejects(queryAppsReadOnly({pm2Home: expected[0].script}, {pid: 45}, t, 10), /pm2_query_failed|pm2_daemon_changed/);
    assert.equal(t.state().closed, 1);
    assert.ok(t.state().calls.every(m => ['getReport', 'getMonitorData'].includes(m)));
  }
});

test('read-only RPC resolves installed dependencies without importing the PM2 entrypoint', async t => {
  for (const hoisted of [false, true]) {
    await t.test(hoisted ? 'npm hoisted dependencies' : 'nested dependencies', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-pm2-layout-'));
      try {
        const pm2 = path.join(root, 'node_modules', 'pm2');
        fs.mkdirSync(path.join(pm2, 'bin'), {recursive: true});
        fs.writeFileSync(path.join(pm2, 'package.json'), JSON.stringify({name: 'pm2', main: 'index.js'}));
        fs.writeFileSync(path.join(pm2, 'index.js'), 'throw Error("PM2 entrypoint must never be loaded")');
        fs.writeFileSync(path.join(pm2, 'bin/pm2'), 'throw Error("PM2 CLI must never be loaded")');
        const modules = hoisted ? path.join(root, 'node_modules') : path.join(pm2, 'node_modules');
        for (const name of ['pm2-axon', 'pm2-axon-rpc']) fs.mkdirSync(path.join(modules, name), {recursive: true});
        fs.writeFileSync(path.join(modules, 'pm2-axon/index.js'), `
          const {EventEmitter}=require('node:events');
          exports.socket=()=>{ const socket=new EventEmitter(); socket.set=()=>{}; socket.close=()=>{};
            socket.connect=()=>queueMicrotask(()=>socket.emit('close')); return socket; };`);
        fs.writeFileSync(path.join(modules, 'pm2-axon-rpc/index.js'), 'exports.Client=function(){}');
        await assert.rejects(queryAppsReadOnly({pm2Home: root, pm2Script: path.join(pm2, 'bin/pm2')}, {pid: 45}, undefined, 50), /pm2_query_failed/);
      } finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        fs.rmSync(root, {recursive: true, force: true});
      }
    });
  }
});

test('native pipe identity reads its actual server PID without PM2 or a daemon', {skip: process.platform !== 'win32'}, async () => {
  const net = require('node:net');
  const name = 'srvpro-backup-test-' + crypto.randomUUID();
  const server = net.createServer(socket => socket.end());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen('\\\\.\\pipe\\' + name, resolve); });
  try { assert.equal(await pipeServerPid(name), process.pid); }
  finally { await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(pipeServerPid(name), /pm2_query_failed/);
});
