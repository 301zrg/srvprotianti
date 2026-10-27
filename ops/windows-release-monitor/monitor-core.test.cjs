'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const core = fs.existsSync(path.join(__dirname, 'monitor-core.cjs')) ? require('./monitor-core.cjs') : {};

function cleanup(directory) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('release-monitor-'));
  fs.rmSync(directory, {recursive: true, force: true});
}

function fixture(t, changes = {}) {
  assert.equal(typeof core.createMonitor, 'function', 'the monitor state machine must exist');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'release-monitor-'));
  t.after(() => cleanup(workspace));
  const jobDir = path.join(workspace, 'queue', 'batch-one');
  fs.mkdirSync(path.join(jobDir, 'payload'), { recursive: true });
  fs.writeFileSync(path.join(jobDir, 'payload', 'app.js'), 'approved file\n');
  const manifest = {
    schemaVersion: 1, id: 'batch-one', title: 'Approved batch', enabled: true,
    server: { projectRoot: 'C:/srvpro', appName: 'game', pm2Home: 'C:/pm2', pm2Script: 'C:/pm2/pm2.js', httpPort: 7922, gamePort: 7911, minimumFreeMiB: 100 },
    files: [{ path: 'app.js', source: 'payload/app.js', sha256: crypto.createHash('sha256').update('approved file\n').digest('hex'), beforeSha256: null, phase: 'backend' }],
    health: { ladderConfig: true, privateStatsGuard: true, expectedHooks: ['random_duel_zombie_penalty'], mode: 'TT', countAfkPenalty: false }, desktop: null,
    ...changes
  };
  fs.writeFileSync(path.join(jobDir, 'manifest.json'), JSON.stringify(manifest));
  const events = [];
  const state = { value: absent() };
  const approvedManifestHash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const adapter = {
    publicRooms: async () => ({ rooms: [] }),
    readState: async () => ({ ...state.value, manifestSha256: state.value.stateExists ? approvedManifestHash : null }),
    upload: async job => events.push(['upload', job.manifest.id]),
    launch: async () => { events.push(['launch']); state.value = running(); return { coordinatorPid: 321 }; },
    remotePreflight: async job => events.push(['remotePreflight', job.manifest.id]),
    sleep: async () => {}
  };
  const desktop = {
    preflightDesktop: async () => events.push(['desktopPreflight']),
    publishDesktop: async () => { events.push(['desktopPublish']); return { status: 'PUBLISHED' }; }
  };
  const config = { schemaVersion: 1, sshHost: 'srvpro-server', publicRoomsUrl: 'https://example.test/api/public/rooms', pollSeconds: 10, queueDir: 'queue', stateDir: 'state', remoteBase: 'C:/srvpro/deployment-backups/release-monitor' };
  const monitor = core.createMonitor({ workspace, config, adapter, desktop, logger: () => {} });
  return { workspace, jobDir, manifest, events, state, adapter, desktop, config, monitor,
    receipt: () => JSON.parse(fs.readFileSync(path.join(workspace, 'state', 'batch-one.json'), 'utf8')) };
}

function absent() { return { stateExists: false, state: null, coordinatorRunning: false, lockExists: false }; }

test('version 2 explicitly enables deck history maintenance and Discord notices', t => {
  const f = fixture(t), m = structuredClone(f.manifest);
  m.schemaVersion = 2;
  m.deckReclassification = {templateSha256: 'a'.repeat(64), beforeTemplateSha256: 'b'.repeat(64)};
  m.notifications = {kind: 'deck-templates', guildId: '1504410444876484658', channelId: '1504410446130839603', botRoot: 'C:/srvpro-runtime/discord-bot'};
  assert.equal(core.validateManifest(m, m.id), m);
  for (const invalid of [
    {...m, schemaVersion: 1},
    {...m, deckReclassification: {...m.deckReclassification, command: 'arbitrary'}},
    {...m, notifications: {...m.notifications, token: 'never-in-manifest'}},
    {...m, files: m.files.map(file => ({...file, path: 'plugins/ladder-web/web/app.js', phase: 'website'}))}
  ]) assert.throws(() => core.validateManifest(invalid, invalid.id), {code: 'MANIFEST_INVALID'});
});

