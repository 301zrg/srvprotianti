'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const server = require('./server-coordinator.cjs');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function cleanup(directory, parent = os.tmpdir(), prefix = 'srv-release-test-') {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent));
  assert.ok(path.basename(directory).startsWith(prefix));
  fs.rmSync(directory, {recursive: true, force: true});
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-release-test-'));
  t.after(() => cleanup(base));
  const root = path.join(base, 'project'), batch = path.join(base, 'batches', 'sample');
  fs.mkdirSync(root, {recursive: true}); fs.mkdirSync(path.join(batch, 'payload'), {recursive: true});
  const manifest = {schemaVersion: 1, id: 'sample', title: 'Sample', enabled: true,
    server: {projectRoot: root, appName: 'ygopro-server', pm2Home: path.join(base, 'pm2-home'), pm2Script: path.join(base, 'pm2.cjs'), httpPort: 7922, gamePort: 7911, minimumFreeMiB: 256},
    files: [], health: {ladderConfig: true, privateStatsGuard: true, expectedHooks: ['random_duel_zombie_penalty'], mode: 'TT', countAfkPenalty: false}, desktop: null};
  function add(name, oldValue, value, phase = 'backend') {
    const target = path.join(root, name), source = path.join(batch, 'payload', name);
    fs.mkdirSync(path.dirname(target), {recursive: true}); fs.mkdirSync(path.dirname(source), {recursive: true});
    if (oldValue !== null) fs.writeFileSync(target, oldValue);
    fs.writeFileSync(source, value);
    manifest.files.push({path: name, source: 'payload/' + name, sha256: digest(value), beforeSha256: oldValue === null ? null : digest(oldValue), phase});
    return target;
  }
  return {base, root, batch, manifest, add};
}

test('manifest paths and production data cannot enter an explicit deployment', t => {
  const f = fixture(t); f.add('plugins/core/index.js', 'old', 'new');
  assert.equal(server.validateManifest(f.manifest, f.batch).id, 'sample');
  for (const target of ['../outside.js', 'config/admin_user.json', 'plugins/core/config.json', 'logs/output.log', 'data/random_duel_ban.json', 'C:/outside.js', 'plugins/core/../../host.js']) {
    const m = structuredClone(f.manifest); m.files[0].path = target;
    assert.throws(() => server.validateManifest(m, f.batch), /manifest_path|private_file/);
  }
  const m = structuredClone(f.manifest); m.files[0].source = '../outside.js';
  assert.throws(() => server.validateManifest(m, f.batch), /manifest_path/);
});

test('website phase cannot replace a host or plugin runtime file', t => {
  const f = fixture(t); f.add('ygopro-server.js', 'old', 'new', 'website');
  assert.throws(() => server.validateManifest(f.manifest, f.batch), /website_path/);
});

test('every old hash and payload is verified before the first target changes', t => {
  const f = fixture(t), first = f.add('one.js', 'old-one', 'new-one');
  const second = f.add('two.js', 'old-two', 'new-two');
  const installer = server.createFileInstaller({manifest: f.manifest, batch: f.batch});
  fs.writeFileSync(second, 'external');
  assert.throws(() => installer.install('backend'), /before_hash_mismatch/);
  assert.equal(fs.readFileSync(first, 'utf8'), 'old-one');
  assert.equal(fs.existsSync(path.join(f.batch, 'original', 'one.js')), false);
});

test('installation verifies backups and rollback restores only this batch files', t => {
  const f = fixture(t), target = f.add('one.js', 'old', 'new'), added = f.add('two.js', null, 'added');
  const installer = server.createFileInstaller({manifest: f.manifest, batch: f.batch});
  installer.install('backend');
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(f.batch, 'original', 'one.js'), 'utf8'), 'old');
  fs.writeFileSync(path.join(f.root, 'untouched.js'), 'keep');
  installer.rollback('backend');
  assert.equal(fs.readFileSync(target, 'utf8'), 'old');
  assert.equal(fs.existsSync(added), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'untouched.js'), 'utf8'), 'keep');
});

test('rollback refuses external edits and corrupt backups before restoring any file', t => {
  for (const corruption of ['external', 'backup']) {
    const f = fixture(t), one = f.add('one.js', 'old1', 'new1'), two = f.add('two.js', 'old2', 'new2');
    const installer = server.createFileInstaller({manifest: f.manifest, batch: f.batch}); installer.install('backend');
    fs.writeFileSync(corruption === 'external' ? two : path.join(f.batch, 'original', 'two.js'), 'changed');
    assert.throws(() => installer.rollback('backend'), /rollback_target_changed|backup_hash_mismatch/);
    assert.equal(fs.readFileSync(one, 'utf8'), 'new1');
  }
});

