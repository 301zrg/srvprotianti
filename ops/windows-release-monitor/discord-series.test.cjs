'use strict';

// Announcement series: @everyone and attachments, both off unless asked (script batch plan 04 §2).
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {validateSeries, createAnnouncementSeries} = require('./discord-notifications.cjs');

const guildId = '1504410444876484658', announcementsId = '1554786350845141002';
const botId = '123456789012345678', botRoot = 'C:/srvpro-runtime/discord-bot';
const Routes = {
  user: id => '/users/' + id, guild: id => '/guilds/' + id,
  guildChannels: id => '/guilds/' + id + '/channels', guildRoles: id => '/guilds/' + id + '/roles',
  guildMember: (id, user) => '/guilds/' + id + '/members/' + user,
  channelMessages: id => '/channels/' + id + '/messages', channelMessage: (id, message) => '/channels/' + id + '/messages/' + message
};
const BASE = 68608n, MENTION = 131072n, ATTACH = 32768n;

function seriesFixture(t, posts, {permissions = String(BASE), attachmentsEcho = true} = {}) {
  const batch = fs.mkdtempSync(path.join(os.tmpdir(), 'release-series-'));
  t.after(() => fs.rmSync(batch, {recursive: true, force: true}));
  const clock = Date.parse('2026-11-10T00:00:00Z');
  let serial = 0;
  const stored = new Map(), sent = [];
  const record = options => {
    const id = String(1555555555555555555n + BigInt(++serial));
    const body = options.body;
    const message = {id, channel_id: announcementsId, content: body.content, nonce: body.nonce, author: {id: botId, bot: true},
      timestamp: new Date(clock).toISOString(),
      mention_everyone: body.allowed_mentions.parse.includes('everyone') && body.content.startsWith('@everyone'),
      mentions: [], mention_roles: [],
      attachments: attachmentsEcho ? (options.files || []).map(file => ({filename: file.name, size: file.data.length})) : []};
    stored.set(id, message);
    sent.push({body, files: options.files || []});
    return message;
  };
  class REST {
    setToken() { return this; }
    async get(resource) {
      if (resource === Routes.user('@me')) return {id: botId, bot: true};
      if (resource === Routes.guild(guildId)) return {id: guildId, owner_id: '999999999999999999'};
      if (resource === Routes.guildChannels(guildId)) return [{id: announcementsId, guild_id: guildId, name: 'announcements', type: 0, permission_overwrites: []}];
      if (resource === Routes.guildRoles(guildId)) return [{id: guildId, permissions}];
      if (resource === Routes.guildMember(guildId, botId)) return {user: {id: botId, bot: true}, roles: []};
      if (resource === Routes.channelMessages(announcementsId)) return [...stored.values()].reverse();
      const id = resource.split('/').pop();
      if (stored.has(id)) return stored.get(id);
      throw Error('unexpected_fixture_route');
    }
    async post(resource, options) { return record(options); }
  }
  class ProxyAgent { async close() {} async destroy() {} }
  const options = {manifest: {id: 'series-test'}, batch, posts, now: () => clock, timeoutMs: 100,
    readConfig: () => ({discord: {botToken: 'private-test-token'}}),
    loadPackages: () => ({REST, Routes, ProxyAgent})};
  const apps = [{name: 'discord-bot', pid: 321, pm2_env: {status: 'online', pm_exec_path: botRoot + '/src/run.mjs'}}];
  return {batch, apps, sent, create: () => createAnnouncementSeries(options)};
}
function attachment(t, name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'series-file-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return {name, file};
}