test('remote preflight skips immutable completed batches and never reuploads changed support', async t => {
  const f = fixture(t);
  const stateDir = path.join(f.workspace, 'state'); fs.mkdirSync(stateDir, {recursive: true});
  fs.writeFileSync(path.join(stateDir, f.manifest.id + '.json'), JSON.stringify({jobId: f.manifest.id,
    manifestHash: core.sha256(JSON.stringify(f.manifest)), status: 'COMPLETE'}));
  const result = await f.monitor.run({preflight: true, remotePreflight: true});
  assert.equal(result.jobs, 0);
  assert.deepEqual(f.events, []);
});
function running(overrides = {}) {
  return { stateExists: true, state: { jobId: 'batch-one', stage: 'VERIFYING', outcome: null, coordinatorPid: 321, startedAt: '2026-10-20T01:00:00.000Z', backendActive: false, websitePublished: false }, coordinatorRunning: true, lockExists: true, lockJobId: 'batch-one', lockCoordinatorRunning: true, ...overrides };
}
function finished(outcome = 'UPDATED', overrides = {}) {
  const value = running({ coordinatorRunning: false, lockExists: false, lockCoordinatorRunning: false, ...overrides });
  value.state = { ...value.state, stage: 'FINISHED', outcome, backendActive: outcome === 'UPDATED', finishedAt: '2026-10-20T01:01:00.000Z' };
  return value;
}

const notes = {zh: '已更新', ja: '更新しました', en: 'Updated', ko: '업데이트 완료'};
function announcementFixture(t, changes = {}) {
  const f = fixture(t, {schemaVersion: 2, releaseNotes: {...notes}, desktop: {test: true}, ...changes});
  f.state.value = finished();
  f.adapter.announceRelease = async () => {
    assert.equal(f.receipt().status, 'ANNOUNCEMENT_PENDING', 'publication completion is durable before a message send');
    f.events.push(['announce']);
    return {status: 'CONFIRMED', guildId: '1504410444876484658', channelId: '1554786350845141002', messageId: '1564156977234575450'};
  };
  return f;
}

test('reviewed release notes are optional schema-2 data and require all four languages', t => {
  const f = announcementFixture(t);
  assert.equal(core.validateManifest(f.manifest, f.manifest.id), f.manifest);
  for (const invalid of [{...f.manifest, schemaVersion: 1}, {...f.manifest, releaseNotes: {...notes, ko: ''}}, {...f.manifest, releaseNotes: {...notes, secret: 'no'}}]) {
    assert.throws(() => core.validateManifest(invalid, invalid.id), {code: 'MANIFEST_INVALID'});
  }
});

test('release announcement follows server and complete desktop verification exactly once', async t => {
  const f = announcementFixture(t);
  assert.equal((await f.monitor.step()).status, 'COMPLETE');
  assert.deepEqual(f.events, [['desktopPublish'], ['announce']]);
  assert.equal(f.receipt().announcement.messageId, '1564156977234575450');
  await f.monitor.step(); assert.deepEqual(f.events, [['desktopPublish'], ['announce']]);
});

test('announcement failure resumes only the announcement with public HTTP unavailable', async t => {
  const f = announcementFixture(t), send = f.adapter.announceRelease;
  f.adapter.announceRelease = async () => { throw Error('private upstream details'); };
  await assert.rejects(f.monitor.step(), {code: 'RELEASE_ANNOUNCEMENT_FAILED'});
  assert.equal(f.receipt().status, 'ANNOUNCEMENT_PENDING');
  assert.equal(f.receipt().desktop.status, 'PUBLISHED');
  assert.doesNotMatch(f.receipt().error, /private upstream/);
  f.adapter.publicRooms = async () => { throw Error('offline'); }; f.adapter.announceRelease = send;
  const reopened = core.createMonitor({workspace: f.workspace, config: f.config, adapter: f.adapter, desktop: f.desktop, logger: () => {}});
  assert.equal((await reopened.step()).status, 'COMPLETE');
  assert.deepEqual(f.events, [['desktopPublish'], ['announce']]);
});

