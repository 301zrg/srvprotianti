'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {validateNotifications, createDiscordNotifications, validateReleaseNotes, createReleaseAnnouncement} = require('./discord-notifications.cjs');

const settings = {kind: 'deck-templates', guildId: '1504410444876484658', channelId: '1504410446130839603', botRoot: 'C:/srvpro-runtime/discord-bot'};
const botId = '123456789012345678', messageId = '1555555555555555555';
const announcementsId = '1554786350845141002';
const releaseNotes = {zh: '助手更新与单卡投入率。', ja: '助手の更新とカード採用率。', en: 'Assistant update and card adoption.', ko: '도우미 업데이트 및 카드 투입률.'};
const Routes = {
  user: id => '/users/' + id, guild: id => '/guilds/' + id,
  guildChannels: id => '/guilds/' + id + '/channels', guildRoles: id => '/guilds/' + id + '/roles',
  guildMember: (id, user) => '/guilds/' + id + '/members/' + user,
  channelMessages: id => '/channels/' + id + '/messages', channelMessage: (id, message) => '/channels/' + id + '/messages/' + message
};

function fixture(t, overrides = {}) {
  const batch = fs.mkdtempSync(path.join(os.tmpdir(), 'release-discord-'));
  t.after(() => fs.rmSync(batch, {recursive: true, force: true}));
  const manifest = {id: 'deck-template-test', notifications: {...settings, ...overrides.settings}};
  if (overrides.announcement) manifest.releaseNotes = {...releaseNotes};
  const destination = overrides.announcement ? announcementsId : manifest.notifications.channelId;
  let clock = Date.parse('2026-10-23T00:00:00Z'), content, nonce;
  const calls = [], posts = [];
  const received = () => ({id: messageId, channel_id: destination, content, nonce, author: {id: botId, bot: true}, timestamp: new Date(clock).toISOString(), mention_everyone: false, mentions: [], mention_roles: []});
  const route = async (method, resource, options) => {
    calls.push([method, resource]);
    if (overrides.request) return overrides.request(method, resource, options, received);
    if (resource === Routes.user('@me')) return {id: botId, bot: true};
    if (resource === Routes.guild(settings.guildId)) return {id: settings.guildId, owner_id: '999999999999999999'};
    if (resource === Routes.guildChannels(settings.guildId)) return overrides.channels || [{id: destination, guild_id: settings.guildId, name: overrides.channelName || (overrides.announcement ? 'announcements' : 'general'), type: 0, permission_overwrites: []}];
    if (resource === Routes.guildRoles(settings.guildId)) return [{id: settings.guildId, permissions: '68608'}];
    if (resource === Routes.guildMember(settings.guildId, botId)) return {user: {id: botId, bot: true}, roles: []};
    if (method === 'get' && resource.endsWith('/' + messageId)) return received();
    if (method === 'get' && resource === Routes.channelMessages(destination)) return posts.length ? [received()] : [];
    throw Error('unexpected_fixture_route');
  };
  class REST {
    constructor(options) { calls.push(['rest-options', options]); }
    setToken(token) { assert.equal(token, 'private-test-token'); return this; }
    get(resource, options) { return route('get', resource, options); }
    async post(resource, options) {
      posts.push({resource, body: options.body}); content = options.body.content; nonce = options.body.nonce;
      const durable = JSON.parse(fs.readFileSync(path.join(batch, overrides.announcement ? 'release-announcement.json' : 'discord-notifications.json'), 'utf8'));
      assert.equal(durable.phases[overrides.phase || (overrides.announcement ? 'release' : 'start')].status, 'attempted');
      if (overrides.post) return overrides.post(received, posts);
      return received();
    }
  }
  class ProxyAgent {
    constructor(proxy) { calls.push(['proxy', proxy]); }
    async close() { calls.push(['close-agent']); }
    async destroy() { calls.push(['destroy-agent']); }
  }
  const options = {manifest, batch, now: () => clock,
    readConfig: filename => { calls.push(['config', filename]); return {discord: {botToken: 'private-test-token'}}; },
    loadPackages: root => { calls.push(['packages', root]); return {REST, Routes, ProxyAgent}; },
    timeoutMs: 100, ...overrides.options};
  const apps = [{name: 'discord-bot', pid: 321, pm2_env: {status: 'online', pm_exec_path: settings.botRoot + '/src/run.mjs', DISCORD_PROXY_URL: 'http://127.0.0.1:7890'}}];
  return {batch, manifest, apps, calls, posts, received, options, advance: ms => { clock += ms; }, create: () => overrides.announcement ? createReleaseAnnouncement(options) : createDiscordNotifications(options)};
}

