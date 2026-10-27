'use strict';

function counts(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value).every(n => Number.isSafeInteger(n) && n >= 0);
}

function valid(s) {
  if (!s || typeof s.maintenanceEnabled !== 'boolean' || typeof s.readyToStop !== 'boolean' ||
      !Number.isSafeInteger(s.rooms) || s.rooms < 0 || !Number.isSafeInteger(s.pendingCount) || s.pendingCount < 0 ||
      !counts(s.pendingWork) || !counts(s.pendingPersistence)) return false;
  const pending = Object.values(s.pendingWork).reduce((sum, n) => sum + n, 0);
  if (pending !== s.pendingCount || !Number.isSafeInteger(pending)) return false;
  const persisted = Object.fromEntries(Object.entries(s.pendingWork).filter(([key]) => !key.endsWith('_protocol')));
  if (Object.keys(persisted).length !== Object.keys(s.pendingPersistence).length ||
      Object.entries(persisted).some(([key, value]) => s.pendingPersistence[key] !== value)) return false;
  return s.readyToStop === (s.maintenanceEnabled && s.rooms === 0 && s.pendingCount === 0);
}

const idle = s => valid(s) && s.rooms === 0 && s.pendingCount === 0;
const barrier = s => idle(s) && s.maintenanceEnabled && s.readyToStop;
const code = error => /^[a-z][a-z0-9_]{0,79}$/.test(error?.message) ? error.message : 'coordinator_operation_failed';

function healthFailure(error) {
  const d = error?.healthFailure;
  if (!d || !['preflight', 'new', 'old'].includes(d.version) ||
      !['hook_probe', 'process', 'maintenance', 'public_api', 'ladder_config', 'private_guard', 'template_download', 'game_port', 'http_port', 'startup_log'].includes(d.check) ||
      typeof d.reason !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(d.reason) || !Number.isSafeInteger(d.attempts) || d.attempts < 0 ||
      !Number.isSafeInteger(d.elapsedMilliseconds) || d.elapsedMilliseconds < 0) return undefined;
  return {version: d.version, check: d.check, reason: d.reason, attempts: d.attempts, elapsedMilliseconds: d.elapsedMilliseconds};
}

async function run(a, {jobId, hasBackend = true, hasWebsite = true, hasNotifications = false, preflightOnly = false} = {}) {
  const r = {jobId, stage: 'PREFLIGHT', outcome: 'PREFLIGHT', startedAt: new Date().toISOString(), backendActive: false, websitePublished: false};
  let ownsMaintenance = false, switched = false, healthy = false, startAttempted = false;
  if (hasNotifications) r.messages = {};
  const save = async stage => { r.stage = stage; await a.record({...r}); };
  const requireOwned = async () => { if (!await a.persisted(true)) throw Error('maintenance_ownership_lost'); };
  async function reopen() {
    await requireOwned();
    // Retry only our own maintenance value. An operator's replacement must survive.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await a.maintain(false);
        const s = await a.snapshot();
        if (valid(s) && !s.maintenanceEnabled && await a.persisted(false)) {
          ownsMaintenance = false;
          await save('REOPENED');
          return;
        }
      } catch (error) {
        if (!await a.persisted(true)) throw error;
      }
    }
    throw Error('reopen_failed');
  }
  async function endNotification(phase) {
    if (!hasNotifications || !startAttempted) return;
    try {
      const messageId = await a.notify(phase);
      if (typeof messageId !== 'string' || !messageId) throw Error('notification_confirmation_missing');
      r.messages[phase] = messageId;
    }
    catch (error) { r.notificationPending = phase; r.notificationErrorCode = code(error); }
  }
  try {
    await save('PREFLIGHT');
    Object.assign(r, await a.verify());
    const first = await a.snapshot();
    if (!valid(first)) throw Error('invalid_snapshot');
    r.initialSnapshot = first;
    if (preflightOnly) return r;
    if (first.maintenanceEnabled || (hasBackend && !idle(first))) {
      r.outcome = 'WAITING'; r.errorCode = first.maintenanceEnabled ? 'external_maintenance' : 'server_busy';
      return r;
    }
    if (hasBackend) {
      await save('ENABLING_MAINTENANCE');
      // Mark the attempted ownership before HTTP: a lost reply can still have persisted it.
      ownsMaintenance = true;
      await a.maintain(true);
      await requireOwned();
      if (!barrier(await a.snapshot())) {
        await reopen(); r.outcome = 'WAITING'; r.errorCode = 'barrier_raced'; return r;
      }
      if (hasNotifications) {
        await save('ANNOUNCING_START');
        startAttempted = true;
        const messageId = await a.notify('start');
        if (typeof messageId !== 'string' || !messageId) throw Error('notification_confirmation_missing');
        r.messages.start = messageId;
      }
      await save('SWITCHING_BACKEND');
      if (!barrier(await a.snapshot())) throw Error('barrier_changed');
      await requireOwned();
      await a.switchBackend(() => { switched = true; }, async (stage, details = {}) => {
        Object.assign(r, details); await save(stage);
      });
      await save('CHECKING_BACKEND');
      r.gameAfter = await a.health('new');
      healthy = true; r.backendActive = true;
      await reopen();
      await endNotification('success');
    }
    if (hasWebsite) {
      await save('PUBLISHING_WEBSITE');
      await a.publishWebsite();
      r.websitePublished = true;
    }
    r.outcome = 'UPDATED';
  } catch (error) {
    r.failureStage = r.stage; r.errorCode = code(error);
    const detail = healthFailure(error); if (detail) r.healthFailure = detail;
    if (r.stage === 'PUBLISHING_WEBSITE') r.outcome = 'FRONTEND_FAILED';
    else if (healthy) r.outcome = 'RECOVERY_FAILED';
    else if (switched) {
      try {
        await requireOwned();
        await save('ROLLING_BACK');
        const restored = await a.rollback();
        if (restored?.deckReclassification) r.deckReclassification = restored.deckReclassification;
        r.gameAfter = await a.health('old');
        await reopen(); r.outcome = 'ROLLED_BACK';
        await endNotification('rollback');
      } catch (recovery) {
        r.outcome = 'RECOVERY_FAILED'; r.recoveryErrorCode = code(recovery);
        const detail = healthFailure(recovery); if (detail) r.recoveryHealthFailure = detail;
      }
    } else {
      try {
        if (ownsMaintenance) await reopen();
        r.outcome = 'CANCELLED';
        await endNotification('cancel');
      } catch (recovery) { r.outcome = 'RECOVERY_FAILED'; r.recoveryErrorCode = code(recovery); }
    }
  } finally {
    r.finishedAt = new Date().toISOString();
    try { await save('FINISHED'); } finally { await a.close(); }
  }
  return r;
}

module.exports = {run, valid, idle, barrier};
