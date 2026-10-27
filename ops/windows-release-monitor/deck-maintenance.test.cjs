'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const modulePath = path.join(__dirname, 'deck-maintenance.cjs');
const api = () => { assert.ok(fs.existsSync(modulePath), 'deck maintenance module is implemented'); return require(modulePath); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const beforeHash = sha('before'), targetHash = sha('target');

function fixture(t, usage = true, classificationHash = null) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-maintenance-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('deck-maintenance-test-'));
    fs.rmSync(base, {recursive: true, force: true});
  });
  const batch = path.join(base, 'batch'); fs.mkdirSync(batch);
  const rows = {
    ladder_match: [{id: '1', playerADeckTypeId: 4095, playerBDeckTypeId: 20}],
    ladder_match_game: [{id: '8', deckTypeId: 4095, opponentDeckTypeId: 20}],
    ...(usage ? {
      ladder_usage_sample: [{id: '4', deckTypeId: 4095}],
      ladder_usage_daily_deck: [{id: 7, dayKey: '20261023', deckTypeId: 4095, deckCount: 1}],
      ladder_usage_total_deck: [{deckTypeId: 4095, deckCount: 1}]
    } : {})
  };
  const original = structuredClone(rows), calls = [], events = [];
  let currentHash = beforeHash, guard = 'source-before', executeFailure = null, invalidVerification = false, raceApply = false, commitFailure = false;
  let transaction;
  function client() {
    return {
      async connect() { events.push('connect'); },
      async end() { events.push('end'); },
      async query(sql, values = []) {
        calls.push(sql);
        if (/^BEGIN/.test(sql)) { transaction = structuredClone(rows); return {rows: []}; }
        if (sql === 'ROLLBACK') { if (transaction) { for (const key of Object.keys(rows)) delete rows[key]; Object.assign(rows, transaction); } transaction = null; return {rows: []}; }
        if (sql === 'COMMIT') { transaction = null; if (commitFailure) throw Error('commit reply lost'); return {rows: []}; }
        if (/^(SET|LOCK)/.test(sql)) return {rows: []};
        if (/has_table_privilege/.test(sql)) return {rows: [{allowed: true}]};
        const table = /(?:FROM|UPDATE|INTO) public\.([a-z_]+)/.exec(sql)?.[1];
        if (/AS fingerprint/.test(sql)) return {rows: [{rowCount: '1', fingerprint: sha(guard + table)}]};
        if (/LIMIT 0/.test(sql)) return {rows: []};
        if (/^SELECT/.test(sql.trim()) && table) return {rows: structuredClone(rows[table].slice(values[1] || 0, (values[1] || 0) + (values[0] || 1000)))};
        if (/^UPDATE/.test(sql.trim()) && table) {
          const incoming = JSON.parse(values[0]);
          for (const row of incoming) Object.assign(rows[table].find(old => String(old.id) === String(row.id)), row);
          return {rows: [], rowCount: incoming.length};
        }
        if (/^DELETE FROM/.test(sql) && table) { const count = rows[table].length; rows[table] = []; return {rows: [], rowCount: count}; }
        if (/^INSERT INTO/.test(sql.trim()) && table) { const incoming = JSON.parse(values[0]); rows[table].push(...incoming); return {rows: [], rowCount: incoming.length}; }
        throw Error('Unexpected fixture query: ' + sql);
      }
    };
  }
  const report = mode => ({mode, committed: mode === 'apply', templates: {sha256: targetHash, count: 2, deckTypeCount: 2},
    ...(classificationHash ? {classification: {sha256: classificationHash}} : {}),
    usageProjectionsIncluded: usage, counts: {changedMatches: 1, changedGameRows: 1, changedUsageSampleRows: usage ? 1 : 0},
    verification: mode === 'audit' ? null : {matchMismatches: invalidVerification ? 1 : 0, gameMismatches: 0,
      ...(usage ? {usageSampleMismatches: 0, usageDailyDeckMismatches: 0, usageTotalDeckMismatches: 0} : {})}});
  const tool = {
    CONFIRMATION: 'APPLY-DECK-RECLASSIFICATION',
    connectionConfig() { throw Error('real credentials must not be read'); },
    async validateSchema() { if (usage === 'partial') throw Error('partial usage schema'); return {usageProjections: usage}; },
    loadClassifier() { return {templateSha256: currentHash, classification: {sha256: classificationHash}}; },
    async execute(options) {
      assert.equal(options.useHostConfig, true); assert.ok(options.queryTimeoutMs > 0);
      events.push(options.mode);
      if (executeFailure?.when === options.mode && executeFailure.before) throw executeFailure.error;
      if (options.mode === 'apply') {
        if (raceApply) rows.ladder_match[0].playerADeckTypeId = 66;
        if (options.beforeApply) await options.beforeApply(client(), {schema: {usageProjections: usage}});
        rows.ladder_match[0].playerADeckTypeId = 10; rows.ladder_match_game[0].deckTypeId = 10;
        if (usage) {
          rows.ladder_usage_sample[0].deckTypeId = 10;
          rows.ladder_usage_daily_deck = [{id: 9, dayKey: '20261023', deckTypeId: 10, deckCount: 1}];
          rows.ladder_usage_total_deck = [{deckTypeId: 10, deckCount: 1}];
        }
        await options.beforeCommit(client(), {schema: {usageProjections: usage}});
        if (executeFailure?.when === 'apply') throw executeFailure.error;
      }
      const value = report(options.mode); fs.writeFileSync(options.report, JSON.stringify(value)); return value;
    }
  };
  const maintenance = api().createDeckMaintenance({projectRoot: base, batch,
    settings: {templateSha256: targetHash, beforeTemplateSha256: beforeHash,
      ...(classificationHash ? {classificationSha256: classificationHash} : {})}, createClient: client, tool});
  return {base, batch, rows, original, calls, events, maintenance, tool,
    driftClassifier() { classificationHash = sha('unapproved-classifier'); },
    target() { currentHash = targetHash; }, drift() { guard = 'external-source'; }, raceApply() { raceApply = true; }, failCommit() { commitFailure = true; },
    fail(when, error, before = false) { executeFailure = {when, error, before}; }, badVerification() { invalidVerification = true; }};
}