test('release notes require exactly four nonempty languages within the public message limit', () => {
  assert.deepEqual(validateReleaseNotes(releaseNotes), releaseNotes);
  assert.equal(validateReleaseNotes(null), null);
  for (const invalid of [false, {}, {...releaseNotes, ko: ''}, {...releaseNotes, zh: 'x'.repeat(2000)}, {...releaseNotes, token: 'private'}, {...releaseNotes, en: '@everyone'}, {...releaseNotes, en: '<@123456789012345678>'}, {...releaseNotes, en: 'bad\u0000text'}]) {
    assert.throws(() => validateReleaseNotes(invalid), /release_notes_invalid/);
  }
});

test('omitted release notes do not initialize credentials or a client', async t => {
  const f = fixture(t, {announcement: true}); delete f.manifest.releaseNotes;
  const n = f.create(); assert.equal((await n.preflight([])).status, 'DISABLED');
  assert.equal(await n.notify('release'), null); await n.close(); assert.deepEqual(f.calls, []);
});

test('release notes share delivery guarantees but have a separate receipt and fixed announcements destination', async t => {
  const f = fixture(t, {announcement: true});
  fs.writeFileSync(path.join(f.batch, 'discord-notifications.json'), 'historical maintenance receipt');
  const n = f.create(); await n.preflight(f.apps); assert.equal(await n.notify('release'), messageId); await n.close();
  for (const text of Object.values(releaseNotes)) assert.ok(f.posts[0].body.content.includes(text));
  assert.equal(f.posts[0].resource, Routes.channelMessages(announcementsId));
  assert.deepEqual(f.posts[0].body.allowed_mentions, {parse: []});
  assert.equal(fs.readFileSync(path.join(f.batch, 'discord-notifications.json'), 'utf8'), 'historical maintenance receipt');
  const resumed = f.create(); await resumed.preflight(f.apps); assert.equal(await resumed.notify('release'), messageId); await resumed.close();
  assert.equal(f.posts.length, 1);
});

test('lost release announcement responses reconcile the original message without another POST', async t => {
  const f = fixture(t, {announcement: true, post: async () => { throw Error('lost response'); }});
  const n = f.create(); await n.preflight(f.apps); assert.equal(await n.notify('release'), messageId); await n.close();
  const resumed = f.create(); await resumed.preflight(f.apps); assert.equal(await resumed.notify('release'), messageId); await resumed.close();
  assert.equal(f.posts.length, 1);
});

test('changed release content cannot reuse an existing announcement receipt', async t => {
  const f = fixture(t, {announcement: true}), n = f.create();
  await n.preflight(f.apps); await n.notify('release'); await n.close(); f.manifest.releaseNotes.zh += 'changed';
  const resumed = f.create(); await assert.rejects(resumed.preflight(f.apps), /notification_receipt_invalid/);
  assert.equal(f.posts.length, 1);
});

test('optional notifications stay disabled without reading config or opening a network client', async t => {
  const f = fixture(t); f.manifest.notifications = null;
  const n = f.create();
  assert.equal(validateNotifications(undefined), null);
  assert.equal(validateNotifications(null), null);
  assert.equal((await n.preflight([])).status, 'DISABLED');
  assert.equal(await n.notify('start'), null); await n.close();
  assert.deepEqual(f.calls, []);
});

test('settings restrict notifications to the approved public channel and keep credentials out of manifests', () => {
  assert.deepEqual(validateNotifications(settings), settings);
  for (const invalid of [{}, false, {...settings, token: 'secret'}, {...settings, kind: 'arbitrary'}, {...settings, guildId: '123'}, {...settings, channelId: '123'}, {...settings, botRoot: 'C:/other'}]) {
    assert.throws(() => validateNotifications(invalid), /notifications_config_invalid/);
  }
});

test('announcements accepts template and general server updates while legacy general is template-only', () => {
  for (const kind of ['deck-templates', 'server-update']) {
    const target = {...settings, kind, channelId: announcementsId};
    assert.deepEqual(validateNotifications(target), target);
  }
  assert.deepEqual(validateNotifications(settings), settings, 'existing immutable template batches must still validate');
  assert.throws(() => validateNotifications({...settings, kind: 'server-update'}), /notifications_config_invalid/);
});

