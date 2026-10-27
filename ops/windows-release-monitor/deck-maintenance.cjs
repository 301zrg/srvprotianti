'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const check = (condition, code) => { if (!condition) throw Error(code); };
const classification = {
  ladder_match: ['playerADeckTypeId', 'playerBDeckTypeId'],
  ladder_match_game: ['deckTypeId', 'opponentDeckTypeId'],
  ladder_usage_sample: ['deckTypeId']
};
const aggregates = {
  ladder_usage_daily_deck: ['id', 'dayKey', 'deckTypeId', 'deckCount'],
  ladder_usage_total_deck: ['deckTypeId', 'deckCount']
};
const quote = value => '"' + value + '"';
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 500000;

function validateDeckReclassification(settings) {
  if (settings == null) return null;
  check(settings && typeof settings === 'object' && !Array.isArray(settings) &&
    ['templateSha256', 'beforeTemplateSha256'].every(key => typeof settings[key] === 'string' && /^[a-f0-9]{64}$/.test(settings[key])) &&
    Object.keys(settings).every(key => ['templateSha256', 'beforeTemplateSha256', 'classificationSha256'].includes(key)) &&
    (!Object.hasOwn(settings, 'classificationSha256') || typeof settings.classificationSha256 === 'string' && /^[a-f0-9]{64}$/.test(settings.classificationSha256)),
  'deck_reclassification_settings_invalid');
  return {templateSha256: settings.templateSha256, beforeTemplateSha256: settings.beforeTemplateSha256,
    ...(Object.hasOwn(settings, 'classificationSha256') ? {classificationSha256: settings.classificationSha256} : {})};
}