test('website resources are replaced before HTML regardless of manifest order', t => {
  const f = fixture(t); f.add('plugins/ladder-web/web/index.html', 'old html', 'new html', 'website'); f.add('plugins/ladder-web/web/app.js', 'old js', 'new js', 'website');
  const order = [];
  server.createFileInstaller({manifest: f.manifest, batch: f.batch, onInstalled: file => order.push(file.path)}).install('website');
  assert.deepEqual(order, ['plugins/ladder-web/web/app.js', 'plugins/ladder-web/web/index.html']);
});

test('global lock prevents other batches and never deletes a replacement owner', t => {
  const f = fixture(t), lockPath = path.join(f.base, 'batches', 'coordinator.lock');
  const lock = server.acquireGlobalLock(lockPath, {pid: 123, processStartedAt: '2026-10-20T00:00:00.000Z', jobId: 'one'});
  assert.throws(() => server.acquireGlobalLock(lockPath, {pid: 124, processStartedAt: '2026-10-20T00:00:00.000Z', jobId: 'two'}), /global_lock_exists/);
  const replacement = {jobId: 'replacement', token: 'other'}; fs.writeFileSync(lockPath, JSON.stringify(replacement));
  lock.release();
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath)), replacement);
});

test('status rejects PID reuse by requiring the process start time', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.batch, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(f.batch, 'state.json'), JSON.stringify({coordinatorPid: 123, processStartedAt: '2026-10-20T00:00:00.000Z', manifestSha256: digest('{}')}));
  assert.equal(server.readStatus(f.batch, () => '2026-10-21T00:00:00.000Z').coordinatorRunning, false);
  assert.equal(server.readStatus(f.batch, () => '2026-10-20T00:00:00.000Z').coordinatorRunning, true);
});

test('a finished receipt is tied to its immutable manifest hash', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.batch, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(f.batch, 'state.json'), JSON.stringify({jobId: 'sample', stage: 'FINISHED', outcome: 'UPDATED', manifestSha256: digest('{}')}));
  assert.equal(server.readStatus(f.batch).manifestSha256, '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  fs.writeFileSync(path.join(f.batch, 'manifest.json'), '{"changed":true}');
  assert.throws(() => server.readStatus(f.batch), /manifest_receipt_mismatch/);
});

