import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {MessageFlags, PermissionsBitField} from 'discord.js';
import './proxy.test.mjs';
import {commandBodies, DiscordAdapter} from '../src/discord.mjs';
import {StatusCard, statusCardText} from '../src/status-card.mjs';

const logger = {write: async () => {}};

test('Discord registers old and new commands and uses the requester locale', async () => {
  assert.deepEqual(commandBodies.map(command => command.name), ['rooms', 'player', 'status', 'play', 'help', 'top', 'meta', 'resend']);
  const called = [], replies = [];
  const adapter = Object.create(DiscordAdapter.prototype);
  adapter.channels = new Map([['c', {channelId: 'c', guildId: 'g', commands: true, languages: ['zh-cn', 'en-us']}]]);
  adapter.logger = logger;
  adapter.service = Object.fromEntries(['rooms', 'player', 'status', 'play', 'help', 'top'].map(name =>
    [name, (...args) => { called.push([name, ...args]); return {messages: [name]}; }]));
  const make = (commandName, locale, explicit) => ({
    isChatInputCommand: () => true, channelId: 'c', guildId: 'g', commandName, locale,
    options: {getString: () => explicit || null}, deferReply: async () => {},
    editReply: async reply => { replies.push(reply.content); }, followUp: async () => {}, deferred: true
  });
  await adapter.onInteraction(make('status', 'ja'));
  await adapter.onInteraction(make('play', 'en-US', 'ko-kr'));
  await adapter.onInteraction(make('top', 'zh-CN'));
  assert.deepEqual(called.map(row => row[1]), [['ja-jp'], ['ko-kr'], ['zh-cn']]);
  assert.deepEqual(replies, ['status', 'play', 'top']);
});

test('status card uses one message across restart and reports failed API snapshots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srvpro-card-'));
  const stateFile = path.join(dir, 'data/card.json');
  const sent = [], edited = [];
  const message = {id: '123', author: {id: 'bot'}, content: '**OCG 1103 Nexus Ladder Server**',
    edit: async value => { edited.push(value.content); }};
  const channel = {guildId: 'g', isTextBased: () => true,
    messages: {fetch: async key => typeof key === 'string' ? message : new Map([['123', message]])},
    send: async value => { sent.push(value); return message; }};
  const client = {user: {id: 'bot'}, channels: {fetch: async () => channel}};
  let available = true;
  const service = {guide: {introUrl: 'http://example.test/intro'}, getStatus: async () => available ?
    {available: true, rooms: 3, playing: 1, players: 5, waiting: 1, checkedAt: 1000} :
    {available: false, checkedAt: 1000}};
  const config = {guildId: 'g', channelId: 'c', stateFile: 'data/card.json', intervalSeconds: 60};
  try {
    const first = new StatusCard({client, service, logger, root: dir, config});
    await first.load();
    await first.update();
    assert.equal(sent.length, 0); // Found the previous card even without a local state file.
    assert.equal(edited.length, 1);
    assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).messageId, '123');
    const restarted = new StatusCard({client, service, logger, root: dir, config});
    await restarted.load();
    available = false;
    await restarted.update();
    assert.equal(sent.length, 0);
    assert.match(edited[1], /temporarily unavailable/);
    assert.match(statusCardText({available: true, rooms: 2, playing: 1, players: 4, waiting: 1, checkedAt: 1000}, 'http://example.test'),
      /People in rooms.*\*\*4\*\*/);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('status card does not create a duplicate when fetching an existing message fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srvpro-card-'));
  let sends = 0;
  const client = {user: {id: 'bot'}, channels: {fetch: async () => ({guildId: 'g', isTextBased: () => true,
    messages: {fetch: async () => { throw {code: '50013'}; }}, send: async () => { sends++; }})}};
  const card = new StatusCard({client, service: {guide: {introUrl: 'http://example.test'},
    getStatus: async () => ({available: false, checkedAt: null})}, logger, root: dir,
    config: {guildId: 'g', channelId: 'c', stateFile: 'data/card.json'}});
  card.messageId = '123';
  try {
    await assert.rejects(card.update());
    assert.equal(sends, 0);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('status card recreates only a confirmed deleted message', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srvpro-card-'));
  let sends = 0;
  const client = {user: {id: 'bot'}, channels: {fetch: async () => ({guildId: 'g', isTextBased: () => true,
    messages: {fetch: async () => { throw {code: 10008}; }},
    send: async () => { sends++; return {id: '456'}; }})}};
  const card = new StatusCard({client, service: {guide: {introUrl: 'http://example.test'},
    getStatus: async () => ({available: false, checkedAt: null})}, logger, root: dir,
    config: {guildId: 'g', channelId: 'c', stateFile: 'data/card.json'}});
  card.messageId = '123';
  try {
    await card.update();
    assert.equal(sends, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'data/card.json'), 'utf8')).messageId, '456');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('streak posts use only explicitly selected channels and always include four languages', async () => {
  const posts = [], adapter = Object.create(DiscordAdapter.prototype);
  adapter.channels = new Map([
    ['matching', {channelId: 'matching', matchAlerts: true}],
    ['streaks', {channelId: 'streaks', winStreakAlerts: true, languages: ['en-us']}]
  ]);
  adapter.ready = true;
  adapter.logger = logger;
  assert.equal(adapter.canNotifyWinStreak(), true);
  adapter.client = {channels: {fetch: async () => ({isTextBased: () => true, send: async () => { throw new Error('unexpected send'); }})},
    rest: {post: async (route, options) => { posts.push({route, ...options}); }}};
  await adapter.notifyWinStreak({eventId: 'match:8', player: 'Alice', streak: 8, points: 1234, wins: 8, losses: 2, diff: 6, winRate: 0.8}, Date.now() + 5000);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].route, '/channels/streaks/messages');
  assert.equal(posts[0].body.content.split('\n\n').length, 4);
  assert.deepEqual(posts[0].body.allowed_mentions, {parse: []});
  assert.equal(posts[0].body.enforce_nonce, true);
  assert.ok(posts[0].signal instanceof AbortSignal);
  await adapter.notifyWinStreak({player: 'Alice', streak: 9}, Date.now() - 1);
  assert.equal(posts.length, 1, 'expired posts are dropped');
  adapter.ready = false;
  assert.equal(adapter.canNotifyWinStreak(), false);
  await adapter.notifyWinStreak({player: 'Alice', streak: 9}, Date.now() + 5000);
  assert.equal(posts.length, 1, 'offline posts are skipped');
});