test('a temporary SSH read failure preserves the pending announcement for a later reopen', async t => {
  const f = announcementFixture(t), send = f.adapter.announceRelease, readState = f.adapter.readState;
  f.adapter.announceRelease = async () => { throw Error('lost send'); };
  await assert.rejects(f.monitor.step(), {code: 'RELEASE_ANNOUNCEMENT_FAILED'});
  f.adapter.readState = async () => { throw Error('temporary SSH outage'); };
  await assert.rejects(f.monitor.step(), {code: 'REMOTE_UNAVAILABLE'});
  assert.equal(f.receipt().status, 'ANNOUNCEMENT_PENDING');
  f.adapter.readState = readState; f.adapter.announceRelease = send;
  const reopened = core.createMonitor({workspace: f.workspace, config: f.config, adapter: f.adapter, desktop: f.desktop, logger: () => {}});
  assert.equal((await reopened.step()).status, 'COMPLETE');
  assert.deepEqual(f.events, [['desktopPublish'], ['announce']]);
});

test('desktop publication failure never announces success', async t => {
  const f = announcementFixture(t);
  f.desktop.publishDesktop = async () => { throw Object.assign(Error('CI failed'), {code: 'DESKTOP_CI_FAILED'}); };
  await assert.rejects(f.monitor.step(), {code: 'DESKTOP_CI_FAILED'});
  assert.ok(!f.events.some(event => event[0] === 'announce'));
});

test('partial desktop or page verification cannot authorize a release announcement', async t => {
  for (const result of [{status: 'EXE_VERIFIED'}, {status: 'PUBLISHED', pages: {status: 'PENDING'}}]) {
    const f = announcementFixture(t, {desktop: {pages: {test: true}}});
    f.desktop.publishDesktop = async () => result;
    await assert.rejects(f.monitor.step(), {code: 'DESKTOP_RESULT_INVALID'});
    assert.ok(!f.events.some(event => event[0] === 'announce'));
  }
});

test('a pending announcement with missing server evidence stops without republishing', async t => {
  const f = announcementFixture(t); f.adapter.announceRelease = async () => { throw Error(); };
  await assert.rejects(f.monitor.step(), {code: 'RELEASE_ANNOUNCEMENT_FAILED'});
  f.state.value = absent();
  await assert.rejects(f.monitor.step(), {code: 'REMOTE_STATE_INVALID'});
  assert.deepEqual(f.events, [['desktopPublish']]);
});

test('regressed remote state cannot turn an announcement recovery into another server launch', async t => {
  for (const remoteState of [finished('WAITING'), running()]) {
    const f = announcementFixture(t); f.adapter.announceRelease = async () => { throw Error(); };
    await assert.rejects(f.monitor.step(), {code: 'RELEASE_ANNOUNCEMENT_FAILED'});
    f.state.value = remoteState;
    await assert.rejects(f.monitor.step(), {code: 'REMOTE_STATE_INVALID'});
    await assert.rejects(f.monitor.step(), {code: 'STOPPED_FOR_REVIEW'});
    assert.deepEqual(f.events, [['desktopPublish']]);
  }
});

test('rollback, cancellation and unverified website never announce successful updates', async t => {
  for (const outcome of ['ROLLED_BACK', 'CANCELLED', 'FRONTEND_FAILED']) {
    const f = announcementFixture(t); f.state.value = finished(outcome);
    await assert.rejects(f.monitor.step()); assert.deepEqual(f.events, []);
  }
  const f = announcementFixture(t);
  f.manifest.files[0] = {...f.manifest.files[0], phase: 'website', path: 'plugins/ladder-web/web/app.js'};
  fs.writeFileSync(path.join(f.jobDir, 'manifest.json'), JSON.stringify(f.manifest));
  f.adapter.readState = async () => ({...f.state.value, manifestSha256: core.sha256(JSON.stringify(f.manifest))});
  await assert.rejects(f.monitor.step(), {code: 'REMOTE_STATE_INVALID'}); assert.deepEqual(f.events, []);
});

