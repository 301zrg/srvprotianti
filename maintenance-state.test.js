'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const coffee = require('coffeescript');
const {MaintenanceState, basicCredentials, neosForwardedIp, hostEnvironmentKeys} = require('./maintenance-state');

const source = fs.readFileSync(require.resolve('./ygopro-server.coffee'), 'utf8').replace(/\r\n/g, '\n');
const log = {warn() {}};
const tick = () => new Promise(resolve => setImmediate(resolve));

async function checkDetachedReplayWrites() {
  const start = source.indexOf('ROOM_try_persist_replay =');
  const end = source.indexOf('\ntoIpv4 =', start);
  const state = new MaintenanceState();
  let fileCallback;
  let releaseDatabase;
  const databaseGate = new Promise(resolve => { releaseDatabase = resolve; });
  const context = {
    global: {}, maintenanceState: state, log,
    settings: {modules: {mysql: {enabled: true}, tournament_mode: {replay_path: 'replay/'}}},
    moment_now: {format() {return '2026-10-10 12-00-00';}},
    fs: {writeFile(name, buffer, callback) {fileCallback = callback;}},
    dataManager: {async saveDuelLog() {await databaseGate; return {id: 7};}},
    plugin_call: async () => {}
  };
  vm.runInNewContext(coffee.compile(source.slice(start, end), {bare: true}), context);
  const room = {
    finished: true, name: 'test', hostinfo: {mode: 0}, scores: {}, winner: 0, dueling_players: [],
    duel_finalization: {takeReplayForPersistence() {return Buffer.from([1]);}}
  };
  const task = context.global.ROOM_try_persist_replay(room);
  assert.strictEqual(state.snapshot(true, []).readyToStop, false, 'unfinished DB write prevents shutdown');
  assert.deepStrictEqual(state.snapshot(true, []).pendingPersistence, {replay_file: 1, duel_log: 1});
  releaseDatabase();
  await task;
  assert.deepStrictEqual(state.snapshot(true, []).pendingPersistence, {replay_file: 1}, 'returning DuelLog does not prove file completion');
  fileCallback(new Error('disk full'));
  assert.strictEqual(state.snapshot(true, []).readyToStop, true, 'failed write completes tracking without inventing a file');
  fileCallback();
  assert.strictEqual(state.snapshot(true, []).pendingCount, 0, 'completion is idempotent');
}

async function checkMaintenanceEndpoint() {
  const start = source.indexOf("    if u.pathname == '/api/maintenance/status'");
  const end = source.indexOf("\n    handled =", start);
  const code = coffee.compile(`handle = ->\n${source.slice(start, end)}\nhandle()`, {bare: true});
  for (const allowed of [false, true]) {
    for (const method of ['GET', 'POST']) {
      const response = {
        writeHead(status, headers) {this.status = status; this.headers = headers;},
        end(body) {this.body = body;}
      };
      let authCalls = 0;
      await vm.runInNewContext(code, {
        u: {pathname: '/api/maintenance/status'}, Maintenance: {basicCredentials},
        request: {method, headers: {authorization: 'Basic ' + Buffer.from('admin:secret').toString('base64')}}, response,
        auth: {async auth(name, password, permission) {
          ++authCalls;
          assert.strictEqual(name, 'admin'); assert.strictEqual(password, 'secret'); assert.strictEqual(permission, 'stop');
          return allowed;
        }},
        settings: {modules: {stop: 'maintenance'}}, ROOM_all: [], maintenanceState: new MaintenanceState()
      });
      assert.strictEqual(response.status, method !== 'GET' ? 405 : allowed ? 200 : 401);
      assert.strictEqual(authCalls, method === 'GET' ? 1 : 0);
      if (response.status === 200) assert.strictEqual(JSON.parse(response.body).readyToStop, true);
      assert.ok(!String(response.body).includes('secret'));
    }
  }
}

