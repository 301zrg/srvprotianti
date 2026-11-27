'use strict';

// Credential storage rules shared by the runtime and the offline scripts.
//
// passwordHash.mode (design 6.2):
//   legacy - first compatible release: new accounts store plaintext, no hash
//            is ever written, password change is off, scripts refuse to run.
//   hashed - normal operation: every credential write stores a scrypt hash.
//   frozen - rollback state: both formats still authenticate, but account
//            creation and every credential change are paused.
// Once a hash may exist the mode can never go back to legacy: a configured
// legacy is then treated as frozen (see effectiveMode).
//
// Both switches are read from the plugin's config files on every use, so an
// edit takes effect without a restart (api.config is a startup snapshot).

const fs = require('fs');
const path = require('path');
const {LadderUser} = require('./entities');

const MODES = ['legacy', 'hashed', 'frozen'];
const RANK = {legacy: 0, hashed: 1, frozen: 1};

async function readJson(filename) {
  try {
    const value = JSON.parse(await fs.promises.readFile(filename, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Plugin config must be an object.');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function normalizeSecurityConfig(config) {
  const mode = config?.passwordHash?.mode ?? 'legacy';
  if (!MODES.includes(mode)) throw new TypeError('passwordHash.mode must be legacy, hashed or frozen.');
  const enabled = config?.passwordChange?.enabled ?? false;
  if (typeof enabled !== 'boolean') throw new TypeError('passwordChange.enabled must be a boolean.');
  return {mode, passwordChangeEnabled: enabled};
}

// scrypt parameters for new hashes, as the server would use them.
async function readScryptParams(rootDir, paramsAllowed) {
  const defaults = await readJson(path.join(rootDir, 'config.default.json'));
  const local = await readJson(path.join(rootDir, 'config.json'));
  const merged = {...(defaults.passwordSecurity || {}), ...(local.passwordSecurity || {})};
  return normalizePasswordSecurity(merged, {paramsAllowed}).config.scrypt;
}

async function readSecurityConfig(rootDir) {
  const defaults = await readJson(path.join(rootDir, 'config.default.json'));
  const local = await readJson(path.join(rootDir, 'config.json'));
  return normalizeSecurityConfig({
    passwordHash: {...(defaults.passwordHash || {}), ...(local.passwordHash || {})},
    passwordChange: {...(defaults.passwordChange || {}), ...(local.passwordChange || {})}
  });
}

// A configured mode combined with what is known to have happened. `floor` is
// the highest mode this process (or the database) has proven.
function effectiveMode(configured, floor) {
  if (configured === 'legacy' && RANK[floor] > 0) return 'frozen';
  return configured;
}

// Live reader. An invalid edit keeps the last valid values (fails closed for
// the mode: the startup fallback is legacy, which writes no hash).
function createLiveSecurityConfig(rootDir, fallback = {}, log = null) {
  let current = {mode: 'legacy', passwordChangeEnabled: false};
  let floor = 'legacy';
  try {
    current = normalizeSecurityConfig(fallback);
  } catch (error) {
    log?.warn?.({event: 'ladder_security_config_invalid', reason: error.code || error.name}, 'Ladder security config invalid; using safe defaults.');
  }
  const reader = async () => {
    try {
      current = await readSecurityConfig(rootDir);
    } catch (error) {
      log?.warn?.({event: 'ladder_security_config_invalid', reason: error.code || error.name},
        'Ladder security config reload failed; keeping last valid values.');
    }
    const mode = effectiveMode(current.mode, floor);
    if (RANK[mode] > RANK[floor]) floor = mode;
    if (mode !== current.mode) {
      log?.warn?.({event: 'ladder_password_mode_forced', configured: current.mode, effective: mode},
        'passwordHash.mode cannot return to legacy after hashes may exist; treating it as frozen.');
    }
    return {...current, mode};
  };
  reader.raiseFloor = mode => { if (RANK[mode] > RANK[floor]) floor = mode; };
  return reader;
}

// passwordSecurity (read once at startup; tune after benchmarking the server):
// scrypt cost for NEW hashes, execution slots/queues, and per-minute budgets.
// Existing hashes keep the parameters stored inside them.
const SECURITY_DEFAULTS = Object.freeze({
  scrypt: Object.freeze({N: 16384, r: 8, p: 1}),
  slots: 4, webSlots: 2, webQueue: 8, webWaitMs: 2000, joinQueue: 256, joinWaitMs: 5000,
  webPerIpPerMinute: 60, webPerAccountPerMinute: 30,
  changeFailuresPerIp: 10, changeFailuresPerAccount: 5, changeFailureWindowMinutes: 15
});
const SECURITY_RANGES = {
  slots: [1, 64], webSlots: [1, 64], webQueue: [0, 1000], webWaitMs: [0, 60000], joinQueue: [0, 1000], joinWaitMs: [0, 60000],
  webPerIpPerMinute: [1, 100000], webPerAccountPerMinute: [1, 100000],
  changeFailuresPerIp: [1, 100000], changeFailuresPerAccount: [1, 100000], changeFailureWindowMinutes: [1, 1440]
};

// Each invalid field falls back to its default and is reported by name only.
function normalizePasswordSecurity(input, {paramsAllowed}) {
  const config = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const invalid = [];
  const result = {};
  for (const [key, [min, max]] of Object.entries(SECURITY_RANGES)) {
    const value = config[key] ?? SECURITY_DEFAULTS[key];
    if (Number.isSafeInteger(value) && value >= min && value <= max) result[key] = value;
    else { result[key] = SECURITY_DEFAULTS[key]; invalid.push(key); }
  }
  const scrypt = {...SECURITY_DEFAULTS.scrypt, ...(config.scrypt && typeof config.scrypt === 'object' ? config.scrypt : {})};
  if (paramsAllowed(scrypt)) result.scrypt = Object.freeze({N: scrypt.N, r: scrypt.r, p: scrypt.p});
  else { result.scrypt = SECURITY_DEFAULTS.scrypt; invalid.push('scrypt'); }
  if (result.webSlots > result.slots) { result.webSlots = result.slots; invalid.push('webSlots'); }
  return {config: Object.freeze(result), invalid};
}

const isPostgresOrMysql = type => ['postgres', 'mysql', 'mariadb', 'aurora-data-api'].includes(type);

// Conditional credential update: succeeds only if the row still stores
// `expected`. Returns true when exactly one row changed.
async function compareAndSetPass(manager, key, expected, next) {
  const type = manager.connection.options.type;
  const builder = () => {
    const query = manager.createQueryBuilder().update(LadderUser).set({pass: next}).where('name = :key', {key});
    return expected == null ? query.andWhere('pass IS NULL') : query.andWhere('pass = :expected', {expected});
  };
  if (isPostgresOrMysql(type)) {
    const result = await builder().execute();
    return result.affected === 1;
  }
  // SQLite/SQL.js report no affected count in TypeORM 0.2.29. These drivers are
  // used only by tests and single-process tools; re-check inside one
  // transaction so the semantics match.
  return manager.transaction(async inner => {
    const row = await inner.findOne(LadderUser, key);
    if (!row || (row.pass ?? null) !== (expected ?? null)) return false;
    await inner.createQueryBuilder().update(LadderUser).set({pass: next}).where('name = :key', {key}).execute();
    return true;
  });
}

// Insert-only account creation. TypeORM's save() turns into an UPDATE when the
// primary key exists, which could overwrite a concurrently created account.
// Returns true when this call created the row, false on a primary key clash.
async function insertAccount(manager, values) {
  try {
    await manager.createQueryBuilder().insert().into(LadderUser).values(values).execute();
    return true;
  } catch (error) {
    if (await manager.findOne(LadderUser, values.name)) return false;
    throw error;
  }
}

// Does the table hold any value written by the hashing code? Used to refuse a
// return to legacy mode.
async function anyHashedCredential(manager) {
  const row = await manager.createQueryBuilder(LadderUser, 'u').select('u.name')
    .where("u.pass LIKE 'scrypt$%' OR u.pass LIKE 'scrypt-temp$%'").getOne();
  return !!row;
}

// Fixed error codes for logs. Driver errors (TypeORM QueryFailedError) carry
// the SQL parameters, which for credential writes include passwords, so they
// must never be logged as-is (design 2.11).
function safeErrorCode(error) {
  if (!error) return 'unknown';
  if (typeof error.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(error.code)) return error.code;
  if (error.name === 'QueryFailedError') return 'query_failed';
  return typeof error.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'unknown';
}

module.exports = {MODES, SECURITY_DEFAULTS, normalizePasswordSecurity, readScryptParams, normalizeSecurityConfig, readSecurityConfig, effectiveMode, createLiveSecurityConfig,
  compareAndSetPass, insertAccount, anyHashedCredential, safeErrorCode};
