'use strict';

// Host side of design 2.2 / 2.4 / 6.1: account-bound reconnect, fail-closed
// authorization hooks, realName without passwords, recover refused, and the
// admin playername filter. Synthetic data only.
require('reflect-metadata');
global.PrimaryKeyType = 'integer';
global.DbDateType = 'datetime';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const coffee = require('coffeescript');
const {PluginHost} = require('./plugin-system');

const source = fs.readFileSync(path.join(__dirname, 'ygopro-server.coffee'), 'utf8').replace(/\r\n/g, '\n');
function extract(start, end) {
  const offset = source.indexOf(start);
  const until = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && until > offset, `Missing server section ${start}`);
  return source.slice(offset, until);
}
const code = coffee.compile([
  extract('CLIENT_get_authorize_key =', '\nCLIENT_reconnect_unregister ='),
  extract('CLIENT_find_disconnect =', '\nCLIENT_send_pre_reconnect_info ='),
  extract('CLIENT_apply_reconnect_grant =', '\nCLIENT_pre_reconnect =')
].join('\n'), {bare: true});

const BEGIN = 0, DUELING = 3;

function makeContext(host) {
  const context = {
    _: require('underscore'),
    global: {},
    settings: {modules: {
      reconnect: {enabled: true, allow_kick_reconnect: true},
      mycard: {enabled: false}, tournament_mode: {enabled: false}, challonge: {enabled: false}
    }},
    ygopro: {constants: {DUEL_STAGE: {BEGIN, DUELING}}},
    disconnect_list: {},
    ROOM_all: [],
    CLIENT_reconnect_unregister() {},
    plugin_call_strict: (name, ...args) => host.callStrict(name, args, {timeoutMs: 50})
  };
  context.global = context;
  vm.runInNewContext(code, context);
  return context;
}

// Objects created inside the vm context have another realm's prototypes.
const same = (actual, expected, message) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);

const client = fields => ({name: 'Player', vpass: 'new-pw', name_vpass: 'Player$new-pw', pass: 'TT', ip: '203.0.113.1', ...fields});