test('announcement preflight selects the exact ID and name without sending or writing a receipt', async t => {
  const f = fixture(t, {settings: {kind: 'server-update', channelId: announcementsId}, channelName: 'announcements'});
  const n = f.create();
  assert.equal((await n.preflight(f.apps)).channelId, announcementsId);
  assert.equal(f.posts.length, 0);
  assert.equal(fs.existsSync(path.join(f.batch, 'discord-notifications.json')), false);
  assert.ok(f.calls.some(call => call[1] === Routes.channelMessages(announcementsId)));
  assert.ok(!f.calls.some(call => call[1] === Routes.channelMessages(settings.channelId)));
  await n.close();
});

test('announcement ID cannot be substituted, renamed, duplicated or changed into another channel type', async t => {
  const base = {id: announcementsId, guild_id: settings.guildId, name: 'announcements', type: 0, permission_overwrites: []};
  for (const channels of [[{...base, id: settings.channelId}], [{...base, name: 'general'}], [base, {...base, id: '999999999999999999'}], [{...base, type: 2}]]) {
    const f = fixture(t, {settings: {kind: 'server-update', channelId: announcementsId}, channels});
    const n = f.create();
    await assert.rejects(n.preflight(f.apps), /notification_channel_changed/);
    assert.equal(f.posts.length, 0);
    await n.close();
  }
});

test('announcement permissions must include history before any notice is sent', async t => {
  const f = fixture(t, {settings: {kind: 'server-update', channelId: announcementsId}, channels: [{id: announcementsId, guild_id: settings.guildId, name: 'announcements', type: 0,
    permission_overwrites: [{id: settings.guildId, type: 0, deny: '65536', allow: '0'}]}]});
  const n = f.create();
  await assert.rejects(n.preflight(f.apps), /notification_permissions_missing/);
  assert.equal(f.posts.length, 0); await n.close();
});

test('general server update notices use accurate four-language outcomes and only the announcement channel', async t => {
  for (const phase of ['start', 'success', 'rollback', 'cancel']) {
    const f = fixture(t, {settings: {kind: 'server-update', channelId: announcementsId}, channelName: 'announcements', phase});
    const n = f.create(); await n.preflight(f.apps); await n.notify(phase);
    assert.equal(f.posts.length, 1); assert.equal(f.posts[0].resource, Routes.channelMessages(announcementsId));
    const body = f.posts[0].body;
    assert.ok(body.content.length <= 2000);
    assert.equal(body.content.split('\n\n').length, 4);
    assert.doesNotMatch(body.content, /卡组模板|deck template|reclassif|テンプレート|재분류/i);
    assert.deepEqual(body.allowed_mentions, {parse: []});
    if (phase === 'start') assert.match(body.content, /Maintenance started/);
    if (phase === 'success') assert.match(body.content, /update.*completed|updated successfully/i);
    if (phase === 'rollback') assert.match(body.content, /previous version/i);
    if (phase === 'cancel') assert.doesNotMatch(body.content, /更新.*完成|update.*completed/i);
    await n.close();
  }
});

test('historical template notice bytes and original general destination remain recoverable', async t => {
  const hashes = {start: 'db73d6798a104f62b429dd3504006bebd67140abe3c89fbeb103c0aa126b4f99', success: 'fe29db3ed2a109a1ecc085d10863c178525be1653c1a212ddbfacfee9a9b76c4',
    rollback: '47cd1a937ef7024923394970c0b339af950162b52016a3ab3d8428e71dc23c37', cancel: '63d04c481a7b8f37d120b7ad2b7ed32ccbaeb10cd4f7bcc27ecfa2a1151a6127'};
  for (const [phase, digest] of Object.entries(hashes)) {
    const f = fixture(t, {phase}), n = f.create();
    await n.preflight(f.apps); await n.notify(phase); await n.close();
    assert.equal(crypto.createHash('sha256').update(f.posts[0].body.content).digest('hex'), digest);
    assert.equal(f.posts[0].resource, Routes.channelMessages(settings.channelId));
    const resumed = f.create(); await resumed.preflight(f.apps); await resumed.notify(phase); await resumed.close();
    assert.equal(f.posts.length, 1, 'a historic confirmed phase must be read back without posting again');
  }
});

