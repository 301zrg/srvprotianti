'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const coffee = require('coffeescript');
const moment = require('moment');
const {PluginHost} = require('./plugin-system');
const lifecycle = require('./room-lifecycle');
const ladderPlugin = require('./plugins/ladder-core');
const {createLiveAfkPenaltyConfig} = require('./plugins/ladder-core/afk-policy');
const ygopro = require('./ygopro');

const source = fs.readFileSync(path.join(__dirname, 'ygopro-server.coffee'), 'utf8').replace(/\r\n/g, '\n');
function extract(start, end) {
  const offset = source.indexOf(start);
  const until = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && until > offset, `Missing server section ${start}`);
  return source.slice(offset, until);
}

// Run the real timeout, warning and close paths without starting a game server.
const serverCode = coffee.compile([
  extract('ROOM_random_penalty_message =', '\nROOM_find_or_create_ai ='),
  extract('ROOM_unwelcome =', '\nCLIENT_kick ='),
  extract('CLIENT_kick =', '\nCLIENT_finish_connection ='),
  extract('CLIENT_send_replays_and_kick =', '\nROOM_try_persist_replay ='),
  'ProbeRoom = class\n' + extract('  disconnect: (client, error)->', '\n  start_death:') + '\nglobal.ProbeRoom = ProbeRoom\n',
  extract('  if settings.modules.random_duel.enabled\n    setInterval', '\n  # A random room')
    .split('\n').map(line => line.startsWith('  ') ? line.slice(2) : line).join('\n')
].join('\n'), {bare: true});