test('streak posts expire while fetching a Discord channel', async () => {
  let sends = 0;
  const adapter = Object.create(DiscordAdapter.prototype);
  adapter.ready = true;
  adapter.logger = logger;
  adapter.client = {channels: {fetch: async () => {
    await new Promise(resolve => setTimeout(resolve, 25));
    return {isTextBased: () => true, send: async () => { sends++; }};
  }}};
  await adapter.proactive({channelId: 'streaks'}, 'win_streak', 'expired', {deadline: Date.now() + 5});
  assert.equal(sends, 0);
});

function metaInteraction(options = {}, permitted = true) {
  const calls = {deferred: [], replies: [], followUps: [], immediate: []};
  const interaction = {isChatInputCommand: () => true, channelId: 'c', guildId: 'g', commandName: 'meta', locale: 'ja', user: {id: 'owner'},
    memberPermissions: new PermissionsBitField(permitted ? PermissionsBitField.Flags.Administrator : 0n),
    options: {getString: name => options[name] || null}, attachmentSizeLimit: 8 * 1024 * 1024, deferred: true,
    deferReply: async value => { calls.deferred.push(value); }, editReply: async value => { calls.replies.push(value); },
    reply: async value => { calls.immediate.push(value); }, followUp: async value => { calls.followUps.push(value); }};
  const adapter = Object.create(DiscordAdapter.prototype);
  adapter.channels = new Map([['c', {channelId: 'c', guildId: 'g', commands: true}]]); adapter.logger = logger;
  return {interaction, calls, adapter};
}
const monthlyFixture = () => ({batch: 'a'.repeat(24), model: {month: '202609', generatedAt: '2026-10-01T02:00:00Z', partial: false,
  decks: Array.from({length: 15}, () => ({})), cards: Object.fromEntries(['monster', 'spell', 'trap', 'extra', 'side'].map(m => [m, Array(10).fill({})])),
  usageUrl: 'https://web.test/usage-stats.html?period=month&month=202609&metric=deck&L=en'},
  files: ['01-decks', '02-monsters', '03-spells-traps', '04-extra-side'].map(n => ({name: `${n}-202609.png`, description: 'Chart.', data: Buffer.from('PNG')}))});

