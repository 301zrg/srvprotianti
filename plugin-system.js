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
    this.serviceOwners = new Map();
    this.plugins = [];
    this.entities = [];
    this.entityOwners = new Map();
    this.entitiesLocked = false;
    this.translations = new Map();
    this.appliedTranslations = [];
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
    return (plugin.manifest.dependencies || []).some(name => {
      const dependency = this.plugins.find(item => item.manifest.name === name);
      return !dependency || dependency.failed;
    });
  }

  ownerFailed(owner) {
    return this.plugins.some(plugin => plugin.manifest.name === owner && plugin.failed);
  }

  assertOwnerAvailable(owner) {
    if (this.ownerFailed(owner)) throw new Error(`Plugin ${owner} is unavailable.`);
  }

  lockEntities() {
    // TypeORM consumes these registrations when creating its connection.
    // Later plugin failures must never remove connected metadata or tables.
    this.entitiesLocked = true;
  }

  registerEntity(owner, entity) {
    this.assertOwnerAvailable(owner);
    if (this.entitiesLocked) throw new Error('Plugin entities must be registered before database connection.');
    if (this.entityOwners.has(entity)) throw new Error('Plugin entity is already registered.');
    this.entityOwners.set(entity, owner);
    this.entities.push(entity);
  }

  removeRegistrations(owner) {
    for (const [name, handlers] of this.hooks) {
      const remaining = handlers.filter(item => item.owner !== owner);
      if (remaining.length) this.hooks.set(name, remaining);
      else this.hooks.delete(name);
    }
    for (const [name, provider] of this.serviceOwners) {
      if (provider !== owner) continue;
      this.services.delete(name);
      this.serviceOwners.delete(name);
    }
    if (!this.entitiesLocked) {
      this.entities = this.entities.filter(entity => this.entityOwners.get(entity) !== owner);
      for (const [entity, provider] of this.entityOwners) {
        if (provider === owner) this.entityOwners.delete(entity);
      }
    }
    for (const [language, messages] of this.translations) {
      for (const [key, registration] of messages) {
        if (registration.owner === owner) messages.delete(key);
      }
      if (!messages.size) this.translations.delete(language);
    }
    const changedRegistries = new Set();
    this.appliedTranslations = this.appliedTranslations.filter(registration => {
      if (registration.owner !== owner) return true;
      const {i18n, language, key, value} = registration;
      if (i18n.i18ns[language]?.[key] === value) {
        delete i18n.i18ns[language][key];
        changedRegistries.add(i18n);
      }
      return false;
    });
    for (const i18n of changedRegistries) i18n.reloadI18nR();
  }

  failPlugin(plugin, error, stage) {
    plugin.failed = true;
    this.removeRegistrations(plugin.manifest.name);
    this.log.warn({err: error, plugin: plugin.manifest.name}, `Plugin ${stage} failed`);
    // A dependant may already have registered during an earlier lifecycle
    // phase. Remove its entries too, not just skip its next phase.
    let changed;
    do {
      changed = false;
      for (const dependent of this.plugins) {
        if (dependent.failed || !this.hasFailedDependency(dependent)) continue;
        dependent.failed = true;
        this.removeRegistrations(dependent.manifest.name);
        this.log.warn({plugin: dependent.manifest.name}, 'Plugin disabled because a dependency failed');
        changed = true;
      }
    } while (changed);
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
      registerEntity: entity => this.registerEntity(owner, entity),
      registerTranslations: translations => this.registerTranslations(owner, translations),
      provide: (name, value) => this.provideService(owner, name, value),
      get: name => this.ownerFailed(this.serviceOwners.get(name)) ? undefined : this.services.get(name)
    });
  }

  registerHook(owner, name, handler, priority) {
    this.assertOwnerAvailable(owner);
    if (typeof handler !== 'function') throw new TypeError(`Hook ${name} from ${owner} is not a function.`);
    const handlers = this.hooks.get(name) || [];
    handlers.push({owner, handler, priority: Number(priority) || 0});
    handlers.sort((a, b) => b.priority - a.priority);
    this.hooks.set(name, handlers);
  }

  registerTranslations(owner, translations) {
    this.assertOwnerAvailable(owner);
    if (!translations || typeof translations !== 'object' || Array.isArray(translations)) {
      throw new TypeError(`Translations from ${owner} must be an object keyed by language.`);
    }
    for (const [language, messages] of Object.entries(translations)) {
      if (!messages || typeof messages !== 'object' || Array.isArray(messages)) {
        throw new TypeError(`Translations for ${language} from ${owner} must be an object.`);
      }
      const registered = this.translations.get(language) || new Map();
      for (const [key, value] of Object.entries(messages)) {
        if (typeof value !== 'string') throw new TypeError(`Translation ${language}.${key} from ${owner} must be a string.`);
        if (registered.has(key)) throw new Error(`Translation ${language}.${key} is already registered by ${registered.get(key).owner}.`);
        registered.set(key, {owner, value});
      }
      this.translations.set(language, registered);
    }
  }

  applyTranslations(i18n) {
    if (!i18n?.i18ns || typeof i18n.reloadI18nR !== 'function') {
      throw new TypeError('A YGOPro i18n registry is required to apply plugin translations.');
    }
    // Validate the complete batch before changing the shared host dictionary.
    for (const [language, messages] of this.translations) {
      if (!i18n.i18ns[language]) throw new Error(`Plugin translations target unknown language ${language}.`);
      for (const [key, registration] of messages) {
        if (Object.prototype.hasOwnProperty.call(i18n.i18ns[language], key)) {
          throw new Error(`Translation ${language}.${key} from ${registration.owner} conflicts with the host registry.`);
        }
      }
    }
    for (const [language, messages] of this.translations) {
      for (const [key, registration] of messages) {
        i18n.i18ns[language][key] = registration.value;
        this.appliedTranslations.push({i18n, language, key, ...registration});
      }
    }
    i18n.reloadI18nR();
  }

  provideService(owner, name, value) {
    this.assertOwnerAvailable(owner);
    if (this.services.has(name)) throw new Error(`Service ${name} is already registered.`);
    this.services.set(name, value);
    this.serviceOwners.set(name, owner);
    this.log.info({plugin: owner, service: name}, 'Plugin service registered');
  }

  async register(context) {
    await this.discover();
    for (const plugin of this.plugins) {
      if (plugin.failed) continue;
      try {
        plugin.config = await this.readConfig(plugin);
        plugin.module = require(path.resolve(plugin.dir, plugin.manifest.main));
      } catch (error) {
        this.failPlugin(plugin, error, 'load');
      }
    }
    // Configuration runs before entity registration and database creation.
    for (const plugin of this.plugins) {
      if (plugin.failed || !plugin.module || this.hasFailedDependency(plugin)) continue;
      try {
        if (typeof plugin.module.configure === 'function') await plugin.module.configure(this.makeApi(plugin, context));
      } catch (error) {
        this.failPlugin(plugin, error, 'configuration');
      }
    }
    for (const plugin of this.plugins) {
      if (plugin.failed || !plugin.module || this.hasFailedDependency(plugin)) continue;
      try {
        if (typeof plugin.module.register === 'function') await plugin.module.register(this.makeApi(plugin, context));
      } catch (error) {
        this.failPlugin(plugin, error, 'registration');
      }
    }
  }

  async init(context) {
    this.lockEntities();
    for (const plugin of this.plugins) {
      if (plugin.failed || !plugin.module || this.hasFailedDependency(plugin)) continue;
      try {
        if (typeof plugin.module.init === 'function') await plugin.module.init(this.makeApi(plugin, context));
        this.log.info({plugin: plugin.manifest.name}, 'Plugin loaded');
      } catch (error) {
        this.failPlugin(plugin, error, 'initialization');
      }
    }
  }

  async call(name, ...args) {
    const results = [];
    for (const {owner, handler} of this.hooks.get(name) || []) {
      if (this.ownerFailed(owner)) continue;
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
