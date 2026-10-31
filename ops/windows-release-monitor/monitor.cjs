'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { promisify } = require('node:util');
const { createMonitor, validateConfig, validateManifest, verifyPayload, acquireLocalLock, readJson, sha256, failure } = require('./monitor-core.cjs');

const SUPPORT = ['server-coordinator.cjs', 'server-flow.cjs', 'launch-once.ps1', 'read-state.ps1'];

function parseArgs(argv) {
  const result = { workspace: path.resolve(__dirname, '../../../server-release-monitor'), once: false, preflight: false, remotePreflight: false };
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === '--workspace') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw failure('CLI_INVALID', '--workspace 需要本机交接目录。');
      result.workspace = path.resolve(value);
    } else if (option === '--once') result.once = true;
    else if (option === '--preflight') result.preflight = true;
    else if (option === '--remote-preflight') { result.preflight = true; result.remotePreflight = true; }
    else throw failure('CLI_INVALID', `未知参数：${option}`);
  }
  return result;
}

function jsonResponse(stdout) {
  let value;
  try { value = JSON.parse(String(stdout).trim()); }
  catch { throw failure('REMOTE_RESPONSE_INVALID', '服务器未返回唯一有效 JSON；停止自动触发。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('REMOTE_RESPONSE_INVALID', '服务器 JSON 回执形状异常。');
  return value;
}

function encodedScript(script) {
  const encode = value => Buffer.from(value, 'utf16le').toString('base64');
  const plain = encode(script);
  if (plain.length <= 7000) return plain;
  // Windows OpenSSH invokes its default shell before PowerShell; keep below cmd.exe's limit.
  const compressed = require('node:zlib').gzipSync(Buffer.from(script, 'utf8')).toString('base64');
  const wrapper = `$s=[IO.MemoryStream]::new([Convert]::FromBase64String('${compressed}'));
$g=[IO.Compression.GZipStream]::new($s,[IO.Compression.CompressionMode]::Decompress);
$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);
try { & ([ScriptBlock]::Create($r.ReadToEnd())) } finally { $r.Dispose() }`;
  const encoded = encode(wrapper);
  if (encoded.length > 7000) throw failure('REMOTE_COMMAND_TOO_LARGE', `批次校验清单压缩后仍有 ${encoded.length} 个字符，超过 Windows SSH 限制；请拆分批次。`);
  return encoded;
}

function createTransport(config, { execFile = promisify(cp.execFile), fetchImpl = globalThis.fetch, supportDir = __dirname } = {}) {
  validateConfig(config);
  const windows = process.env.WINDIR || 'C:/Windows';
  const ssh = path.join(windows, 'System32', 'OpenSSH', 'ssh.exe');
  const scp = path.join(windows, 'System32', 'OpenSSH', 'scp.exe');
  const strict = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'ConnectTimeout=10'];
  const execute = (exe, args, timeout = 30000) => execFile(exe, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout, maxBuffer: 2 * 1024 * 1024 });
  const batchPath = job => {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(job?.manifest?.id || '')) throw failure('MANIFEST_INVALID', '批次编号无效。');
    return `${config.remoteBase}/${job.manifest.id}`;
  };
  const powershell = script => execute(ssh, [...strict, config.sshHost, 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript(script)]);
  const scriptData = value => `$v = '${JSON.stringify(value).replace(/'/g, "''")}' | ConvertFrom-Json;`;

  async function readState(job) {
    const batch = batchPath(job);
    const script = `$ErrorActionPreference = 'Stop'; ${scriptData({ batch, remoteBase: config.remoteBase })}
$reader = Join-Path $v.batch 'read-state.ps1';
if (Test-Path -LiteralPath $reader -PathType Leaf) { & $reader -Batch $v.batch; if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
elseif (Test-Path -LiteralPath $v.batch) { throw 'Batch exists without its status reader; review required.' }
else { $locked = Test-Path -LiteralPath (Join-Path $v.remoteBase 'coordinator.lock'); @{ stateExists = $false; state = $null; coordinatorRunning = $false; lockExists = [bool]$locked; lockJobId = $null; lockCoordinatorRunning = $false } | ConvertTo-Json -Compress }`;
    return jsonResponse((await powershell(script)).stdout);
  }

  async function upload(job) {
    validateManifest(job.manifest, job.manifest.id);
    verifyPayload(job);
    const batch = batchPath(job);
    const manifestPath = path.join(job.jobDir, 'manifest.json');
    if (sha256(fs.readFileSync(manifestPath)) !== job.manifestHash) throw failure('MANIFEST_CHANGED', '上传前批次清单发生变化。');
    const transfers = [{ source: manifestPath, relative: 'manifest.json', sha256: job.manifestHash }];
    for (const file of job.manifest.files) transfers.push({ source: path.join(job.jobDir, file.source), relative: file.source, sha256: file.sha256 });
    const support = job.manifest.schemaVersion === 2 ? [...SUPPORT, 'release-options.cjs', 'deck-maintenance.cjs', 'discord-notifications.cjs'] : SUPPORT;
    if (job.manifest.releaseNotes) support.push('announce-release.cjs');
    for (const name of support) {
      const source = path.join(supportDir, name);
      transfers.push({ source, relative: name, sha256: sha256(fs.readFileSync(source)) });
    }
    if (new Set(transfers.map(file => file.relative.toLowerCase())).size !== transfers.length) throw failure('MANIFEST_INVALID', '候选源路径与协调器保留文件重名。');
    const staging = `${config.remoteBase}/.upload-${job.manifest.id}-${crypto.randomBytes(8).toString('hex')}`;
    const data = { batch, staging, remoteBase: config.remoteBase, manifestHash: job.manifestHash };
    // Stage separately. Existing control files are only hash-checked, never overwritten.
    await powershell(`$ErrorActionPreference = 'Stop'; ${scriptData(data)}
New-Item -ItemType Directory -Path $v.remoteBase -Force | Out-Null;
if (Test-Path -LiteralPath (Join-Path $v.remoteBase 'coordinator.lock')) { throw 'Global coordinator lock exists; prepared upload remains isolated.' }
New-Item -ItemType Directory -Path $v.staging -ErrorAction Stop | Out-Null;
@{ staged = $true } | ConvertTo-Json -Compress`);
    const [manifestTransfer, ...remainingTransfers] = transfers;
    await execute(scp, [...strict, manifestTransfer.source, `${config.sshHost}:${staging}/${manifestTransfer.relative}`], 120000);
    await powershell(`$ErrorActionPreference = 'Stop'; ${scriptData(data)}
$manifestPath = Join-Path $v.staging 'manifest.json';
if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $v.manifestHash) { throw 'Uploaded manifest hash mismatch.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json;
foreach ($file in $manifest.files) {
  $parent = Split-Path -Parent (Join-Path $v.staging $file.source);
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
}
@{ directoriesReady = $true } | ConvertTo-Json -Compress`);
    for (const file of remainingTransfers) await execute(scp, [...strict, file.source, `${config.sshHost}:${staging}/${file.relative}`], 120000);
    const supportHashes = remainingTransfers.filter(file => !job.manifest.files.some(candidate => candidate.source === file.relative))
      .map(file => [file.relative, file.sha256]);
    const verification = { ...data, support: supportHashes };
    const prepared = await powershell(`$ErrorActionPreference = 'Stop'; ${scriptData(verification)}
$manifestPath = Join-Path $v.staging 'manifest.json';
if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $v.manifestHash) { throw 'Uploaded manifest hash mismatch.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json;
$expected = @(,@('manifest.json', $v.manifestHash));
foreach ($file in $manifest.files) { $expected += ,@($file.source, $file.sha256) }
foreach ($file in $v.support) { $expected += ,$file }
foreach ($file in $expected) {
  $candidate = Join-Path $v.staging $file[0];
  if ((Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file[1]) { throw 'Uploaded candidate hash mismatch.' }
}
if (Test-Path -LiteralPath (Join-Path $v.remoteBase 'coordinator.lock')) { throw 'Global coordinator lock exists; prepared upload remains isolated.' }
if (Test-Path -LiteralPath $v.batch) {
  foreach ($file in $expected) {
    $existing = Join-Path $v.batch $file[0];
    if (!(Test-Path -LiteralPath $existing -PathType Leaf) -or (Get-FileHash -LiteralPath $existing -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file[1]) { throw 'Existing batch differs; do not overwrite. Use a new batch id after review.' }
  }
} else { Move-Item -LiteralPath $v.staging -Destination $v.batch -ErrorAction Stop }
@{ prepared = $true } | ConvertTo-Json -Compress`);
    if (jsonResponse(prepared.stdout).prepared !== true) throw failure('REMOTE_RESPONSE_INVALID', '服务器未确认候选上传校验。');
  }

  async function launch(job) {
    const batch = batchPath(job);
    if (!/^[a-f0-9]{64}$/.test(job.manifestHash || '')) throw failure('MANIFEST_INVALID', '启动请求缺少固定清单 SHA。');
    const result = await execute(ssh, [...strict, config.sshHost, 'powershell.exe', '-NoProfile', '-NonInteractive', '-File', `${batch}/launch-once.ps1`, '-Batch', batch, '-ManifestSha', job.manifestHash]);
    return jsonResponse(result.stdout);
  }

  async function remotePreflight(job) {
    const status = await readState(job);
    if (status.coordinatorRunning || status.lockExists) throw failure('REMOTE_BUSY', '远端协调器或全局锁存在，停止预检上传。');
    await upload(job);
    const batch = batchPath(job);
    // This CLI mode cannot activate maintenance or start/restart the game process.
    const result = await powershell(`$ErrorActionPreference = 'Stop'; ${scriptData({ batch })}
& node.exe (Join-Path $v.batch 'server-coordinator.cjs') --batch $v.batch --preflight-only;
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`);
    const response = jsonResponse(result.stdout);
    if (job.manifest.releaseNotes) await announceRelease(job, {preflight: true});
    return response;
  }

  async function announceRelease(job, {preflight = false} = {}) {
    const {validateReleaseNotes} = require('./discord-notifications.cjs');
    if (!validateReleaseNotes(job.manifest.releaseNotes)) return {status: 'DISABLED'};
    if (!/^[a-f0-9]{64}$/.test(job.manifestHash || '')) throw failure('MANIFEST_INVALID', '公告请求缺少固定清单 SHA。');
    const result = await powershell(`$ErrorActionPreference = 'Stop'; ${scriptData({batch: batchPath(job), manifestHash: job.manifestHash})}
& node.exe (Join-Path $v.batch 'announce-release.cjs') --batch $v.batch --manifest-sha $v.manifestHash${preflight ? ' --preflight' : ''};
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`);
    const value = jsonResponse(result.stdout);
    if (value.status !== (preflight ? 'READY' : 'CONFIRMED') || value.guildId !== '1504410444876484658' || value.channelId !== '1554786350845141002' ||
        (preflight ? value.enabled !== true : !/^[0-9]{17,20}$/.test(value.messageId || ''))) throw failure('REMOTE_RESPONSE_INVALID', '更新公告未返回既定频道的有效确认。');
    return value;
  }

  async function publicRooms() {
    const response = await fetchImpl(config.publicRoomsUrl, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw failure('PUBLIC_ROOMS_UNAVAILABLE', `公开房间 HTTP ${response.status}`);
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1048576) { await reader.cancel(); throw failure('PUBLIC_ROOMS_INVALID', '公开房间响应过大。'); }
          chunks.push(Buffer.from(part.value));
        }
      } finally { reader.releaseLock(); }
      text = Buffer.concat(chunks).toString('utf8');
    } else text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 1048576) throw failure('PUBLIC_ROOMS_INVALID', '公开房间响应过大。');
    try { return JSON.parse(text); } catch { throw failure('PUBLIC_ROOMS_INVALID', '公开房间不是有效 JSON。'); }
  }

  function sleep(milliseconds, signal) {
    if (signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, milliseconds);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }
  return { publicRooms, readState, upload, launch, remotePreflight, announceRelease, sleep };
}

