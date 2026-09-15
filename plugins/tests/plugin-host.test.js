'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {PluginHost} = require('../../plugin-system');

const log = {info() {}, warn() {}};

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

  const serverSource = await fs.promises.readFile(path.resolve(__dirname, '../../ygopro-server.coffee'), 'utf8');
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