test('meta uses locale or explicit language and sends four named attachments in one public reply', async () => {
  const {interaction, adapter, calls} = metaInteraction({month: '2026-09', language: 'ko-kr'}); let query;
  adapter.service = {meta: async input => { query = input; return {messages: ['Report'], files: monthlyFixture().files}; }};
  await adapter.onInteraction(interaction);
  assert.deepEqual(query, {month: '2026-09', view: 'report', language: 'ko-kr'});
  assert.equal(calls.deferred[0], undefined); assert.equal(calls.replies[0].files.length, 4);
  assert.equal(calls.replies[0].files[0].name, '01-decks-202609.png');
  assert.deepEqual(calls.replies[0].allowedMentions, {parse: []}); assert.equal(calls.followUps.length, 0);
});

test('export and preview require Administrator or owner; ordinary members cannot bypass suggestions', async () => {
  for (const view of ['preview', 'export']) {
    for (const permission of [0n, PermissionsBitField.Flags.ManageGuild]) {
      const denied = metaInteraction({view}, false);
      denied.interaction.memberPermissions = new PermissionsBitField(permission);
      denied.adapter.service = {meta: async () => { throw new Error('must not query'); }};
      await denied.adapter.onInteraction(denied.interaction);
      assert.equal(denied.calls.immediate[0].flags, MessageFlags.Ephemeral); assert.equal(denied.calls.deferred.length, 0);
      assert.equal(denied.calls.replies.length, 0); assert.equal(denied.calls.followUps.length, 0);
    }
    for (const owner of [false, true]) {
      const allowed = metaInteraction({view}, !owner); let called;
      if (owner) allowed.interaction.guild = {ownerId: 'owner'};
      allowed.adapter.service = {meta: async input => { called = input; return {messages: ['Result'], files: monthlyFixture().files}; }};
      await allowed.adapter.onInteraction(allowed.interaction);
      assert.equal(called.view, view); assert.equal(called.language, 'ja-jp'); assert.equal(allowed.calls.replies[0].files.length, 4);
    }
  }
});

function metaAutocomplete(search = '', administrator = false) {
  const context = metaInteraction({}, administrator);
  context.interaction.isAutocomplete = () => true;
  context.interaction.isChatInputCommand = () => false;
  context.interaction.options = {getFocused: () => ({name: 'view', value: search})};
  context.interaction.respond = async choices => { context.choices = choices; };
  return context;
}
test('meta view is registered for dynamic suggestions without globally visible static admin choices', () => {
  const view = commandBodies.find(command => command.name === 'meta').options.find(option => option.name === 'view');
  assert.equal(view.autocomplete, true); assert.equal(view.choices, undefined);
});

test('ordinary members see only public report views, even when searching for hidden actions', async () => {
  for (const permission of [0n, PermissionsBitField.Flags.ManageGuild]) {
    for (const search of ['', 'export', 'Preview', 'administrator', 'X assets']) {
      const context = metaAutocomplete(search);
      context.interaction.memberPermissions = new PermissionsBitField(permission);
      await context.adapter.onInteraction(context.interaction);
      assert.deepEqual(context.choices.map(choice => choice.value), search ? [] : ['report', 'decks', 'monster', 'spell', 'trap', 'extra', 'side']);
      assert.equal(context.calls.replies.length, 0);
    }
  }
  const query = metaInteraction({view: 'decks'}, false); let called = false;
  query.adapter.service = {meta: async () => { called = true; return {messages: ['Decks']}; }};
  await query.adapter.onInteraction(query.interaction); assert.equal(called, true);
});

test('Administrator and server owner see both tools; suggestions search names and values without querying statistics', async () => {
  for (const owner of [false, true]) {
    const context = metaAutocomplete('', !owner);
    if (owner) context.interaction.guild = {ownerId: 'owner'};
    context.adapter.service = {meta: async () => { throw new Error('autocomplete must not query data'); }};
    await context.adapter.onInteraction(context.interaction);
    assert.deepEqual(context.choices.map(choice => choice.value), ['report', 'decks', 'monster', 'spell', 'trap', 'extra', 'side', 'export', 'preview']);
  }
  for (const [search, expected] of [['EXPORT', 'export'], ['four-language', 'preview'], ['monsters', 'monster']]) {
    const context = metaAutocomplete(search, true);
    await context.adapter.onInteraction(context.interaction);
    assert.deepEqual(context.choices.map(choice => choice.value), [expected]);
  }
});

