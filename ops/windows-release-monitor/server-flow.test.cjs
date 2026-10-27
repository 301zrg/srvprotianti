'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const flow = require('./server-flow.cjs');

const open = () => ({maintenanceEnabled: false, rooms: 0, pendingWork: {}, pendingPersistence: {}, pendingCount: 0, readyToStop: false});
const stopped = () => ({...open(), maintenanceEnabled: true, readyToStop: true});

function fixture(overrides = {}) {
  const calls = [], states = [];
  let maintenance = false;
  const adapter = {
    verify: async () => { calls.push('verify'); return {gameBefore: {pid: 1}}; },
    snapshot: async () => maintenance ? stopped() : open(),
    persisted: async value => value === maintenance,
    maintain: async value => { calls.push(value ? 'close' : 'open'); maintenance = value; },
    switchBackend: async issued => { issued(); calls.push('switch'); },
    health: async version => { calls.push('health:' + version); return {pid: 2}; },
    rollback: async () => { calls.push('rollback'); },
    publishWebsite: async () => { calls.push('website'); },
    record: async state => { states.push({...state}); },
    close: async () => { calls.push('release-lock'); },
    ...overrides
  };
  return {adapter, calls, states};
}
const options = {jobId: 'sample', hasBackend: true, hasWebsite: true};

test('a complete snapshot includes internally consistent pending work', () => {
  assert.equal(flow.valid(open()), true);
  for (const invalid of [null, {}, {...open(), pendingWork: undefined}, {...open(), pendingCount: 1}, {...open(), rooms: -1}, {...open(), readyToStop: true}, {...open(), pendingWork: {db: -1}}]) {
    assert.equal(flow.valid(invalid), false);
  }
});

test('invalid, active, pending, and externally maintained snapshots never switch', async () => {
  for (const snapshot of [{}, {...open(), rooms: 1}, {...open(), pendingWork: {db: 1}, pendingPersistence: {db: 1}, pendingCount: 1}, stopped()]) {
    const f = fixture({snapshot: async () => snapshot});
    const result = await flow.run(f.adapter, options);
    assert.equal(f.calls.includes('switch'), false);
    assert.equal(f.calls.includes('close'), false);
    assert.equal(result.stage, 'FINISHED');
    assert.equal(result.outcome, flow.valid(snapshot) ? 'WAITING' : 'CANCELLED');
  }
});

test('preflight verifies and observes without maintenance, restart, or publishing', async () => {
  const f = fixture();
  const result = await flow.run(f.adapter, {...options, preflightOnly: true});
  assert.equal(result.outcome, 'PREFLIGHT');
  assert.deepEqual(f.calls, ['verify', 'release-lock']);
});

test('a raced barrier reopens only owned maintenance and can wait again', async () => {
  let count = 0;
  const f = fixture({snapshot: async () => ++count === 1 || count >= 3 ? open() : {...stopped(), rooms: 1, readyToStop: false}});
  const result = await flow.run(f.adapter, options);
  assert.equal(result.outcome, 'WAITING');
  assert.deepEqual(f.calls, ['verify', 'close', 'open', 'release-lock']);
});

test('backend health precedes reopening, which precedes website publication', async () => {
  const f = fixture();
  const result = await flow.run(f.adapter, options);
  assert.equal(result.outcome, 'UPDATED');
  assert.equal(result.backendActive, true);
  assert.equal(result.websitePublished, true);
  assert.deepEqual(f.calls, ['verify', 'close', 'switch', 'health:new', 'open', 'website', 'release-lock']);
});

test('website failure preserves the healthy open backend and never rolls it back', async () => {
  const f = fixture({publishWebsite: async () => { throw Error('website_failed'); }});
  const result = await flow.run(f.adapter, options);
  assert.equal(result.outcome, 'FRONTEND_FAILED');
  assert.equal(result.backendActive, true);
  assert.equal(f.calls.includes('rollback'), false);
  assert.equal(f.calls.filter(x => x === 'switch').length, 1);
});