test('module import does not run the coordinator or create receipts', t => {
  const f = fixture(t);
  const filename = require.resolve('./server-coordinator.cjs'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previous = process.argv;
  try {
    process.argv = [process.execPath, filename, '--batch', f.batch];
    loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  } finally { process.argv = previous; }
  assert.equal(typeof loaded.exports.main, 'function');
  assert.deepEqual(fs.readdirSync(f.batch), ['payload']);
});

test('startup detection includes plugin failures and runtime exceptions', () => {
  assert.deepEqual(server.startupSummary('Plugin initialization failed\nTypeError: broken'), ['TypeError', 'plugin_initialization_failed']);
  assert.deepEqual(server.startupSummary('HTTP listening'), []);
});

function runtimeFixture(t) {
  const f = fixture(t); f.add('host.js', 'module.exports=1;', 'module.exports=2;');
  let maintained = false, app = {name: 'ygopro-server', pid: 100, pm_id: 0, pm2_env: {status: 'online', restart_time: 0, pm_uptime: 1000, watch: false, exec_mode: 'fork_mode', pm_exec_path: path.join(f.root, 'ygopro-server.js')}};
  const calls = []; let requestsUnavailable = false;
  const snap = () => ({maintenanceEnabled: maintained, rooms: 0, pendingWork: {}, pendingPersistence: {}, pendingCount: 0, readyToStop: maintained});
  const deps = {
    pm2: args => {
      if (args[0] === 'jlist') return JSON.stringify([app]);
      calls.push(args[0]);
      if (args[0] === 'stop') app = {...app, pid: 0, pm2_env: {...app.pm2_env, status: 'stopped'}};
      if (args[0] === 'restart') app = {...app, pid: 200, pm2_env: {...app.pm2_env, status: 'online', restart_time: app.pm2_env.restart_time + 1, pm_uptime: 2000}};
      return '';
    },
    freeMemoryMiB: () => 1024,
    credentials: () => ({name: 'test', password: 'never-print', header: 'Basic dGVzdA=='}),
    maintenanceValue: () => maintained ? '[release-monitor:sample] maintenance' : false,
    request: async route => {
      if (requestsUnavailable) throw Error('request_failed');
      if (route.startsWith('/api/message?')) { maintained = new URLSearchParams(route.split('?')[1]).get('stop') !== 'false'; return {status: 200, data: "['stop ok',"}; }
      if (route === '/api/maintenance/status') return {status: 200, value: snap()};
      if (route === '/api/ladder-config') return {status: 200, value: {rating: {initialPoints: 1000, totalWeight: .6, monthWeight: .4, kFactor: 20, minDelta: 8, maxDelta: 15, fixedDelta: 12, minimumPoints: 0, eloScale: 400, useDynamic: true}}};
      if (route === '/api/public/rooms') return {status: 200, value: {rooms: []}};
      return {status: 403, value: {code: 'authentication_required'}};
    },
    checkSyntax: () => {}, tcp: async () => {}, probeHooks: async () => ({hooks: ['random_duel_zombie_penalty'], countAfkPenalty: false}),
    now: () => 2000, sleep: async () => {}, stableMilliseconds: 0, healthTimeoutMilliseconds: 10
  };
  return {...f, deps, calls, setApp: value => { app = value; }, getApp: () => app, failRequests: () => { requestsUnavailable = true; }, setMaintenance: value => { maintained = value; }};
}

test('runtime cannot switch after a fresh complete barrier becomes busy', async t => {
  const f = runtimeFixture(t), a = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps});
  await a.verify(); await a.maintain(true);
  f.deps.request = async () => ({status: 200, value: {maintenanceEnabled: true, rooms: 1, pendingWork: {}, pendingPersistence: {}, pendingCount: 0, readyToStop: false}});
  const b = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps}); await b.verify();
  await assert.rejects(b.switchBackend(() => {}), /last_barrier_failed/);
  assert.deepEqual(f.calls, []);
});

test('an installed hook probe failure is caught before maintenance or a stop', async t => {
  const f = runtimeFixture(t);
  f.deps.probeHooks = async () => { throw Error('hook_missing'); };
  const a = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps});
  await assert.rejects(a.verify(), error => {
    assert.equal(error.message, 'health_probe_failed');
    assert.equal(error.healthFailure.version, 'preflight');
    assert.equal(error.healthFailure.check, 'hook_probe');
    assert.equal(error.healthFailure.reason, 'hook_missing');
    return true;
  });
  assert.deepEqual(f.calls, []);
  assert.equal(fs.readFileSync(path.join(f.root, 'host.js'), 'utf8'), 'module.exports=1;');
});

test('website-only verification does not require backend hook probes', async t => {
  const f = runtimeFixture(t); f.manifest.files = [];
  f.add('plugins/ladder-web/web/site-shell.js', 'old', 'new', 'website');
  f.deps.probeHooks = async () => { throw Error('hook_missing'); };
  const a = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps});
  await a.verify();
  assert.deepEqual(f.calls, []);
});

test('a timed-out hook subprocess is distinguished without copying its private diagnostics', async t => {
  const f = runtimeFixture(t);
  f.deps.probeHooks = async () => { throw Object.assign(Error('never-print'), {code: 'ETIMEDOUT', stderr: 'private configuration'}); };
  const a = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps});
  await assert.rejects(a.verify(), error => {
    assert.equal(error.healthFailure.reason, 'hook_probe_timeout');
    assert.equal(JSON.stringify(error).includes('private configuration'), false);
    assert.equal(JSON.stringify(error).includes('never-print'), false);
    return true;
  });
  assert.deepEqual(f.calls, []);
});

test('a changed hook payload defers the installed-policy preflight to the new generation', async t => {
  const f = runtimeFixture(t); f.add('plugins/ladder-core/index.js', 'old hook', 'new hook');
  let probes = 0; f.deps.probeHooks = async () => { probes++; throw Error('hook_missing'); };
  const a = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps});
  await a.verify(); await a.maintain(true); await a.switchBackend(() => {});
  assert.equal(probes, 0);
  await assert.rejects(a.health('new'), error => {
    assert.equal(error.message, 'health_probe_failed');
    assert.equal(error.healthFailure.version, 'new');
    assert.equal(error.healthFailure.reason, 'hook_missing');
    return true;
  });
  assert.equal(probes, 1);
});

