'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const coffee = require('coffeescript');
const {PluginHost} = require('../../plugin-system');

const log = {info() {}, warn() {}};

async function verifyFailureIsolation(stage) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `srvpro-plugin-${stage}-`));
  try {
    const addPlugin = async (name, dependencies, source) => {
      const dir = path.join(root, name);
      await fs.promises.mkdir(dir);
      await fs.promises.writeFile(path.join(dir, 'plugin.json'), JSON.stringify({name, main: 'index.js', dependencies}));
      await fs.promises.writeFile(path.join(dir, 'index.js'), source);
    };
    const registrations = `
      api.hook('probe', () => api.name);
      api.provide(api.name, {available: true});
      api.registerTranslations({'en-us': {[api.name]: api.name}});
    `;
    await addPlugin('provider', [], `
      module.exports.configure = api => {
        if (${JSON.stringify(stage)} === 'configure') {
          ${registrations}
          throw new Error('configuration failed');
        }
      };
      module.exports.register = api => {
        ${registrations}
        api.registerEntity({name: api.name});
        ${stage === 'register' ? "throw new Error('registration failed');" : ''}
      };
      module.exports.init = async api => {
        if (${JSON.stringify(stage)} === 'init') {
          api.hook('late', () => 'partial init');
          throw new Error('initialization failed');
        }
      };
    `);
    await addPlugin('dependent', ['provider'], `
      module.exports.configure = api => {
        api.hook('configured', () => api.name);
        api.provide('configured-dependent', {});
        api.registerTranslations({'en-us': {configured: 'dependent'}});
      };
      module.exports.register = api => { ${registrations} api.registerEntity({name: api.name}); };
    `);
    await addPlugin('transitive', ['dependent'], `module.exports.register = api => { ${registrations} };`);
    await addPlugin('independent', [], `module.exports.register = api => { ${registrations} api.registerEntity({name: api.name}); };`);
    const host = new PluginHost(root, log);
    await host.register({settings: {}, runtime: {}});
    const registeredEntities = host.entities.slice();
    const i18n = {i18ns: {'en-us': {base: 'host'}}, reloadI18nR() {}};
    host.applyTranslations(i18n);
    await host.init({settings: {}, runtime: {}});
    assert.deepStrictEqual(await host.call('probe'), ['independent'], `${stage} failure must remove provider and transitive hooks`);
    assert.deepStrictEqual(await host.call('configured'), [], 'remove dependent entries even from a completed earlier phase');
    assert.deepStrictEqual(await host.call('late'), [], 'remove partial init entries');
    assert.deepStrictEqual([...host.services.keys()], ['independent']);
    assert.deepStrictEqual(i18n.i18ns['en-us'], {base: 'host', independent: 'independent'}, 'failed translations must not remain in the host dictionary');
    assert.ok(host.plugins.filter(plugin => plugin.manifest.name !== 'independent').every(plugin => plugin.failed));
    if (stage !== 'init') {
      assert.deepStrictEqual(host.entities.map(entity => entity.name), ['independent'], 'remove failed entities before creating the database connection');
    } else {
      assert.deepStrictEqual(host.entities, registeredEntities, 'init failure must retain connected entity metadata');
    }
    const failedApi = host.makeApi(host.plugins.find(plugin => plugin.manifest.name === 'provider'), {});
    assert.throws(() => failedApi.hook('late-task', () => {}), /unavailable/, 'late tasks cannot re-register a failed plugin');
    assert.strictEqual(failedApi.get('provider'), undefined);
    const healthyApi = host.makeApi(host.plugins.find(plugin => plugin.manifest.name === 'independent'), {});
    assert.throws(() => healthyApi.registerEntity({name: 'too-late'}), /before database connection/);
  } finally {
    assert.strictEqual(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.promises.rm(root, {recursive: true, force: true});
  }
}

async function verifyStartupReadiness(serverSource, emptyHost) {
  // Execute the actual CoffeeScript startup tail with controlled listeners.
  // This detects the previous behavior: listeners opened before slow init.
  const listenStart = serverSource.indexOf('  log.info("Starting server.")');
  const directoryStart = serverSource.indexOf('  mkdirList = [');
  const start = Math.min(listenStart, directoryStart);
  const end = serverSource.indexOf('\n  return\n\n# 获取可用内存', start);
  assert.ok(start >= 0 && end > start);
  const code = coffee.compile(`startup = ->\n${serverSource.slice(start, end)}\nstartup()`, {bare: true});
  for (const withNeos of [false, true]) {
    let entered;
    let release;
    const initialized = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const listeners = [];
    const context = {
      log, dataManager: undefined, ROOM_all: [], roomlist: null,
      settings: {port: 7911, modules: {
        stop: false, http: {port: 7922, ssl: {enabled: withNeos, port: 7923, cert: 'cert', key: 'key'}},
        neos: {enabled: withNeos, port: 7977}, tournament_mode: {deck_path: 'deck', replay_path: 'replay', log_save_path: 'logs'}, deck_log: {local: 'decks'}
      }},
      netRequestHandler() {}, httpRequestListener() {}, neosRequestListener() {},
      createDirectoryIfNotExists: async () => {},
      net: {createServer() { return {listen() { listeners.push('tcp'); }}; }},
      http: {createServer() { return {listen() { listeners.push('http'); }}; }},
      fs: {promises: {readFile: async () => Buffer.from('test certificate')}},
      require(name) {
        if (name === 'https') return {createServer() { return {listen(port) { listeners.push(port === 7977 ? 'neos' : 'https'); }}; }};
        if (name === 'ws') return {WebSocketServer: class { on() {} }};
        throw new Error(`Unexpected module ${name}`);
      },
      pluginHost: {async init(api) { entered(); await gate; await emptyHost.init(api); }}
    };
    const startup = vm.runInNewContext(code, context);
    await initialized;
    assert.deepStrictEqual(listeners, [], 'TCP, HTTP and Neos must not listen during plugin initialization');
    release();
    await startup;
    assert.deepStrictEqual(listeners, withNeos ? ['tcp', 'https', 'http', 'neos'] : ['tcp', 'http'], 'base listeners must still start with no plugins');
  }
}