test('preflight checks identity, channel, membership and history without sending or writing attempts', async t => {
  const f = fixture(t), n = f.create();
  assert.deepEqual(f.calls, []);
  const result = await n.preflight(f.apps);
  assert.equal(result.status, 'READY'); assert.equal(result.botId, botId);
  assert.equal(f.posts.length, 0);
  assert.equal(fs.existsSync(path.join(f.batch, 'discord-notifications.json')), false);
  const options = f.calls.find(x => x[0] === 'rest-options')[1];
  assert.equal(options.retries, 0);
  assert(f.calls.some(x => x[1] === Routes.guildMember(settings.guildId, botId)));
  await n.close(); assert(f.calls.some(x => x[0] === 'close-agent'));
});

test('offline, duplicate, moved bots and non-loopback proxies fail before private config reads', async t => {
  for (const mutate of [apps => { apps[0].pm2_env.status = 'stopped'; }, apps => apps.push({...apps[0]}), apps => { apps[0].pm2_env.pm_exec_path = 'C:/other/run.mjs'; }, apps => { apps[0].pm2_env.DISCORD_PROXY_URL = 'https://remote.example'; }]) {
    const f = fixture(t); mutate(f.apps); const n = f.create();
    await assert.rejects(n.preflight(f.apps), /^Error: notification_/);
    assert.equal(f.calls.some(x => x[0] === 'config'), false);
  }
});

test('a channel overwrite denying history blocks preflight despite guild-level access', async t => {
  const f = fixture(t), original = f.options.loadPackages;
  f.options.loadPackages = root => {
    const packages = original(root), Base = packages.REST;
    packages.REST = class extends Base {
      async get(resource, options) {
        if (resource === Routes.guildChannels(settings.guildId)) return [{id: settings.channelId, name: 'general', type: 0, guild_id: settings.guildId, permission_overwrites: [{id: settings.guildId, type: 0, deny: '65536', allow: '0'}]}];
        return super.get(resource, options);
      }
    }; return packages;
  };
  await assert.rejects(f.create().preflight(f.apps), /notification_permissions_missing/);
});

test('duplicate general channels and wrong bot identities block preflight', async t => {
  for (const wrongIdentity of [false, true]) {
    const f = fixture(t), original = f.options.loadPackages;
    f.options.loadPackages = root => {
      const p = original(root), Base = p.REST;
      p.REST = class extends Base {
        async get(resource, options) {
          const value = await super.get(resource, options);
          if (!wrongIdentity && resource === Routes.guildChannels(settings.guildId)) return [value[0], {...value[0], id: '999999999999999999'}];
          if (wrongIdentity && resource === Routes.guildMember(settings.guildId, botId)) return {...value, user: {id: '999999999999999999', bot: true}};
          return value;
        }
      }; return p;
    };
    await assert.rejects(f.create().preflight(f.apps), /notification_(channel_changed|bot_identity_invalid)/);
    assert.equal(f.posts.length, 0);
  }
});

test('a send durably records its phase, disables mentions, and confirms the readback', async t => {
  const f = fixture(t), n = f.create(); await n.preflight(f.apps);
  assert.equal(await n.notify('start'), messageId);
  const post = f.posts[0];
  assert.deepEqual(post.body.allowed_mentions, {parse: []}); assert.equal(post.body.enforce_nonce, true);
  assert.equal(post.body.nonce, crypto.createHash('sha256').update('deck-template-test:start').digest('hex').slice(0, 24));
  assert.match(post.body.content, /更新卡组分类模板并重新分类历史对局/);
  assert.match(post.body.content, /reclassify historical matches/);
  assert.match(post.body.content, /過去の対戦データ/); assert.match(post.body.content, /새 방 입장은 일시 중지되며/);
  assert.match(post.body.content.split('\n\n')[1], /^\[Maintenance started\]/);
  assert(f.calls.some(x => x[1] === Routes.channelMessage(settings.channelId, messageId)));
  const state = JSON.parse(fs.readFileSync(path.join(f.batch, 'discord-notifications.json'), 'utf8'));
  assert.equal(state.phases.start.status, 'confirmed'); assert.equal(state.phases.start.messageId, messageId);
  assert.equal(JSON.stringify(state).includes('private-test-token'), false);
  await n.close();
});

test('confirmed phases resume by checking their original message and never POST again', async t => {
  const f = fixture(t), first = f.create(); await first.preflight(f.apps); await first.notify('start'); await first.close();
  const resumed = f.create(); await resumed.preflight(f.apps);
  assert.equal(await resumed.notify('start'), messageId); assert.equal(f.posts.length, 1); await resumed.close();
});

test('a lost POST reply is reconciled from history without another send', async t => {
  const f = fixture(t, {post: async () => { throw Error('private request with secret'); }}), n = f.create();
  await n.preflight(f.apps); assert.equal(await n.notify('start'), messageId); assert.equal(f.posts.length, 1); await n.close();
});