test('release announcement preflights never send or write publication completion', async t => {
  const f = announcementFixture(t);
  assert.equal((await f.monitor.run({preflight: true})).status, 'PREFLIGHT_OK');
  assert.deepEqual(f.events, [['desktopPreflight']]);
  assert.equal(fs.existsSync(path.join(f.workspace, 'state', 'batch-one.json')), false);
});

test('an absent announcement adapter or unconfirmed result leaves verified updates pending', async t => {
  for (const result of [null, {status: 'CONFIRMED', messageId: 'bad'}, {status: 'CONFIRMED', guildId: '1504410444876484658', channelId: '1504410446130839603', messageId: '1564156977234575450'}]) {
    const f = announcementFixture(t); f.adapter.announceRelease = async () => result;
    await assert.rejects(f.monitor.step(), {code: 'RELEASE_ANNOUNCEMENT_FAILED'});
    assert.equal(f.receipt().status, 'ANNOUNCEMENT_PENDING');
  }
});

test('local plugin configuration cannot be uploaded as either destination or source', async t => {
  for (const field of ['path', 'source']) {
    const f = fixture(t);
    f.manifest.files[0][field] = 'plugins/example/config.json';
    fs.writeFileSync(path.join(f.jobDir, 'manifest.json'), JSON.stringify(f.manifest));
    await assert.rejects(f.monitor.step(), {code: 'MANIFEST_INVALID'});
    assert.deepEqual(f.events, []);
  }
});

test('website roles reject host code and allow only the website directory', t => {
  const f = fixture(t), invalid = structuredClone(f.manifest);
  invalid.files[0].phase = 'website';
  invalid.files[0].path = 'ygopro-server.js';
  assert.throws(() => core.validateManifest(invalid, 'batch-one'), {code: 'MANIFEST_INVALID'});
});

test('health policy can explicitly pin another valid mode or enabled counting', t => {
  const f = fixture(t), m = structuredClone(f.manifest);
  m.health.mode = 'CUSTOM'; m.health.countAfkPenalty = true;
  assert.equal(core.validateManifest(m, 'batch-one'), m);
});

test('a pure website batch does not wait for active public rooms', async t => {
  const file = {path:'plugins/ladder-web/web/app.js',source:'payload/app.js',sha256:core.sha256('approved file\n'),beforeSha256:null,phase:'website'};
  const f = fixture(t, {files:[file]});
  f.adapter.publicRooms = async () => ({rooms:[{}, {}]});
  assert.equal((await f.monitor.step()).status, 'RUNNING');
  assert.deepEqual(f.events, [['upload','batch-one'],['launch']]);
});

test('interrupted and timed-out desktop stages resume without a second server launch', async t => {
  for (const code of ['DESKTOP_INTERRUPTED','DESKTOP_CI_TIMEOUT','DESKTOP_PAGES_REQUEST_FAILED','DESKTOP_PAGES_TIMEOUT']) {
    const f = fixture(t, {desktop:{}}), abort = new AbortController();
    f.state.value = finished();
    f.desktop.publishDesktop = async (d, options) => {
      assert.equal(options.signal, abort.signal);
      if (code === 'DESKTOP_INTERRUPTED') abort.abort();
      throw Object.assign(Error(code), {code});
    };
    const monitor = core.createMonitor({workspace:f.workspace,config:f.config,adapter:f.adapter,desktop:f.desktop,signal:abort.signal,logger:()=>{}});
    await assert.rejects(monitor.step(), {code});
    assert.equal(f.receipt().status, 'SERVER_DONE');
    f.desktop.publishDesktop = async () => ({status:'PUBLISHED'});
    assert.equal((await f.monitor.step()).status, 'COMPLETE');
    assert.deepEqual(f.events, []);
  }
});

