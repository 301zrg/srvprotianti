'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const RELATIVE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*)*$/;
const TERMINAL_OUTCOMES = new Set(['UPDATED', 'WAITING', 'ROLLED_BACK', 'CANCELLED', 'RECOVERY_FAILED', 'FRONTEND_FAILED']);

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function relative(value) { return typeof value === 'string' && RELATIVE.test(value) && !value.split('/').some(part => /[. ]$/.test(part)); }
function privatePath(value) {
  return /(^|\/)(config|data|replays?|recordings?|logs?|node_modules|\.git|\.ssh)(\/|$)/i.test(value) || /(^|\/)(?:\.env(?:\..*)?|config\.json|admin_user\.json|random_duel_ban\.json)$/i.test(value) || /\.(?:db|sqlite|sqlite3|pem|key|pfx)$/i.test(value);
}

function validateConfig(config) {
  if (!config || config.schemaVersion !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(config.sshHost || '') ||
      !relative(config.queueDir) || !relative(config.stateDir) || config.queueDir === config.stateDir ||
      !Number.isInteger(config.pollSeconds) || config.pollSeconds < 1 || config.pollSeconds > 3600 ||
      typeof config.remoteBase !== 'string' || !/^[a-zA-Z]:\/(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(config.remoteBase)) {
    throw failure('CONFIG_INVALID', '本机配置字段无效；请检查 schemaVersion、SSH 别名、目录与轮询秒数。');
  }
  let url;
  try { url = new URL(config.publicRoomsUrl); } catch { throw failure('CONFIG_INVALID', '公开房间地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('CONFIG_INVALID', '公开房间地址只接受不带凭据的 HTTP(S) 地址。');
  return config;
}

function validateManifest(manifest, folderId) {
  const invalid = () => { throw failure('MANIFEST_INVALID', `批次 ${folderId} 清单无效；请核对显式候选、文件路径和 SHA256。`); };
  if (!manifest || ![1, 2].includes(manifest.schemaVersion) || !ID.test(manifest.id || '') || manifest.id !== folderId || typeof manifest.title !== 'string' || !manifest.title.trim() || typeof manifest.enabled !== 'boolean' || !manifest.server || !manifest.health || !Array.isArray(manifest.files) || !Object.hasOwn(manifest, 'desktop')) invalid();
  const allowed = ['schemaVersion', 'id', 'title', 'enabled', 'server', 'files', 'health', 'desktop'];
  if (manifest.schemaVersion === 2) allowed.push('deckReclassification', 'notifications', 'releaseNotes', 'runtimeCleanup');
  if (Object.keys(manifest).some(key => !allowed.includes(key))) invalid();
  const server = manifest.server, health = manifest.health;
  const absoluteWindows = value => typeof value === 'string' && /^[a-zA-Z]:[\\/]/.test(value) && !/[\x00-\x1f"<>|?*]/.test(value) && !value.split(/[\\/]/).includes('..');
  const port = value => Number.isInteger(value) && value > 0 && value <= 65535;
  if (!absoluteWindows(server.projectRoot) || !absoluteWindows(server.pm2Home) || !absoluteWindows(server.pm2Script) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(server.appName || '') || !port(server.httpPort) || !port(server.gamePort) || server.httpPort === server.gamePort ||
      !Number.isInteger(server.minimumFreeMiB) || server.minimumFreeMiB < 1 ||
      typeof health.ladderConfig !== 'boolean' || typeof health.privateStatsGuard !== 'boolean' ||
      typeof health.mode !== 'string' || !/^[A-Z0-9_-]{1,16}$/.test(health.mode) || typeof health.countAfkPenalty !== 'boolean' ||
      !Array.isArray(health.expectedHooks) || !health.expectedHooks.length || health.expectedHooks.some(hook => typeof hook !== 'string' || !/^[a-zA-Z0-9_]+$/.test(hook))) invalid();
  if (manifest.files.length === 0 && !manifest.desktop) invalid();
  const destinations = new Set(), sources = new Set();
  for (const file of manifest.files) {
    if (!file || !relative(file.path) || !relative(file.source) || privatePath(file.path) || privatePath(file.source) ||
        /^(?:manifest\.json|state\.json|preflight-state\.json|server-coordinator\.cjs|server-flow\.cjs|release-options\.cjs|deck-maintenance\.cjs|discord-notifications\.cjs|announce-release\.cjs|release-announcement\.(?:json|lock)|launch-once\.ps1|read-state\.ps1)$/i.test(file.source) ||
        !HASH.test(file.sha256 || '') || !(file.beforeSha256 === null || HASH.test(file.beforeSha256 || '')) || !['backend', 'website'].includes(file.phase) ||
        (file.phase === 'website' && !file.path.startsWith('plugins/ladder-web/web/')) ||
        destinations.has(file.path.toLowerCase()) || sources.has(file.source.toLowerCase())) invalid();
    destinations.add(file.path.toLowerCase());
    sources.add(file.source.toLowerCase());
  }
  if (manifest.schemaVersion === 2) {
    try { require('./release-options.cjs').validateReleaseOptions(manifest); } catch { invalid(); }
  }
  return manifest;
}

function below(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw failure('PATH_ESCAPE', '候选路径越出指定目录。');
  return resolved;
}

function verifyPayload(job) {
  const realRoot = fs.realpathSync(job.jobDir);
  for (const file of job.manifest.files) {
    const filename = below(job.jobDir, file.source);
    let actual;
    try {
      const real = fs.realpathSync(filename);
      if (!real.startsWith(realRoot + path.sep) || !fs.statSync(real).isFile()) throw Error('path');
      actual = sha256(fs.readFileSync(real));
    } catch { throw failure('PAYLOAD_HASH_MISMATCH', `候选文件缺失或越界：${file.source}`); }
    if (actual !== file.sha256) throw failure('PAYLOAD_HASH_MISMATCH', `候选文件 SHA256 不符：${file.source}`);
  }
  return job;
}

function readJson(filename, optional = false) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw failure('LOCAL_STATE_INVALID', `无法读取有效 JSON：${filename}`);
  }
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(temp, filename);
}

function loadJobs(workspace, config) {
  const queueDir = below(workspace, config.queueDir);
  if (!fs.existsSync(queueDir)) return [];
  const jobs = [];
  for (const dirent of fs.readdirSync(queueDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isDirectory()) continue;
    const jobDir = below(queueDir, dirent.name);
    const filename = path.join(jobDir, 'manifest.json');
    if (!fs.existsSync(filename)) continue;
    const bytes = fs.readFileSync(filename);
    let manifest;
    try { manifest = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
    catch { throw failure('MANIFEST_INVALID', `批次 ${dirent.name} 不是有效 JSON。`); }
    validateManifest(manifest, dirent.name);
    if (manifest.enabled) jobs.push({ manifest, manifestHash: sha256(bytes), jobDir });
  }
  return jobs;
}

function createFileStore(stateDir) {
  return {
    get: id => readJson(path.join(stateDir, `${id}.json`), true),
    put: (id, value) => writeJson(path.join(stateDir, `${id}.json`), value),
    observation: value => writeJson(path.join(stateDir, 'observation.json'), value),
    monitor: value => writeJson(path.join(stateDir, 'monitor.json'), value)
  };
}

function acquireLocalLock(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const filename = path.join(stateDir, 'monitor.lock');
  const token = crypto.randomBytes(16).toString('hex');
  const value = { pid: process.pid, startedAt: new Date().toISOString(), token };
  try { fs.writeFileSync(filename, JSON.stringify(value), { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') throw failure('LOCAL_LOCKED', `本机监控锁已存在：${filename}。请先核对原窗口或退出回执；不会自动抢占陈旧锁。`);
    throw error;
  }
  return () => {
    const current = readJson(filename);
    if (current.token !== token) throw failure('LOCAL_LOCK_MISMATCH', '本机锁身份已改变；保留锁并停止。');
    fs.unlinkSync(filename);
  };
}

function validateStatus(value, job, record) {
  if (!value || typeof value.stateExists !== 'boolean' || typeof value.coordinatorRunning !== 'boolean' || typeof value.lockExists !== 'boolean' || (value.stateExists && !value.state) || (!value.stateExists && value.state !== null)) throw failure('REMOTE_STATE_INVALID', '服务器回执形状异常；停止自动触发。');
  if (value.lockExists && value.lockJobId !== job.manifest.id) throw failure('LOCK_MISMATCH', '服务器全局锁不属于当前批次；停止自动触发。');
  if (!value.stateExists) {
    if (value.coordinatorRunning || value.lockExists) throw failure('LOCK_MISMATCH', '服务器锁或进程存在但缺少批次回执。');
    if (record && ['TRIGGER_UNCERTAIN', 'RUNNING', 'SERVER_DONE'].includes(record.status)) throw failure('TRIGGER_UNCONFIRMED', '启动后未取得本批次回执；保留本地记录，禁止重发启动命令。');
    return value;
  }
  if (value.manifestSha256 !== job.manifestHash) throw failure('REMOTE_MANIFEST_MISMATCH', '服务器批次清单 SHA256 与当前审批候选不符；禁止后续发布或重新触发。');
  const state = value.state;
  if (state.jobId !== job.manifest.id || !Number.isInteger(state.coordinatorPid) || state.coordinatorPid <= 0 || !Number.isFinite(Date.parse(state.startedAt)) || typeof state.stage !== 'string' || !state.stage) throw failure('RECEIPT_MISMATCH', '服务器回执的批次或协调进程身份无效。');
  if (record?.coordinatorPid && (record.coordinatorPid !== state.coordinatorPid || (record.coordinatorStartedAt && record.coordinatorStartedAt !== state.startedAt))) throw failure('RECEIPT_MISMATCH', '服务器协调进程 PID 或开始时间与已记录身份不符。');
  if (record?.previousAttempt && record.previousAttempt.coordinatorPid === state.coordinatorPid && record.previousAttempt.startedAt === state.startedAt) throw failure('OLD_RECEIPT', '启动后仍是上一轮回执；禁止自动重发启动命令。');
  if (state.stage !== 'FINISHED' && !value.coordinatorRunning) throw failure('COORDINATOR_DEAD', '服务器协调进程已退出但没有完成回执；需要人工核对。');
  if (state.stage !== 'FINISHED' && value.coordinatorRunning && !value.lockExists) throw failure('LOCK_MISMATCH', '协调进程仍在运行但全局锁缺失；需要人工核对。');
  if (!value.coordinatorRunning && value.lockExists) throw failure('LOCK_MISMATCH', '协调进程已退出但全局锁仍存在；保留陈旧锁并停止。');
  if (state.stage === 'FINISHED' && !TERMINAL_OUTCOMES.has(state.outcome)) throw failure('REMOTE_STATE_INVALID', '服务器终态结果不在约定范围内。');
  return value;
}

function createMonitor({ workspace, config, adapter, desktop, store, logger = console.log, signal }) {
  validateConfig(config);
  workspace = path.resolve(workspace);
  const stateDir = below(workspace, config.stateDir);
  store ||= createFileStore(stateDir);
  const stamp = () => new Date().toISOString();
  const save = (job, record) => { store.put(job.manifest.id, record); return record; };
  const stopped = (job, record, error) => {
    const resumable = record?.status === 'SERVER_DONE' && new Set(['DESKTOP_INTERRUPTED', 'DESKTOP_CI_TIMEOUT',
      'DESKTOP_REQUEST_FAILED', 'DESKTOP_ASSET_DOWNLOAD_FAILED', 'DESKTOP_AUTH_REQUIRED',
      'DESKTOP_PAGES_REQUEST_FAILED', 'DESKTOP_PAGES_TIMEOUT', 'ABORT_ERR']).has(error.code) ||
      record?.status === 'ANNOUNCEMENT_PENDING' && ['RELEASE_ANNOUNCEMENT_FAILED', 'REMOTE_UNAVAILABLE'].includes(error.code);
    save(job, { ...record, jobId: job.manifest.id, manifestHash: job.manifestHash, status: resumable ? record.status : 'STOPPED_FOR_REVIEW', errorCode: error.code || 'MONITOR_FAILED', error: error.message, checkedAt: stamp() });
    throw error;
  };
  const remote = async (job, record) => {
    let value;
    try { value = await adapter.readState(job); }
    catch { throw failure('REMOTE_UNAVAILABLE', '无法核对服务器回执；保留记录，禁止重新触发。'); }
    return validateStatus(value, job, record);
  };

  async function handle(job, record, status, mayLaunch) {
    const value = status || await remote(job, record);
    if (signal?.aborted) return { status: 'STOPPED' };
    if (record?.status === 'ANNOUNCEMENT_PENDING' && (!value.stateExists || value.state.stage !== 'FINISHED' || value.state.outcome !== 'UPDATED')) throw failure('REMOTE_STATE_INVALID', '公告恢复缺少原批次的成功回执；停止处理，不重发发布命令。');
    if (value.stateExists) {
      const state = value.state;
      record = save(job, { ...record, jobId: job.manifest.id, manifestHash: job.manifestHash, coordinatorPid: state.coordinatorPid, coordinatorStartedAt: state.startedAt, remoteState: state, checkedAt: stamp() });
      if (state.stage !== 'FINISHED' || value.coordinatorRunning || value.lockExists) {
        save(job, { ...record, status: record.status === 'ANNOUNCEMENT_PENDING' ? record.status : 'RUNNING' });
        logger(`批次 ${job.manifest.id}：服务器阶段 ${state.stage}，等待协调进程退出和锁清理。`);
        return { status: 'RUNNING', jobId: job.manifest.id };
      }
      if (state.outcome === 'WAITING') {
        record = save(job, { ...record, status: 'WAITING', coordinatorPid: null, coordinatorStartedAt: null });
        if (!mayLaunch) return { status: 'WAITING', jobId: job.manifest.id };
      } else if (state.outcome !== 'UPDATED') {
        const diagnostic = [state.failureStage, state.errorCode, state.healthFailure?.check, state.healthFailure?.reason]
          .filter(value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/i.test(value)).join(' / ');
        throw failure(state.outcome, `服务器结果 ${state.outcome}${diagnostic ? '；诊断 ' + diagnostic : ''}；停止后续发布与自动重试。`);
      } else {
        if (job.manifest.files.some(file => file.phase === 'backend') && state.backendActive !== true) throw failure('REMOTE_STATE_INVALID', 'UPDATED 回执未确认后端已启用。');
        if (job.manifest.files.some(file => file.phase === 'website') && state.websitePublished !== true) throw failure('REMOTE_STATE_INVALID', 'UPDATED 回执未确认官网文件已发布。');
        let desktopResult = record.status === 'ANNOUNCEMENT_PENDING' ? record.desktop : { status: 'SKIPPED' };
        if (record.status === 'ANNOUNCEMENT_PENDING') {
          if (!job.manifest.releaseNotes || desktopResult?.status !== (job.manifest.desktop === null ? 'SKIPPED' : 'PUBLISHED')) throw failure('LOCAL_STATE_INVALID', '公告待处理回执缺少已验证的发布结果。');
        } else {
          record = save(job, { ...record, status: 'SERVER_DONE' });
          if (job.manifest.desktop !== null) {
            if (!desktop?.publishDesktop) throw failure('DESKTOP_ADAPTER_MISSING', '缺少桌面发布适配器；服务器已完成，禁止重新触发服务器。');
            desktopResult = await desktop.publishDesktop(job.manifest.desktop, { jobDir: job.jobDir, stateDir, signal, log: logger });
          }
        }
        let announcement;
        if (job.manifest.releaseNotes) {
          if (desktopResult?.status !== (job.manifest.desktop === null ? 'SKIPPED' : 'PUBLISHED') ||
              job.manifest.desktop?.pages && desktopResult.pages?.status !== 'PUBLISHED') throw failure('DESKTOP_RESULT_INVALID', '助手或页面包尚未全部核验完成，不能发送更新成功公告。');
          record = save(job, { ...record, status: 'ANNOUNCEMENT_PENDING', desktop: desktopResult });
          if (signal?.aborted) return {status: 'STOPPED'};
          try {
            announcement = await adapter.announceRelease(job);
            if (announcement?.status !== 'CONFIRMED' || announcement.guildId !== '1504410444876484658' ||
                announcement.channelId !== '1554786350845141002' || !/^[0-9]{17,20}$/.test(announcement.messageId || '')) throw Error();
          } catch { throw failure('RELEASE_ANNOUNCEMENT_FAILED', '本批更新已验收，更新内容公告待核对；重新打开入口只续跑公告，不重复发布或重启。'); }
        }
        save(job, { ...record, status: 'COMPLETE', desktop: desktopResult, ...(announcement ? {announcement} : {}), errorCode: null, error: null, finishedAt: stamp() });
        logger(`批次 ${job.manifest.id} 已完成；服务器协调进程退出且锁已清除。`);
        if (state.notificationPending) logger(`Discord ${state.notificationPending} 通知待核对；游戏已完成本批处理，不会再次重启。`);
        return { status: 'COMPLETE', jobId: job.manifest.id };
      }
    }
    if (!mayLaunch) return { status: 'WAITING', jobId: job.manifest.id };
    if (signal?.aborted) return { status: 'STOPPED' };
    verifyPayload(job);
    if (job.manifest.desktop !== null) {
      if (!desktop?.preflightDesktop) throw failure('DESKTOP_ADAPTER_MISSING', '缺少桌面候选预检适配器。');
      await desktop.preflightDesktop(job.manifest.desktop, { jobDir: job.jobDir, stateDir, signal, log: logger });
    }
    if (!record?.prepared) await adapter.upload(job);
    if (signal?.aborted) return { status: 'STOPPED' };
    // The intent is durable before SSH: interruption after launch must reconcile.
    const previousAttempt = value.stateExists ? { coordinatorPid: value.state.coordinatorPid, startedAt: value.state.startedAt } : null;
    record = save(job, { jobId: job.manifest.id, manifestHash: job.manifestHash, status: 'TRIGGER_UNCERTAIN', prepared: true, previousAttempt, attemptStartedAt: stamp() });
    let launched;
    try { launched = await adapter.launch(job); }
    catch { logger('启动响应不明确；只核对服务器回执，不重发启动命令。'); }
    if (Number.isInteger(launched?.coordinatorPid) && launched.coordinatorPid > 0) record = save(job, { ...record, coordinatorPid: launched.coordinatorPid });
    const current = await remote(job, record);
    if (!current.stateExists) throw failure('TRIGGER_UNCONFIRMED', '启动后没有确认回执；停止并保留本地启动意图。');
    return handle(job, record, current, false);
  }

  let observations = 0, lastPublicRooms;
  async function step() {
    const jobs = loadJobs(workspace, config);
    const pending = [];
    for (const job of jobs) {
      const record = store.get(job.manifest.id);
      if (record?.manifestHash && record.manifestHash !== job.manifestHash) stopped(job, record, failure('MANIFEST_CHANGED', '已记录批次清单发生变化；请使用新批次编号。'));
      if (record?.status === 'STOPPED_FOR_REVIEW') throw failure('STOPPED_FOR_REVIEW', `批次 ${job.manifest.id} 待核对：${record.errorCode || record.error}`);
      if (record?.status === 'COMPLETE') continue;
      try { verifyPayload(job); } catch (error) { stopped(job, record, error); }
      pending.push({ job, record });
    }
    // In-flight remote work is reconciled even if public HTTP is unavailable.
    const inflight = pending.find(item => ['TRIGGER_UNCERTAIN', 'RUNNING', 'SERVER_DONE', 'ANNOUNCEMENT_PENDING'].includes(item.record?.status));
    if (inflight) {
      try { return await handle(inflight.job, inflight.record, null, false); }
      catch (error) { stopped(inflight.job, store.get(inflight.job.manifest.id), error); }
    }
    let publicRooms = null;
    try {
      const body = await adapter.publicRooms();
      if (!body || !Array.isArray(body.rooms)) throw Error('rooms shape');
      publicRooms = body.rooms.length;
    } catch { logger('公开房间请求失败或数据异常；不会按零房间处理。'); }
    observations++;
    if (publicRooms !== null && (publicRooms !== lastPublicRooms || observations % 6 === 0)) logger(`当前公开房间：${publicRooms}；待处理批次：${pending.length}。`);
    lastPublicRooms = publicRooms;
    store.observation({ checkedAt: stamp(), localPid: process.pid, publicRooms, queuedJobs: pending.length });
    if (pending.length === 0) return { status: 'OBSERVING', publicRooms, queuedJobs: 0 };
    const { job, record } = pending[0];
    if (job.manifest.files.some(file => file.phase === 'backend')) {
      if (publicRooms === null) return { status: 'OBSERVING', publicRooms, queuedJobs: pending.length };
      if (publicRooms > 0) return { status: 'WAITING', publicRooms, queuedJobs: pending.length };
    }
    try { return { ...await handle(job, record, null, true), publicRooms }; }
    catch (error) { stopped(job, store.get(job.manifest.id) || record, error); }
  }

  async function run({ once = false, preflight = false, remotePreflight = false } = {}) {
    try {
      if (remotePreflight && !preflight) throw failure('CLI_INVALID', '远端预检必须显式使用预检模式。');
      if (preflight) {
        const jobs = loadJobs(workspace, config);
        let checked = 0;
        for (const job of jobs) {
          const record = store.get(job.manifest.id);
          if (record?.manifestHash && record.manifestHash !== job.manifestHash) throw failure('MANIFEST_CHANGED', '已记录批次清单发生变化；请使用新批次编号。');
          if (record?.status === 'COMPLETE') continue;
          verifyPayload(job);
          if (job.manifest.desktop !== null) {
            if (!desktop?.preflightDesktop) throw failure('DESKTOP_ADAPTER_MISSING', '缺少桌面候选预检适配器。');
            await desktop.preflightDesktop(job.manifest.desktop, { jobDir: job.jobDir, stateDir, signal, log: logger });
          }
          if (remotePreflight) await adapter.remotePreflight(job);
          checked++;
        }
        return { status: 'PREFLIGHT_OK', jobs: checked, remote: remotePreflight };
      }
      store.monitor({ status: 'RUNNING', pid: process.pid, startedAt: stamp() });
      while (!signal?.aborted) {
        const result = await step();
        if (once) { store.monitor({ status: 'ONCE_FINISHED', finishedAt: stamp(), result }); return result; }
        await adapter.sleep(config.pollSeconds * 1000, signal);
      }
      const result = { status: 'STOPPED', stoppedAt: stamp(), reason: '本机等待已停止；远端协调进程继续独立收尾。' };
      store.monitor(result);
      return result;
    } catch (error) {
      store.monitor({ status: 'STOPPED_FOR_REVIEW', stoppedAt: stamp(), errorCode: error.code || 'MONITOR_FAILED', error: error.message });
      throw error;
    }
  }
  return { step, run };
}

module.exports = { createMonitor, validateConfig, validateManifest, verifyPayload, loadJobs, createFileStore, acquireLocalLock, readJson, writeJson, sha256, failure };
