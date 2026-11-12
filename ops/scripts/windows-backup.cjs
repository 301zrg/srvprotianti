'use strict';
// This entry only verifies already-stopped writers; it never stops/starts PM2.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const {acquireGlobalLock, processStart} = require('../windows-release-monitor/server-coordinator.cjs');
const check = (value, code) => { if (!value) throw Error(code); };
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function queryAppsReadOnly(guard, identity, transport, timeout = 10000) {
  if (!transport) {
    let root = path.dirname(guard.pm2Script);
    while (path.dirname(root) !== root) {
      const pkg = path.join(root, 'package.json');
      if (fs.existsSync(pkg) && json(pkg).name === 'pm2') break;
      root = path.dirname(root);
    }
    const axon = require(path.join(root, 'modules/pm2-axon'));
    const rpc = require(path.join(root, 'modules/pm2-axon-rpc'));
    transport = {axon, rpc, endpoint: "\\\\.\\pipe\\rpc.sock"};
  }
  const socket = transport.axon.socket("req"), client = new transport.rpc.Client(socket);
  socket.set("retry timeout", 0);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); socket.close(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(Error('pm2_query_failed')), timeout);
    socket.once('error', () => finish(Error('pm2_query_failed')));
    socket.once('reconnect attempt', () => finish(Error('pm2_query_failed')));
    socket.once('close', () => { if (!done) finish(Error('pm2_query_failed')); });
    socket.once('connect', () => {
      client.call('getReport', {}, (error, report) => {
        // Validate the endpoint identity before inspecting applications. Report env
        // remains in memory and must never enter stdout or the backup manifest.
        if (error || report?.pid !== identity.pid || !samePath(report?.env?.PM2_HOME, guard.pm2Home)) return finish(Error('pm2_daemon_changed'));
        client.call('getMonitorData', {}, (failure, apps) => finish(failure ? Error('pm2_query_failed') : null, apps));
      });
    });
    // Direct RPC only; do not load PM2 Client/start/CLI, which can launch a daemon.
    socket.connect(transport.endpoint);
  });
}

function validateStoppedApps(apps, expected) {
  check(Array.isArray(apps) && Array.isArray(expected) && expected.length > 0, 'explicit_writers_required');
  const names = new Set();
  return expected.map(writer => {
    check(typeof writer.name === 'string' && writer.name && !names.has(writer.name), 'duplicate_writer');
    names.add(writer.name);
    const matches = apps.filter(app => app.name === writer.name);
    check(matches.length === 1, 'writer_missing_or_ambiguous');
    const app = matches[0], env = app.pm2_env;
    check(env && samePath(env.pm_exec_path, writer.script), 'writer_script_mismatch');
    check(env.status === 'stopped' && app.pid === 0 && env.watch === false && env.exec_mode === 'fork_mode', 'writer_not_stopped');
    return {name: writer.name, status: 'stopped'};
  });
}

