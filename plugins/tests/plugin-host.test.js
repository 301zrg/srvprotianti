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

  await fs.promises.rm(emptyRoot, {recursive: true, force: true});
  await fs.promises.rm(mixedRoot, {recursive: true, force: true});
  console.log('plugin host tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
