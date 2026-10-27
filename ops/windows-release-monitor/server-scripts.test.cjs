'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'release-powershell-test-')), batch = path.join(base, 'sample');
  fs.mkdirSync(batch); t.after(() => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('release-powershell-test-'));
    fs.rmSync(base, {recursive: true, force: true});
  });
  return {base, batch};
}
function powershell(script, batch, extra = {}) {
  return cp.spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Batch', batch],
    {encoding: 'utf8', windowsHide: true, timeout: 15000, ...extra});
}

test('read-state reports missing state and a different batch global lock', {skip: process.platform !== 'win32'}, t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.base, 'coordinator.lock'), JSON.stringify({jobId: 'other', pid: 2147483000, processStartedAt: '2026-10-20T00:00:00Z'}));
  const result = powershell(path.join(__dirname, 'read-state.ps1'), f.batch);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.stateExists, false); assert.equal(receipt.coordinatorRunning, false);
  assert.equal(receipt.lockExists, true); assert.equal(receipt.lockJobId, 'other'); assert.equal(receipt.lockCoordinatorRunning, false);
});

test('read-state proves the receipt and remote manifest have the same hash', {skip: process.platform !== 'win32'}, t => {
  const f = fixture(t), hash = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
  fs.writeFileSync(path.join(f.batch, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(f.batch, 'state.json'), JSON.stringify({jobId: 'sample', stage: 'FINISHED', outcome: 'UPDATED', manifestSha256: hash}));
  let result = powershell(path.join(__dirname, 'read-state.ps1'), f.batch);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).manifestSha256, hash);
  fs.writeFileSync(path.join(f.batch, 'manifest.json'), '{"changed":true}');
  result = powershell(path.join(__dirname, 'read-state.ps1'), f.batch);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /manifest_receipt_mismatch/);
});

test('launch refuses a global lock and a completed batch before WMI', {skip: process.platform !== 'win32'}, t => {
  const f = fixture(t), script = path.join(__dirname, 'launch-once.ps1');
  fs.writeFileSync(path.join(f.base, 'coordinator.lock'), '{}');
  let result = powershell(script, f.batch);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /global_lock_exists/);
  fs.unlinkSync(path.join(f.base, 'coordinator.lock'));
  fs.writeFileSync(path.join(f.batch, 'state.json'), JSON.stringify({stage: 'FINISHED', outcome: 'UPDATED', coordinatorPid: 2147483000, processStartedAt: '2026-10-20T00:00:00Z'}));
  result = powershell(script, f.batch);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /batch_already_attempted/);
});

test('launch uses hidden WMI breakaway and waits for its first receipt', {skip: process.platform !== 'win32'}, t => {
  const f = fixture(t), wrapper = path.join(f.base, 'fake-wmi.ps1');
  fs.writeFileSync(path.join(f.batch, 'server-coordinator.cjs'), '');
  const source = `param([string]$Batch)
$ErrorActionPreference='Stop'
function New-CimInstance { param($ClassName, [switch]$ClientOnly, $Property) return [pscustomobject]$Property }
function Invoke-CimMethod {
  param($ClassName,$MethodName,$Arguments)
  if($Arguments.ProcessStartupInformation.ShowWindow -ne 0 -or $Arguments.ProcessStartupInformation.CreateFlags -ne 0x01000000){throw 'not_hidden_breakaway'}
  [IO.File]::WriteAllText((Join-Path $Batch 'wmi.json'),($Arguments | ConvertTo-Json -Depth 6))
  [IO.File]::WriteAllText((Join-Path $Batch 'state.json'),(@{coordinatorPid=333;startedAt=[DateTime]::UtcNow.ToString('o');processStartedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json))
  return @{ReturnValue=0;ProcessId=333}
}
& $env:RELEASE_TEST_LAUNCH -Batch $Batch
`;
  fs.writeFileSync(wrapper, source);
  const result = powershell(wrapper, f.batch, {env: {...process.env, RELEASE_TEST_LAUNCH: path.join(__dirname, 'launch-once.ps1')}});
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout), wmi = JSON.parse(fs.readFileSync(path.join(f.batch, 'wmi.json')));
  assert.equal(receipt.launched, true); assert.equal(receipt.receiptReady, true); assert.equal(receipt.coordinatorPid, 333);
  assert.equal(receipt.launcher, 'WMI_BREAKAWAY');
  assert.ok(wmi.CommandLine.includes('"' + path.join(f.batch, 'server-coordinator.cjs') + '"'));
  assert.ok(wmi.CommandLine.includes('--batch "' + f.batch + '"'));
});
