'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tool = path.join(__dirname, '../scripts/windows-service/pm2-dump-summary.cjs');
const {summarize} = require(tool);

const app = {name: 'srvpro', pm_exec_path: 'C:\\srvpro\\app\\ygopro-server.js', pm_cwd: 'C:\\srvpro\\app',
  exec_mode: 'fork_mode', watch: false, autorestart: true, status: 'online',
  env: {username: 'a', USERNAME: 'b', DB_PASSWORD: 'TOPSECRET'}, pm2_env: {secret: 'TOPSECRET'}};

test('summary keeps only whitelisted fields', () => {
  assert.deepEqual(summarize(JSON.stringify([app])), [{name: 'srvpro', script: app.pm_exec_path, cwd: app.pm_cwd,
    exec_mode: 'fork_mode', watch: false, autorestart: true, status: 'online'}]);
});

test('non-scalar whitelisted values are dropped, not passed through', () => {
  const [s] = summarize(JSON.stringify([{...app, name: {x: 'TOPSECRET'}, watch: ['a']}]));
  assert.equal(s.name, null);
  assert.equal(s.watch, null);
});

test('rejects non-array and non-object entries', () => {
  assert.throws(() => summarize('{}'));
  assert.throws(() => summarize('[1]'));
  assert.throws(() => summarize('not json'));
});

test('CLI prints no environment values and fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-dump-'));
  try {
    const dump = path.join(dir, 'dump.pm2');
    fs.writeFileSync(dump, JSON.stringify([app]));
    const ok = cp.spawnSync(process.execPath, [tool, dump], {encoding: 'utf8'});
    assert.equal(ok.status, 0);
    assert.doesNotMatch(ok.stdout + ok.stderr, /TOPSECRET|USERNAME/);
    fs.writeFileSync(dump, '[{');
    const bad = cp.spawnSync(process.execPath, [tool, dump], {encoding: 'utf8'});
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout, '');
    const usage = cp.spawnSync(process.execPath, [tool], {encoding: 'utf8'});
    assert.equal(usage.status, 2);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