function createDeckMaintenance({projectRoot, batch, settings, tool: injectedTool, createClient: injectedClient, queryTimeoutMs = 120000}) {
  settings = validateDeckReclassification(settings);
  let state = {enabled: !!settings, status: settings ? 'pending' : 'disabled', committed: false, recoveryBlocked: false, ...settings};
  const status = () => structuredClone(state);
  if (!settings) return {enabled: false, status, verify: async () => status(), backup: async () => status(), reclassify: async () => status(), rollback: async () => status()};
  check(path.isAbsolute(projectRoot) && path.isAbsolute(batch), 'deck_paths_invalid');
  check(Number.isSafeInteger(queryTimeoutMs) && queryTimeoutMs >= 1000 && queryTimeoutMs <= 600000, 'deck_timeout_invalid');
  const directory = path.join(batch, 'deck-maintenance');
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  let cachedTool;
  const tool = () => cachedTool || (cachedTool = injectedTool || projectRequire('./plugins/deck_analysis/reclassify-database.js'));
  const filename = name => path.join(directory, name + '.json');
  const exists = name => fs.existsSync(filename(name));
  const owned = value => value?.schemaVersion === 1 && value.templateSha256 === settings.templateSha256 &&
    value.beforeTemplateSha256 === settings.beforeTemplateSha256 && value.classificationSha256 === settings.classificationSha256;
  function read(name) {
    check(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(), 'deck_receipt_invalid');
    const file = filename(name), metadata = fs.lstatSync(file);
    check(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= MAX_BYTES, 'deck_receipt_invalid');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(owned(value), 'deck_receipt_invalid'); return value;
  }
  function write(name, content) {
    const value = {schemaVersion: 1, ...settings, ...content};
    const bytes = JSON.stringify(value);
    check(Buffer.byteLength(bytes) <= MAX_BYTES, 'deck_snapshot_limit');
    const fd = fs.openSync(filename(name), 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Flush directory entries where supported; Windows rejects opening directories.
    let dir;
    try { dir = fs.openSync(directory, 'r'); fs.fsyncSync(dir); }
    catch (error) { if (!['EPERM', 'EACCES', 'EISDIR', 'EINVAL'].includes(error.code)) throw error; }
    finally { if (dir !== undefined) fs.closeSync(dir); }
    return value;
  }
  function fail(code, blocked = false) {
    if (blocked) state.recoveryBlocked = true;
    const error = Error(code); error.recoveryBlocked = state.recoveryBlocked;
    return error;
  }
  function blocked() {
    return state.recoveryBlocked || exists('blocked') || exists('rollback-started') && !exists('rolled-back') ||
      exists('apply-started') && !exists('applied') && !exists('not-committed');
  }
  async function client() {
    const c = injectedClient ? injectedClient() : new (projectRequire('pg').Client)({...tool().connectionConfig({useHostConfig: true}),
      connectionTimeoutMillis: 10000, statement_timeout: queryTimeoutMs, query_timeout: queryTimeoutMs + 5000,
      lock_timeout: Math.min(queryTimeoutMs, 15000)});
    try { await c.connect(); return c; }
    catch { await c.end().catch(() => {}); throw fail('deck_database_connection_failed'); }
  }
  async function transaction(readOnly, action) {
    const c = await client(); let open = false;
    try {
      await c.query(readOnly ? 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN'); open = true;
      const value = await action(c);
      await c.query('ROLLBACK'); open = false; return value;
    } finally { if (open) await c.query('ROLLBACK').catch(() => {}); await c.end().catch(() => {}); }
  }
  async function schema(c) {
    try { return await tool().validateSchema(c); } catch { throw fail('deck_schema_invalid'); }
  }
  function tables(s) {
    return ['ladder_match', 'ladder_match_game', ...(s.usageProjections ? ['ladder_usage_sample', ...Object.keys(aggregates)] : [])];
  }
  async function access(c, s) {
    for (const table of [...tables(s), 'duel_log', 'duel_log_player']) {
      const required = aggregates[table] ? ['SELECT', 'INSERT', 'DELETE'] : classification[table] ? ['SELECT', 'UPDATE'] : ['SELECT'];
      const privilege = await c.query('SELECT bool_and(has_table_privilege($1, privilege)) AS allowed FROM unnest($2::text[]) AS privilege', ['public.' + table, required]);
      check(privilege.rows[0]?.allowed === true, 'deck_database_access_denied');
    }
    for (const table of tables(s)) {
      const columns = classification[table] ? ['id', ...classification[table]] : aggregates[table];
      await c.query('SELECT ' + columns.map(quote).join(', ') + ' FROM public.' + table + ' LIMIT 0');
    }
  }
  async function template(expected, code, target = false) {
    let loaded;
    try { loaded = await tool().loadClassifier(); } catch { throw fail('deck_tool_invalid'); }
    check(loaded?.templateSha256 === expected, code);
    if (target && settings.classificationSha256) {
      check(loaded.classification?.sha256 === settings.classificationSha256, 'deck_classification_target_hash_mismatch');
    }
    return loaded.templateSha256;
  }
  async function snapshot(c, s) {
    const data = {}, guards = {};
    // Only field backups are retained. Names, buffers and other source values become SQL fingerprints.
    for (const table of tables(s)) {
      const fields = classification[table] ? ['id', ...classification[table]] : aggregates[table];
      const order = classification[table] || table === 'ladder_usage_daily_deck' ? 'id' : '"deckTypeId"';
      const columns = fields.map(field => field === 'id' && classification[table] ? 'id::text AS id' : quote(field)).join(', ');
      const rows = [];
      for (let offset = 0; ; offset += 1000) {
        const page = await c.query('SELECT ' + columns + ' FROM public.' + table + ' ORDER BY ' + order + ' LIMIT $1 OFFSET $2', [1000, offset]);
        rows.push(...page.rows); check(rows.length <= MAX_ROWS, 'deck_snapshot_limit');
        if (page.rows.length < 1000) break;
      }
      data[table] = rows;
    }
    for (const table of [...tables(s).filter(table => classification[table]), 'duel_log', 'duel_log_player']) {
      const result = await c.query('SELECT COUNT(*)::text AS "rowCount", md5(COALESCE(string_agg(md5((to_jsonb(t) - $1::text[])::text), \'\' ORDER BY id), \'\')) AS fingerprint FROM public.' + table + ' t', [classification[table] || []]);
      guards[table] = result.rows[0];
    }
    const identity = await c.query("SELECT md5(current_database() || ':' || current_user || ':' || COALESCE(inet_server_addr()::text, 'local') || ':' || COALESCE(inet_server_port()::text, '') || ':' || pg_postmaster_start_time()::text) AS fingerprint");
    const value = {usageProjections: s.usageProjections, data, guards, identity: identity.rows[0].fingerprint};
    return {snapshot: value, sha256: digest(value)};
  }
  function validSnapshot(value) {
    check(value?.snapshot && value.sha256 === digest(value.snapshot), 'deck_snapshot_corrupt'); return value;
  }
  function summary(value) {
    return {sha256: value.sha256, counts: Object.fromEntries(Object.entries(value.snapshot.data).map(([key, rows]) =>
      [({ladder_match: 'matchRows', ladder_match_game: 'gameRows', ladder_usage_sample: 'usageSampleRows',
        ladder_usage_daily_deck: 'usageDailyDeckRows', ladder_usage_total_deck: 'usageTotalDeckRows'})[key], rows.length]))};
  }
  async function lock(c, s) {
    await c.query('LOCK TABLE ' + tables(s).map(table => 'public.' + table).join(', ') + ' IN ACCESS EXCLUSIVE MODE');
    await c.query('LOCK TABLE public.duel_log, public.duel_log_player IN SHARE MODE');
  }
  async function verify() {
    try {
      check(!fs.existsSync(directory), 'deck_backup_exists');
      await template(settings.beforeTemplateSha256, 'deck_template_before_hash_mismatch');
      await transaction(true, async c => { const s = await schema(c); await access(c, s); state.usageProjectionsIncluded = s.usageProjections; });
      state.status = 'verified'; return status();
    } catch (error) { throw fail(/^deck_[a-z_]+$/.test(error.message) ? error.message : 'deck_preflight_failed'); }
  }
  async function backup() {
    try {
      check(!fs.existsSync(directory), 'deck_backup_exists');
      await template(settings.beforeTemplateSha256, 'deck_template_before_hash_mismatch');
      await transaction(false, async c => {
        const s = await schema(c); await access(c, s); await lock(c, s);
        const saved = await snapshot(c, s);
        fs.mkdirSync(directory, {mode: 0o700});
        write('before', saved);
        const savedSummary = summary(saved);
        state = {...state, status: 'backed_up', beforeSha256: savedSummary.sha256, counts: savedSummary.counts,
          usageProjectionsIncluded: s.usageProjections};
      });
      return status();
    } catch (error) { throw fail(/^deck_[a-z_]+$/.test(error.message) ? error.message : 'deck_backup_failed'); }
  }
  function validateReport(report, mode, usage) {
    check(report?.mode === mode && report.templates?.sha256 === settings.templateSha256 &&
      report.usageProjectionsIncluded === usage && report.committed === (mode === 'apply') &&
      (!settings.classificationSha256 || report.classification?.sha256 === settings.classificationSha256), 'deck_report_invalid');
    if (mode === 'audit') return;
    const keys = ['matchMismatches', 'gameMismatches', ...(usage ? ['usageSampleMismatches', 'usageDailyDeckMismatches', 'usageTotalDeckMismatches'] : [])];
    check(report.verification && keys.every(key => report.verification[key] === 0) &&
      Object.values(report.verification).every(value => value === 0), 'deck_verification_failed');
  }
  async function reclassify() {
    let applyAttempted = false, committed = false;
    try {
      if (blocked() || exists('applied') || exists('not-committed')) throw fail('deck_recovery_review_required', true);
      const before = validSnapshot(read('before'));
      await template(settings.templateSha256, 'deck_template_target_hash_mismatch', true);
      await transaction(false, async c => {
        const s = await schema(c); await lock(c, s);
        check((await snapshot(c, s)).sha256 === before.sha256, 'deck_database_drift');
      });
      for (const mode of ['audit', 'simulate', 'apply']) {
        const reportFile = filename(mode + '-report');
        check(!fs.existsSync(reportFile), 'deck_report_exists');
        await template(settings.templateSha256, 'deck_template_target_hash_mismatch', true);
        if (mode === 'apply') { write('apply-started', {beforeSha256: before.sha256}); applyAttempted = true; }
        const report = await tool().execute({mode, useHostConfig: true, confirm: tool().CONFIRMATION,
          report: reportFile, reportExclusive: true, queryTimeoutMs,
          expectedTemplateSha256: settings.templateSha256, expectedClassificationSha256: settings.classificationSha256,
          ...(mode === 'apply' ? {beforeApply: async (c, {schema: s}) => {
            check((await snapshot(c, s)).sha256 === before.sha256, 'deck_database_drift');
          }, beforeCommit: async (c, {schema: s}) => {
            const post = await snapshot(c, s);
            check(digest(post.snapshot.guards) === digest(before.snapshot.guards) && post.snapshot.identity === before.snapshot.identity,
              'deck_database_drift');
            write('post', post);
          }} : {})});
        if (mode === 'apply') committed = report?.committed === true;
        validateReport(report, mode, before.snapshot.usageProjections);
        if (mode === 'apply') {
          const post = validSnapshot(read('post'));
          await transaction(false, async c => {
            const s = await schema(c); await lock(c, s);
            check((await snapshot(c, s)).sha256 === post.sha256, 'deck_database_drift');
          });
          const safeCounts = Object.fromEntries(Object.entries(report.counts || {}).filter(([key, value]) =>
            /^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(key) && Number.isSafeInteger(value) && value >= 0));
          write('applied', {beforeSha256: before.sha256, postSha256: post.sha256, counts: safeCounts});
          state = {...state, status: 'applied', committed: true, counts: safeCounts, beforeSha256: before.sha256, postSha256: post.sha256};
        }
      }
      return status();
    } catch (error) {
      const uncertain = applyAttempted && (committed || error.commitState !== 'not_committed');
      if (applyAttempted && !uncertain) {
        try { write('not-committed', {}); } catch { state.recoveryBlocked = true; }
      }
      if (uncertain) {
        state.recoveryBlocked = true;
        try { if (!exists('blocked')) write('blocked', {reason: 'apply_commit_or_receipt_uncertain'}); } catch {}
      }
      throw fail(applyAttempted ? 'deck_reclassification_failed' : /^deck_[a-z_]+$/.test(error.message) ? error.message : 'deck_reclassification_failed', uncertain);
    }
  }
  async function restore(c, before, post) {
    for (const [table, fields] of Object.entries(classification)) {
      if (!before.snapshot.data[table]) continue;
      const current = new Map(post.snapshot.data[table].map(row => [row.id, row]));
      const changed = before.snapshot.data[table].filter(row => digest(row) !== digest(current.get(row.id)));
      for (let offset = 0; offset < changed.length; offset += 500) {
        const rows = changed.slice(offset, offset + 500);
        const result = await c.query('UPDATE public.' + table + ' t SET ' + fields.map(field => quote(field) + ' = s.' + quote(field)).join(', ') +
          ' FROM jsonb_populate_recordset(NULL::public.' + table + ', $1::jsonb) s WHERE t.id = s.id', [JSON.stringify(rows)]);
        check(result.rowCount === rows.length, 'deck_restore_count_mismatch');
      }
    }
    for (const [table, fields] of Object.entries(aggregates)) {
      if (!before.snapshot.data[table]) continue;
      await c.query('DELETE FROM public.' + table);
      const rows = before.snapshot.data[table];
      for (let offset = 0; offset < rows.length; offset += 500) {
        const chunk = rows.slice(offset, offset + 500);
        const result = await c.query('INSERT INTO public.' + table + ' (' + fields.map(quote).join(', ') + ') SELECT ' + fields.map(quote).join(', ') +
          ' FROM jsonb_populate_recordset(NULL::public.' + table + ', $1::jsonb)', [JSON.stringify(chunk)]);
        check(result.rowCount === chunk.length, 'deck_restore_count_mismatch');
      }
    }
  }
  async function rollback() {
    if (!fs.existsSync(directory)) { state.status = 'not_applied'; return status(); }
    if (blocked()) throw fail('deck_recovery_review_required', true);
    if (!exists('apply-started') || exists('not-committed')) { state.status = 'not_applied'; return status(); }
    let c, open = false;
    try {
      check(!exists('rolled-back'), 'deck_rollback_already_completed');
      const before = validSnapshot(read('before')), post = validSnapshot(read('post')), receipt = read('applied');
      check(receipt.beforeSha256 === before.sha256 && receipt.postSha256 === post.sha256, 'deck_receipt_invalid');
      c = await client(); await c.query('BEGIN'); open = true;
      const s = await schema(c); await lock(c, s);
      check((await snapshot(c, s)).sha256 === post.sha256, 'deck_rollback_database_drift');
      write('rollback-started', {beforeSha256: before.sha256, postSha256: post.sha256});
      await restore(c, before, post);
      check((await snapshot(c, s)).sha256 === before.sha256, 'deck_restore_verification_failed');
      await c.query('COMMIT'); open = false;
      write('rolled-back', {sha256: before.sha256});
      state = {...state, status: 'rolled_back', committed: false, recoveryBlocked: false, restoredSha256: before.sha256};
      return status();
    } catch (error) { throw fail(/^deck_[a-z_]+$/.test(error.message) ? error.message : 'deck_rollback_failed', true); }
    finally { if (c) { if (open) await c.query('ROLLBACK').catch(() => {}); await c.end().catch(() => {}); } }
  }
  return {enabled: true, status, verify, backup, reclassify, rollback};
}

module.exports = {validateDeckReclassification, createDeckMaintenance};
