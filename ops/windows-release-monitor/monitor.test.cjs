'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cli = fs.existsSync(path.join(__dirname, 'monitor.cjs')) ? require('./monitor.cjs') : {};
const config = { schemaVersion: 1, sshHost: 'srvpro-server', publicRoomsUrl: 'https://example.test/api/public/rooms', pollSeconds: 10, queueDir: 'queue', stateDir: 'state', remoteBase: 'C:/srvpro/deployment-backups/release-monitor' };

function cleanup(directory, prefix) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith(prefix));
  fs.rmSync(directory, {recursive: true, force: true});
}

function transport(t, execFile, fetchImpl) {
  assert.equal(typeof cli.createTransport, 'function', 'the Windows OpenSSH transport must exist');
  const supportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-transport-'));
  t.after(() => cleanup(supportDir, 'release-transport-'));
  for (const name of ['server-coordinator.cjs', 'server-flow.cjs', 'launch-once.ps1', 'read-state.ps1', 'release-options.cjs', 'deck-maintenance.cjs', 'discord-notifications.cjs', 'announce-release.cjs']) fs.writeFileSync(path.join(supportDir, name), `support ${name}`);
  return cli.createTransport(config, { execFile, fetchImpl, supportDir });
}

test('CLI defaults to resident monitoring and permits bounded local-only preflight', () => {
  assert.equal(typeof cli.parseArgs, 'function', 'the CLI parser must exist');
  assert.deepEqual(cli.parseArgs(['--workspace', 'C:/handoff']), { workspace: path.resolve('C:/handoff'), once: false, preflight: false, remotePreflight: false });
  assert.deepEqual(cli.parseArgs(['--workspace', 'C:/handoff', '--preflight']), { workspace: path.resolve('C:/handoff'), once: false, preflight: true, remotePreflight: false });
  assert.equal(cli.parseArgs(['--remote-preflight']).preflight, true);
  assert.throws(() => cli.parseArgs(['--launch-now']), { code: 'CLI_INVALID' });
  assert.throws(() => cli.parseArgs(['--workspace']), { code: 'CLI_INVALID' });
});

test('release announcement transport invokes only the scoped message helper and validates its destination',async t=>{
  const calls=[],reply={status:'CONFIRMED',guildId:'1504410444876484658',channelId:'1554786350845141002',messageId:'1564156977234575450'};
  const adapter=transport(t,async(exe,args)=>{calls.push({exe,args});return {stdout:JSON.stringify(reply)};});
  const job={manifest:{id:'batch-one',releaseNotes:{zh:'更新',ja:'更新',en:'Update',ko:'업데이트'}},manifestHash:'a'.repeat(64)};
  assert.equal((await adapter.announceRelease(job)).messageId,reply.messageId);
  const script=Buffer.from(calls[0].args.at(-1),'base64').toString('utf16le');
  assert.match(script,/announce-release\.cjs/);assert.match(script,/--manifest-sha/);
  assert.doesNotMatch(script,/launch-once|server-coordinator\.cjs|restart|stop /);
  reply.channelId='1504410446130839603';await assert.rejects(adapter.announceRelease(job),{code:'REMOTE_RESPONSE_INVALID'});
});

test('omitted release notes never call the SSH announcement helper',async t=>{
  const adapter=transport(t,async()=>{throw Error('unexpected SSH');});
  assert.equal((await adapter.announceRelease({manifest:{id:'batch-one'}})).status,'DISABLED');
});

test('remote status uses hidden Windows OpenSSH with strict host checking and exact JSON', async t => {
  const calls = [];
  const adapter = transport(t, async (exe, args, options) => { calls.push({ exe, args, options }); return { stdout: '{"stateExists":false,"state":null,"coordinatorRunning":false,"lockExists":false}\r\n', stderr: '' }; });
  assert.equal((await adapter.readState({ manifest: { id: 'batch-one' } })).stateExists, false);
  assert.match(calls[0].exe.replace(/\\/g, '/'), /\/System32\/OpenSSH\/ssh\.exe$/);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].args.includes('BatchMode=yes'));
  assert.ok(calls[0].args.includes('StrictHostKeyChecking=yes'));
  const encoded = calls[0].args.at(-1);
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(script, /read-state\.ps1/);
  assert.match(script, /-Batch/);
});

test('extra output and multiple JSON objects cannot become a trusted remote status', async t => {
  for (const stdout of ['banner\n{"stateExists":false}', '{}\n{}', '', 'null']) {
    const adapter = transport(t, async () => ({ stdout, stderr: '' }));
    await assert.rejects(adapter.readState({ manifest: { id: 'batch-one' } }), { code: 'REMOTE_RESPONSE_INVALID' });
  }
});

test('launch always includes the parameterized batch path and never falls back to shell execution', async t => {
  const calls = [];
  const adapter = transport(t, async (exe, args, options) => { calls.push({ exe, args, options }); return { stdout: '{"launched":true,"coordinatorPid":345}', stderr: '' }; });
  assert.equal((await adapter.launch({ manifest: { id: 'batch-one' } })).coordinatorPid, 345);
  assert.deepEqual(calls[0].args.slice(-4), ['-File', 'C:/srvpro/deployment-backups/release-monitor/batch-one/launch-once.ps1', '-Batch', 'C:/srvpro/deployment-backups/release-monitor/batch-one']);
  assert.equal(calls[0].options.shell, false);
});