test('malformed public room data never starts a queued batch', async t => {
  const f = fixture(t);
  for (const body of [null, {}, [], { rooms: null }, { rooms: 0 }]) {
    f.adapter.publicRooms = async () => body;
    const result = await f.monitor.step();
    assert.equal(result.publicRooms, null);
    assert.equal(result.status, 'OBSERVING');
  }
  assert.deepEqual(f.events, []);
});

test('a failed public room request never starts a queued batch', async t => {
  const f = fixture(t);
  f.adapter.publicRooms = async () => { throw Error('offline'); };
  assert.equal((await f.monitor.step()).publicRooms, null);
  assert.deepEqual(f.events, []);
});

test('nonzero public rooms keep an approved batch waiting', async t => {
  const f = fixture(t);
  f.adapter.publicRooms = async () => ({ rooms: [{ name: 'busy' }] });
  assert.equal((await f.monitor.step()).status, 'WAITING');
  assert.deepEqual(f.events, []);
});

test('empty queue remains resident and observes until cancelled', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.jobDir, 'manifest.json'));
  const abort = new AbortController();
  let samples = 0;
  f.adapter.publicRooms = async () => { samples++; return { rooms: [] }; };
  f.adapter.sleep = async () => { if (samples === 3) abort.abort(); };
  const monitor = core.createMonitor({ workspace: f.workspace, config: f.config, adapter: f.adapter, desktop: f.desktop, signal: abort.signal, logger: () => {} });
  assert.equal((await monitor.run()).status, 'STOPPED');
  assert.equal(samples, 3);
  assert.deepEqual(f.events, []);
});

test('idle observation uploads only the explicit candidate and records launch identity', async t => {
  const f = fixture(t);
  assert.equal((await f.monitor.step()).status, 'RUNNING');
  assert.deepEqual(f.events, [['upload', 'batch-one'], ['launch']]);
  assert.equal(f.receipt().coordinatorPid, 321);
  assert.equal(f.receipt().coordinatorStartedAt, '2026-10-20T01:00:00.000Z');
});

test('unknown launch response reconciles the running coordinator without replay', async t => {
  const f = fixture(t);
  f.adapter.launch = async () => { f.events.push(['launch']); f.state.value = running(); throw Error('SSH disconnected after launch'); };
  assert.equal((await f.monitor.step()).status, 'RUNNING');
  assert.equal((await f.monitor.step()).status, 'RUNNING');
  assert.deepEqual(f.events, [['upload', 'batch-one'], ['launch']]);
});

test('unknown launch with no receipt blocks permanently across a resumed monitor', async t => {
  const f = fixture(t);
  f.adapter.launch = async () => { f.events.push(['launch']); throw Error('response lost'); };
  await assert.rejects(f.monitor.step(), { code: 'TRIGGER_UNCONFIRMED' });
  const resumed = core.createMonitor({ workspace: f.workspace, config: f.config, adapter: f.adapter, desktop: f.desktop, logger: () => {} });
  await assert.rejects(resumed.step(), { code: 'STOPPED_FOR_REVIEW' });
  assert.deepEqual(f.events, [['upload', 'batch-one'], ['launch']]);
});

test('a known triggered batch resumes reconciliation while public API is offline', async t => {
  const f = fixture(t);
  await f.monitor.step();
  f.adapter.publicRooms = async () => { throw Error('offline'); };
  f.state.value = finished();
  const resumed = core.createMonitor({ workspace: f.workspace, config: f.config, adapter: f.adapter, desktop: f.desktop, logger: () => {} });
  assert.equal((await resumed.step()).status, 'COMPLETE');
  assert.deepEqual(f.events, [['upload', 'batch-one'], ['launch']]);
});

