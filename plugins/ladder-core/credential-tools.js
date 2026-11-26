'use strict';

// Logic behind the offline credential scripts (admin reset, bulk conversion).
// The scripts are thin CLIs; everything here works on a small "store"
// interface so it can be tested without PostgreSQL:
//   store.get(key)                     -> {name, displayName, pass} | null
//   store.page(afterKey, limit)        -> rows ordered by name, name > afterKey
//   store.compareAndSet(key, exp, nx)  -> true when exactly one row changed
//   store.anyHashed()                  -> true if any row holds a hash
//   store.close()
// Nothing here prints or returns a stored credential.

const path = require('path');
const passwordHash = require('./password-hash');
const {readSecurityConfig, effectiveMode} = require('./credentials');

const PLUGIN_DIR = __dirname;
const normalizeName = value => String(value || '').trim().toLowerCase();

const toolError = (code, message) => Object.assign(new Error(message), {code});

// Effective mode as the running server would see it, including the rule that
// legacy means frozen once hashes exist.
async function currentMode(store, pluginDir = PLUGIN_DIR) {
  const {mode} = await readSecurityConfig(pluginDir);
  return effectiveMode(mode, await store.anyHashed() ? 'hashed' : 'legacy');
}

async function requireHashedMode(store, pluginDir) {
  const mode = await currentMode(store, pluginDir);
  if (mode !== 'hashed') {
    throw toolError('mode_not_hashed', `passwordHash.mode is ${mode}; credential writes are allowed only in hashed mode.`);
  }
}

// Admin reset (design 2.7). Returns {account, temporaryPassword, length, warning}.
// The caller prints the temporary password exactly once.
async function resetPassword(store, nickname, {length = null, params = passwordHash.DEFAULT_PARAMS, pluginDir} = {}) {
  await requireHashedMode(store, pluginDir);
  const key = normalizeName(nickname);
  if (!key) throw toolError('invalid_nickname', 'A nickname is required.');
  const row = await store.get(key);
  if (!row) throw toolError('account_not_found', `No ladder account named ${key}.`);
  const loginName = row.displayName || String(nickname).trim();
  const chosen = passwordHash.temporaryPasswordLength(loginName, length);
  const warning = chosen < 3
    ? `Only ${chosen} character(s) fit after this ${loginName.length}-character nickname; the temporary password is weak. Ask the player to change it soon.`
    : null;
  const temporaryPassword = passwordHash.generateTemporaryPassword(chosen);
  const stored = await passwordHash.hashPassword(temporaryPassword, {temporary: true, params});
  // A change or another reset between our read and write wins; never overwrite it.
  if (!await store.compareAndSet(key, row.pass ?? null, stored)) {
    throw toolError('credential_changed', 'The credential changed while resetting. Nothing was written; run the reset again.');
  }
  return {account: key, temporaryPassword, length: chosen, warning};
}

// Bulk conversion (design 2.8). Converts every non-empty legacy plaintext to a
// hash with conditional updates. Damaged rows (hash prefix, invalid body) are
// reported, never skipped silently. Returns a summary without credentials.
async function convertPasswords(store, {apply = false, batchSize = 200, params = passwordHash.DEFAULT_PARAMS, pluginDir, maxRetries = 3,
  onProgress = null} = {}) {
  if (apply) await requireHashedMode(store, pluginDir);
  const summary = {apply, scanned: 0, empty: 0, hashed: 0, temporary: 0, legacy: 0, converted: 0, retried: 0, damaged: [], conflicts: [],
    stoppedBecauseMode: null};
  let after = '';
  for (;;) {
    const rows = await store.page(after, batchSize);
    if (!rows.length) break;
    for (const row of rows) {
      after = row.name;
      summary.scanned++;
      const kind = passwordHash.classifyStored(row.pass);
      if (kind === 'empty') { summary.empty++; continue; }
      if (kind === 'hash') { summary.hashed++; continue; }
      if (kind === 'temp') { summary.temporary++; continue; }
      if (kind === 'damaged') { summary.damaged.push(row.name); continue; }
      summary.legacy++;
      if (!apply) continue;
      // Stop as soon as the operator switches away from hashed (e.g. frozen).
      const mode = await currentMode(store, pluginDir);
      if (mode !== 'hashed') { summary.stoppedBecauseMode = mode; return summary; }
      let current = row;
      let done = false;
      for (let attempt = 0; attempt <= maxRetries && !done; attempt++) {
        const currentKind = passwordHash.classifyStored(current?.pass);
        if (!current || currentKind !== 'legacy') {
          // Someone else (a password change, a reset) already wrote it.
          done = true;
          break;
        }
        const next = await passwordHash.hashPassword(current.pass, {params});
        if (await store.compareAndSet(current.name, current.pass, next)) {
          summary.converted++;
          done = true;
        } else {
          summary.retried++;
          current = await store.get(row.name);
        }
      }
      if (!done) summary.conflicts.push(row.name);
      onProgress?.(summary);
    }
  }
  return summary;
}

