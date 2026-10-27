'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const {validateManifest, acquireGlobalLock} = require('./server-coordinator.cjs');
const {validateReleaseNotes, createReleaseAnnouncement} = require('./discord-notifications.cjs');
const check = (value, code) => { if (!value) throw Error(code); };

function readFile(filename) {
  check(!fs.lstatSync(filename).isSymbolicLink() && fs.statSync(filename).isFile() && fs.statSync(filename).size <= 1048576, 'announcement_file_invalid');
  return fs.readFileSync(filename);
}

function apps(manifest) {
  return JSON.parse(cp.execFileSync(process.execPath, [manifest.server.pm2Script, 'jlist'], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    env: {...process.env, PM2_HOME: manifest.server.pm2Home}
  }));
}

async function runAnnouncement({batch, manifestHash, preflight = false}, options = {}) {
  check(typeof batch === 'string' && path.isAbsolute(batch) && /^[a-f0-9]{64}$/.test(manifestHash || ''), 'announcement_request_invalid');
  const resolved = fs.realpathSync(batch);
  check(!fs.lstatSync(batch).isSymbolicLink(), 'announcement_batch_invalid');
  const bytes = readFile(path.join(resolved, 'manifest.json'));
  check(crypto.createHash('sha256').update(bytes).digest('hex') === manifestHash, 'announcement_manifest_changed');
  const manifest = JSON.parse(bytes);
  validateManifest(manifest, resolved);
  if (!validateReleaseNotes(manifest.releaseNotes)) return {status: 'DISABLED'};
  if (!preflight) {
    const state = JSON.parse(readFile(path.join(resolved, 'state.json')));
    check(state.jobId === manifest.id && state.stage === 'FINISHED' && state.outcome === 'UPDATED' &&
      (!manifest.files.some(file => file.phase === 'backend') || state.backendActive === true) &&
      (!manifest.files.some(file => file.phase === 'website') || state.websitePublished === true), 'announcement_updates_unverified');
  }
  let lock, delivery;
  try {
    if (!preflight) lock = acquireGlobalLock(path.join(resolved, 'release-announcement.lock'), {jobId: manifest.id, pid: process.pid});
    delivery = (options.createDelivery || createReleaseAnnouncement)({manifest, batch: resolved});
    const ready = await delivery.preflight(await (options.appsProvider || apps)(manifest));
    if (preflight) return ready;
    const messageId = await delivery.notify('release');
    return {status: 'CONFIRMED', guildId: ready.guildId, channelId: ready.channelId, messageId};
  } finally {
    try { if (delivery) await delivery.close(); } finally { lock?.release(); }
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--batch') options.batch = argv[++index];
    else if (flag === '--manifest-sha') options.manifestHash = argv[++index];
    else if (flag === '--preflight') options.preflight = true;
    else throw Error('announcement_arguments_invalid');
  }
  return options;
}

module.exports = {runAnnouncement};
if (require.main === module) {
  runAnnouncement(parseArgs(process.argv.slice(2))).then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(error => {
    process.stderr.write((/^[a-z][a-z0-9_]{0,79}$/.test(error.message || '') ? error.message : 'announcement_operation_failed') + '\n');
    process.exitCode = 1;
  });
}