test('settings disable only when absent and reject malformed or extra fields', () => {
  const {validateDeckReclassification: validate} = api();
  assert.equal(validate(null), null); assert.equal(validate(undefined), null);
  assert.deepEqual(validate({templateSha256: targetHash, beforeTemplateSha256: beforeHash}), {templateSha256: targetHash, beforeTemplateSha256: beforeHash});
  for (const value of [false, {}, {templateSha256: targetHash}, {templateSha256: targetHash.toUpperCase(), beforeTemplateSha256: beforeHash},
    {templateSha256: targetHash, beforeTemplateSha256: beforeHash, force: true}]) assert.throws(() => validate(value), /deck_reclassification_settings_invalid/);
});

test('preflight rejects a template baseline mismatch before opening the database', async t => {
  const f = fixture(t); f.target();
  await assert.rejects(f.maintenance.verify(), /deck_template_before_hash_mismatch/);
  assert.deepEqual(f.events, []);
});

test('maintenance awaits asynchronous catalog-aware classifier probes', async t => {
  const f = fixture(t), load = f.tool.loadClassifier;
  f.tool.loadClassifier = async () => { await Promise.resolve(); return load(); };
  await f.maintenance.verify(); await f.maintenance.backup(); f.target();
  assert.equal((await f.maintenance.reclassify()).committed, true);
});

test('classification identity is optional for legacy batches and pinned for new batches', async t => {
  const settings = {templateSha256: targetHash, beforeTemplateSha256: beforeHash, classificationSha256: sha('approved')};
  assert.deepEqual(api().validateDeckReclassification(settings), settings);
  assert.throws(() => api().validateDeckReclassification({...settings, classificationSha256: 'bad'}), /settings_invalid/);
  const f = fixture(t, true, settings.classificationSha256);
  await f.maintenance.verify(); await f.maintenance.backup(); f.target(); f.driftClassifier();
  await assert.rejects(f.maintenance.reclassify(), /deck_classification_target_hash_mismatch/);
  assert.deepEqual(f.rows, f.original);
  assert.ok(!f.events.includes('audit'));
});