test('health timeout retains the failing check without retaining a response body', async t => {
  const f = runtimeFixture(t), request = f.deps.request;
  f.deps.request = async route => route === '/api/ladder-config' ? {status: 200, value: {secret: 'never-print'}} : request(route);
  let now = 2000; f.deps.now = () => now; f.deps.sleep = async () => { now += 20; };
  const a = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps});
  await a.verify(); await a.maintain(true); await a.switchBackend(() => {});
  await assert.rejects(a.health('new'), error => {
    assert.deepEqual(error.healthFailure, {version: 'new', check: 'ladder_config', reason: 'rating_missing', attempts: 1, elapsedMilliseconds: 20});
    assert.equal(JSON.stringify(error.healthFailure).includes('never-print'), false);
    return true;
  });
});

test('deck history backup precedes installation and reclassification precedes restart', async t => {
  const f = runtimeFixture(t), events = [], pm2 = f.deps.pm2;
  f.manifest.schemaVersion = 2;
  f.manifest.deckReclassification = {templateSha256: 'a'.repeat(64), beforeTemplateSha256: 'b'.repeat(64)};
  f.deps.pm2 = args => { if (args[0] !== 'jlist') events.push(args[0]); return pm2(args); };
  f.deps.deckMaintenance = {
    verify: async () => events.push('verify-decks'),
    backup: async () => { assert.match(fs.readFileSync(path.join(f.root, 'host.js'), 'utf8'), /=1/); events.push('backup'); },
    reclassify: async () => { assert.match(fs.readFileSync(path.join(f.root, 'host.js'), 'utf8'), /=2/); events.push('reclassify'); },
    rollback: async () => events.push('restore-decks'),
    status: () => ({stage: 'VERIFIED'})
  };
  const a = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps});
  await a.verify(); await a.maintain(true); await a.switchBackend(() => {});
  assert.deepEqual(events, ['verify-decks', 'stop', 'backup', 'reclassify', 'restart']);
  await a.rollback();
  assert.deepEqual(events.slice(-3), ['stop', 'restore-decks', 'restart']);
  assert.match(fs.readFileSync(path.join(f.root, 'host.js'), 'utf8'), /=1/);
});

test('an uncertain database commit keeps the game stopped and refuses file-only rollback', async t => {
  const f = runtimeFixture(t);
  f.manifest.schemaVersion = 2;
  f.manifest.deckReclassification = {templateSha256: 'a'.repeat(64), beforeTemplateSha256: 'b'.repeat(64)};
  f.deps.deckMaintenance = {verify: async () => {}, backup: async () => {},
    reclassify: async () => { throw Object.assign(Error('deck_commit_unknown'), {recoveryBlocked: true}); },
    rollback: async () => { throw Error('deck_commit_unknown'); }, status: () => ({recoveryBlocked: true})};
  const a = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps});
  await a.verify(); await a.maintain(true);
  await assert.rejects(a.switchBackend(() => {}), /deck_commit_unknown/);
  await assert.rejects(a.rollback(), /deck_commit_unknown/);
  assert.deepEqual(f.calls, ['stop', 'stop']);
  assert.match(fs.readFileSync(path.join(f.root, 'host.js'), 'utf8'), /=2/);
});

test('read-only preflight loads the approved maintenance tool against production dependencies', t => {
  const f = fixture(t), rel = 'plugins/deck_analysis/reclassify-database.js';
  f.add(rel, 'module.exports = {version: "old"};', 'module.exports = {version: "new", dependency: require("./index.js"), directory: __dirname};');
  fs.writeFileSync(path.join(f.root, 'plugins/deck_analysis/index.js'), 'module.exports = "production-classifier";');
  assert.equal(typeof server.loadReclassificationTool, 'function');
  const loaded = server.loadReclassificationTool(f.manifest, f.batch);
  assert.equal(loaded.version, 'new');
  assert.equal(loaded.dependency, 'production-classifier');
  assert.equal(loaded.directory, path.join(f.root, 'plugins/deck_analysis'));
  assert.equal(require(path.join(f.root, rel)).version, 'old');
});