test('public HTTP error or oversized body is rejected before it can be treated as idle', async t => {
  for (const response of [
    { ok: false, status: 503, text: async () => '{"rooms":[]}' },
    { ok: true, text: async () => 'x'.repeat(1048577) },
    { ok: true, text: async () => 'not json' }
  ]) {
    const adapter = transport(t, async () => { throw Error('no SSH'); }, async () => response);
    await assert.rejects(adapter.publicRooms());
  }
});

test('upload contains only validated candidate and named coordinator support files', async t => {
  const calls = [];
  const adapter = transport(t, async (exe, args, options) => { calls.push({ exe, args, options }); return { stdout: '{"prepared":true}', stderr: '' }; });
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-job-'));
  t.after(() => cleanup(jobDir, 'release-job-'));
  fs.mkdirSync(path.join(jobDir, 'payload'));
  fs.writeFileSync(path.join(jobDir, 'payload', 'app.js'), 'candidate');
  const manifest = { schemaVersion: 1, id: 'batch-one', title: 'candidate', enabled: true,
    server: { projectRoot: 'C:/srvpro', appName: 'game', pm2Home: 'C:/pm2', pm2Script: 'C:/pm2/pm2.js', httpPort: 7922, gamePort: 7911, minimumFreeMiB: 100 },
    health: { ladderConfig: true, privateStatsGuard: true, expectedHooks: ['random_duel_zombie_penalty'], mode: 'TT', countAfkPenalty: false },
    desktop: null, files: [{ path: 'app.js', source: 'payload/app.js', sha256: crypto.createHash('sha256').update('candidate').digest('hex'), beforeSha256: null, phase: 'backend' }] };
  const manifestBytes = JSON.stringify(manifest);
  fs.writeFileSync(path.join(jobDir, 'manifest.json'), manifestBytes);
  fs.writeFileSync(path.join(jobDir, 'private-secret.key'), 'never upload');
  await adapter.upload({ jobDir, manifest, manifestHash: crypto.createHash('sha256').update(manifestBytes).digest('hex') });
  const copies = calls.filter(call => /scp\.exe$/.test(call.exe));
  assert.equal(copies.length, 6);
  assert.deepEqual(copies.map(call => path.basename(call.args.at(-2))).sort(), ['app.js', 'launch-once.ps1', 'manifest.json', 'read-state.ps1', 'server-coordinator.cjs', 'server-flow.cjs']);
  assert.ok(copies.every(call => call.options.windowsHide && call.options.shell === false));
  assert.ok(copies.every(call => call.args.at(-1).includes('/.upload-batch-one-')));
  const finalScript = Buffer.from(calls.at(-1).args.at(-1), 'base64').toString('utf16le');
  assert.match(finalScript, /Get-FileHash/);
  assert.match(finalScript, /coordinator\.lock/);
});

test('transport rejects unsafe SSH host and remote path before running any command', t => {
  transport(t, async () => ({ stdout: '{}', stderr: '' }));
  assert.throws(() => cli.createTransport({ ...config, sshHost: '-ProxyCommand=bad' }), { code: 'CONFIG_INVALID' });
  assert.throws(() => cli.createTransport({ ...config, remoteBase: "C:/safe';bad" }), { code: 'CONFIG_INVALID' });
});