test('disconnection during reconciliation blocks instead of launching again', async t => {
  const f = fixture(t);
  await f.monitor.step();
  f.adapter.readState = async () => { throw Error('SSH disconnected'); };
  await assert.rejects(f.monitor.step(), { code: 'REMOTE_UNAVAILABLE' });
  assert.equal(f.receipt().status, 'STOPPED_FOR_REVIEW');
  assert.deepEqual(f.events, [['upload', 'batch-one'], ['launch']]);
});

for (const [name, mutate, code] of [
  ['dead coordinator', value => { value.coordinatorRunning = false; }, 'COORDINATOR_DEAD'],
  ['different job receipt', value => { value.state.jobId = 'other'; }, 'RECEIPT_MISMATCH'],
  ['changed PID', value => { value.state.coordinatorPid = 999; }, 'RECEIPT_MISMATCH'],
  ['changed process start', value => { value.state.startedAt = '2026-10-20T02:00:00.000Z'; }, 'RECEIPT_MISMATCH'],
  ['foreign lock', value => { value.lockJobId = 'other'; }, 'LOCK_MISMATCH'],
  ['missing active lock', value => { value.lockExists = false; }, 'LOCK_MISMATCH']
]) test(`${name} fails closed without another trigger`, async t => {
  const f = fixture(t);
  await f.monitor.step();
  mutate(f.state.value);
  await assert.rejects(f.monitor.step(), { code });
  assert.equal(f.receipt().status, 'STOPPED_FOR_REVIEW');
  assert.equal(f.events.filter(event => event[0] === 'launch').length, 1);
});

test('terminal UPDATED waits for coordinator exit and lock cleanup before desktop', async t => {
  const f = fixture(t, { desktop: { approved: true } });
  await f.monitor.step();
  f.state.value = finished('UPDATED', { coordinatorRunning: true, lockExists: true });
  assert.equal((await f.monitor.step()).status, 'RUNNING');
  assert.equal(f.events.some(event => event[0] === 'desktopPublish'), false);
  f.state.value = finished();
  assert.equal((await f.monitor.step()).status, 'COMPLETE');
  assert.equal(f.events.filter(event => event[0] === 'desktopPublish').length, 1);
  assert.equal((await f.monitor.step()).status, 'OBSERVING');
  assert.equal(f.events.filter(event => event[0] === 'desktopPublish').length, 1);
});

for (const outcome of ['ROLLED_BACK', 'CANCELLED', 'RECOVERY_FAILED', 'FRONTEND_FAILED']) test(`${outcome} blocks desktop and automatic restart`, async t => {
  const f = fixture(t, { desktop: { approved: true } });
  await f.monitor.step();
  f.state.value = finished(outcome);
  await assert.rejects(f.monitor.step(), { code: outcome });
  assert.equal(f.events.some(event => event[0] === 'desktopPublish'), false);
  assert.equal(f.receipt().status, 'STOPPED_FOR_REVIEW');
});

test('a terminal health failure names its check without exposing raw diagnostics', async t => {
  const f = fixture(t);
  f.state.value = finished('ROLLED_BACK');
  Object.assign(f.state.value.state, {errorCode: 'health_probe_failed', failureStage: 'CHECKING_BACKEND',
    healthFailure: {check: 'hook_probe', reason: 'hook_probe_timeout', stderr: 'never-print'}});
  await assert.rejects(f.monitor.step(), error => {
    assert.match(error.message, /CHECKING_BACKEND.*health_probe_failed.*hook_probe.*hook_probe_timeout/);
    assert.equal(error.message.includes('never-print'), false);
    return true;
  });
  assert.deepEqual(f.events, []);
});

test('a remote completed batch is adopted without upload or relaunch', async t => {
  const f = fixture(t);
  f.state.value = finished();
  assert.equal((await f.monitor.step()).status, 'COMPLETE');
  assert.deepEqual(f.events, []);
});

test('a completed receipt for different remote candidate bytes cannot authorize desktop', async t => {
  const f = fixture(t, { desktop: { approved: true } });
  f.adapter.readState = async () => ({ ...finished(), manifestSha256: 'f'.repeat(64) });
  await assert.rejects(f.monitor.step(), { code: 'REMOTE_MANIFEST_MISMATCH' });
  assert.deepEqual(f.events, []);
});