// Acceptance check: the number of non-empty legacy plaintext rows left.
async function remainingLegacy(store, batchSize = 500) {
  let after = '';
  const result = {legacy: 0, damaged: 0};
  for (;;) {
    const rows = await store.page(after, batchSize);
    if (!rows.length) return result;
    for (const row of rows) {
      after = row.name;
      const kind = passwordHash.classifyStored(row.pass);
      if (kind === 'legacy') result.legacy++;
      if (kind === 'damaged') result.damaged++;
    }
  }
}

// ---- PostgreSQL ------------------------------------------------------------
// Same environment variables as migrations/202609-history-repair/migrate.js.
function pgConnectionConfig(env = process.env) {
  const ssl = !env.SRVPRO_LADDER_PG_SSL || /^(false|0|off)$/i.test(env.SRVPRO_LADDER_PG_SSL) ? undefined : true;
  if (env.SRVPRO_LADDER_DATABASE_URL) return {connectionString: env.SRVPRO_LADDER_DATABASE_URL, ssl};
  const config = {
    host: env.SRVPRO_LADDER_PG_HOST,
    port: Number(env.SRVPRO_LADDER_PG_PORT || 5432),
    database: env.SRVPRO_LADDER_PG_DATABASE,
    user: env.SRVPRO_LADDER_PG_USERNAME,
    password: env.SRVPRO_LADDER_PG_PASSWORD,
    ssl
  };
  if (!config.host || !config.database || !config.user) {
    throw toolError('connection_incomplete',
      'Set SRVPRO_LADDER_DATABASE_URL, or SRVPRO_LADDER_PG_HOST / _PORT / _DATABASE / _USERNAME / _PASSWORD.');
  }
  return config;
}

async function openPgStore(env = process.env) {
  const {Client} = require('pg');
  const client = new Client(pgConnectionConfig(env));
  await client.connect();
  return {
    client,
    async get(key) {
      const result = await client.query('SELECT name, "displayName", pass FROM ladder_user WHERE name = $1', [key]);
      return result.rows[0] || null;
    },
    async page(afterKey, limit) {
      const result = await client.query('SELECT name, "displayName", pass FROM ladder_user WHERE name > $1 ORDER BY name LIMIT $2', [afterKey, limit]);
      return result.rows;
    },
    async compareAndSet(key, expected, next) {
      const result = expected == null
        ? await client.query('UPDATE ladder_user SET pass = $2 WHERE name = $1 AND pass IS NULL', [key, next])
        : await client.query('UPDATE ladder_user SET pass = $3 WHERE name = $1 AND pass = $2', [key, expected, next]);
      return result.rowCount === 1;
    },
    async anyHashed() {
      const result = await client.query("SELECT 1 FROM ladder_user WHERE pass LIKE 'scrypt$%' OR pass LIKE 'scrypt-temp$%' LIMIT 1");
      return result.rowCount > 0;
    },
    close: () => client.end()
  };
}

// Script error output: a fixed code and our own message only. Driver errors
// can carry SQL parameters, which include passwords here (design 2.11).
function describeError(error) {
  if (error && typeof error.code === 'string' && /^[a-z_]+$/.test(error.code)) return `${error.code}: ${error.message}`;
  const code = error && typeof error.code === 'string' && /^[A-Za-z0-9_]{1,10}$/.test(error.code) ? error.code : error?.name || 'error';
  return `database_or_runtime_error (${code})`;
}

module.exports = {normalizeName, currentMode, resetPassword, convertPasswords, remainingLegacy, pgConnectionConfig, openPgStore,
  describeError, PLUGIN_DIR: path.resolve(PLUGIN_DIR)};