(async () => {
  const emptyRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'srvpro-empty-plugins-'));
  const emptyHost = new PluginHost(emptyRoot, log);
  await emptyHost.register({settings: {}, runtime: {}});
  await emptyHost.init({settings: {}, runtime: {}});
  assert.deepStrictEqual(await emptyHost.call('anything'), []);
  assert.deepStrictEqual(emptyHost.entities, []);
  emptyHost.registerTranslations('test-plugin', {'en-us': {plugin_message: 'Hello'}});
  const i18n = {i18ns: {'en-us': {host_message: 'Host'}}, reloads: 0, reloadI18nR() { this.reloads++; }};
  emptyHost.applyTranslations(i18n);
  assert.strictEqual(i18n.i18ns['en-us'].plugin_message, 'Hello');
  assert.strictEqual(i18n.reloads, 1);
  assert.throws(() => emptyHost.registerTranslations('other-plugin', {'en-us': {plugin_message: 'Conflict'}}), /already registered/);

  const conflictHost = new PluginHost(emptyRoot, log);
  conflictHost.registerTranslations('test-plugin', {'en-us': {host_message: 'Conflict'}});
  assert.throws(() => conflictHost.applyTranslations(i18n), /conflicts with the host registry/);

  const mixedRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'srvpro-mixed-plugins-'));
  const good = path.join(mixedRoot, 'good');
  const broken = path.join(mixedRoot, 'broken');
  await fs.promises.mkdir(good);
  await fs.promises.mkdir(broken);
  await fs.promises.writeFile(path.join(good, 'plugin.json'), JSON.stringify({name: 'good', main: 'index.js', dependencies: []}));
  await fs.promises.writeFile(path.join(good, 'index.js'), "module.exports.register=api=>api.hook('ping',()=> 'pong');\n");
  await fs.promises.writeFile(path.join(broken, 'plugin.json'), JSON.stringify({name: 'broken', main: 'index.js', dependencies: []}));
  await fs.promises.writeFile(path.join(broken, 'index.js'), 'module.exports = {};\n');
  await fs.promises.writeFile(path.join(broken, 'config.default.json'), '{ invalid json');
  const mixedHost = new PluginHost(mixedRoot, log);
  await mixedHost.register({settings: {}, runtime: {}});
  assert.deepStrictEqual(await mixedHost.call('ping'), ['pong'], 'one broken plugin must not disable an independent plugin');

  const replayRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'srvpro-base-replay-'));
  await fs.promises.writeFile(path.join(replayRoot, 'orphan.yrp'), Buffer.from([1]));
  let replayService;
  let replayHandler;
  require('../public-replay-web').init({
    dataManager: {getRepository() { return {createQueryBuilder() { return {
      leftJoinAndSelect() { return this; }, where() { return this; }, async getMany() { return []; }
    }; }}; }},
    settings: {modules: {tournament_mode: {replay_path: replayRoot}}},
    config: {listEndpoint: '/api/public/replays', downloadPrefix: '/api/public/replay/', defaultPageSize: 20, maxPageSize: 100},
    provide(name, value) { if (name === 'publicReplayWeb') replayService = value; },
    hook(name, handler) { if (name === 'http_request') replayHandler = handler; },
    log
  });
  assert.ok(replayService && replayHandler, 'the base replay plugin must initialize without ladder services');
  const replayResponse = {writeHead(status) { this.status = status; }, end(body) { this.body = body; }};
  assert.strictEqual(await replayHandler({method: 'GET'}, replayResponse, {pathname: '/api/public/replays', query: {}}), true);
  assert.strictEqual(JSON.parse(replayResponse.body).replays[0].name, 'orphan.yrp');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../public-replay-web/plugin.json'), 'utf8')).dependencies, []);

  const serverSource = (await fs.promises.readFile(path.resolve(__dirname, '../../ygopro-server.coffee'), 'utf8')).replace(/\r\n/g, '\n');
  await verifyFailureIsolation('configure');
  await verifyFailureIsolation('register');
  await verifyFailureIsolation('init');
  await verifyStartupReadiness(serverSource, emptyHost);
  assert.match(serverSource, /duel_players = \(for player in room\.dueling_players when player\s/,
    'the generic duel_result event must include every valid playing position');
  assert.doesNotMatch(serverSource, /duel_players = \(for player in room\.dueling_players when player and player\.pos < 2/,
    'the host must not impose ladder two-player semantics');
  assert.ok(serverSource.includes('@policy_overrides = {}'));
  assert.ok(!serverSource.includes('@plugin_hide_names'));
  assert.ok(!serverSource.includes('@plugin_no_early_surrender'));

  await fs.promises.rm(emptyRoot, {recursive: true, force: true});
  await fs.promises.rm(mixedRoot, {recursive: true, force: true});
  await fs.promises.rm(replayRoot, {recursive: true, force: true});
  console.log('plugin host tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