test('series validation: limits, no mentions in text, safe unique attachments', t => {
  const a = attachment(t, 'notes.md', '# notes');
  assert.equal(validateSeries([{content: 'x'.repeat(2000)}])[0].content.length, 2000);
  assert.equal(validateSeries([{content: 'hi', mentionEveryone: true}])[0].content, '@everyone\nhi');
  for (const bad of [[], [{content: ''}], [{content: 'x'.repeat(2001)}], [{content: 'x'.repeat(1991), mentionEveryone: true}],
    [{content: 'hello @everyone'}], [{content: '<@123456789012345678>'}], [{content: 'x', extra: 1}], [{content: 'x', mentionEveryone: 'yes'}]]) {
    assert.throws(() => validateSeries(bad), /announcement_series_invalid/);
  }
  for (const bad of [[{content: 'x', attachments: [{name: '../a.md', file: a.file}]}], [{content: 'x', attachments: [{name: 'a.exe', file: a.file}]}],
    [{content: 'x', attachments: [{name: 'a.md', file: a.file + '.missing'}]}], [{content: 'x', attachments: [a, a]}]]) {
    assert.throws(() => validateSeries(bad), /announcement_attachment_invalid/);
  }
});

test('series defaults: no mention, no files, base permissions only', async t => {
  const f = seriesFixture(t, [{content: 'one'}, {content: 'two'}]);
  const n = f.create();
  assert.equal((await n.preflight(f.apps)).status, 'READY');
  assert.ok(await n.notify('post-1'));
  assert.ok(await n.notify('post-2'));
  await n.close();
  assert.deepEqual(f.sent.map(s => s.body.allowed_mentions.parse), [[], []]);
  assert.deepEqual(f.sent.map(s => s.files.length), [0, 0]);
});

test('series: @everyone on the first post only, attachments on the last, permissions checked', async t => {
  const files = [attachment(t, 'prohibition.md', '# Prohibition'), attachment(t, 'summon-count.md', '# Counting')];
  const posts = [{content: 'zh', mentionEveryone: true}, {content: 'ja'}, {content: 'en'}, {content: 'ko', attachments: files}];
  const missing = seriesFixture(t, posts, {permissions: String(BASE)});
  await assert.rejects(missing.create().preflight(missing.apps), /notification_permissions_missing/);
  const noAttach = seriesFixture(t, posts, {permissions: String(BASE | MENTION)});
  await assert.rejects(noAttach.create().preflight(noAttach.apps), /notification_permissions_missing/);
  const f = seriesFixture(t, posts, {permissions: String(BASE | MENTION | ATTACH)});
  const n = f.create();
  assert.equal((await n.preflight(f.apps)).status, 'READY');
  for (const phase of ['post-1', 'post-2', 'post-3', 'post-4']) assert.ok(await n.notify(phase));
  await n.close();
  assert.deepEqual(f.sent.map(s => s.body.allowed_mentions.parse), [['everyone'], [], [], []]);
  assert.ok(f.sent[0].body.content.startsWith('@everyone\n'));
  assert.ok(!f.sent[1].body.content.includes('@everyone'));
  assert.deepEqual(f.sent[3].files.map(file => file.name), ['prohibition.md', 'summon-count.md']);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.batch, 'announcement-series.json'), 'utf8'));
  assert.deepEqual(Object.values(receipt.phases).map(p => p.status), ['confirmed', 'confirmed', 'confirmed', 'confirmed']);
});

test('series: a post whose attachments do not read back is never reported as delivered', async t => {
  const posts = [{content: 'with file', attachments: [attachment(t, 'a.md', 'abc')]}];
  const f = seriesFixture(t, posts, {permissions: String(BASE | ATTACH), attachmentsEcho: false});
  const n = f.create();
  await n.preflight(f.apps);
  await assert.rejects(n.notify('post-1'), /notification_delivery_uncertain/);
  await n.close();
});

test('series: changing an attachment invalidates the earlier receipt', async t => {
  const file = attachment(t, 'a.md', 'first');
  const posts = [{content: 'x', attachments: [file]}];
  const f = seriesFixture(t, posts, {permissions: String(BASE | ATTACH)});
  const n = f.create();
  await n.preflight(f.apps);
  await n.notify('post-1');
  await n.close();
  fs.writeFileSync(file.file, 'changed');
  await assert.rejects(f.create().preflight(f.apps), /notification_receipt_invalid/);
});