test('catalog-aware maintenance rejects a report for different classification semantics', async t => {
  const f = fixture(t, true, sha('approved'));
  await f.maintenance.backup(); f.target();
  const execute = f.tool.execute;
  f.tool.execute = async options => ({...await execute(options), classification: {sha256: sha('different')}});
  await assert.rejects(f.maintenance.reclassify(), /deck_report_invalid/);
  assert.ok(!f.events.includes('apply'));
});

test('each execution receives expected identities to enforce before its database transaction', async t => {
  const approved = sha('approved'), f = fixture(t, true, approved), execute = f.tool.execute;
  f.tool.execute = async options => {
    assert.equal(options.expectedTemplateSha256, targetHash);
    assert.equal(options.expectedClassificationSha256, approved);
    return execute(options);
  };
  await f.maintenance.backup(); f.target();
  assert.equal((await f.maintenance.reclassify()).committed, true);
});

test('partial usage installation stops before a backup or apply', async t => {
  const f = fixture(t, 'partial');
  await assert.rejects(f.maintenance.verify(), /deck_schema_invalid/);
  assert.equal(fs.existsSync(path.join(f.batch, 'deck-maintenance')), false);
  assert.equal(f.events.filter(x => x === 'connect').length, f.events.filter(x => x === 'end').length);
});

test('successful lifecycle keeps durable private snapshots and restores only classifications and aggregates', async t => {
  const f = fixture(t); await f.maintenance.verify(); const saved = await f.maintenance.backup();
  assert.equal(saved.status, 'backed_up');
  f.target(); const result = await f.maintenance.reclassify();
  assert.equal(result.committed, true); assert.equal(result.status, 'applied');
  assert.equal(result.recoveryBlocked, false); assert.equal(result.templateSha256, targetHash);
  assert.deepEqual(f.events.filter(x => ['audit', 'simulate', 'apply'].includes(x)), ['audit', 'simulate', 'apply']);
  const privateFiles = fs.readdirSync(path.join(f.batch, 'deck-maintenance'));
  for (const filename of ['before.json', 'post.json', 'apply-started.json', 'applied.json']) assert.ok(privateFiles.includes(filename));
  const restored = await f.maintenance.rollback();
  assert.equal(restored.status, 'rolled_back'); assert.deepEqual(f.rows, f.original);
  assert.ok(!JSON.stringify(result).includes('playerName')); assert.ok(!JSON.stringify(result).includes('ladder_match'));
  assert.ok(f.calls.filter(sql => /^UPDATE/.test(sql.trim())).every(sql => !/player.*Name|duelPoints|ladder_user/.test(sql)));
});

test('databases without usage projections can be backed up and restored', async t => {
  const f = fixture(t, false); await f.maintenance.backup(); f.target(); await f.maintenance.reclassify();
  await f.maintenance.rollback(); assert.deepEqual(f.rows, f.original);
  assert.ok(!f.calls.some(sql => /FROM public\.ladder_usage/.test(sql)));
});

test('a batch never overwrites an existing backup or retries an uncertain apply', async t => {
  const f = fixture(t); await f.maintenance.backup();
  const filename = path.join(f.batch, 'deck-maintenance', 'before.json'), original = fs.readFileSync(filename);
  await assert.rejects(f.maintenance.backup(), /deck_backup_exists/); assert.deepEqual(fs.readFileSync(filename), original);
  f.target(); f.fail('apply', Error('lost commit response')); await assert.rejects(f.maintenance.reclassify(), error => error.recoveryBlocked === true);
  await assert.rejects(f.maintenance.reclassify(), error => error.recoveryBlocked === true);
});