test('unreadable history keeps an uncertain send pending without blindly retrying on resume', async t => {
  const f = fixture(t, {post: async () => { throw Error('private request'); }}), original = f.options.loadPackages;
  let blockHistory = false;
  f.options.loadPackages = root => {
    const p = original(root), Base = p.REST;
    p.REST = class extends Base {
      async get(resource, options) {
        if (blockHistory && resource === Routes.channelMessages(settings.channelId)) throw Error('private-token-in-request');
        return super.get(resource, options);
      }
    }; return p;
  };
  const n = f.create(); await n.preflight(f.apps); blockHistory = true;
  await assert.rejects(n.notify('start'), /^Error: notification_delivery_uncertain$/); await n.close();
  const resumed = f.create(); blockHistory = false; await resumed.preflight(f.apps); blockHistory = true;
  await assert.rejects(resumed.notify('start'), /^Error: notification_delivery_uncertain$/);
  assert.equal(f.posts.length, 1); await resumed.close();
});

test('an old uncertain send with absent history fails closed after the nonce deduplication window', async t => {
  const f = fixture(t, {post: async () => { throw Error('private request'); }}), original = f.options.loadPackages;
  f.options.loadPackages = root => { const p = original(root), Base = p.REST; p.REST = class extends Base {
    async get(resource, options) { if (resource === Routes.channelMessages(settings.channelId)) return []; return super.get(resource, options); }
  }; return p; };
  const n = f.create(); await n.preflight(f.apps);
  await assert.rejects(n.notify('start'), /notification_delivery_uncertain/); await n.close(); f.advance(180000);
  const resumed = f.create(); await resumed.preflight(f.apps);
  await assert.rejects(resumed.notify('start'), /notification_delivery_uncertain/); assert.equal(f.posts.length, 1); await resumed.close();
});

test('receipt edits and cross-batch reuse block sends', async t => {
  for (const change of [r => { r.phases.start.contentSha256 = 'f'.repeat(64); }, r => { r.batchId = 'different-batch'; }]) {
    const f = fixture(t), n = f.create(); await n.preflight(f.apps); await n.notify('start'); await n.close();
    const filename = path.join(f.batch, 'discord-notifications.json'), value = JSON.parse(fs.readFileSync(filename, 'utf8')); change(value); fs.writeFileSync(filename, JSON.stringify(value));
    const resumed = f.create(); await assert.rejects(resumed.preflight(f.apps), /notification_receipt_invalid/); assert.equal(f.posts.length, 1);
  }
});

test('edited confirmed Discord content is never treated as a valid receipt or resent', async t => {
  const f = fixture(t), n = f.create(); await n.preflight(f.apps); await n.notify('start');
  const original = f.options.loadPackages; await n.close();
  f.options.loadPackages = root => { const p = original(root), Base = p.REST; p.REST = class extends Base {
    async get(resource, options) { const value = await super.get(resource, options); return resource.endsWith('/' + messageId) ? {...value, content: 'edited'} : value; }
  }; return p; };
  const resumed = f.create(); await resumed.preflight(f.apps);
  await assert.rejects(resumed.notify('start'), /notification_readback_invalid/); assert.equal(f.posts.length, 1); await resumed.close();
});

test('rollback announces restoration and cancel only announces reopening in all four languages', async t => {
  for (const phase of ['success', 'rollback', 'cancel']) {
    const f = fixture(t, {phase}), n = f.create(); await n.preflight(f.apps); await n.notify(phase);
    const content = f.posts[0].body.content;
    assert.equal(content.split('\n\n').length, 4);
    if (phase === 'success') assert.match(content, /Deck template updates and historical match reclassification are complete\./);
    if (phase === 'rollback') { assert.match(content, /未完成/); assert.match(content, /previous templates and classifications/); }
    if (phase === 'cancel') { assert.doesNotMatch(content, /更新.*完成|update.*completed|templates.*complete/i); }
    await n.close();
  }
});

test('REST timeouts are bounded and do not expose upstream request details', async t => {
  const f = fixture(t, {request: () => new Promise(() => {}), options: {timeoutMs: 10}}), n = f.create();
  await assert.rejects(n.preflight(f.apps), /^Error: notification_preflight_failed$/);
  assert(f.calls.some(x => x[0] === 'destroy-agent'));
});