test('preflight uses the approved candidate classifier without replacing or caching it as live code', t => {
  const f = fixture(t), rel = 'plugins/deck_analysis/reclassify-database.js', classifier = 'plugins/deck_analysis/index.js';
  f.add(classifier, 'module.exports = "old-classifier";', 'module.exports = "canonical-classifier";');
  f.add(rel, 'module.exports = "old-tool";', 'module.exports = {classifier: require("./index")};');
  assert.equal(server.loadReclassificationTool(f.manifest, f.batch).classifier, 'canonical-classifier');
  assert.equal(require(path.join(f.root, classifier)), 'old-classifier');
  assert.equal(require(path.join(f.root, rel)), 'old-tool');
});

test('new backend health verifies the exact templates loaded by the running classifier', async t => {
  for (const correct of [true, false]) {
    const f = runtimeFixture(t), request = f.deps.request;
    f.manifest.schemaVersion = 2;
    f.manifest.deckReclassification = {templateSha256: 'a'.repeat(64), beforeTemplateSha256: 'b'.repeat(64)};
    f.add('plugins/deck_analysis/deck_templates/3330.ydk', '#main\n1\n', '#main\n2\n');
    f.deps.deckMaintenance = {verify: async () => {}, backup: async () => {}, reclassify: async () => {}, rollback: async () => {}, status: () => ({status: 'applied'})};
    f.deps.request = async route => route.startsWith('/api/ladder/deck-template?') ?
      {status: 200, data: correct ? '#main\n2\n' : '#main\n1\n'} : request(route);
    let now = 2000; f.deps.now = () => now; f.deps.sleep = async () => { now += 20; };
    const a = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps});
    await a.verify(); await a.maintain(true); await a.switchBackend(() => {});
    if (correct) assert.equal((await a.health('new')).status, 'online');
    else await assert.rejects(a.health('new'), /health_timeout/);
  }
});

test('a definitely stopped new generation can restore the old files without an HTTP listener', async t => {
  const f = runtimeFixture(t), a = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps});
  await a.verify(); await a.maintain(true); await a.switchBackend(() => {});
  const app = f.getApp(); f.setApp({...app, pid: 0, pm2_env: {...app.pm2_env, status: 'errored'}});
  f.failRequests();
  await a.rollback();
  assert.equal(fs.readFileSync(path.join(f.root, 'host.js'), 'utf8'), 'module.exports=1;');
  assert.deepEqual(f.calls, ['stop', 'restart', 'stop', 'restart']);
});

test('an unknown running generation cannot be stopped for rollback', async t => {
  const f = runtimeFixture(t), a = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps});
  await a.verify(); await a.maintain(true); await a.switchBackend(() => {});
  const app = f.getApp(); f.setApp({...app, pid: 999, pm2_env: {...app.pm2_env, pm_uptime: 9999, restart_time: 7}});
  await assert.rejects(a.rollback(), /rollback_runtime_changed/);
  assert.deepEqual(f.calls, ['stop', 'restart']);
  assert.equal(fs.readFileSync(path.join(f.root, 'host.js'), 'utf8'), 'module.exports=2;');
});

test('new backend health requires rating, ports, private 403 guard and installed hooks', async t => {
  for (const broken of ['rating', 'private', 'port', 'hooks']) {
    const f = runtimeFixture(t);
    const request = f.deps.request;
    if (broken === 'rating') f.deps.request = async route => route === '/api/ladder-config' ? {status: 200, value: {}} : request(route);
    if (broken === 'private') f.deps.request = async route => route === '/api/ladder/player/stats' ? {status: 200, value: {}} : request(route);
    if (broken === 'port') f.deps.tcp = async () => { throw Error('tcp_failed'); };
    let failHooks = false;
    if (broken === 'hooks') f.deps.probeHooks = async () => { if (failHooks) throw Error('hook_missing'); };
    let now = 2000; f.deps.now = () => now; f.deps.sleep = async () => { now += 20; };
    const a = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps});
    await a.verify(); await a.maintain(true); await a.switchBackend(() => {});
    failHooks = true;
    await assert.rejects(a.health('new'), broken === 'hooks' ? /health_probe_failed/ : /health_timeout/);
  }
});