function createServer(host) {
  const penalties = [];
  const chats = [];
  const historyUpdates = [];
  let history;
  let tick;
  let closing = [];
  const settings = {hostinfo: {time_limit: 180}, modules: {
    random_duel: {enabled: true, hang_timeout: 90, record_match_scores: false, default_type: 'S', extra_modes: {}, blank_pass_modes: {}},
    mysql: {enabled: true}, max_mem_percentage: 100,
    reconnect: {enabled: true}, http: {websocket_roomlist: false}, side_timeout: false
  }};
  const context = {
    settings, _: require('underscore'), ROOM_all: [], moment, moment_now: moment(),
    memory_usage: 0, rooms_count: 0, ROOM_players_oppentlist: {},
    Room: class { constructor(name) { this.name = name; } },
    dataManager: {
      getRandomDuelBan: async () => history,
      updateRandomDuelBan: async record => historyUpdates.push(record)
    },
    plugin_call: (name, ...args) => host.call(name, ...args),
    ROOM_ban_player: async (name, ip, reason) => penalties.push({name, reason}),
    CLIENT_send_replays: async () => false,
    CLIENT_reconnect_unregister: () => false,
    SERVER_kick: () => true,
    ygopro: {...ygopro, constants: {DUEL_STAGE: {BEGIN: 0, SIDING: 4}, COLORS: {}},
      stoc_send_chat: (player, message) => chats.push({player, message}), stoc_send_chat_to_room() {}},
    setInterval: callback => { tick = callback; }
  };
  context.global = context;
  vm.runInNewContext(serverCode, context);
  return {
    penalties, chats, settings, historyUpdates,
    async match(type, record) {
      history = record;
      historyUpdates.length = 0;
      return context.ROOM_find_or_create_random(type, '198.51.100.1');
    },
    async tick() {
      await tick();
      await new Promise(resolve => setImmediate(resolve));
      await Promise.all(closing);
    },
    room(type = 'TT', seconds = 90) {
      penalties.length = 0;
      chats.length = 0;
      closing = [];
      const room = new context.ProbeRoom();
      const afk = {name: 'AFK', name_vpass: 'AFK', ip: '198.51.100.1', pos: 0, server: {}};
      const opponent = {name: 'Opponent', name_vpass: 'Opponent', ip: '198.51.100.2', pos: 1, server: {}};
      Object.assign(room, {
        players: [afk, opponent], scores: {AFK: 0, Opponent: 0}, hostinfo: {mode: 1},
        random_type: type, duel_stage: 1, policy_overrides: {},
        last_active_time: context.moment_now.clone().subtract(seconds, 'seconds').format(), waiting_for_player: afk,
        get_disconnected_count: () => 0,
        refreshLastActiveTime() { this.last_active_time = context.moment_now.format(); },
        getMaskedPlayerName: player => player.name
      });
      for (const client of room.players) {
        client.destroy = () => {
          client.isClosed = true;
          const rejected = lifecycle.reconnectRegistrationRejection({
            enabled: true, room, client, isPlayer: true, beginStage: 0, disconnectedCount: 0
          });
          if (rejected) closing.push(room.disconnect(client));
        };
      }
      context.ROOM_all[0] = room;
      return {room, afk, opponent};
    }
  };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-afk-policy-'));
  try {
    const localFile = path.join(root, 'config.json');
    const defaultFile = path.join(root, 'config.default.json');
    const warnings = [];
    const log = {info() {}, warn(...args) { warnings.push(args); }};
    const writeLocal = value => fs.writeFileSync(localFile, JSON.stringify(value));
    const read = createLiveAfkPenaltyConfig(root, false, log);
    assert.strictEqual(await read(), false, 'missing config must default to no AFK penalty');
    writeLocal({countAfkPenalty: true});
    assert.strictEqual(await read(), true);
    for (const value of ['false', null, 0, {}, []]) {
      writeLocal({countAfkPenalty: value});
      assert.strictEqual(await read(), true, 'invalid types must retain the last valid value');
    }
    fs.writeFileSync(localFile, '{unfinished');
    assert.strictEqual(await read(), true, 'partial writes must retain the last valid value');
    fs.writeFileSync(localFile, '[]');
    assert.strictEqual(await read(), true, 'config must be an object');
    assert.strictEqual(warnings.length, 7);
    fs.writeFileSync(defaultFile, JSON.stringify({countAfkPenalty: true}));
    writeLocal({countAfkPenalty: false});
    assert.strictEqual(await read(), false, 'local overrides must take precedence');
    fs.unlinkSync(localFile);
    assert.strictEqual(await read(), true, 'removing an override must restore file defaults');
    fs.writeFileSync(defaultFile, '{}');
    assert.strictEqual(await read(), false, 'omitting the field must restore false');
    assert.strictEqual(await createLiveAfkPenaltyConfig(root, 'invalid', log)(), false,
      'invalid startup settings must not enable penalties');

    const host = new PluginHost(root, log);
    const server = createServer(host);
    const services = new Map();
    const api = {
      rootDir: root, config: {...require('./plugins/ladder-core/config.default.json')},
      settings: {modules: {mysql: {enabled: true}, reconnect: {enabled: true}}},
      dataManager: {}, log,
      hook: (name, handler) => host.registerHook('ladder-core', name, handler),
      registerEntity() {}, registerTranslations() {},
      provide: (name, service) => services.set(name, service), get: name => services.get(name)
    };
    ladderPlugin.register(api);
    ladderPlugin.init(api);
    services.get('ladderCore').authenticate = async () => true;

    let scenario = server.room();
    await server.tick();
    assert.deepStrictEqual(server.penalties, [], 'TT default-off must waive AFK and duplicate flee penalties');
    assert.strictEqual(scenario.afk.system_kicked, true, 'waiving the penalty must still kick the AFK player');
    assert.strictEqual(scenario.room.scores.AFK, -9, 'waiving the penalty must keep the losing scoreboard');
    assert.strictEqual(scenario.room.explicit_forfeit, true, 'AFK kicks must retain terminal evidence for settlement');

    scenario = server.room('TT', 70);
    await host.call('before_join_room', {name: 'Joining', vpass: 'test'}, scenario.room);
    await server.tick();
    assert.strictEqual(scenario.opponent.flee_free, true);
    assert.strictEqual(server.penalties.length, 0, 'the warning must not count AFK penalties');
    const ladderChat = server.chats.find(chat => chat.player === scenario.opponent).message;
    assert.ok(ladderChat.includes('${ladder_opponent_leave_tip_suffix}'));
    for (const messages of Object.values(require('./plugins/ladder-core/i18n.json'))) {
      assert.ok(messages.ladder_opponent_leave_tip_suffix, 'each supported language must have a ladder warning');
    }
    assert.match(require('./plugins/ladder-core/i18n.json')['zh-cn'].ladder_opponent_leave_tip_suffix, /不视为强退.*仍可能扣除天梯积分/);

    writeLocal({countAfkPenalty: true});
    scenario.room.last_active_time = moment(scenario.room.last_active_time).subtract(20, 'seconds').format();
    await server.tick();
    assert.strictEqual(server.penalties.length, 1, 'hot enable must apply to an existing game and count once');
    assert.strictEqual(server.penalties[0].reason, '${random_ban_reason_AFK}');
    scenario = server.room('TT', 70);
    await server.tick();
    writeLocal({countAfkPenalty: false});
    scenario.room.last_active_time = moment(scenario.room.last_active_time).subtract(20, 'seconds').format();
    await server.tick();
    assert.strictEqual(server.penalties.length, 0, 'hot disable must apply to an existing game without recreating the plugin');
    fs.writeFileSync(localFile, '{unfinished');
    scenario = server.room();
    await server.tick();
    assert.strictEqual(server.penalties.length, 0, 'invalid hot edits must not re-enable penalties');
    fs.unlinkSync(localFile);

    scenario = server.room('M', 70);
    await host.call('before_join_room', {name: 'Joining', vpass: 'test'}, scenario.room);
    await server.tick();
    assert.ok(server.chats.find(chat => chat.player === scenario.opponent).message.includes('${unwelcome_tip_part2}'),
      'ordinary rooms must keep the original warning');
    scenario = server.room('M');
    await server.tick();
    assert.strictEqual(server.penalties.length, 1, 'non-ladder AFK kicks must still count once');
    assert.strictEqual(server.penalties[0].reason, '${random_ban_reason_AFK}');

    scenario = server.room();
    await scenario.room.disconnect(scenario.afk);
    assert.strictEqual(server.penalties.length, 0, 'disabled TT departure penalties must also exempt voluntary departures');
    assert.strictEqual(scenario.room.scores.AFK, -9, 'voluntary departures must still lose');
    assert.strictEqual(scenario.room.explicit_forfeit, true);
    writeLocal({countAfkPenalty: true});
    scenario = server.room();
    await scenario.room.disconnect(scenario.afk);
    assert.strictEqual(server.penalties.length, 1, 'hot enable must restore TT flee counting');
    assert.strictEqual(server.penalties[0].reason, '${random_ban_reason_flee}');
    writeLocal({countAfkPenalty: false});
    scenario = server.room('M');
    await scenario.room.disconnect(scenario.afk);
    assert.strictEqual(server.penalties[0].reason, '${random_ban_reason_flee}', 'ordinary flee penalties must remain enabled');

    function legacyRecord(count, reasons = ['${random_ban_reason_AFK}', '${random_ban_reason_flee}']) {
      return {count, reasons, time: moment().add(1, 'hour').toDate(), needTip: 1,
        getNeedTip() { return this.needTip === 1; }, setNeedTip(value) { this.needTip = value ? 1 : 0; }};
    }
    for (const count of [1, 4, 9]) {
      const record = legacyRecord(count);
      const result = await server.match('TT', record);
      assert.ok(!result.error, 'disabled TT penalties must suppress old departure warnings, restrictions and bans');
      assert.ok(!result.deprecated, 'ignored history must not place the player in the restricted pool');
      assert.strictEqual(record.needTip, 1, 'ignored history must not be changed');
      assert.strictEqual(server.historyUpdates.length, 0);
    }
    const oldBan = legacyRecord(9);
    assert.ok((await server.match('M', oldBan)).error, 'ordinary matchmaking must keep enforcing the same legacy record');
    server.settings.modules.random_duel.default_type = 'TT';
    assert.ok(!(await server.match('', oldBan)).error, 'blank input using the default ladder mode must also waive old departure history');
    server.settings.modules.random_duel.default_type = 'S';
    writeLocal({countAfkPenalty: true});
    assert.ok((await server.match('TT', oldBan)).error, 'hot enable must restore history enforcement without deleting records');
    writeLocal({countAfkPenalty: false});
    const mixed = legacyRecord(9, ['${random_ban_reason_flee}', '${random_ban_reason_abuse}']);
    const mixedResult = await server.match('TT', mixed);
    assert.ok(mixedResult.error.includes(ygopro.i18ns['zh-cn'].random_ban_reason_abuse), 'other recorded violations must remain enforced');
    assert.ok(!mixedResult.error.includes(ygopro.i18ns['zh-cn'].random_ban_reason_flee), 'exempt reasons must not appear in the penalty notice');
    assert.deepStrictEqual(mixed.reasons, ['${random_ban_reason_flee}', '${random_ban_reason_abuse}'], 'filtered notices must not rewrite stored reasons');
    for (const count of [1, 4]) {
      const record = legacyRecord(count, ['${random_ban_reason_AFK}', '${random_ban_reason_abuse}']);
      const result = await server.match('TT', record);
      assert.ok(result.error.includes(ygopro.i18ns['zh-cn'].random_ban_reason_abuse) &&
        !result.error.includes(ygopro.i18ns['zh-cn'].random_ban_reason_AFK));
      assert.deepStrictEqual(server.historyUpdates[0].reasons, record.reasons, 'needTip writes must preserve the complete history');
    }
    assert.ok((await server.match('TT', legacyRecord(9, []))).error, 'unknown reasons must not be guessed or cleared');
    const noPlugins = createServer(new PluginHost(root, log));
    noPlugins.room('M');
    await noPlugins.tick();
    assert.strictEqual(noPlugins.penalties.length, 1, 'the host must count AFK penalties without any plugins');
    assert.ok((await noPlugins.match('M', legacyRecord(9))).error, 'legacy bans must remain enforced with no plugins');
    host.registerHook('broken', 'random_duel_afk_penalty', () => { throw new Error('failed'); });
    server.room('M');
    await server.tick();
    assert.strictEqual(server.penalties.length, 1, 'a failed plugin hook must not waive ordinary penalties');
    api.config.mode = 'CUSTOM';
    server.room('CUSTOM');
    await server.tick();
    assert.strictEqual(server.penalties.length, 0, 'the configured ladder mode must own its policy without a host TT check');
    server.room('TT');
    await server.tick();
    assert.strictEqual(server.penalties.length, 1, 'the old mode must no longer receive the ladder exemption');
  } finally {
    assert.strictEqual(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('srvpro-afk-policy-'));
    fs.rmSync(root, {recursive: true, force: true});
  }
  console.log('random duel AFK tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