test('a recent uncertain send retries once with the original nonce only after proving absence', async t => {
  const f = fixture(t, {post: async (received, posts) => { if (posts.length === 1) throw Error('lost first response'); return received(); }});
  const original = f.options.loadPackages;
  let visible = false;
  f.options.loadPackages = root => { const p = original(root), Base = p.REST; p.REST = class extends Base {
    async get(resource, options) { if (!visible && resource === Routes.channelMessages(settings.channelId)) return []; return super.get(resource, options); }
  }; return p; };
  const first = f.create(); await first.preflight(f.apps);
  await assert.rejects(first.notify('start'), /notification_delivery_uncertain/); await first.close();
  f.advance(1000); const resumed = f.create(); await resumed.preflight(f.apps);
  assert.equal(await resumed.notify('start'), messageId);
  assert.equal(f.posts.length, 2); assert.equal(f.posts[0].body.nonce, f.posts[1].body.nonce);
  await resumed.close();
});

test('a forged receipt checksum cannot bypass the built-in phase content hashes', async t => {
  const f = fixture(t), first = f.create(); await first.preflight(f.apps); await first.notify('start'); await first.close();
  const filename = path.join(f.batch, 'discord-notifications.json'), value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  value.phases.start.contentSha256 = 'e'.repeat(64); delete value.receiptSha256;
  value.receiptSha256 = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); fs.writeFileSync(filename, JSON.stringify(value));
  const resumed = f.create(); await assert.rejects(resumed.preflight(f.apps), /notification_receipt_invalid/);
  assert.equal(f.posts.length, 1);
});

test('a message by another bot cannot reconcile an uncertain phase', async t => {
  const f = fixture(t, {post: async () => { throw Error('lost response'); }}), original = f.options.loadPackages;
  f.options.loadPackages = root => { const p = original(root), Base = p.REST; p.REST = class extends Base {
    async get(resource, options) { const value = await super.get(resource, options); return resource === Routes.channelMessages(settings.channelId) ? value.map(item => ({...item, author: {id: '999999999999999999', bot: true}})) : value; }
  }; return p; };
  const n = f.create(); await n.preflight(f.apps);
  await assert.rejects(n.notify('start'), /notification_delivery_uncertain/); assert.equal(f.posts.length, 1); await n.close();
});

test('late completion of a timed-out POST cannot issue another send for the same phase', async t => {
  let resolvePost;
  const f = fixture(t, {post: received => new Promise(resolve => { resolvePost = () => resolve(received()); }), options: {timeoutMs: 10}});
  const n = f.create(); await n.preflight(f.apps);
  // History can still prove the original delivery after the client timeout.
  assert.equal(await n.notify('start'), messageId); resolvePost(); await n.close();
  const resumed = f.create(); await resumed.preflight(f.apps); assert.equal(await resumed.notify('start'), messageId);
  assert.equal(f.posts.length, 1); await resumed.close();
});

test('existing authenticated loopback proxies stay runtime-only', async t => {
  const f = fixture(t), n = f.create(); f.apps[0].pm2_env.DISCORD_PROXY_URL = 'http://local-user:private-proxy-password@127.0.0.1:7890';
  await n.preflight(f.apps); await n.notify('start');
  const receipt = fs.readFileSync(path.join(f.batch, 'discord-notifications.json'), 'utf8');
  assert.doesNotMatch(receipt, /private-proxy-password|local-user|DISCORD_PROXY_URL/);
  await n.close();
});

test('a known POST message ID survives unavailable readback and resumes without relying on history', async t => {
  const f = fixture(t), original = f.options.loadPackages;
  let blockReadback = true;
  f.options.loadPackages = root => { const p = original(root), Base = p.REST; p.REST = class extends Base {
    async get(resource, options) {
      if (resource === Routes.channelMessages(settings.channelId)) return [];
      if (blockReadback && resource === Routes.channelMessage(settings.channelId, messageId)) throw Error('private request');
      return super.get(resource, options);
    }
  }; return p; };
  const first = f.create(); await first.preflight(f.apps);
  await assert.rejects(first.notify('start'), /notification_delivery_uncertain/); await first.close();
  const receipt = JSON.parse(fs.readFileSync(path.join(f.batch, 'discord-notifications.json'), 'utf8'));
  assert.equal(receipt.phases.start.messageId, messageId); assert.equal(receipt.phases.start.status, 'uncertain');
  f.advance(180000); blockReadback = false;
  const resumed = f.create(); await resumed.preflight(f.apps);
  assert.equal(await resumed.notify('start'), messageId); assert.equal(f.posts.length, 1); await resumed.close();
});
