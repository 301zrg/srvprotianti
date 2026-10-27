'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {run, valid, idle, barrier} = require('./server-flow.cjs');

const check = (condition, code) => { if (!condition) throw Error(code); };
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const sha = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeCode = error => /^[a-z][a-z0-9_]{0,79}$/.test(error?.message) ? error.message : 'coordinator_operation_failed';

function relative(value) {
  check(typeof value === 'string' && value.length < 240 &&
    value.split('/').every(part => /^[a-z0-9_@+(). -]+$/i.test(part) && part !== '.' && part !== '..' && !/[. ]$/.test(part)) &&
    !value.includes('\\') && !value.includes(':') && !value.startsWith('/'), 'manifest_path');
  return value;
}

function inside(base, name) {
  relative(name);
  const target = path.resolve(base, name), rel = path.relative(path.resolve(base), target);
  check(rel && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel), 'manifest_path');
  // Reject junctions/symlinks, including an existing parent of a new target.
  let current = target;
  while (true) {
    if (fs.existsSync(current)) check(!fs.lstatSync(current).isSymbolicLink(), 'manifest_path');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return target;
}

function validateManifest(m, batch) {
  check(m && [1, 2].includes(m.schemaVersion) && /^[a-z0-9][a-z0-9-]{0,79}$/.test(m.id) && m.enabled === true &&
    typeof m.title === 'string' && m.title.length > 0 && Array.isArray(m.files), 'manifest_invalid');
  check(path.basename(path.resolve(batch)) === m.id, 'batch_id_mismatch');
  const allowed = ['schemaVersion', 'id', 'title', 'enabled', 'server', 'files', 'health', 'desktop'];
  if (m.schemaVersion === 2) allowed.push('deckReclassification', 'notifications', 'releaseNotes');
  check(Object.keys(m).every(key => allowed.includes(key)), 'manifest_invalid');
  const s = m.server;
  check(s && [s.projectRoot, s.pm2Home, s.pm2Script].every(p => typeof p === 'string' && path.isAbsolute(p) && !/[\r\n\0"]/.test(p)) &&
    /^[a-z0-9][a-z0-9_.-]{0,79}$/i.test(s.appName) &&
    [s.httpPort, s.gamePort].every(n => Number.isInteger(n) && n > 0 && n <= 65535) &&
    Number.isFinite(s.minimumFreeMiB) && s.minimumFreeMiB >= 64, 'server_config_invalid');
  const targets = new Set(), sources = new Set();
  for (const f of m.files) {
    check(f && typeof f === 'object', 'manifest_invalid');
    relative(f.path); relative(f.source);
    const key = f.path.toLowerCase(), source = f.source.toLowerCase();
    check(!/(^|\/)(config|logs?|replays?|recordings?|node_modules|\.git|\.pm2|deployment-backups|db|database)(\/|$)/i.test(key) &&
      !/(^|\/)(config|admin_user|random_duel_ban|ban)\.json$/i.test(key) &&
      !/\.(db|sqlite|sqlite3|log|dmp)$/i.test(key) && !/^data\/(?!i18n\.json$)/i.test(key), 'private_file');
    check(!targets.has(key) && !sources.has(source) && !['manifest.json', 'state.json', 'preflight-state.json', 'server-coordinator.cjs', 'server-flow.cjs', 'release-options.cjs', 'deck-maintenance.cjs', 'discord-notifications.cjs', 'announce-release.cjs', 'release-announcement.json', 'release-announcement.lock', 'launch-once.ps1', 'read-state.ps1'].includes(source), 'manifest_duplicate');
    check(hash(f.sha256) && (f.beforeSha256 === null || hash(f.beforeSha256)) && ['backend', 'website'].includes(f.phase), 'manifest_invalid');
    check(f.phase !== 'website' || f.path.startsWith('plugins/ladder-web/web/'), 'website_path');
    targets.add(key); sources.add(source); inside(s.projectRoot, f.path); inside(batch, f.source);
  }
  check(m.files.length > 0 || m.desktop, 'empty_batch');
  const h = m.health;
  check(h && typeof h.ladderConfig === 'boolean' && typeof h.privateStatsGuard === 'boolean' && Array.isArray(h.expectedHooks) &&
    h.expectedHooks.every(name => ['random_duel_afk_penalty', 'random_duel_flee_penalty', 'random_duel_zombie_penalty', 'random_duel_penalty_history'].includes(name)) &&
    typeof h.mode === 'string' && /^[A-Z0-9_-]{1,16}$/.test(h.mode) && typeof h.countAfkPenalty === 'boolean', 'health_config_invalid');
  if (m.schemaVersion === 2) require('./release-options.cjs').validateReleaseOptions(m);
  return m;
}

function createFileInstaller({manifest, batch, onInstalled = () => {}}) {
  validateManifest(manifest, batch);
  const installed = new Set();
  const files = phase => manifest.files.filter(f => f.phase === phase).sort((a, b) => Number(/\.html?$/i.test(a.path)) - Number(/\.html?$/i.test(b.path)));
  const target = f => inside(manifest.server.projectRoot, f.path);
  const original = f => inside(path.join(batch, 'original'), f.path);
  function verifyFile(f) {
    check(sha(inside(batch, f.source)) === f.sha256, 'payload_hash_mismatch');
    const dest = target(f);
    check(f.beforeSha256 === null ? !fs.existsSync(dest) : fs.existsSync(dest) && sha(dest) === f.beforeSha256, 'before_hash_mismatch');
  }
  function verify(phase) { for (const f of phase ? files(phase) : manifest.files) verifyFile(f); }
  function install(phase) {
    const selected = files(phase);
    verify(phase);
    for (const f of selected) {
      if (f.beforeSha256 === null) continue;
      const backup = original(f);
      fs.mkdirSync(path.dirname(backup), {recursive: true});
      if (!fs.existsSync(backup)) fs.copyFileSync(target(f), backup, fs.constants.COPYFILE_EXCL);
      check(sha(backup) === f.beforeSha256, 'backup_hash_mismatch');
    }
    // Check the entire backup set before the first production rename.
    for (const f of selected) if (f.beforeSha256 !== null) check(sha(original(f)) === f.beforeSha256, 'backup_hash_mismatch');
    verify(phase);
    for (const f of selected) {
      const dest = target(f), temp = dest + '.release-' + manifest.id + '.tmp';
      fs.mkdirSync(path.dirname(dest), {recursive: true});
      fs.copyFileSync(inside(batch, f.source), temp, fs.constants.COPYFILE_EXCL);
      try {
        check(sha(temp) === f.sha256, 'staged_hash_mismatch');
        const expected = f.beforeSha256;
        check(expected === null ? !fs.existsSync(dest) : sha(dest) === expected, 'before_hash_mismatch');
        fs.renameSync(temp, dest); installed.add(f.path);
        check(sha(dest) === f.sha256, 'installed_hash_mismatch');
        onInstalled(f);
      } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    }
  }
  function rollback(phase) {
    const selected = files(phase).filter(f => installed.has(f.path));
    for (const f of selected) {
      check(fs.existsSync(target(f)) && sha(target(f)) === f.sha256, 'rollback_target_changed');
      if (f.beforeSha256 !== null) check(sha(original(f)) === f.beforeSha256, 'backup_hash_mismatch');
    }
    for (const f of selected) {
      const dest = target(f);
      if (f.beforeSha256 === null) fs.unlinkSync(dest);
      else {
        const temp = dest + '.rollback-' + manifest.id + '.tmp';
        fs.copyFileSync(original(f), temp, fs.constants.COPYFILE_EXCL);
        try { check(sha(temp) === f.beforeSha256, 'backup_hash_mismatch'); fs.renameSync(temp, dest); }
        finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
        check(sha(dest) === f.beforeSha256, 'rollback_hash_mismatch');
      }
      installed.delete(f.path);
    }
  }
  return {verify, install, rollback};
}

function loadReclassificationTool(manifest, batch) {
  const Module = require('node:module'), cache = new Map();
  const projectRequire = createRequire(path.join(manifest.server.projectRoot, 'package.json'));
  const candidates = new Map(manifest.files.filter(file => file.phase === 'backend').map(file =>
    [inside(manifest.server.projectRoot, file.path), file]));
  function load(target) {
    const candidate = candidates.get(target);
    if (!candidate) return projectRequire(target);
    if (cache.has(target)) return cache.get(target).exports;
    const source = inside(batch, candidate.source);
    check(sha(source) === candidate.sha256, 'payload_hash_mismatch');
    // Keep approved candidate dependencies private: preflight must not cache old live classifier code.
    const loaded = new Module(target, module);
    loaded.filename = target; loaded.paths = Module._nodeModulePaths(path.dirname(target));
    const requireLive = loaded.require.bind(loaded);
    loaded.require = request => {
      const resolved = Module._resolveFilename(request, loaded);
      return candidates.has(resolved) ? load(resolved) : requireLive(request);
    };
    cache.set(target, loaded);
    loaded._compile(fs.readFileSync(source, 'utf8'), target);
    return loaded.exports;
  }
  return load(inside(manifest.server.projectRoot, 'plugins/deck_analysis/reclassify-database.js'));
}

function acquireGlobalLock(filename, identity) {
  const owner = {...identity, token: crypto.randomBytes(24).toString('hex')};
  let descriptor;
  try { descriptor = fs.openSync(filename, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw Error('global_lock_exists'); throw error; }
  try { fs.writeFileSync(descriptor, JSON.stringify(owner)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  return {owner, release() {
    // A stale coordinator must never remove somebody else's replacement lock.
    try { if (json(filename).token === owner.token) fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }};
}

function processStart(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform !== 'win32') {
    try { process.kill(pid, 0); return pid === process.pid ? new Date(Date.now() - process.uptime() * 1000).toISOString() : null; } catch { return null; }
  }
  try {
    const command = '$p=Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue; if($p -and $p.ProcessName -eq "node"){$p.StartTime.ToUniversalTime().ToString("o")}';
    const result = cp.execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {encoding: 'utf8', windowsHide: true, timeout: 5000}).trim();
    return result ? new Date(result).toISOString() : null;
  } catch { return null; }
}

function sameProcess(pid, stamp, lookup = processStart) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof stamp !== 'string') return false;
  const actual = lookup(pid);
  return actual !== null && Number.isFinite(Date.parse(actual)) && Math.abs(Date.parse(actual) - Date.parse(stamp)) < 100;
}

function readStatus(batch, lookup = processStart) {
  const stateFile = path.join(batch, 'state.json'), lockFile = path.join(path.dirname(batch), 'coordinator.lock');
  const stateExists = fs.existsSync(stateFile), lockExists = fs.existsSync(lockFile);
  const state = stateExists ? json(stateFile) : null, lock = lockExists ? json(lockFile) : null;
  const manifestFile = path.join(batch, 'manifest.json'), manifestSha256 = fs.existsSync(manifestFile) ? sha(manifestFile) : null;
  check(!stateExists || hash(state.manifestSha256) && state.manifestSha256 === manifestSha256, 'manifest_receipt_mismatch');
  return {stateExists, state, manifestSha256, coordinatorRunning: !!state && sameProcess(state.coordinatorPid, state.processStartedAt, lookup),
    lockExists, lockJobId: lock?.jobId || null, lockCoordinatorRunning: !!lock && sameProcess(lock.pid, lock.processStartedAt, lookup)};
}

function startupSummary(text) {
  const names = ['SyntaxError', 'ReferenceError', 'MODULE_NOT_FOUND', 'Cannot find module', 'EADDRINUSE', 'UnhandledPromiseRejection', 'TypeError'];
  const found = names.filter(name => text.includes(name));
  if (/Plugin (load|configuration|registration|initialization) failed|Plugin dependency resolution failed|Plugin disabled because a dependency failed|Ladder web inactive: required services are unavailable|Invalid plugin manifest/i.test(text)) found.push('plugin_initialization_failed');
  return found;
}

function requestLocal(port, route, {method = 'GET', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const req = http.request({hostname: '127.0.0.1', port, path: route, method, headers}, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 2000000) req.destroy(Error('response_limit')); });
      res.on('error', () => finish(Error('response_failed')));
      res.on('end', () => { let value; try { value = JSON.parse(data); } catch {} finish(null, {status: res.statusCode, data, value}); });
    });
    const timer = setTimeout(() => { req.destroy(); finish(Error('request_timeout')); }, 5000);
    req.on('error', () => finish(Error('request_failed'))); req.end(body);
  });
}