test('cancellation during reconciliation does not begin desktop publication', async t => {
  const f = fixture(t, { desktop: { approved: true } });
  const abort = new AbortController();
  const monitor = core.createMonitor({ workspace: f.workspace, config: f.config, adapter: f.adapter, desktop: f.desktop, logger: () => {}, signal: abort.signal });
  await monitor.step();
  f.state.value = finished();
  const read = f.adapter.readState;
  f.adapter.readState = async job => { const status = await read(job); abort.abort(); return status; };
  assert.equal((await monitor.step()).status, 'STOPPED');
  assert.equal(f.events.some(event => event[0] === 'desktopPublish'), false);
});

test('WAITING retries only after confirmed exit and requires a new receipt', async t => {
  const f = fixture(t);
  f.state.value = finished('WAITING');
  f.adapter.launch = async () => { f.events.push(['launch']); return { coordinatorPid: 321 }; };
  await assert.rejects(f.monitor.step(), { code: 'OLD_RECEIPT' });
  assert.deepEqual(f.events, [['upload', 'batch-one'], ['launch']]);
});

test('confirmed WAITING reuses the immutable prepared batch and accepts a new coordinator identity', async t => {
  const f = fixture(t);
  await f.monitor.step();
  f.state.value = finished('WAITING');
  assert.equal((await f.monitor.step()).status, 'WAITING');
  f.adapter.launch = async () => {
    f.events.push(['launch']);
    f.state.value = running();
    f.state.value.state.coordinatorPid = 322;
    f.state.value.state.startedAt = '2026-10-20T02:00:00.000Z';
    return { coordinatorPid: 322 };
  };
  assert.equal((await f.monitor.step()).status, 'RUNNING');
  assert.deepEqual(f.events, [['upload', 'batch-one'], ['launch'], ['launch']]);
  assert.equal(f.receipt().coordinatorPid, 322);
});

test('pending payload hash mismatch stops before contacting production', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.jobDir, 'payload', 'app.js'), 'changed locally');
  f.adapter.publicRooms = async () => { throw Error('should not reach network'); };
  await assert.rejects(f.monitor.step(), { code: 'PAYLOAD_HASH_MISMATCH' });
  assert.deepEqual(f.events, []);
});

for (const mutation of [
  manifest => { manifest.files[0].source = '../outside.js'; },
  manifest => { manifest.files[0].path = 'config/config.json'; },
  manifest => { manifest.id = 'bad;command'; },
  manifest => { manifest.files = []; },
  manifest => { manifest.files[0].beforeSha256 = 'unverified'; }
]) test('unsafe or empty manifests are rejected locally', async t => {
  const f = fixture(t);
  mutation(f.manifest);
  fs.writeFileSync(path.join(f.jobDir, 'manifest.json'), JSON.stringify(f.manifest));
  await assert.rejects(f.monitor.step(), { code: 'MANIFEST_INVALID' });
  assert.deepEqual(f.events, []);
});

test('local preflight verifies candidates without rooms, upload, launch or remote maintenance', async t => {
  const f = fixture(t);
  f.adapter.publicRooms = async () => { throw Error('preflight must stay local'); };
  const result = await f.monitor.run({ preflight: true });
  assert.equal(result.status, 'PREFLIGHT_OK');
  assert.equal(result.jobs, 1);
  assert.deepEqual(f.events, []);
});

test('explicit remote preflight invokes only the read-only preflight adapter', async t => {
  const f = fixture(t);
  assert.equal((await f.monitor.run({ preflight: true, remotePreflight: true })).status, 'PREFLIGHT_OK');
  assert.deepEqual(f.events, [['remotePreflight', 'batch-one']]);
});

test('desktop=null requires neither desktop adapter nor release credentials', async t => {
  const f = fixture(t);
  const monitor = core.createMonitor({ workspace: f.workspace, config: f.config, adapter: f.adapter, logger: () => {} });
  f.state.value = finished();
  assert.equal((await monitor.step()).status, 'COMPLETE');
});