test('autocomplete returns no choices outside configured guild/command channels or for an unrelated option', async () => {
  for (const change of [i => { i.guildId = 'other'; }, i => { i.channelId = 'unknown'; },
    i => { i.guildId = null; }, i => { i.options.getFocused = () => ({name: 'month', value: ''}); }]) {
    const context = metaAutocomplete('', true); change(context.interaction);
    await context.adapter.onInteraction(context.interaction); assert.deepEqual(context.choices, []);
  }
  const context = metaAutocomplete('', true); context.adapter.channels.get('c').commands = false;
  await context.adapter.onInteraction(context.interaction); assert.deepEqual(context.choices, []);
});

test('arbitrary autocomplete input is rejected before any public reply or statistics query', async () => {
  const context = metaInteraction({view: 'unknown'}, false);
  context.adapter.service = {meta: async () => { throw new Error('must not query'); }};
  await context.adapter.onInteraction(context.interaction);
  assert.equal(context.calls.immediate[0].flags, MessageFlags.Ephemeral);
  assert.equal(context.calls.deferred.length, 0); assert.equal(context.calls.replies.length, 0);
});

test('export is private from defer onward, including fallback followups; no assets reach the public channel', async () => {
  const {interaction, adapter, calls} = metaInteraction({view: 'export'});
  const image = Buffer.alloc(4 * 1024 * 1024);
  adapter.service = {meta: async () => ({messages: ['Private export'], files: [{name: 'assets.zip', data: Buffer.alloc(9 * 1024 * 1024)}],
    fallbackFiles: Array.from({length: 7}, (_, i) => ({name: `file-${i}.png`, data: image}))})};
  await adapter.onInteraction(interaction);
  assert.equal(calls.deferred[0].flags, MessageFlags.Ephemeral);
  assert.equal(calls.replies[0].files.length, 6);
  assert.equal(calls.followUps.length, 1); assert.equal(calls.followUps[0].flags, MessageFlags.Ephemeral);
});

test('oversized public report returns a localized error without a success summary or partial attachments', async () => {
  const {interaction, adapter, calls} = metaInteraction(); interaction.attachmentSizeLimit = 2;
  adapter.service = {meta: async () => ({messages: ['Report success'], files: monthlyFixture().files})};
  await adapter.onInteraction(interaction);
  assert.match(calls.replies[0].content, /添付/); assert.equal(calls.replies[0].files, undefined);
});