function tcp(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host: '127.0.0.1', port});
    const timer = setTimeout(() => { socket.destroy(); reject(Error('tcp_timeout')); }, 3000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
    socket.once('error', () => { clearTimeout(timer); socket.destroy(); reject(Error('tcp_failed')); });
  });
}

function loadCredentials(root) {
  // This executes on the remote host only. Credentials never enter a receipt/stdout.
  const users = json(path.join(root, 'config', 'admin_user.json'));
  const candidate = Object.entries(users.users || {}).find(([name, user]) => {
    const permissions = typeof user.permissions === 'object' ? user.permissions : users.permission_examples?.[user.permissions];
    return user.enabled && typeof user.password === 'string' && !/[:\r\n\0]/.test(name) && permissions?.stop;
  });
  check(candidate, 'no_stop_account');
  const [name, user] = candidate;
  return {name, password: user.password, header: 'Basic ' + Buffer.from(name + ':' + user.password).toString('base64')};
}

function metadata(app) {
  return {pid: app.pid, restarts: app.pm2_env.restart_time, started: app.pm2_env.pm_uptime, status: app.pm2_env.status};
}
const generationMatches = (left, right) => left && right && left.started === right.started && left.restarts === right.restarts;

function recentLog(filename, offset) {
  if (!filename || !fs.existsSync(filename)) return '';
  const size = fs.statSync(filename).size, start = Math.max(size < offset ? 0 : offset, size - 262144), data = Buffer.alloc(size - start);
  const fd = fs.openSync(filename, 'r');
  try { fs.readSync(fd, data, 0, data.length, start); } finally { fs.closeSync(fd); }
  return data.toString('utf8');
}