test('failed backend restores old health before opening and blocks the website', async () => {
  const f = fixture({health: async version => { f.calls.push('health:' + version); if (version === 'new') throw Error('health_timeout'); }});
  const result = await flow.run(f.adapter, options);
  assert.equal(result.outcome, 'ROLLED_BACK');
  assert.equal(result.backendActive, false);
  assert.deepEqual(f.calls, ['verify', 'close', 'switch', 'health:new', 'rollback', 'health:old', 'open', 'release-lock']);
});

test('a rollback receipt keeps the new health failure after the old service recovers', async () => {
  const detail = {version: 'new', check: 'hook_probe', reason: 'hook_probe_timeout', attempts: 1, elapsedMilliseconds: 12000};
  const f = fixture({health: async version => {
    if (version === 'new') throw Object.assign(Error('health_probe_failed'), {healthFailure: {...detail, body: 'never-print'}});
    return {pid: 3};
  }});
  const result = await flow.run(f.adapter, options);
  assert.equal(result.outcome, 'ROLLED_BACK');
  assert.deepEqual(result.healthFailure, detail);
  assert.equal(JSON.stringify(result).includes('never-print'), false);
});

test('a restored deck snapshot replaces the pre-rollback applied snapshot in the final receipt', async () => {
  const restored = {status: 'rolled_back', committed: false, restoredSha256: 'b'.repeat(64)};
  const f = fixture({
    switchBackend: async (issued, progress) => { issued(); await progress('DECKS_RECLASSIFIED', {deckReclassification: {status: 'applied', committed: true}}); },
    health: async version => { if (version === 'new') throw Error('health_probe_failed'); return {pid: 3}; },
    rollback: async () => ({deckReclassification: restored})
  });
  const result = await flow.run(f.adapter, options);
  assert.equal(result.outcome, 'ROLLED_BACK');
  assert.deepEqual(result.deckReclassification, restored);
});

test('lost maintenance ownership is not reopened or used for rollback', async () => {
  const f = fixture({persisted: async () => false});
  const result = await flow.run(f.adapter, options);
  assert.equal(result.outcome, 'RECOVERY_FAILED');
  assert.equal(f.calls.includes('open'), false);
  assert.equal(f.calls.includes('switch'), false);
});

test('a healthy backend that cannot reopen is not restarted again', async () => {
  const f = fixture({maintain: async value => { f.calls.push(value ? 'close' : 'open'); if (!value) throw Error('ownership_lost'); }, snapshot: async () => f.calls.includes('close') ? stopped() : open(), persisted: async value => value});
  const result = await flow.run(f.adapter, options);
  assert.equal(result.outcome, 'RECOVERY_FAILED');
  assert.equal(result.backendActive, true);
  assert.equal(f.calls.includes('rollback'), false);
  assert.equal(f.calls.includes('website'), false);
});

test('website-only batches publish without touching the game lifecycle', async () => {
  const f = fixture();
  const result = await flow.run(f.adapter, {...options, hasBackend: false});
  assert.equal(result.outcome, 'UPDATED');
  assert.deepEqual(f.calls, ['verify', 'website', 'release-lock']);
});

test('website-only batches may publish while matches and persistence work are active', async () => {
  const f = fixture({snapshot: async () => ({...open(), rooms:2, pendingCount:1, pendingWork:{db:1}, pendingPersistence:{db:1}})});
  const result = await flow.run(f.adapter, {...options, hasBackend:false});
  assert.equal(result.outcome, 'UPDATED');
  assert.deepEqual(f.calls, ['verify','website','release-lock']);
});

test('enabled notifications confirm start between idle barriers and success after reopening', async () => {
  const f = fixture({notify: async phase => { f.calls.push('notify:' + phase); return phase + '-id'; }});
  const result = await flow.run(f.adapter, {...options, hasNotifications: true});
  assert.equal(result.outcome, 'UPDATED');
  assert.deepEqual(result.messages, {start: 'start-id', success: 'success-id'});
  assert.deepEqual(f.calls, ['verify', 'close', 'notify:start', 'switch', 'health:new', 'open', 'notify:success', 'website', 'release-lock']);
});

