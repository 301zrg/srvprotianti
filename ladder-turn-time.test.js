'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const {EventEmitter} = require('events');
const {PassThrough} = require('stream');
const coffee = require('coffeescript');
const {PluginHost} = require('./plugin-system');
const ladderPlugin = require('./plugins/ladder-core');
const defaults = require('./plugins/ladder-core/config.default.json');
const {createLiveTurnTimeConfig} = require('./plugins/ladder-core/turn-time');

const source = fs.readFileSync(path.join(__dirname, 'ygopro-server.coffee'), 'utf8').replace(/\r\n/g, '\n');
function extract(start, end) {
  const offset = source.indexOf(start);
  const until = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && until > offset, `Missing server section ${start}`);
  return source.slice(offset, until);
}
// Exercise the real matchmaking, constructor and process arguments without
// opening listeners, accessing a database or launching a duel engine.
const serverCode = coffee.compile([
  extract('ROOM_find_or_create_random =', '\nROOM_find_or_create_ai ='),
  extract('class Room\n', '\n  delete: ->'),
  'global.Room = Room\n'
].join('\n'), {bare: true});

function createServer(rootDir, log, {plugin = true, enabled = true, config = defaults} = {}) {
  const host = new PluginHost(rootDir, log);
  const spawned = [];
  const settings = {hostinfo: {
    lflist: 0, rule: 0, mode: 0, duel_rule: 5, no_check_deck: false,
    no_shuffle_deck: false, start_lp: 8000, start_hand: 5, draw_count: 1, time_limit: 180
  }, modules: {
    mysql: {enabled}, max_mem_percentage: 100,
    random_duel: {default_type: 'S', no_rematch_check: true, blank_pass_modes: {}, extra_modes: {}},
    tournament_mode: {enabled: false}, http: {websocket_roomlist: false}
  }};
  if (plugin) ladderPlugin.register({
    rootDir, log, settings, config, registerEntity() {}, registerTranslations() {},
    hook: (name, handler) => host.registerHook('ladder-core', name, handler)
  });
  const context = {
    settings, _: require('underscore'), ROOM_all: [], ROOM_players_oppentlist: {},
    memory_usage: 0, rooms_count: 0, lflists: [], extra_mode_list: [], log,
    DuelFinalization: class {}, ygopro: {constants: {DUEL_STAGE: {BEGIN: 0, DUELING: 1}}},
    dataManager: {getRandomDuelBan: async () => null},
    plugin_call: (name, ...args) => host.call(name, ...args),
    rawSpawn(args) {
      spawned.push(Array.from(args));
      const process = new EventEmitter();
      Object.assign(process, {pid: spawned.length, stdout: new PassThrough(), stderr: new PassThrough()});
      return process;
    }
  };
  context.global = context;
  vm.runInNewContext(serverCode, context);
  context.Room.prototype.get_playing_player = function () { return this.players; };
  context.Room.prototype.get_host = function () { return this.players[0] || null; };
  return {host, context, settings, spawned,
    match: (type = 'TT', ip = '198.51.100.1') => context.ROOM_find_or_create_random(type, ip)};
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-turn-time-'));
  const warnings = [];
  const log = {info() {}, warn(fields, message) { warnings.push({fields, message}); }};
  const localFile = path.join(root, 'config.json');
  const defaultFile = path.join(root, 'config.default.json');
  const writeLocal = value => fs.writeFileSync(localFile, JSON.stringify(value));
  try {
    assert.strictEqual(defaults.turnTimeLimitSeconds, 300);
    const read = createLiveTurnTimeConfig(root, undefined, log);
    assert.strictEqual(await read(), 300, 'old installations without this field use the built-in default');
    fs.writeFileSync(defaultFile, JSON.stringify({turnTimeLimitSeconds: 400}));
    assert.strictEqual(await read(), 400);
    writeLocal({turnTimeLimitSeconds: 450});
    assert.strictEqual(await read(), 450, 'local values override file defaults without a restart');
    for (const invalid of [0, -1, 1.5, 65536, '450', true, null, [], {}]) {
      writeLocal({turnTimeLimitSeconds: invalid});
      assert.strictEqual(await read(), 450, `invalid value ${JSON.stringify(invalid)} preserves the last good value`);
    }
    for (const invalidDocument of ['null', '[]', '{"secret":"do not log this",']) {
      fs.writeFileSync(localFile, invalidDocument);
      assert.strictEqual(await read(), 450, 'invalid documents do not disrupt room creation');
    }
    assert.ok(!JSON.stringify(warnings).includes('do not log this'), 'warnings must not expose configuration contents');
    assert.strictEqual(await createLiveTurnTimeConfig(root, 'invalid', log)(), 300, 'invalid startup values use 300');
    assert.strictEqual(await createLiveTurnTimeConfig(root, 700, log)(), 700, 'a valid startup value survives a failed reload');
    for (const value of [1, 65535]) {
      writeLocal({turnTimeLimitSeconds: value});
      assert.strictEqual(await read(), value, 'both uint16 protocol boundaries are supported');
    }
    writeLocal({countAfkPenalty: false});
    assert.strictEqual(await read(), 400, 'removing just the override restores the file default');
    fs.unlinkSync(localFile);
    assert.strictEqual(await read(), 400);
    fs.unlinkSync(defaultFile);
    assert.strictEqual(await read(), 300, 'missing default files restore the built-in value');
    fs.writeFileSync(defaultFile, JSON.stringify(defaults));

    const server = createServer(root, log);
    const first = await server.match();
    assert.strictEqual(first.hostinfo.time_limit, 300);
    assert.strictEqual(first.hostinfo.mode, 1, 'TT remains a match room');
    assert.strictEqual(server.spawned[0][10], 300, 'the engine receives the configured value at creation');
    assert.strictEqual(server.settings.hostinfo.time_limit, 180, 'TT does not mutate the shared host defaults');
    first.players.push({ip: '198.51.100.1'});
    writeLocal({turnTimeLimitSeconds: 450});
    assert.strictEqual(await server.match('TT', '198.51.100.2'), first, 'joining an existing waiting room reuses it');
    assert.strictEqual(first.hostinfo.time_limit, 300, 'waiting rooms retain their original time');
    assert.strictEqual(server.spawned.length, 1);
    first.duel_stage = 1;
    const second = await server.match();
    assert.strictEqual(second.hostinfo.time_limit, 450);
    assert.strictEqual(server.spawned[1][10], 450, 'new rooms receive hot edits before the process starts');
    assert.strictEqual(first.hostinfo.time_limit, 300, 'ongoing rooms retain the setting across the match');
    fs.writeFileSync(localFile, '{');
    assert.strictEqual((await server.match()).hostinfo.time_limit, 450, 'bad JSON retains the last valid TT setting');
    fs.unlinkSync(localFile);
    assert.strictEqual((await server.match()).hostinfo.time_limit, 300, 'deleting the override affects the next room');
    assert.strictEqual((await server.match('S')).hostinfo.time_limit, 180, 'other random modes keep their default');
    assert.strictEqual(new server.context.Room('ordinary').hostinfo.time_limit, 180, 'custom rooms keep their default');
    server.settings.modules.random_duel.default_type = 'TT';
    assert.strictEqual((await server.match('')).hostinfo.time_limit, 300, 'blank requests use the effective default mode');

    const noPlugin = createServer(root, log, {plugin: false});
    assert.strictEqual((await noPlugin.match('S')).hostinfo.time_limit, 180);
    noPlugin.host.registerHook('bad-policy', 'random_room_time_limit', async () => { throw new Error('Unavailable'); });
    assert.strictEqual((await noPlugin.match('S')).hostinfo.time_limit, 180, 'hook errors preserve host behavior');
    for (const invalid of [0, 65536, '500', 1.5, null]) {
      const invalidHook = createServer(root, log, {plugin: false});
      invalidHook.host.registerHook('bad-policy', 'random_room_time_limit', () => invalid);
      assert.strictEqual((await invalidHook.match('S')).hostinfo.time_limit, 180, 'the host validates hook results');
    }
    const orderedHooks = createServer(root, log, {plugin: false});
    for (const value of [null, 0, 420, 600]) {
      orderedHooks.host.registerHook('policy', 'random_room_time_limit', () => value);
    }
    assert.strictEqual((await orderedHooks.match('S')).hostinfo.time_limit, 420, 'the first valid result wins');
    const disabled = createServer(root, log, {enabled: false});
    assert.strictEqual((await disabled.match('S')).hostinfo.time_limit, 180, 'disabled ladder plugins cannot change timings');

    const concurrent = createServer(root, log);
    const rooms = await Promise.all(['198.51.100.3', '198.51.100.4'].map(ip =>
      concurrent.match('TT', ip).then(room => { room.players.push({ip}); return room; })));
    assert.strictEqual(rooms[0], rooms[1], 'async reload must not split simultaneous players into separate waiting rooms');
    assert.strictEqual(concurrent.spawned.length, 1);
    console.log('ladder turn time tests passed');
  } finally {
    // Delete only the dedicated temporary fixture created above.
    fs.rmSync(root, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