test('offline probe calls registered installed hooks with a safe virtual API', async t => {
  const f = fixture(t), plugin = path.join(f.root, 'plugins', 'ladder-core'); fs.mkdirSync(plugin, {recursive: true});
  fs.writeFileSync(path.join(plugin, 'config.default.json'), JSON.stringify({mode: 'TT', countAfkPenalty: false}));
  fs.writeFileSync(path.join(plugin, 'index.js'), 'exports.register = api => {}; exports.init = api => {api.hook("random_duel_zombie_penalty", room => room.random_type === api.config.mode ? api.config.countAfkPenalty : null);};');
  const result = await server.probeLadderHooks(f.root, f.manifest.health);
  assert.deepEqual(result.hooks, ['random_duel_zombie_penalty']);
  assert.equal(result.countAfkPenalty, false);
  fs.writeFileSync(path.join(plugin, 'index.js'), 'exports.register = api => {}; exports.init = api => {};');
  await assert.rejects(server.probeLadderHooks(f.root, f.manifest.health), /hook_missing/);
});

test('a malformed reachable rollback snapshot cannot reuse an older idle barrier', async t => {
  const f = runtimeFixture(t), original = f.deps.request; let malformed = false;
  f.deps.request = async route => malformed && route === '/api/maintenance/status' ? {status: 200, value: {}} : original(route);
  const a = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps});
  await a.verify(); await a.maintain(true); await a.switchBackend(() => {}); malformed = true;
  await assert.rejects(a.rollback(), /rollback_invalid_snapshot/);
  assert.deepEqual(f.calls, ['stop', 'restart']);
});

test('a new backend must hold the same healthy generation for ten seconds', async t => {
  const f = runtimeFixture(t); let now = 2000, waits = 0;
  f.deps.now = () => now; f.deps.sleep = async () => { now += 1500; waits++; };
  f.deps.stableMilliseconds = 10000; f.deps.healthTimeoutMilliseconds = 60000;
  const a = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps});
  await a.verify(); await a.maintain(true); await a.switchBackend(() => {});
  const result = await a.health('new');
  assert.equal(result.pid, 200); assert.equal(waits, 7);
});

test('startup exceptions block an otherwise healthy backend', async t => {
  const f = runtimeFixture(t), errorLog = path.join(f.base, 'stderr.log'); fs.writeFileSync(errorLog, '');
  const app = f.getApp(); f.setApp({...app, pm2_env: {...app.pm2_env, pm_err_log_path: errorLog}});
  let now = 2000; f.deps.now = () => now; f.deps.sleep = async () => { now += 20; };
  const a = server.createRuntimeAdapter({manifest: f.manifest, batch: f.batch, ...f.deps});
  await a.verify(); await a.maintain(true); await a.switchBackend(() => {});
  fs.writeFileSync(errorLog, 'Plugin initialization failed');
  await assert.rejects(a.health('new'), /health_timeout/);
});

test('partial website writes roll back only files actually installed', t => {
  const f = fixture(t), first = f.add('plugins/ladder-web/web/one.js', 'old1', 'new1', 'website'), second = f.add('plugins/ladder-web/web/two.js', 'old2', 'new2', 'website');
  const installer = server.createFileInstaller({manifest: f.manifest, batch: f.batch, onInstalled: () => fs.unlinkSync(path.join(f.batch, 'payload/plugins/ladder-web/web/two.js'))});
  assert.throws(() => installer.install('website'), /ENOENT/);
  installer.rollback('website');
  assert.equal(fs.readFileSync(first, 'utf8'), 'old1'); assert.equal(fs.readFileSync(second, 'utf8'), 'old2');
});

test('the real reviewed ladder plugin registers and executes the requested policy hooks', async t => {
  const root = fs.mkdtempSync(path.join(__dirname, '.hook-test-'));
  t.after(() => cleanup(root, __dirname, '.hook-test-'));
  const source = path.resolve(__dirname, '../../plugins/ladder-core'), plugin = path.join(root, 'plugins/ladder-core');
  fs.mkdirSync(plugin, {recursive: true});
  for (const filename of ['index.js', 'entities.js', 'afk-policy.js', 'turn-time.js', 'i18n.json', 'config.default.json']) fs.copyFileSync(path.join(source, filename), path.join(plugin, filename));
  const result = await server.probeLadderHooks(root, {mode: 'TT', countAfkPenalty: false, expectedHooks: ['random_duel_zombie_penalty', 'random_duel_penalty_history']});
  assert.deepEqual(result.hooks, ['random_duel_zombie_penalty', 'random_duel_penalty_history']);
  assert.equal(result.countAfkPenalty, false);
});