test('edited manifest cannot reuse an earlier launch receipt', async t => {
  const f = fixture(t);
  await f.monitor.step();
  f.manifest.title = 'Different approval';
  fs.writeFileSync(path.join(f.jobDir, 'manifest.json'), JSON.stringify(f.manifest));
  await assert.rejects(f.monitor.step(), { code: 'MANIFEST_CHANGED' });
});

test('a terminal receipt with a dead coordinator and leftover lock stops for review', async t => {
  const f = fixture(t);
  await f.monitor.step();
  f.state.value = finished('UPDATED', { lockExists: true });
  await assert.rejects(f.monitor.step(), { code: 'LOCK_MISMATCH' });
  assert.equal(f.receipt().status, 'STOPPED_FOR_REVIEW');
});

test('terminal coordinator may clear its lock just before exiting without allowing desktop early', async t => {
  const f = fixture(t, { desktop: { approved: true } });
  await f.monitor.step();
  f.state.value = finished('UPDATED', { coordinatorRunning: true, lockExists: false });
  assert.equal((await f.monitor.step()).status, 'RUNNING');
  assert.equal(f.events.some(event => event[0] === 'desktopPublish'), false);
  f.state.value = finished();
  assert.equal((await f.monitor.step()).status, 'COMPLETE');
});

test('a foreign global lock blocks upload even before the first launch', async t => {
  const f = fixture(t);
  f.state.value = { ...absent(), lockExists: true, lockJobId: 'other' };
  await assert.rejects(f.monitor.step(), { code: 'LOCK_MISMATCH' });
  assert.deepEqual(f.events, []);
});

test('failed candidate upload cannot send a launch command', async t => {
  const f = fixture(t);
  f.adapter.upload = async () => { throw Object.assign(Error('candidate differs'), { code: 'UPLOAD_FAILED' }); };
  await assert.rejects(f.monitor.step(), { code: 'UPLOAD_FAILED' });
  assert.deepEqual(f.events, []);
});

test('unknown manifest command fields are rejected before public HTTP', async t => {
  const f = fixture(t, { command: 'restart arbitrary service' });
  await assert.rejects(f.monitor.step(), { code: 'MANIFEST_INVALID' });
  assert.deepEqual(f.events, []);
});

test('coordinator control filenames cannot be used as payload sources', async t => {
  const f = fixture(t);
  f.manifest.files[0].source = 'launch-once.ps1';
  fs.writeFileSync(path.join(f.jobDir, 'manifest.json'), JSON.stringify(f.manifest));
  await assert.rejects(f.monitor.step(), { code: 'MANIFEST_INVALID' });
});

test('invalid server port fails pure local preflight', async t => {
  const f = fixture(t);
  f.manifest.server.httpPort = 0;
  fs.writeFileSync(path.join(f.jobDir, 'manifest.json'), JSON.stringify(f.manifest));
  await assert.rejects(f.monitor.run({ preflight: true }), { code: 'MANIFEST_INVALID' });
});

test('backend activation requires UPDATED to include positive backend health evidence', async t => {
  const f = fixture(t);
  f.state.value = finished();
  f.state.value.state.backendActive = false;
  await assert.rejects(f.monitor.step(), { code: 'REMOTE_STATE_INVALID' });
});

test('local lock prevents another monitor and does not delete a foreign replacement lock', t => {
  const f = fixture(t);
  assert.equal(typeof core.acquireLocalLock, 'function');
  const release = core.acquireLocalLock(path.join(f.workspace, 'state'));
  assert.throws(() => core.acquireLocalLock(path.join(f.workspace, 'state')), { code: 'LOCAL_LOCKED' });
  const lockPath = path.join(f.workspace, 'state', 'monitor.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ token: 'foreign' }));
  assert.throws(release, { code: 'LOCAL_LOCK_MISMATCH' });
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'foreign');
});
