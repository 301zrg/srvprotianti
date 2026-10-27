'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const coffee = require('coffeescript');
const moment = require('moment');
const {PluginHost} = require('./plugin-system');
const ladderPlugin = require('./plugins/ladder-core');
const ygopro = require('./ygopro');
const translations = require('./plugins/ladder-core/i18n.json');
const languages = ['zh-cn', 'en-us', 'ja-jp', 'ko-kr'];
const combinedMessage = key => languages.map(language => translations[language][key]).join(' / ');

const source = fs.readFileSync(path.join(__dirname, 'ygopro-server.coffee'), 'utf8');
function extract(start, end) {
  const offset = source.indexOf(start);
  const until = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && until > offset, `Missing server section ${start}`);
  return source.slice(offset, until);
}
const code = coffee.compile([
  extract('ROOM_random_penalty_message =', '\nROOM_find_or_create_random ='),
  extract('ROOM_unwelcome =', '\nCLIENT_kick ='),
  'MessageRoom = class\n' + extract('  join_player: (client) ->', '\n  refreshLastActiveTime:') + '\nglobal.MessageRoom = MessageRoom\n',
  extract("ygopro.ctos_follow 'CHAT', true,", '\n  switch cmd[0]') + '\n  return cancel\n'
].join('\n'), {bare: true});