function createBackup(options = {}) {
 const fs = options.fs || require('node:fs');
 const platform = options.platform || process.platform, pid = options.pid || process.pid;
 const processStart = options.processStart || require('../windows-release-monitor/server-coordinator.cjs').processStart;
 const acquireGlobalLock = options.acquireGlobalLock || require('../windows-release-monitor/server-coordinator.cjs').acquireGlobalLock;
 const spawnSync = options.spawnSync || cp.spawnSync, log = options.log || console.log;
 const queryApps = options.queryApps || queryAppsReadOnly;
 const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8').toString().replace(/^\uFEFF/, ''));
function regularPath(filename, directory = false) {
  check(typeof filename === 'string' && path.isAbsolute(filename), 'absolute_path_required');
  for (let cursor = path.resolve(filename); ; cursor = path.dirname(cursor)) {
    const info = fs.lstatSync(cursor);
    check(!info.isSymbolicLink(), 'linked_guard_path');
    if (cursor === path.resolve(filename)) check(directory ? info.isDirectory() : info.isFile(), 'invalid_guard_path');
    if (path.dirname(cursor) === cursor) break;
  }
}


function loadPlan(filename, queueRoot) {
  regularPath(filename);
  const bytes = fs.readFileSync(filename);
  const planSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const plan = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")), guard = plan.writerGuard;
  check(guard?.manager === 'pm2' && guard.writerInventoryReviewed === true, 'reviewed_pm2_inventory_required');
  regularPath(guard.pm2Home, true); regularPath(guard.pm2Script);
  regularPath(queueRoot, true);
  check(samePath(guard.coordinatorLock, path.join(queueRoot, 'coordinator.lock')), 'canonical_coordinator_lock_required');
  regularPath(path.dirname(guard.coordinatorLock), true);
  return {plan, guard, planSha256};
}

function daemon(guard) {
  // jlist may otherwise spawn a fresh daemon and turn a read-only check into a mutation.
  const value = fs.readFileSync(path.join(guard.pm2Home, 'pm2.pid'), 'utf8').toString().trim();
  check(/^[1-9][0-9]*$/.test(value), 'pm2_daemon_missing');
  const pid = Number(value), started = processStart(pid);
  check(started, 'pm2_daemon_missing');
  return {pid, started};
}


async function inspect(filename, token, queueRoot) {
  check(platform === 'win32', 'native_windows_required');
  const {guard, planSha256} = loadPlan(filename, queueRoot), owner = json(guard.coordinatorLock);
  check(token && owner.token === token && owner.planSha256 === planSha256, 'backup_lock_mismatch');
  check(processStart(owner.pid) === owner.processStartedAt, 'backup_owner_not_running');
  check(JSON.stringify(daemon(guard)) === JSON.stringify(owner.pm2Daemon), 'pm2_daemon_changed');
  const apps = await queryApps(guard, owner.pm2Daemon);
  check(JSON.stringify(daemon(guard)) === JSON.stringify(owner.pm2Daemon), 'pm2_daemon_changed');
  check(JSON.stringify(json(guard.coordinatorLock).pm2Daemon) === JSON.stringify(owner.pm2Daemon), 'pm2_daemon_changed');
  check(json(guard.coordinatorLock).token === token && loadPlan(filename, queueRoot).planSha256 === planSha256, 'backup_lock_mismatch');
  return {mode: 'windows-pm2-offline', planSha256, apps: validateStoppedApps(apps, guard.apps), coordinatorLockHeld: true};
}

async function main(args) {
  const index = args.indexOf("--queue-root");
  check(index >= 0 && args[index + 1], "reviewed_queue_root_required");
  const queueRoot = args[index + 1]; args = args.filter((_, i) => i !== index && i !== index + 1);
  const [action, filename, ...rest] = args;
  check(['backup', 'check'].includes(action) && filename, 'usage_backup_or_check_plan');
  const {guard, planSha256} = loadPlan(path.resolve(filename), queueRoot);
  check(platform === 'win32', 'native_windows_required');
  if (action === 'check') { check(rest.length === 1, 'check_requires_token'); log(JSON.stringify(await inspect(path.resolve(filename), rest[0], queueRoot))); return; }
  check(rest.length >= 2 && rest.length <= 3, 'backup_requires_output_python_and_optional_pg_bin');
  const [output, python, pgBin] = rest;
  const started = processStart(pid); check(started, 'backup_owner_unknown');
  const lock = acquireGlobalLock(guard.coordinatorLock, {pid: pid, processStartedAt: started,
    jobId: 'offline-backup', planSha256, pm2Daemon: daemon(guard)});
  let child;
  try {
    await inspect(path.resolve(filename), lock.owner.token, queueRoot);
    child = spawnSync(python, [path.join(__dirname, 'ops.py'), 'backup', '--plan', path.resolve(filename),
      '--output', output, '--pm2-lock-token', lock.owner.token, '--pm2-queue-root', queueRoot, ...(pgBin ? ['--pg-bin', pgBin] : [])],
    {env: process.env, windowsHide: true, stdio: 'inherit'});
    check(!child.error && child.status === 0, 'offline_backup_failed');
  } finally {
    // An interrupted parent/child may still be active: retain the lock for review.
    if (!child || child.error?.code === "ENOENT" || (!child.error && child.status !== null)) lock.release();
  }
}
 return {inspect, main};
}
const {inspect, main} = createBackup();
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error('ERROR: ' + error.message); process.exitCode = 1; });
module.exports = {validateStoppedApps, createBackup, queryAppsReadOnly, inspect, main};