test('failed start cancels and reopens the old service without stopping it', async () => {
  const f = fixture({notify: async phase => { f.calls.push('notify:' + phase); if (phase === 'start') throw Error('notification_delivery_uncertain'); return 'cancel-id'; }});
  const result = await flow.run(f.adapter, {...options, hasNotifications: true});
  assert.equal(result.outcome, 'CANCELLED');
  assert.equal(result.messages.cancel, 'cancel-id');
  assert.deepEqual(f.calls, ['verify', 'close', 'notify:start', 'open', 'notify:cancel', 'release-lock']);
});

test('a barrier race while start is sent cancels without switching and announces reopening', async () => {
  let announced = false;
  const f = fixture({
    notify: async phase => { f.calls.push('notify:' + phase); announced = true; return phase + '-id'; },
    snapshot: async () => !f.calls.includes('close') || f.calls.includes('open') ? open() : announced ? {...stopped(), pendingWork: {db: 1}, pendingPersistence: {db: 1}, pendingCount: 1, readyToStop: false} : stopped()
  });
  const result = await flow.run(f.adapter, {...options, hasNotifications: true});
  assert.equal(result.outcome, 'CANCELLED'); assert.equal(result.errorCode, 'barrier_changed');
  assert.equal(f.calls.includes('switch'), false); assert(f.calls.includes('notify:cancel'));
});

test('end notification failures preserve backend success and record a pending phase', async () => {
  const f = fixture({notify: async phase => { f.calls.push('notify:' + phase); if (phase === 'success') throw Error('private request details'); return 'start-id'; }});
  const result = await flow.run(f.adapter, {...options, hasNotifications: true});
  assert.equal(result.outcome, 'UPDATED'); assert.equal(result.backendActive, true);
  assert.equal(result.notificationPending, 'success'); assert.equal(result.notificationErrorCode, 'coordinator_operation_failed');
  assert.equal(f.calls.includes('rollback'), false); assert.equal(f.calls.filter(x => x === 'switch').length, 1);
});

test('rollback sends its own end phase only after the old service has reopened', async () => {
  const f = fixture({health: async version => { f.calls.push('health:' + version); if (version === 'new') throw Error('health_timeout'); }, notify: async phase => { f.calls.push('notify:' + phase); if (phase === 'rollback') throw Error('notification_delivery_uncertain'); return 'start-id'; }});
  const result = await flow.run(f.adapter, {...options, hasNotifications: true});
  assert.equal(result.outcome, 'ROLLED_BACK'); assert.equal(result.notificationPending, 'rollback');
  assert.deepEqual(f.calls, ['verify', 'close', 'notify:start', 'switch', 'health:new', 'rollback', 'health:old', 'open', 'notify:rollback', 'release-lock']);
});

test('preflight never sends enabled notifications', async () => {
  const f = fixture({notify: async phase => { f.calls.push('notify:' + phase); }});
  const result = await flow.run(f.adapter, {...options, hasNotifications: true, preflightOnly: true});
  assert.equal(result.outcome, 'PREFLIGHT'); assert.deepEqual(f.calls, ['verify', 'release-lock']);
});

test('runtime deck progress is persisted while the backend switch is in progress', async () => {
  const summary = {status: 'COMPLETED', updatedMatches: 12};
  const f = fixture({switchBackend: async (issued, progress) => {
    issued();
    assert.equal(typeof progress, 'function');
    await progress('BACKING_UP_DECKS');
    await progress('RECLASSIFYING_DECKS', {deckReclassification: summary});
  }});
  const result = await flow.run(f.adapter, options);
  assert.equal(result.outcome, 'UPDATED');
  assert.deepEqual(result.deckReclassification, summary);
  assert(f.states.some(state => state.stage === 'BACKING_UP_DECKS'));
  assert(f.states.some(state => state.stage === 'RECLASSIFYING_DECKS' && state.deckReclassification === summary));
});

test('an empty start confirmation cancels without switching the backend', async () => {
  const f = fixture({notify: async () => undefined});
  const result = await flow.run(f.adapter, {...options, hasNotifications: true});
  assert.equal(result.outcome, 'CANCELLED'); assert.equal(result.errorCode, 'notification_confirmation_missing');
  assert.equal(f.calls.includes('switch'), false); assert(f.calls.includes('open'));
  assert.equal(result.notificationPending, 'cancel');
});