test('both upload readers preserve BOM-less four-language UTF-8 regardless of PowerShell default encoding', {skip: process.platform !== 'win32'}, async t => {
  const calls = [], adapter = transport(t, async (exe, args) => {
    if (/ssh\.exe$/.test(exe)) calls.push(args.at(-1));
    return {stdout: '{"prepared":true}', stderr: ''};
  });
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-job-'));
  t.after(() => cleanup(jobDir, 'release-job-'));
  const body = 'candidate'; fs.mkdirSync(path.join(jobDir, 'payload'));
  fs.writeFileSync(path.join(jobDir, 'payload/app.js'), body);
  const notes = {zh: '异画识别已修复。', ja: '別イラスト対応を修正。', en: 'Alternate artwork fixed.', ko: '다른 일러스트 인식을 수정했습니다.'};
  const manifest = {schemaVersion: 2, id: 'batch-one', title: notes.zh, enabled: true,
    server: {projectRoot:'C:/srvpro',appName:'game',pm2Home:'C:/pm2',pm2Script:'C:/pm2/pm2.js',httpPort:7922,gamePort:7911,minimumFreeMiB:100},
    health: {ladderConfig:true,privateStatsGuard:true,expectedHooks:['random_duel_zombie_penalty'],mode:'TT',countAfkPenalty:false}, desktop:null,
    files: [{path:'app.js',source:'payload/app.js',sha256:crypto.createHash('sha256').update(body).digest('hex'),beforeSha256:null,phase:'backend'}], releaseNotes:notes};
  const bytes = JSON.stringify(manifest), manifestPath = path.join(jobDir, 'manifest.json');
  fs.writeFileSync(manifestPath, bytes);
  await adapter.upload({jobDir, manifest, manifestHash:crypto.createHash('sha256').update(bytes).digest('hex')});
  const readers = calls.map(encoded => {
    let script = Buffer.from(encoded, 'base64').toString('utf16le');
    if (script.includes('GZipStream')) {
      const compressed = /FromBase64String\('([^']+)'\)/.exec(script)[1];
      script = require('node:zlib').gunzipSync(Buffer.from(compressed, 'base64')).toString('utf8');
    }
    return /^\$manifest = .*$/m.exec(script)?.[0];
  }).filter(Boolean);
  assert.equal(readers.length, 2);
  for (const reader of readers) {
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$PSDefaultParameterValues['Get-Content:Encoding']='ASCII';
$manifestPath='${manifestPath.replace(/'/g, "''")}';
${reader}
$manifest.releaseNotes | ConvertTo-Json -Compress`;
    const stdout = require('node:child_process').execFileSync(path.join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',cli.encodedScript(script)], {encoding:'utf8',windowsHide:true,timeout:15000});
    assert.deepEqual(JSON.parse(stdout), notes);
  }
});

test('a twenty-file template and website upload stays within Windows SSH command-line limits', async t => {
  const calls = [], adapter = transport(t, async (exe, args) => {
    if (/ssh\.exe$/.test(exe)) {
      calls.push(args.at(-1));
      assert.ok(args.at(-1).length <= 7000, `encoded PowerShell command is ${args.at(-1).length} characters`);
    }
    return {stdout: '{"prepared":true}', stderr: ''};
  });
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-job-')); t.after(() => cleanup(jobDir, 'release-job-'));
  const backend = Array.from({length: 9}, (_, i) => `plugins/deck_analysis/deck_templates/${5890 + i}.ydk`);
  const website = [
    'plugins/ladder-web/web/intro.html',
    'plugins/ladder-web/web/rooms.html',
    'plugins/ladder-web/web/replays.html',
    'plugins/ladder-web/web/ladder.html',
    'plugins/ladder-web/web/deck-stats.html',
    'plugins/ladder-web/web/player-stats.html',
    'plugins/ladder-web/web/usage-stats.html',
    'plugins/ladder-web/web/deck-detail.html',
    'plugins/ladder-web/web/assets/common.css',
    'plugins/ladder-web/web/assets/site-shell.js',
    'plugins/ladder-web/web/assets/intro-web.js'
  ];
  const files = [...backend, ...website].map((relative, i) => {
    const source = 'payload/' + relative;
    const bytes = '#main\n' + String(i + 1), target = path.join(jobDir, source);
    fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, bytes);
    return {path: relative, source, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), beforeSha256: null, phase: i < backend.length ? 'backend' : 'website'};
  });
  const manifest = {schemaVersion: 2, id: 'deck-templates-20261023', title: 'templates', enabled: true,
    server: {projectRoot:'C:/srvpro',appName:'ygopro-server',pm2Home:'C:/Users/Administrator/.pm2',pm2Script:'C:/Users/Administrator/AppData/Roaming/npm/node_modules/pm2/bin/pm2',httpPort:7922,gamePort:7911,minimumFreeMiB:192},
    files, health: {ladderConfig:true,privateStatsGuard:true,expectedHooks:['random_duel_zombie_penalty'],mode:'TT',countAfkPenalty:false}, desktop:null,
    deckReclassification:{templateSha256:'a'.repeat(64),beforeTemplateSha256:'b'.repeat(64)}};
  const bytes = JSON.stringify(manifest); fs.writeFileSync(path.join(jobDir,'manifest.json'), bytes);
  await adapter.upload({jobDir,manifest,manifestHash:crypto.createHash('sha256').update(bytes).digest('hex')});
  assert.equal(calls.length,3);
});

test('compressed commands execute losslessly with Windows PowerShell 5.1', () => {
  assert.equal(typeof cli.encodedScript, 'function');
  const value = '模板维护 '.repeat(4000);
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @{ value='${value}' } | ConvertTo-Json -Compress`;
  const encoded = cli.encodedScript(script);
  assert.ok(encoded.length <= 7000);
  const output = require('node:child_process').execFileSync(path.join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded], {encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(JSON.parse(output).value,value);
});

test('local-only main preflight completes without starting a child or requiring desktop credentials', async t => {
  assert.equal(typeof cli.main, 'function');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cli-'));
  t.after(() => cleanup(workspace, 'release-cli-'));
  fs.writeFileSync(path.join(workspace, 'config.json'), JSON.stringify(config));
  const output = [];
  const result = await cli.main(['--workspace', workspace, '--preflight'], { execFile: async () => { throw Error('must not execute'); }, logger: line => output.push(line) });
  assert.equal(result.status, 'PREFLIGHT_OK');
  assert.equal(fs.existsSync(path.join(workspace, 'state', 'monitor.lock')), false);
});