function monthlyAdapter(messages = new Map()) {
  const adapter = Object.create(DiscordAdapter.prototype); adapter.ready = true; adapter.logger = logger;
  const channel = {guildId: 'g', isTextBased: () => true, permissionsFor: () => ({has: () => true}), messages: {fetch: async () => messages}};
  adapter.client = {user: {id: 'bot'}, channels: {fetch: async () => channel}, rest: {post: async () => ({id: 'posted'})}};
  return {adapter, channel};
}
test('scheduled report has exactly four images, four-language scope, canonical URL, nonce and acknowledged ID', async () => {
  const {adapter} = monthlyAdapter(); let request;
  adapter.client.rest.post = async (route, payload) => { request = {route, payload}; return {id: 'posted'}; };
  const report = monthlyFixture(); assert.equal(await adapter.sendMonthlyReport({guildId: 'g', channelId: 'c'}, report), 'posted');
  assert.equal(request.payload.files.length, 4); assert.equal(request.payload.body.attachments.length, 4);
  assert.ok(request.payload.body.attachments[0].description.includes(`Edition ${report.batch}.`));
  for (const text of ['Main Deck monsters', 'Main Deck spells', 'Main Deck traps', 'Extra Deck', 'Side Deck', '日本語', '한국어', '主卡怪兽']) assert.ok(request.payload.body.content.includes(text));
  assert.equal((request.payload.body.content.match(/https:\/\//g) || []).length, 1);
  assert.equal(request.payload.body.enforce_nonce, true); assert.ok(request.payload.signal instanceof AbortSignal);
  adapter.client.rest.post = async () => { throw {code: 'timeout'}; };
  await assert.rejects(adapter.sendMonthlyReport({guildId: 'g', channelId: 'c'}, report), error => error.code === 'timeout');
});

test('report recovery requires own author, month, exact attachment set and matching edition; history failure never means absent', async () => {
  const report = monthlyFixture(), messages = new Map(), {adapter, channel} = monthlyAdapter(messages);
  const message = {id: 'old', author: {id: 'someone'}, content: '2026-09 · OCG 1103 Nexus Monthly Report', createdTimestamp: Date.now(),
    attachments: new Map(report.files.map((f, i) => [i, {name: f.name, description: `Chart. Edition ${report.batch}.`}]))};
  messages.set('old', message);
  const target = {guildId: 'g', channelId: 'c'};
  assert.equal(await adapter.findMonthlyReport(target, report, 0), null);
  message.author.id = 'bot'; assert.equal(await adapter.findMonthlyReport(target, report, 0), 'old');
  message.attachments.get(0).description = 'wrong edition';
  await assert.rejects(adapter.findMonthlyReport(target, report, 0), /needs_review/);
  channel.messages.fetch = async () => { throw {code: '50013'}; };
  await assert.rejects(adapter.findMonthlyReport(target, report, 0), error => error.code === '50013');
  channel.permissionsFor = () => ({has: () => false});
  await assert.rejects(adapter.sendMonthlyReport(target, report), /permissions/);
});

function resendInteraction(channelId = 'test', administrator = true) {
  const calls = {replies: [], edits: [], deliveries: []}, adapter = Object.create(DiscordAdapter.prototype);
  adapter.logger = logger; adapter.resendSessions = new Map();
  adapter.channels = new Map([
    ['test', {channelId: 'test', guildId: 'g', commands: true, adminResendTest: true, languages: ['zh-cn', 'en-us', 'ja-jp', 'ko-kr']}],
    ['ladder', {channelId: 'ladder', guildId: 'g', commands: false, monthlyTop10: true}],
    ['monthly', {channelId: 'monthly', guildId: 'g', commands: false, monthlyReport: true}],
    ['general', {channelId: 'general', guildId: 'g', commands: true}]
  ]);
  adapter.service = {
    api: {getMonthlyTop10: async () => ({ladder: []})}, monthlyReports: {export: async () => monthlyFixture()},
    scheduler: {resend: async target => { calls.deliveries.push(['formal-top', target.channelId]); return {status: 'sent', messageId: 'top-id'}; }},
    reportScheduler: {resend: async target => { calls.deliveries.push(['formal-monthly', target.channelId]); return {status: 'existing', messageId: 'report-id'}; }}
  };
  adapter.sendDailyRanking = async target => { calls.deliveries.push(['test-top', target.channelId]); return 'top-test'; };
  adapter.sendMonthlyReport = async target => { calls.deliveries.push(['test-monthly', target.channelId]); return 'monthly-test'; };
  const interaction = {isChatInputCommand: () => true, commandName: 'resend', channelId, guildId: 'g', user: {id: 'admin'},
    memberPermissions: new PermissionsBitField(administrator ? PermissionsBitField.Flags.Administrator : 0n),
    reply: async value => { calls.replies.push(value); }, deferReply: async () => { interaction.deferred = true; },
    editReply: async value => { calls.edits.push(value); }};
  const click = action => ({...interaction, isButton: () => true,
    customId: calls.replies[0].components[0].toJSON().components.find(button => button.custom_id.endsWith(`:${action}`)).custom_id,
    deferReply: async function () { this.deferred = true; }});
  return {adapter, interaction, calls, click};
}

test('resend command defaults to Administrator visibility and rejects non-admins or unrelated channels', async () => {
  assert.equal(commandBodies.find(command => command.name === 'resend').default_member_permissions, String(PermissionsBitField.Flags.Administrator));
  for (const [channel, admin] of [['ladder', false], ['test', false], ['general', true]]) {
    const h = resendInteraction(channel, admin); await h.adapter.onInteraction(h.interaction);
    assert.equal(h.calls.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(h.calls.replies[0].components, undefined); assert.equal(h.calls.deliveries.length, 0);
  }
});

test('admin test buttons publish both contents only in the invoking test channel without formal acknowledgements', async () => {
  const h = resendInteraction(); await h.adapter.onInteraction(h.interaction);
  assert.equal(h.calls.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(h.calls.replies[0].components[0].toJSON().components.length, 2);
  await h.adapter.onInteraction(h.click('top')); await h.adapter.onInteraction(h.click('monthly'));
  assert.deepEqual(h.calls.deliveries, [['test-top', 'test'], ['test-monthly', 'test']]);
  assert.ok(h.calls.edits.every(reply => reply.content.includes('/g/test/')));
});

test('formal buttons work with ordinary commands disabled and expose only that channel delivery', async () => {
  for (const [channel, action] of [['ladder', 'top'], ['monthly', 'monthly']]) {
    const h = resendInteraction(channel); await h.adapter.onInteraction(h.interaction);
    assert.equal(h.calls.replies[0].components[0].toJSON().components.length, 1);
    const button = h.click(action); await h.adapter.onInteraction(button);
    assert.deepEqual(h.calls.deliveries, [[`formal-${action}`, channel]]);
    button.customId = button.customId.replace(`:${action}`, action === 'top' ? ':monthly' : ':top');
    await h.adapter.onInteraction(button); assert.equal(h.calls.deliveries.length, 1);
  }
});

test('resend buttons recheck admin permission, actor, guild, channel and expiration', async () => {
  for (const override of [{memberPermissions: new PermissionsBitField(0n)}, {user: {id: 'different'}}, {guildId: 'wrong'}, {channelId: 'ladder'}, {}]) {
    const h = resendInteraction(); await h.adapter.onInteraction(h.interaction);
    const button = {...h.click('top'), ...override};
    if (!Object.keys(override).length) [...h.adapter.resendSessions.values()][0].expires = 0;
    await h.adapter.onInteraction(button); assert.equal(h.calls.deliveries.length, 0);
    assert.equal(h.calls.replies.at(-1).flags, MessageFlags.Ephemeral);
  }
});

test('daily recovery recognizes own marked and legacy same-day rankings; history denial blocks sending', async () => {
  const {adapter, channel} = monthlyAdapter();
  const date = '2026-10-12', since = Date.parse(`${date}T00:00:00+08:00`), target = {guildId: 'g', channelId: 'ladder'};
  const message = {id: 'old', author: {id: 'other'}, content: `${date} · Daily Ladder Top 10\n202610: ...`, createdTimestamp: since + 10000};
  channel.messages.fetch = async () => new Map([['old', message]]);
  assert.equal(await adapter.findDailyRanking(target, date, since), null);
  message.author.id = 'bot'; assert.equal(await adapter.findDailyRanking(target, date, since), 'old');
  message.content = '202610: 本月天梯排行榜前10名\n1. A';
  assert.equal(await adapter.findDailyRanking(target, date, since), 'old');
  message.createdTimestamp = since - 1000; assert.equal(await adapter.findDailyRanking(target, date, since), null);
  channel.permissionsFor = () => ({has: () => false});
  await assert.rejects(adapter.sendDailyRanking(target, {ladder: []}, '202610', date), /permissions/);
});

test('daily ranking sends one dated message with stable nonce and propagates delivery failure', async () => {
  const {adapter} = monthlyAdapter(); let payload;
  adapter.client.rest.post = async (_route, value) => { payload = value; return {id: 'sent'}; };
  const target = {guildId: 'g', channelId: 'ladder', languages: ['zh-cn', 'en-us', 'ja-jp', 'ko-kr']};
  await adapter.sendDailyRanking(target, {ladder: [{name: 'A', rank: 1, duelPoints: 1200, wins: 2, losses: 1, diff: 1}]}, '202610', '2026-10-12');
  assert.ok(payload.body.content.split('\n')[2].endsWith('胜率 / Win rate / 勝率 / 승률'));
  assert.ok(payload.body.content.endsWith('1. A | 1200 | 2 | 1 | 1 | 66.67%'));
  assert.ok(payload.body.content.startsWith('2026-10-12 · Daily Ladder Top 10\n'));
  assert.equal(payload.body.enforce_nonce, true); const nonce = payload.body.nonce;
  await adapter.sendDailyRanking(target, {ladder: []}, '202610', '2026-10-12'); assert.equal(payload.body.nonce, nonce);
  adapter.client.rest.post = async () => { throw {code: 'TIMEOUT'}; };
  await assert.rejects(adapter.sendDailyRanking(target, {ladder: []}, '202610', '2026-10-12'), error => error.code === 'TIMEOUT');
});