function socket(name, lang) {
  return {name, lang, vpass: 'test-password', packets: [],
    write(buffer, done) { this.packets.push(Buffer.from(buffer)); done(); },
    setTimeout() {}, destroy() { this.destroyed = true; }};
}
function chatMessages(client) {
  const identifier = ygopro.helper.translateProto('CHAT', 'STOC');
  const Chat = ygopro.helper.getProtoClass('CHAT', 'STOC');
  return client.packets.filter(packet => packet[2] === identifier)
    .map(packet => new Chat().fromPayload(packet.subarray(3)).msg);
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-ladder-messages-'));
  const originalYgopro = global.ygopro;
  const originalMomentLocale = moment.locale();
  try {
    const config = require('./plugins/ladder-core/config.default.json');
    fs.writeFileSync(path.join(root, 'config.default.json'), JSON.stringify(config));
    const log = {info() {}, warn() {}};
    const host = new PluginHost(root, log);
    let chatHandler;
    const wire = {...ygopro, i18ns: JSON.parse(JSON.stringify(ygopro.i18ns)), i18nR: {},
      ctos_follow(_name, _synchronous, handler) { chatHandler = handler; }};
    const context = {_: require('underscore'), ygopro: wire, settings: {modules: {}}, ROOM_all: [],
      moment, moment_now: moment('2026-10-10T12:00:00Z'),
      plugin_call: (name, ...args) => host.call(name, ...args)};
    context.global = context;
    vm.runInNewContext(code, context);
    const services = new Map();
    const api = {rootDir: root, config, dataManager: {}, log,
      settings: {modules: {mysql: {enabled: true}, reconnect: {enabled: true}}},
      registerEntity() {}, registerTranslations: messages => host.registerTranslations('ladder-core', messages),
      hook: (name, handler) => host.registerHook('ladder-core', name, handler),
      provide: (name, value) => services.set(name, value), get: name => services.get(name)};
    ladderPlugin.register(api);
    host.applyTranslations(wire);
    global.ygopro = wire;
    ladderPlugin.init(api);
    const service = services.get('ladderCore');
    service.authenticate = async () => true;
    service.getMonthlyProfile = async () => ({points: 1000, wins: 0, losses: 0, currentWinStreak: 0});

    // Every supported core dictionary covers the same keys; no fallback can hide
    // a missing translation in refresh, replay, compatibility or other messages.
    const keys = Object.keys(ygopro.i18ns['zh-cn']);
    for (const [language, messages] of Object.entries(ygopro.i18ns)) {
      for (const key of keys) {
        assert.strictEqual(typeof messages[key], 'string', `${language} is missing ${key}`);
        assert.ok(!wire.split_chat_lines('${' + key + '}', 8, language)[0].includes('${'), `${language}/${key} must translate`);
      }
    }
    assert.ok(!/[\u3040-\u30ff]/.test(wire.i18ns['en-us'].lp_low_opponent), 'English LP tip must not be Japanese');
    assert.strictEqual(wire.i18ns['ja-jp'].lp_low_opponent, 'もはやお前のライフは風前の灯！');

    const defaultMode = (await host.call('random_mode', config.mode))[0];
    assert.strictEqual(defaultMode.welcome, combinedMessage('ladder_welcome'));
    const originalWelcome = config.welcome;
    for (const value of ['天梯比赛', '${ladder_welcome}']) {
      config.welcome = value;
      assert.strictEqual((await host.call('random_mode', config.mode))[0].welcome, combinedMessage('ladder_welcome'));
    }
    for (const value of ['Custom welcome', '']) {
      config.welcome = value;
      assert.strictEqual((await host.call('random_mode', config.mode))[0].welcome, value);
    }
    config.welcome = originalWelcome;

    function room(type = 'TT') {
      const value = new context.MessageRoom();
      Object.assign(value, {random_type: type, process_pid: 123, duel_stage: wire.constants.DUEL_STAGE.BEGIN,
        players: [], hostinfo: {mode: 1}, cleanup_empty_waiting_room: async () => true,
        connect(client) { this.players.push(client); }});
      context.ROOM_all[0] = value;
      return value;
    }
    const value = room();
    value.welcome2 = defaultMode.welcome;
    const afk = socket('AFK', 'zh-cn');
    const opponent = socket('Opponent', 'zh-cn');
    afk.pos = 0;
    opponent.pos = 1;
    assert.strictEqual(await value.join_player(afk), true);
    assert.strictEqual(await value.join_player(opponent), true);
    for (const [command, language] of [['/zh', 'zh-cn'], ['/en', 'en-us'], ['/ja', 'ja-jp'], ['/ko', 'ko-kr']]) {
      opponent.packets.length = 0;
      assert.strictEqual(await chatHandler(null, {msg: command}, opponent, null, []), true);
      assert.strictEqual(opponent.lang, language);
      context.ROOM_unwelcome(value, afk, '${random_ban_reason_AFK}');
      await new Promise(resolve => setImmediate(resolve));
      const expected = wire.i18ns[language].unwelcome_tip_part1 + wire.i18ns[language].random_ban_reason_AFK +
        translations[language].ladder_opponent_leave_tip_suffix;
      assert.ok(chatMessages(opponent).some(message => message.endsWith(expected)),
        `${language} must receive the complete rating warning in an actual CHAT packet: ${JSON.stringify(chatMessages(opponent))}`);
      assert.ok(chatMessages(opponent).every(message => !message.includes('${')), 'sent packets must contain translated text');
      assert.ok(chatMessages(opponent).some(message => message.endsWith(combinedMessage('ladder_welcome'))),
        'the room welcome must contain all four languages after every switch');
      assert.strictEqual(opponent.flee_free, true);
    }

    const ordinary = room('M');
    const ordinaryAfk = socket('AFK', 'zh-cn');
    const ordinaryOpponent = socket('Opponent', 'zh-cn');
    ordinary.players = [ordinaryAfk, ordinaryOpponent];
    context.ROOM_unwelcome(ordinary, ordinaryAfk, '${random_ban_reason_AFK}');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(chatMessages(ordinaryOpponent)[0].endsWith(wire.i18ns['zh-cn'].unwelcome_tip_part2), 'ordinary rooms must keep their original wording');

    // Penalty rejection precedes language selection. Verify localized reasons and
    // durations together in one real packet, while leaving Moment's global locale.
    moment.locale('zh-cn');
    for (const kind of ['warn', 'deprecated', 'banned']) {
      for (const [amount, unit] of [[4, 'minutes'], [2, 'hours'], [1, 'day']]) {
        const until = kind === 'warn' ? undefined : context.moment_now.clone().add(amount, unit);
        const reasons = ['${random_ban_reason_flee}', '${random_ban_reason_AFK}', '${random_ban_reason_abuse}', '${random_ban_reason_zombie}'];
        const message = context.ROOM_random_penalty_message(kind, reasons, until);
        assert.strictEqual(message.split(' / ').length, 4, 'penalty notice must contain four language sections');
        for (const language of languages) {
          assert.ok(message.includes(wire.i18ns[language].random_ban_reason_abuse), 'penalty reasons must be translated per section');
          if (until) assert.ok(message.includes(until.clone().locale(language).from(context.moment_now, true)),
            'remaining duration must use each language');
          const recipient = socket('Penalized', language);
          await wire.stoc_send_chat(recipient, message, wire.constants.COLORS.RED);
          assert.strictEqual(chatMessages(recipient).length, 1);
          assert.ok(chatMessages(recipient)[0].endsWith(message),
            `the complete ${kind} penalty notice (${message.length} chars) must survive packet encoding: ${JSON.stringify(chatMessages(recipient))}`);
        }
        assert.ok(!message.includes('${'));
        assert.ok(!message.includes('\n'));
        assert.strictEqual(moment.locale(), 'zh-cn', 'per-message formatting must not change the global locale');
      }
    }

    async function verifyRejection(client, key) {
      await new Promise(resolve => setImmediate(resolve));
      const received = chatMessages(client);
      assert.strictEqual(received.length, 1, 'the join rejection must be one CHAT message');
      assert.ok(received[0].endsWith(combinedMessage(key)), 'all four languages must arrive without truncation');
      assert.ok(client.packets.some(packet => packet[2] === wire.helper.translateProto('ERROR_MSG', 'STOC')));
      assert.strictEqual(client.destroyed, true);
      assert.ok(!received[0].includes(client.vpass));
    }
    for (const language of languages) {
      const directJoin = socket('DirectJoin', language);
      assert.strictEqual((await host.call('resolve_room_join', directJoin, room(), 'M#TT,RANDOM#1'))[0], true);
      await verifyRejection(directJoin, 'ladder_direct_join_denied');

      const duplicate = socket(' SAME-ACCOUNT ', language);
      const occupied = room();
      occupied.players.push(socket('same-account', language));
      assert.strictEqual(await occupied.join_player(duplicate), false);
      await verifyRejection(duplicate, 'ladder_duplicate_seat');

      service.authenticate = async () => {throw new Error('test authentication unavailable');};
      const unavailable = socket('Unavailable', language);
      assert.strictEqual(await room().join_player(unavailable), false);
      await verifyRejection(unavailable, 'ladder_auth_unavailable');
    }

    service.authenticate = async () => false;
    const combined = combinedMessage('ladder_auth_mismatch');
    assert.ok(!combined.includes('\n'), 'the pre-join error must be one line');
    for (const language of ['zh-cn', 'en-us', 'ja-jp', 'ko-kr', 'es-es']) {
      const rejected = socket('WrongPassword', language);
      assert.strictEqual(await room().join_player(rejected), false);
      await new Promise(resolve => setImmediate(resolve));
      const received = chatMessages(rejected);
      assert.strictEqual(received.length, 1, 'the authentication error must be a single CHAT message');
      assert.ok(received[0].endsWith(combined), 'each client language must receive all four languages without truncation');
      assert.ok(rejected.packets.some(packet => packet[2] === wire.helper.translateProto('ERROR_MSG', 'STOC')), 'authentication must still reject the connection');
      assert.strictEqual(rejected.destroyed, true);
      assert.ok(!combined.includes(rejected.vpass), 'the error must not echo a password');
    }
  } finally {
    global.ygopro = originalYgopro;
    moment.locale(originalMomentLocale);
    assert.strictEqual(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('srvpro-ladder-messages-'));
    fs.rmSync(root, {recursive: true, force: true});
  }
  console.log('ladder message packet tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
