'use strict';

const fs = require('fs');
const path = require('path');
const deepmerge = require('deepmerge');

/**
 * Generic plugin host. It deliberately knows nothing about application rules or web
 * pages: the core only discovers manifests and exposes hooks, entities and
 * named services to plugins.
 */
class PluginHost {
  constructor(rootDir, log) {
    this.rootDir = path.resolve(rootDir);
    this.log = log;
    this.hooks = new Map();
    this.services = new Map();
    this.plugins = [];
    this.entities = [];
  }

  async discover() {
    let entries;
    try {
      entries = await fs.promises.readdir(this.rootDir, {withFileTypes: true});
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const discovered = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.rootDir, entry.name);
      const manifestPath = path.join(dir, 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        if (manifest.enabled === false) continue;
        if (!manifest.name || !manifest.main) throw new Error('plugin.json requires both "name" and "main".');
        discovered.push({dir, manifest, module: null, config: {}});
      } catch (error) {
        this.log.warn({err: error, plugin: entry.name}, 'Invalid plugin manifest');
      }
    }
    this.plugins = this.sortByDependencies(discovered);
  }

  sortByDependencies(plugins) {
    const byName = new Map(plugins.map(plugin => [plugin.manifest.name, plugin]));
    const result = [];
    const visiting = new Set();
    const visited = new Set();
    const visit = plugin => {
      const name = plugin.manifest.name;
      if (visited.has(name)) return;
      if (plugin.failed) throw new Error(`Plugin dependency ${name} is unavailable.`);
      if (visiting.has(name)) throw new Error(`Plugin dependency cycle at ${name}.`);
      visiting.add(name);
      for (const dependency of plugin.manifest.dependencies || []) {
        const target = byName.get(dependency);
        if (!target) throw new Error(`Plugin ${name} requires missing plugin ${dependency}.`);
        visit(target);
      }
      visiting.delete(name);
      visited.add(name);
      result.push(plugin);
    };
    for (const plugin of plugins) {
      try {
        visit(plugin);
      } catch (error) {
        plugin.failed = true;
        visiting.clear();
        this.log.warn({err: error, plugin: plugin.manifest.name}, 'Plugin dependency resolution failed');
      }
    }
    return result;
  }

  hasFailedDependency(plugin) {
    return (plugin.manifest.dependencies || []).some(name => this.plugins.find(item => item.manifest.name === name)?.failed);
  }

  async readConfig(plugin) {
    const load = async file => {
      try {
        return JSON.parse(await fs.promises.readFile(path.join(plugin.dir, file), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw new Error(`${plugin.manifest.name}/${file}: ${error.message}`);
      }
    };
    return deepmerge(await load('config.default.json'), await load('config.json'), {
      arrayMerge: (_destination, source) => source
    });
  }

  makeApi(plugin, context) {
    const owner = plugin.manifest.name;
    return Object.freeze({
      ...context,
      name: owner,
      rootDir: plugin.dir,
      config: plugin.config,
      hook: (name, handler, priority = 0) => this.registerHook(owner, name, handler, priority),
      emit: (name, ...args) => this.call(name, ...args),
      registerEntity: entity => this.entities.push(entity),
      provide: (name, value) => this.provideService(owner, name, value),
      get: name => this.services.get(name)
    });
  }

  registerHook(owner, name, handler, priority) {
    if (typeof handler !== 'function') throw new TypeError(`Hook ${name} from ${owner} is not a function.`);
    const handlers = this.hooks.get(name) || [];
    handlers.push({owner, handler, priority: Number(priority) || 0});
    handlers.sort((a, b) => b.priority - a.priority);
    this.hooks.set(name, handlers);
  }

  provideService(owner, name, value) {
    if (this.services.has(name)) throw new Error(`Service ${name} is already registered.`);
    this.services.set(name, value);
    this.log.info({plugin: owner, service: name}, 'Plugin service registered');
  }

  async register(context) {
    await this.discover();
    for (const plugin of this.plugins) {
      try {
        plugin.config = await this.readConfig(plugin);
        plugin.module = require(path.resolve(plugin.dir, plugin.manifest.main));
      } catch (error) {
        plugin.failed = true;
        this.log.warn({err: error, plugin: plugin.manifest.name}, 'Plugin load failed');
      }
    }
    // Configuration runs before entity registration and database creation.
    for (const plugin of this.plugins) {
      if (plugin.failed || !plugin.module || this.hasFailedDependency(plugin)) continue;
      try {
        if (typeof plugin.module.configure === 'function') await plugin.module.configure(this.makeApi(plugin, context));
      } catch (error) {
        plugin.failed = true;
        this.log.warn({err: error, plugin: plugin.manifest.name}, 'Plugin configuration failed');
      }
    }
    for (const plugin of this.plugins) {
      if (plugin.failed || !plugin.module || this.hasFailedDependency(plugin)) continue;
      try {
        if (typeof plugin.module.register === 'function') await plugin.module.register(this.makeApi(plugin, context));
      } catch (error) {
        plugin.failed = true;
        this.log.warn({err: error, plugin: plugin.manifest.name}, 'Plugin registration failed');
      }
    }
  }

  async init(context) {
    for (const plugin of this.plugins) {
      if (plugin.failed || !plugin.module || this.hasFailedDependency(plugin)) continue;
      try {
        if (typeof plugin.module.init === 'function') await plugin.module.init(this.makeApi(plugin, context));
        this.log.info({plugin: plugin.manifest.name}, 'Plugin loaded');
      } catch (error) {
        plugin.failed = true;
        this.log.warn({err: error, plugin: plugin.manifest.name}, 'Plugin initialization failed');
      }
    }
  }

  async call(name, ...args) {
    const results = [];
    for (const {owner, handler} of this.hooks.get(name) || []) {
      try {
        results.push(await handler(...args));
      } catch (error) {
        this.log.warn({err: error, plugin: owner, hook: name}, 'Plugin hook failed');
      }
    }
    return results;
  }
}

module.exports = {PluginHost};