async function probeLadderHooks(projectRoot, health) {
  const root = path.join(projectRoot, 'plugins', 'ladder-core'), filename = path.join(root, 'index.js');
  const config = {...json(path.join(root, 'config.default.json'))};
  const local = path.join(root, 'config.json');
  if (fs.existsSync(local)) Object.assign(config, json(local));
  check(config.mode === health.mode && config.countAfkPenalty === health.countAfkPenalty, 'hook_policy_mismatch');
  const hooks = new Map(), services = new Map(), warnings = [];
  const api = {rootDir: root, config, settings: {modules: {mysql: {enabled: true}, reconnect: {enabled: true}}},
    registerTranslations() {}, registerEntity() {},
    hook(name, handler) { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(handler); },
    provide(name, service) { services.set(name, service); }, get(name) { return services.get(name) || {}; },
    dataManager: {getRepository() { throw Error('probe_database_forbidden'); }, pluginTransaction() { throw Error('probe_database_forbidden'); }},
    log: {warn() { warnings.push('plugin_configuration_invalid'); }, info() {}, debug() {}, error() { warnings.push('plugin_configuration_invalid'); }}
  };
  const loaded = {exports: {}};
  const pluginRequire = createRequire(filename);
  const source = fs.readFileSync(filename, 'utf8');
  // Trusted entity imports load TypeORM from disk. Keep that cold I/O outside
  // the VM's evaluation budget; the isolated parent process still has a deadline.
  if (/require\(['"]\.\/entities['"]\)/.test(source)) pluginRequire('./entities');
  const context = vm.createContext({module: loaded, exports: loaded.exports, require: pluginRequire, __filename: filename, __dirname: root, Buffer, URL, setTimeout, clearTimeout});
  new vm.Script('(function(exports,require,module,__filename,__dirname){' + source + '\n})(exports,require,module,__filename,__dirname);', {filename}).runInContext(context, {timeout: 5000});
  check(typeof loaded.exports.register === 'function' && typeof loaded.exports.init === 'function', 'plugin_lifecycle_missing');
  await loaded.exports.register(api); await loaded.exports.init(api);
  for (const name of health.expectedHooks) {
    const handlers = hooks.get(name); check(handlers?.length, 'hook_missing');
    let results;
    if (name === 'random_duel_penalty_history') {
      results = await Promise.all(handlers.map(handler => handler(health.mode, {reasons: ['${random_ban_reason_zombie}']})));
      check(health.countAfkPenalty ? results.every(value => value === null) : results.some(value => value?.ignore === true), 'hook_policy_mismatch');
    } else {
      results = await Promise.all(handlers.map(handler => handler({random_type: health.mode}, {})));
      check(results.some(value => value === health.countAfkPenalty), 'hook_policy_mismatch');
    }
  }
  check(warnings.length === 0, 'plugin_configuration_invalid');
  return {hooks: [...health.expectedHooks], mode: health.mode, countAfkPenalty: health.countAfkPenalty};
}

function probeInstalled(projectRoot, health) {
  try {
    const result = cp.execFileSync(process.execPath, [__filename, '--probe-hooks', projectRoot, Buffer.from(JSON.stringify(health)).toString('base64')],
      {encoding: 'utf8', windowsHide: true, timeout: 12000, stdio: ['ignore', 'pipe', 'pipe']});
    return JSON.parse(result);
  } catch (error) {
    if (error.code === 'ETIMEDOUT') throw Error('hook_probe_timeout');
    // Our CLI writes one JSON error. Preserve only its controlled code, never
    // a stack, command line, response body or production configuration.
    let reason = 'hook_probe_process_failed';
    try {
      const report = JSON.parse(String(error.stderr || '').trim().split(/\r?\n/).at(-1));
      reason = hookFailureReason(Error(report.errorCode));
    } catch {}
    throw Error(reason);
  }
}

function hookFailureReason(error) {
  if (error?.code === 'ETIMEDOUT') return 'hook_probe_timeout';
  const allowed = ['hook_probe_timeout', 'hook_missing', 'hook_policy_mismatch', 'plugin_lifecycle_missing',
    'plugin_configuration_invalid', 'probe_database_forbidden', 'coordinator_operation_failed'];
  return allowed.includes(error?.message) ? error.message : 'hook_probe_process_failed';
}

function createRuntimeAdapter(options) {
  const {manifest, batch} = options, s = manifest.server;
  const request = options.request || ((route, init) => requestLocal(s.httpPort, route, init));
  const now = options.now || Date.now, pause = options.sleep || sleep;
  const maintenanceValue = options.maintenanceValue || (() => json(path.join(s.projectRoot, 'config', 'config.json')).modules.stop);
  const maintenance = '[release-monitor:' + manifest.id + '] maintenance';
  const installer = createFileInstaller({manifest, batch});
  const decks = manifest.deckReclassification ? options.deckMaintenance || require('./deck-maintenance.cjs').createDeckMaintenance({projectRoot: s.projectRoot, batch, settings: manifest.deckReclassification,
    tool: loadReclassificationTool(manifest, batch)}) : null;
  const notifications = manifest.notifications ? options.discordNotifications || require('./discord-notifications.cjs').createDiscordNotifications({manifest, batch}) : null;
  let original, auth, ownedGeneration, lastBarrier = null, issuedAt = null, daemonIdentity;
  let logs = [];
  function pm2(args) {
    if (options.pm2) return options.pm2(args);
    const pid = Number(fs.readFileSync(path.join(s.pm2Home, 'pm2.pid'), 'utf8').trim());
    check(Number.isSafeInteger(pid) && pid > 0, 'pm2_daemon_missing');
    const stamp = processStart(pid); check(stamp, 'pm2_daemon_missing');
    if (!daemonIdentity) daemonIdentity = {pid, stamp};
    check(pid === daemonIdentity.pid && stamp === daemonIdentity.stamp, 'pm2_daemon_changed');
    return cp.execFileSync(process.execPath, [s.pm2Script, ...args], {encoding: 'utf8', windowsHide: true, timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, PM2_HOME: s.pm2Home}});
  }
  function game() {
    const list = JSON.parse(pm2(['jlist'])), matches = list.filter(app => app.name === s.appName);
    check(matches.length === 1, 'game_missing_or_duplicate');
    const a = matches[0], env = a.pm2_env;
    check(env && path.resolve(env.pm_exec_path).toLowerCase() === path.resolve(s.projectRoot, 'ygopro-server.js').toLowerCase() &&
      env.watch === false && env.exec_mode === 'fork_mode', 'runtime_layout_changed');
    return a;
  }
  const persisted = async enabled => maintenanceValue() === (enabled ? maintenance : false);
  async function snapshot() {
    const response = await request('/api/maintenance/status', {headers: {Authorization: auth.header}});
    check(response.status === 200 && valid(response.value), 'invalid_snapshot');
    return response.value;
  }
  function markLogs(app) {
    logs = [app.pm2_env.pm_err_log_path, app.pm2_env.pm_out_log_path].filter(Boolean).map(filename => ({filename, offset: fs.existsSync(filename) ? fs.statSync(filename).size : 0}));
  }
  function sameOriginal() {
    const current = metadata(game());
    check(current.status === 'online' && current.pid === original.pid && generationMatches(current, original), 'runtime_changed');
  }
  async function probeHooks(version) {
    const started = now();
    try { return await (options.probeHooks || probeInstalled)(s.projectRoot, manifest.health); }
    catch (error) {
      throw Object.assign(Error('health_probe_failed'), {healthFailure: {version, check: 'hook_probe',
        reason: hookFailureReason(error), attempts: 1, elapsedMilliseconds: Math.max(0, now() - started)}});
    }
  }
  async function verify() {
    installer.verify();
    const syntax = options.checkSyntax || (filename => cp.execFileSync(process.execPath, ['--check', filename], {timeout: 15000, windowsHide: true, stdio: 'pipe'}));
    for (const f of manifest.files) if (/\.(c?js|mjs)$/i.test(f.path)) {
      try { syntax(inside(batch, f.source)); } catch { throw Error('payload_syntax_invalid'); }
    }
    for (const f of manifest.files) if (/\.json$/i.test(f.path)) {
      try { json(inside(batch, f.source)); } catch { throw Error('payload_json_invalid'); }
    }
    const a = game(); original = metadata(a);
    check(original.status === 'online' && original.pid > 0 && Number.isFinite(original.started) && Number.isInteger(original.restarts), 'game_not_online');
    check((options.freeMemoryMiB || (() => os.freemem() / 1048576))() >= s.minimumFreeMiB, 'insufficient_memory');
    auth = (options.credentials || loadCredentials)(s.projectRoot); markLogs(a);
    // Check unchanged installed hooks while the old service is still open.
    // A ladder-core payload may intentionally change policy, so its actual
    // installed candidate is still checked after the switch.
    if (manifest.files.some(file => file.phase === 'backend') && manifest.health.expectedHooks.length && !manifest.files.some(file =>
      file.phase === 'backend' && /^plugins\/ladder-core\//i.test(file.path))) await probeHooks('preflight');
    if (decks) await decks.verify();
    if (notifications) await notifications.preflight(JSON.parse(pm2(['jlist'])));
    return {gameBefore: original, ...(decks ? {deckReclassification: decks.status()} : {})};
  }
  async function maintain(enabled) {
    if (enabled) {
      sameOriginal();
      const current = await snapshot();
      check(idle(current) && !current.maintenanceEnabled && !maintenanceValue(), 'external_maintenance_or_busy');
      check((options.freeMemoryMiB || (() => os.freemem() / 1048576))() >= s.minimumFreeMiB, 'insufficient_memory');
    } else check(await persisted(true), 'maintenance_ownership_lost');
    const query = new URLSearchParams({username: auth.name, pass: auth.password, stop: enabled ? maintenance : 'false'});
    const response = await request('/api/message?' + query);
    check(response.status === 200 && response.data.startsWith("['stop ok',"), 'maintenance_failed');
  }
  async function switchBackend(issued, progress = async () => {}) {
    sameOriginal();
    const current = await snapshot();
    check(barrier(current) && await persisted(true), 'last_barrier_failed');
    lastBarrier = current; installer.verify('backend');
    issuedAt = now(); issued();
    pm2(['stop', s.appName]);
    const stopped = game(); ownedGeneration = metadata(stopped);
    check(!stopped.pid && stopped.pm2_env.status === 'stopped', 'stop_failed');
    if (decks) {
      await progress('BACKING_UP_DECKS');
      await decks.backup();
    }
    installer.install('backend');
    if (decks) {
      await progress('RECLASSIFYING_DECKS', {deckReclassification: decks.status()});
      await decks.reclassify();
      await progress('DECKS_RECLASSIFIED', {deckReclassification: decks.status()});
    }
    markLogs(stopped);
    pm2(['restart', s.appName]); ownedGeneration = metadata(game());
  }
  async function health(version) {
    const started = now(), end = started + (options.healthTimeoutMilliseconds ?? 60000), stable = options.stableMilliseconds ?? 10000;
    let stableSince = null, seen, attempts = 0, failedCheck = 'process', reason = 'process_not_fresh';
    if (version === 'new' && manifest.health.expectedHooks.length) {
      await probeHooks(version);
    }
    while (now() < end) {
      let checking = 'process'; attempts++;
      try {
        const a = game(), m = metadata(a);
        check(m.pid > 0 && m.status === 'online' && m.pid !== original.pid && generationMatches(m, ownedGeneration) && m.started >= issuedAt - 1000, 'process_not_fresh');
        checking = 'maintenance';
        const status = await snapshot(); check(barrier(status) && await persisted(true), 'maintenance_not_idle'); lastBarrier = status;
        checking = 'public_api';
        const config = await request('/api/ladder-config'), rooms = await request('/api/public/rooms');
        check(rooms.status === 200 && Array.isArray(rooms.value?.rooms), 'public_health_failed');
        if (manifest.health.ladderConfig || version === 'old') {
          checking = 'ladder_config';
          const rating = config.value?.rating;
          check(config.status === 200 && rating && ['initialPoints', 'totalWeight', 'monthWeight', 'kFactor', 'minDelta', 'maxDelta', 'fixedDelta', 'minimumPoints', 'eloScale'].every(key => Number.isFinite(rating[key])) && typeof rating.useDynamic === 'boolean', 'rating_missing');
        }
        if (manifest.health.privateStatsGuard && version === 'new') {
          checking = 'private_guard';
          const guard = await request('/api/ladder/player/stats', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({player: '', password: '', scope: 'month'})});
          check(guard.status === 403 && guard.value?.code === 'authentication_required', 'private_guard_missing');
        }
        if (decks && version === 'new') {
          checking = 'template_download';
          for (const file of manifest.files.filter(file => /^plugins\/deck_analysis\/deck_templates\/\d+(?:[-_]\d+)?\.ydk$/i.test(file.path))) {
            const filename = path.basename(file.path), deckTypeId = filename.match(/^\d+/)[0];
            const query = new URLSearchParams({deckTypeId, filename});
            const response = await request('/api/ladder/deck-template?' + query);
            check(response.status === 200 && typeof response.data === 'string' &&
              crypto.createHash('sha256').update(response.data).digest('hex') === file.sha256, 'template_download_mismatch');
          }
        }
        checking = 'game_port'; await (options.tcp || tcp)(s.gamePort);
        checking = 'http_port'; await (options.tcp || tcp)(s.httpPort);
        checking = 'startup_log';
        check(startupSummary(logs.map(log => recentLog(log.filename, log.offset)).join('\n')).length === 0, 'startup_error');
        if (!seen || seen.pid !== m.pid || !generationMatches(seen, m)) { seen = m; stableSince = now(); }
        if (now() - stableSince >= stable) return m;
      } catch (error) { failedCheck = checking; reason = safeCode(error); stableSince = null; seen = null; }
      await pause(1500);
    }
    throw Object.assign(Error('health_timeout'), {healthFailure: {version, check: failedCheck, reason,
      attempts, elapsedMilliseconds: Math.max(0, now() - started)}});
  }
  async function rollback() {
    check(await persisted(true) && barrier(lastBarrier), 'rollback_maintenance_not_owned');
    const current = metadata(game());
    check(generationMatches(current, ownedGeneration) && (!current.pid || current.pid === ownedGeneration.pid), 'rollback_runtime_changed');
    let observed;
    try { observed = await snapshot(); }
    catch (error) { if (error.message === 'invalid_snapshot') throw Error('rollback_invalid_snapshot'); }
    if (observed) check(barrier(observed), 'rollback_busy');
    else {
      // The only unreachable instance we may stop is our own still-closed generation.
      check(current.pid === ownedGeneration.pid || (!current.pid && ['stopped', 'errored'].includes(current.status)), 'rollback_runtime_changed');
      check(await persisted(true) && barrier(lastBarrier), 'rollback_maintenance_not_owned');
    }
    pm2(['stop', s.appName]);
    const stopped = game(); check(!stopped.pid && stopped.pm2_env.status === 'stopped', 'stop_failed');
    if (decks) await decks.rollback();
    installer.rollback('backend'); markLogs(stopped);
    pm2(['restart', s.appName]); ownedGeneration = metadata(game());
    return decks ? {deckReclassification: decks.status()} : {};
  }
  async function publishWebsite() {
    try { installer.install('website'); }
    catch (error) {
      try { installer.rollback('website'); } catch { throw Error('website_recovery_failed'); }
      throw error;
    }
  }
  return {verify, snapshot, maintain, persisted, switchBackend, health, rollback, publishWebsite,
    notify: phase => { check(notifications, 'notifications_not_configured'); return notifications.notify(phase); },
    close: async () => { if (notifications) await notifications.close(); }};
}

function atomicReceipt(filename, state) {
  const temp = filename + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), {flag: 'wx'});
  fs.renameSync(temp, filename);
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--probe-hooks') {
    check(argv.length === 3, 'arguments_invalid');
    const result = await probeLadderHooks(argv[1], JSON.parse(Buffer.from(argv[2], 'base64').toString('utf8')));
    process.stdout.write(JSON.stringify(result) + '\n'); return result;
  }
  const batchIndex = argv.indexOf('--batch');
  check(batchIndex >= 0 && typeof argv[batchIndex + 1] === 'string' && path.isAbsolute(argv[batchIndex + 1]), 'batch_required');
  const batch = path.resolve(argv[batchIndex + 1]);
  check(/^[a-z0-9][a-z0-9-]{0,79}$/.test(path.basename(batch)) && !/[\r\n\0"]/.test(batch), 'batch_invalid');
  const flags = argv.filter((_, i) => i !== batchIndex && i !== batchIndex + 1);
  check(flags.every(flag => ['--preflight-only', '--read-only'].includes(flag)) && new Set(flags).size === flags.length && flags.length <= 1, 'arguments_invalid');
  if (flags.includes('--read-only')) { const status = readStatus(batch); process.stdout.write(JSON.stringify(status) + '\n'); return status; }
  const manifestFile = path.join(batch, 'manifest.json'), manifestSha256 = sha(manifestFile);
  const manifest = validateManifest(json(manifestFile), batch), preflightOnly = flags.includes('--preflight-only');
  const startedAt = processStart(process.pid); check(startedAt, 'process_identity_unavailable');
  let lock;
  if (!preflightOnly) {
    lock = acquireGlobalLock(path.join(path.dirname(batch), 'coordinator.lock'), {pid: process.pid, processStartedAt: startedAt, jobId: manifest.id});
    try {
      const old = readStatus(batch);
      check(!old.stateExists || old.state.stage === 'FINISHED' && old.state.outcome === 'WAITING' && !old.coordinatorRunning, 'batch_already_attempted');
    } catch (error) { lock.release(); throw error; }
  }
  const filename = path.join(batch, preflightOnly ? 'preflight-state.json' : 'state.json');
  const runtime = createRuntimeAdapter({manifest, batch});
  const adapter = {...runtime,
    record: state => atomicReceipt(filename, {...state, coordinatorPid: process.pid, processStartedAt: startedAt, manifestSha256, mode: preflightOnly ? 'PREFLIGHT_ONLY' : 'RELEASE'}),
    close: async () => { try { await runtime.close(); } finally { lock?.release(); } }};
  let result;
  try {
    result = await run(adapter, {jobId: manifest.id, preflightOnly, hasBackend: manifest.files.some(f => f.phase === 'backend'), hasWebsite: manifest.files.some(f => f.phase === 'website'), hasNotifications: Boolean(manifest.notifications)});
  } finally { lock?.release(); }
  process.stdout.write(JSON.stringify({outcome: result.outcome, stage: result.stage, backendActive: result.backendActive, websitePublished: result.websitePublished, errorCode: result.errorCode}) + '\n');
  if (!['UPDATED', 'WAITING', 'PREFLIGHT'].includes(result.outcome)) process.exitCode = 1;
  return result;
}

module.exports = {validateManifest, createFileInstaller, loadReclassificationTool, acquireGlobalLock, readStatus, startupSummary, probeLadderHooks, createRuntimeAdapter, main};

if (require.main === module) {
  main().catch(error => { process.stderr.write(JSON.stringify({outcome: 'COORDINATOR_FAILED', errorCode: safeCode(error)}) + '\n'); process.exitCode = 1; });
}
