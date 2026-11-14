'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const cp = require('node:child_process');
const path = require('node:path');
const tool = path.join(__dirname, '../scripts/windows-service/pm2-apps-readonly.cjs');
const {summarizeApps, main} = require(tool);

const live = {name: 'srvpro', pid: 2792, pm2_env: {pm_exec_path: 'C:\\app\\ygopro-server.js', pm_cwd: 'C:\\app',
  exec_mode: 'fork_mode', watch: false, status: 'online', env: {DB_PASSWORD: 'TOPSECRET'}, USERNAME: 'TOPSECRET'}};

test('summary keeps whitelisted fields only', () => {
  const out = summarizeApps([live]);
  assert.deepEqual(out, [{name: 'srvpro', script: 'C:\\app\\ygopro-server.js', cwd: 'C:\\app', exec_mode: 'fork_mode',
    watch: false, status: 'online', pid: 2792}]);
  assert.doesNotMatch(JSON.stringify(out), /TOPSECRET/);
});

test('missing pm2_env and non-scalar values become null', () => {
  assert.deepEqual(summarizeApps([{name: {x: 1}}]), [{name: null, script: null, cwd: null, exec_mode: null,
    watch: null, status: null, pid: null}]);
  assert.throws(() => summarizeApps(null));
});

test('main passes guard and identity to the read-only query', async () => {
  let seen;
  const out = await main(['C:\\pm2\\bin\\pm2', 'C:\\pm2home', '3840'], async (guard, identity) => { seen = {guard, identity}; return [live]; });
  assert.deepEqual(seen, {guard: {pm2Script: 'C:\\pm2\\bin\\pm2', pm2Home: 'C:\\pm2home'}, identity: {pid: 3840}});
  assert.equal(out[0].name, 'srvpro');
  await assert.rejects(main(['a', 'b'], async () => []));
  await assert.rejects(main(['a', 'b', '0'], async () => []));
  await assert.rejects(main(['a', 'b', '12x'], async () => []));
  await assert.rejects(main(['a', 'b', '1'], async () => { throw new Error('pm2_daemon_changed'); }), /pm2_daemon_changed/);
});

test('CLI rejects bad arguments without touching PM2', () => {
  const r = cp.spawnSync(process.execPath, [tool, 'only-one-arg'], {encoding: 'utf8'});
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /usage/);
});