test('rollback rejects external classification or source drift without writing rows', async t => {
  for (const kind of ['classification', 'source']) {
    const f = fixture(t); await f.maintenance.backup(); f.target(); await f.maintenance.reclassify();
    if (kind === 'classification') f.rows.ladder_match[0].playerADeckTypeId = 99; else f.drift();
    const current = structuredClone(f.rows), count = f.calls.length;
    await assert.rejects(f.maintenance.rollback(), error => error.recoveryBlocked === true);
    assert.deepEqual(f.rows, current); assert.ok(!f.calls.slice(count).some(sql => /^(UPDATE|DELETE|INSERT)/.test(sql.trim())));
  }
});

test('definite precommit failure permits old file recovery while ambiguous or committed failure blocks it', async t => {
  for (const state of ['not_committed', 'unknown', 'committed']) {
    const f = fixture(t); await f.maintenance.backup(); f.target();
    f.fail('apply', Object.assign(Error('private database details'), {commitState: state}), state === 'not_committed');
    await assert.rejects(f.maintenance.reclassify(), error => error.message === 'deck_reclassification_failed' && error.recoveryBlocked === (state !== 'not_committed'));
    if (state === 'not_committed') assert.equal((await f.maintenance.rollback()).status, 'not_applied');
    else await assert.rejects(f.maintenance.rollback(), error => error.recoveryBlocked === true);
  }
});

test('a failed simulation verification cannot reach apply', async t => {
  const f = fixture(t); await f.maintenance.backup(); f.target(); f.badVerification();
  await assert.rejects(f.maintenance.reclassify(), /deck_verification_failed/);
  assert.ok(!f.events.includes('apply')); assert.equal((await f.maintenance.rollback()).status, 'not_applied');
});

test('application checks the exact backup state after tool locks before overwriting classification changes', async t => {
  const f = fixture(t); await f.maintenance.backup(); f.target(); f.raceApply();
  await assert.rejects(f.maintenance.reclassify(), /deck_reclassification_failed/);
  assert.equal(f.rows.ladder_match[0].playerADeckTypeId, 66);
  assert.equal(fs.existsSync(path.join(f.batch, 'deck-maintenance', 'post.json')), false);
});

test('disabled settings perform no file access or database work', async () => {
  const m = api().createDeckMaintenance({settings: null, createClient() { throw Error('must not connect'); }});
  for (const method of ['verify', 'backup', 'reclassify', 'rollback']) assert.equal((await m[method]()).status, 'disabled');
});

test('target template mismatch and a corrupt backup stop before any reclassification', async t => {
  for (const kind of ['template', 'snapshot']) {
    const f = fixture(t); await f.maintenance.backup();
    if (kind === 'snapshot') {
      f.target(); const file = path.join(f.batch, 'deck-maintenance', 'before.json');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')); saved.snapshot.data.ladder_match[0].playerADeckTypeId = 22;
      fs.writeFileSync(file, JSON.stringify(saved));
    }
    await assert.rejects(f.maintenance.reclassify(), /deck_template_target_hash_mismatch|deck_snapshot_corrupt/);
    assert.ok(!f.events.includes('audit'));
  }
});

test('rollback requires complete post-state and a matching durable applied receipt', async t => {
  const f = fixture(t); await f.maintenance.backup(); f.target(); await f.maintenance.reclassify();
  const file = path.join(f.batch, 'deck-maintenance', 'applied.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.postSha256 = beforeHash; fs.writeFileSync(file, JSON.stringify(saved));
  const current = structuredClone(f.rows);
  await assert.rejects(f.maintenance.rollback(), error => error.recoveryBlocked === true);
  assert.deepEqual(f.rows, current);
});

test('lost rollback COMMIT reply leaves recovery blocked and cannot be replayed', async t => {
  const f = fixture(t); await f.maintenance.backup(); f.target(); await f.maintenance.reclassify(); f.failCommit();
  await assert.rejects(f.maintenance.rollback(), error => error.recoveryBlocked === true);
  assert.equal(fs.existsSync(path.join(f.batch, 'deck-maintenance', 'rolled-back.json')), false);
  await assert.rejects(f.maintenance.rollback(), error => error.recoveryBlocked === true);
});