(async () => {
  // ---- PluginHost.callStrict ----
  const strictLog = [];
  const strictHost = new PluginHost(__dirname, {info() {}, warn: (...args) => strictLog.push(args)});
  strictHost.registerHook('a', 'probe', async value => ({seen: value}));
  let outcome = await strictHost.callStrict('probe', [1], {timeoutMs: 50});
  assert.deepStrictEqual(outcome, {results: [{seen: 1}], failed: false});
  strictHost.registerHook('b', 'probe', async () => { throw new Error('boom Synthetic-Secret'); });
  outcome = await strictHost.callStrict('probe', [1], {timeoutMs: 50});
  assert.strictEqual(outcome.failed, true, 'a throwing handler is reported, not skipped');
  assert.ok(!JSON.stringify(strictLog).includes('Synthetic-Secret'), 'strict hook failures log codes only');
  const hangHost = new PluginHost(__dirname, {info() {}, warn() {}});
  hangHost.registerHook('c', 'probe', () => new Promise(() => {}));
  assert.strictEqual((await hangHost.callStrict('probe', [], {timeoutMs: 20})).failed, true, 'a hanging handler fails closed');
  assert.deepStrictEqual(await hangHost.callStrict('missing', []), {results: [], failed: false});

  // ---- reconnect lookup ----
  let hostHooks = new PluginHost(__dirname, {info() {}, warn() {}});
  let ctx = makeContext(hostHooks);
  const room = {duel_stage: DUELING, windbot: false, get_playing_player() { return this.players; }, players: []};
  ctx.ROOM_all[0] = room;

  // Legacy (non-TT) seat: unchanged behaviour, keyed by name$password.
  const oldLegacy = {name: 'Legacy', vpass: 'pw', name_vpass: 'Legacy$pw', pos: 0};
  ctx.disconnect_list['Legacy$pw'] = {room_id: 0, old_client: oldLegacy, deckbuf: Buffer.from([1]), account_key: null, expired: false};
  const legacyClient = client({name: 'Legacy', vpass: 'pw', name_vpass: 'Legacy$pw'});
  same(await ctx.CLIENT_authorize_reconnect(legacyClient), {grant: null}, 'no plugin opinion');
  assert.strictEqual(ctx.CLIENT_is_able_to_reconnect(legacyClient), true, 'non-TT reconnect is unchanged');
  assert.strictEqual(ctx.CLIENT_is_able_to_reconnect(client({name: 'Legacy', vpass: 'other', name_vpass: 'Legacy$other'})), false);

  // TT seat bound to an account, registered under the OLD password key.
  const oldTT = {name: 'Player', vpass: 'old-pw', name_vpass: 'Player$old-pw', pos: 1, rid: 0, account_binding: {key: 'player', credentialVersion: 'v1'}};
  ctx.disconnect_list['Player$old-pw'] = {room_id: 0, old_client: oldTT, deckbuf: Buffer.from([2]), account_key: 'player', expired: false};
  // Without a grant, not even the old name$password key authorizes it.
  assert.strictEqual(ctx.CLIENT_is_able_to_reconnect(client({vpass: 'old-pw', name_vpass: 'Player$old-pw'})), false,
    'legacy key lookup never authorizes an account-bound seat');
  // With a grant (issued against the current credentials) the new password finds it.
  const granted = client({reconnect_grant: {account: 'player', credentialVersion: 'v2'}});
  assert.strictEqual(ctx.CLIENT_find_disconnect(granted).old_client, oldTT);
  assert.strictEqual(ctx.CLIENT_is_able_to_reconnect(granted, Buffer.from([2])), true);
  assert.strictEqual(ctx.CLIENT_is_able_to_reconnect(granted, Buffer.from([9])), false, 'deck check still applies');
  assert.strictEqual(ctx.CLIENT_is_able_to_reconnect(client({reconnect_grant: {account: 'someone', credentialVersion: 'x'}})), false);

  // Kick-reconnect on a live bound seat: IP and old vpass are not authorization.
  delete ctx.disconnect_list['Player$old-pw'];
  const liveTT = {...oldTT, isClosed: false, pass: 'TT', ip: '198.51.100.7', start_deckbuf: Buffer.from([2])};
  room.players = [liveTT];
  assert.strictEqual(ctx.CLIENT_get_kick_reconnect_target(client({vpass: 'old-pw', ip: '198.51.100.7'})), null,
    'same IP and same old vpass without a grant cannot take a bound seat');
  assert.strictEqual(ctx.CLIENT_get_kick_reconnect_target(client({reconnect_grant: {account: 'player'}, ip: '192.0.2.50'})), liveTT,
    'a grant takes over from any address');
  assert.strictEqual(ctx.CLIENT_get_kick_reconnect_target(client({reconnect_grant: {account: 'player'}}), Buffer.from([7])), null);

  // ---- authorization hook: error and failure both refuse ----
  hostHooks = new PluginHost(__dirname, {info() {}, warn() {}});
  ctx = makeContext(hostHooks);
  hostHooks.registerHook('ladder-core', 'reconnect_authorize', async c => c.vpass === 'new-pw'
    ? {grant: {account: 'player', credentialVersion: 'v2'}} : {error: 'mismatch-message'});
  same(await ctx.CLIENT_authorize_reconnect(client()), {grant: {account: 'player', credentialVersion: 'v2'}});
  same(await ctx.CLIENT_authorize_reconnect(client({vpass: 'old-pw'})), {error: 'mismatch-message'});
  const failingHost = new PluginHost(__dirname, {info() {}, warn() {}});
  failingHost.registerHook('ladder-core', 'reconnect_authorize', async () => { throw new Error('db down'); });
  same(await makeContext(failingHost).CLIENT_authorize_reconnect(client()), {error: '${reconnect_failed}'});

  // ---- final takeover ----
  const commitHost = new PluginHost(__dirname, {info() {}, warn() {}});
  let commitAnswer = {ok: true};
  commitHost.registerHook('ladder-core', 'reconnect_commit', async () => {
    if (commitAnswer instanceof Error) throw commitAnswer;
    return commitAnswer;
  });
  ctx = makeContext(commitHost);
  ctx.ROOM_all[0] = room;
  const target = {...oldTT};
  const taking = client({reconnect_grant: {account: 'player', credentialVersion: 'v2'}, reconnect_target: target});
  assert.strictEqual(await ctx.CLIENT_confirm_reconnect(taking, target), true);
  assert.strictEqual(await ctx.CLIENT_confirm_reconnect(taking, {...oldTT}), false, 'a different seat than at pre-reconnect');
  assert.strictEqual(await ctx.CLIENT_confirm_reconnect({...taking, reconnect_grant: null}, target), false);
  for (const answer of [null, {error: 'changed'}, {ok: 'yes'}, new Error('boom')]) {
    commitAnswer = answer;
    assert.strictEqual(await ctx.CLIENT_confirm_reconnect(taking, target), false, `refused for ${String(answer && (answer.message || JSON.stringify(answer)))}`);
  }
  assert.strictEqual(await ctx.CLIENT_confirm_reconnect(client(), {name: 'Legacy'}), true, 'unbound seats keep the legacy path');
  const noHooks = makeContext(new PluginHost(__dirname, {info() {}, warn() {}}));
  noHooks.ROOM_all[0] = room;
  assert.strictEqual(await noHooks.CLIENT_confirm_reconnect(taking, target), false, 'no plugin answer means refuse');

  // After takeover the connection carries the seat account with the new version.
  const reconnected = client({account_binding: {key: 'player', credentialVersion: 'v1'}, reconnect_grant: {account: 'player', credentialVersion: 'v2'}, reconnect_target: target});
  ctx.CLIENT_apply_reconnect_grant(reconnected);
  same(reconnected.account_binding, {key: 'player', credentialVersion: 'v2'});
  assert.strictEqual(reconnected.reconnect_grant, undefined);

  // ---- realName and recover (source checks on the shipped host) ----
  assert.match(source, /realName: player\.name\n/, 'duel logs store the nickname only');
  assert.doesNotMatch(source, /realName: player\.name_vpass/);
  assert.match(source, /RECOVER_ALLOWED = global\.RECOVER_ALLOWED = false/);
  assert.match(source, /info\.pass\.toUpperCase\(\)=="RC" and RECOVER_ALLOWED and/, 'RC search is refused in code');
  assert.match(source, /if RECOVER_ALLOWED and settings\.modules\.tournament_mode\.enable_recover and \(param = rule\.match/, 'recover rooms are refused in code');
  assert.match(source, /"account_binding",\n\]/, 'the seat account survives a reconnect');
  const compiled = fs.readFileSync(path.join(__dirname, 'ygopro-server.js'), 'utf8');
  assert.ok(compiled.includes('realName: player.name,') && compiled.includes('RECOVER_ALLOWED = global.RECOVER_ALLOWED = false'),
    'ygopro-server.js must be rebuilt from the coffee source');

  // ---- admin playername filter matches by nickname ----
  const {DataManager} = require('./data-manager/DataManager');
  const dataManager = new DataManager({type: 'sqljs'}, {info() {}, warn() {}});
  await dataManager.init();
  const player = (realName, pos) => ({name: realName.split('$')[0], pos, realName, startDeckBuffer: null, deck: {main: [], side: []},
    isFirst: pos === 0, winner: pos === 0, ip: '127.0.0.1', score: 1, lp: 8000, cardCount: 0});
  await dataManager.saveDuelLog('room-old', 1, 0, 'a.yrp', 1, 1, [player('Alice$synthetic-pw', 0), player('Bob', 1)]);
  await dataManager.saveDuelLog('room-new', 2, 0, 'b.yrp', 1, 1, [player('Alice', 0), player('Carol', 1)]);
  await dataManager.saveDuelLog('room-like', 3, 0, 'c.yrp', 1, 1, [player('Al_ce', 0), player('A%', 1)]);
  const rooms = async name => (await dataManager.getDuelLogFromCondition({playerName: name})).map(log => log.name).sort();
  assert.deepStrictEqual(await rooms('Alice'), ['room-new', 'room-old'], 'before and after cleanup');
  assert.deepStrictEqual(await rooms('Alice$anything'), ['room-new', 'room-old'], 'old full-form parameters still work');
  assert.deepStrictEqual(await rooms('Al_ce'), ['room-like'], 'LIKE wildcards are escaped');
  assert.deepStrictEqual(await rooms('A%'), ['room-like']);
  assert.deepStrictEqual(await rooms('Ali'), [], 'no prefix matches');
  await dataManager.getConnection().close();

  console.log('account reconnect host tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