async function checkProtocolWork() {
  // Exercise the real queue wrappers: work waiting in a queue must be counted too.
  for (const kind of ['client', 'server']) {
    const start = source.indexOf(kind === 'client' ? '  queuedDataHandler =' : '  queuedServerDataHandler =');
    const end = source.indexOf('\n\n', start);
    const variable = kind === 'client' ? 'queuedDataHandler' : 'queuedServerDataHandler';
    const state = new MaintenanceState();
    let release;
    const gate = new Promise(resolve => {release = resolve;});
    const context = {client: {}, server: {}, maintenanceState: state};
    context[kind + '_data_queue'] = {async add(task) {await gate; return task();}};
    context[kind === 'client' ? 'dataHandler' : 'serverDataHandler'] = async () => 'ordered result';
    vm.runInNewContext(coffee.compile(source.slice(start, end), {bare: true}), context);
    const task = context[variable](Buffer.from([1]));
    assert.strictEqual(state.snapshot(true, []).readyToStop, false);
    assert.strictEqual(state.snapshot(true, []).pendingWork[kind + '_protocol'], 1);
    release();
    assert.strictEqual(await task, 'ordered result');
    assert.strictEqual(state.snapshot(true, []).readyToStop, true);
  }
}

async function checkProxyTrust() {
  const start = source.indexOf('toIpv4 =');
  const end = source.indexOf('\n\nCLIENT_set_ip =', start);
  const context = {
    global: {}, settings: {modules: {trusted_proxies: ['127.0.0.1/32', '::1/128']}},
    ip6addr: require('ip6addr'), log
  };
  vm.runInNewContext(coffee.compile(source.slice(start, end), {bare: true}), context);
  const headers = {'x-forwarded-for': '203.0.113.7, 127.0.0.1', 'x-real-ip': '203.0.113.8'};
  const old = neosForwardedIp({ip_header: 'X-Forwarded-For'}, headers);
  assert.strictEqual(context.global.getRealIp('127.0.0.1', old), '::ffff:203.0.113.7');
  assert.strictEqual(context.global.getRealIp('198.51.100.2', old), '::ffff:198.51.100.2', 'untrusted callers cannot spoof IP');
  assert.strictEqual(neosForwardedIp({trusted_proxy_header: 'x-real-ip', ip_header: 'x-forwarded-for'}, headers), '203.0.113.8');
  assert.strictEqual(neosForwardedIp({trusted_proxy_header: '', ip_header: 'x-forwarded-for'}, headers), undefined);
  assert.strictEqual(neosForwardedIp({ip_header: '\nx-forwarded-for'}, headers), undefined);
}

(async () => {
  const migratedKeys = vm.runInNewContext(coffee.compile(source.match(/^  keysFromEnv = .*$/m)[0].trim(), {bare: true}), {
    Maintenance: {hostEnvironmentKeys}, process: {env: {
      SRVPRO_port: '7911', SRVPRO_modules__stop: 'false', SRVPRO_LADDER_PG_PASSWORD: 'never-log-or-save',
      SRVPRO_LADDER_PG_USERNAME: 'runtime', PATH: 'ignored'
    }}
  });
  assert.deepStrictEqual(migratedKeys, ['SRVPRO_port', 'SRVPRO_modules__stop'], 'plugin PostgreSQL namespace must bypass generic config migration');
  const state = new MaintenanceState();
  assert.strictEqual(state.snapshot(false, []).readyToStop, false);
  assert.strictEqual(state.snapshot(true, [null, {established: false}]).readyToStop, false);
  assert.strictEqual(state.snapshot(true, [{deleting: true}]).readyToStop, false);
  assert.strictEqual(state.snapshot(true, [{deleted: true}]).readyToStop, true);
  await assert.rejects(state.run('cloud_replay', async () => {throw new Error('failed');}), /failed/);
  assert.strictEqual(state.snapshot(true, []).pendingCount, 0);
  let release;
  const task = state.run('cloud_replay', () => new Promise(resolve => {release = resolve;}));
  await tick();
  assert.strictEqual(state.snapshot(true, []).readyToStop, false);
  release(); await task;
  for (const header of [undefined, 'Bearer secret', 'Basic !!!', 'Basic ' + Buffer.from(':secret').toString('base64')]) {
    assert.strictEqual(basicCredentials(header), null);
  }
  assert.deepStrictEqual(basicCredentials('Basic ' + Buffer.from('中文:p:a').toString('base64')), {name: '中文', pass: 'p:a'});
  await checkDetachedReplayWrites();
  await checkMaintenanceEndpoint();
  await checkProtocolWork();
  await checkProxyTrust();
  console.log('maintenance state and proxy compatibility tests passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