async function main(argv = process.argv.slice(2), overrides = {}) {
  const options = parseArgs(argv);
  const config = validateConfig(readJson(path.join(options.workspace, 'config.json')));
  const logger = overrides.logger || (line => console.log(`${new Date().toLocaleString('zh-CN', { hour12: false })} ${line}`));
  const abort = new AbortController();
  const stop = () => { logger('已停止本机等待；服务器一次性协调进程仍按自身回执独立收尾。'); abort.abort(); };
  const signal = overrides.signal || abort.signal;
  const release = options.preflight && !options.remotePreflight ? () => {} : acquireLocalLock(path.resolve(options.workspace, config.stateDir));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const adapter = overrides.adapter || createTransport(config, overrides);
    const desktop = overrides.desktop || {
      preflightDesktop: (...args) => require('./desktop-publish.cjs').preflightDesktop(...args),
      publishDesktop: (...args) => require('./desktop-publish.cjs').publishDesktop(...args)
    };
    const monitor = createMonitor({ workspace: options.workspace, config, adapter, desktop, logger, signal });
    logger(options.preflight ? `开始${options.remotePreflight ? '远端只读' : '纯本地'}预检。` : '本机常驻监控已启动；只处理 queue 中明确启用的批次。无任务时继续观察。');
    const result = await monitor.run(options);
    logger(`本机结果：${result.status}；回执目录：${path.resolve(options.workspace, config.stateDir)}`);
    return result;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    release();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`监控已停止：${error.code || 'MONITOR_FAILED'}；${error.message}`);
    console.error('保留本地回执并恢复 Codex 会话核对；不会自动重发不确定的启动命令。');
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, encodedScript, createTransport, main };
