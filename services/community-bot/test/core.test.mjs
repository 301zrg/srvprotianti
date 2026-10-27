import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {GameApi} from '../src/api.mjs';
import {chartPng, chartValues} from '../src/chart.mjs';
import {mergeConfig, validateConfig} from '../src/config.mjs';
import {formatHelp, formatMonthly, formatPlayer, formatRooms, formatWaiting} from '../src/i18n.mjs';
import {isSingleWaitingTt, MatchMonitor} from '../src/monitor.mjs';
import {QqAdapter} from '../src/qq.mjs';
import {MonthlyScheduler} from '../src/scheduler.mjs';

const logger = {write: async () => {}};
const room = (id, users, istart = 'wait') => ({roomid: String(id), roomname: `M#TT,RANDOM#${id}`, users, istart});

test('room polling uses effective player seats and alerts once for a new TT room', async () => {
  assert.equal(isSingleWaitingTt(room(1, [{pos: 0}, {pos: 7}])), true);
  assert.equal(isSingleWaitingTt(room(1, [{pos: 7}])), false);
  assert.equal(isSingleWaitingTt(room(1, [{pos: null}])), false);
  assert.equal(isSingleWaitingTt(room(1, [{pos: 0}, {pos: 1}])), false);
  let snapshot = [room(1, [{pos: 0}])], alerts = 0;
  const monitor = new MatchMonitor({api: {getRooms: async () => snapshot}, intervalMs: 5000, cooldownMs: 60000,
    onWaiting: async () => { alerts++; }, logger});
  await monitor.poll(); // Old waiting rooms are only baseline state.
  snapshot = [room(1, [{pos: 0}]), room(2, [{pos: 0}, {pos: 7}])];
  await monitor.poll();
  await monitor.poll();
  snapshot = [room(1, [{pos: 0}]), room(2, [{pos: 0}, {pos: 1}])];
  await monitor.poll();
  snapshot = [room(1, [{pos: 0}]), room(2, [{pos: 0}])];
  await monitor.poll();
  assert.equal(alerts, 1);
});

test('an empty TT room alerts when its first player takes a seat', async () => {
  let snapshot = [], alerts = 0;
  const monitor = new MatchMonitor({api: {getRooms: async () => snapshot}, intervalMs: 5000, cooldownMs: 60000,
    onWaiting: async () => { alerts++; }, logger});
  await monitor.poll();
  snapshot = [room(5, [])];
  await monitor.poll();
  snapshot = [room(5, [{pos: 0}])];
  await monitor.poll();
  await monitor.poll();
  assert.equal(alerts, 1);
});

test('failed polling rebaselines without replaying waiting rooms', async () => {
  let fail = false, alerts = 0, snapshot = [];
  const monitor = new MatchMonitor({api: {getRooms: async () => { if (fail) throw new Error('offline'); return snapshot; }},
    intervalMs: 5000, cooldownMs: 0, onWaiting: async () => { alerts++; }, logger});
  await monitor.poll();
  fail = true;
  await monitor.poll();
  fail = false;
  snapshot = [room(3, [{pos: 0}])];
  await monitor.poll();
  assert.equal(alerts, 0);
});

test('rank query follows server JSON ordering and player query never authenticates', async () => {
  const calls = [];
  const api = new GameApi({baseUrl: 'http://localhost:5000', timeoutMs: 1000}, async (url, options) => {
    calls.push({url: String(url), options});
    return new Response(JSON.stringify(String(url).includes('/player') ? {found: false, authenticated: false} : {ladder: []}),
      {status: 200, headers: {'Content-Type': 'application/json'}});
  });
  await api.getMonthlyTop10('202609');
  await api.getPublicPlayer('Alice', '202609');
  assert.match(calls[0].url, /pageSize=10/);
  assert.doesNotMatch(calls[0].url, /rankingBasis/);
  assert.deepEqual(JSON.parse(calls[1].options.body), {player: 'Alice', month: '202609', page: 1, password: ''});
});

test('monthly schedule runs once at 04:00 and does not backfill or duplicate after restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srvpro-bot-test-'));
  const stateFile = path.join(dir, 'schedule.json');
  let calls = 0, current = new Date('2026-09-21T19:59:00Z'); // Shanghai 03:59
  try {
    const scheduler = new MonthlyScheduler({stateFile, logger, now: () => current, onMonthly: async () => { calls++; }});
    await scheduler.load();
    assert.equal(await scheduler.tick(), false);
    current = new Date('2026-09-21T20:00:05Z');
    assert.equal(await scheduler.tick(), true);
    assert.equal(await scheduler.tick(), false);
    const restarted = new MonthlyScheduler({stateFile, logger, now: () => current, onMonthly: async () => { calls++; }});
    await restarted.load();
    assert.equal(await restarted.tick(), false);
    current = new Date('2026-09-22T20:05:00Z');
    assert.equal(await restarted.tick(), false);
    current = new Date('2026-09-23T20:00:05Z');
    assert.equal(await restarted.tick(), true);
    assert.equal(calls, 2);
  } finally {
    await fs.unlink(stateFile).catch(() => {});
    await fs.rmdir(dir);
  }
});

test('language combinations send one text, rooms use only joinable names, public profile shows total and month', () => {
  const combined = formatWaiting(['zh-cn', 'en-us']);
  assert.match(combined, /^当前有人正在等待天梯匹配 \/ A player/);
  const help = formatHelp(['zh-cn', 'en-us']);
  assert.match(help, /可用指令/);
  assert.match(help, /Available commands/);
  assert.match(help, /@机器人 房间/);
  assert.equal(formatRooms([room(3, []), room(4, [])], ['zh-cn']), 'M#TT,RANDOM#3\nM#TT,RANDOM#4');
  const profile = {found: true, player: 'Alice', month: '202609', summary: {total: {
    rank: 2, points: 5000, wins: 10, losses: 2, diff: 8, winRate: 10 / 12
  }, month: {
    rank: 4, points: 1200, wins: 3, losses: 1, diff: 2, winRate: 0.75,
    decks: [{deckTypeId: 1, names: {zh: '六武众', en: 'Six Samurai'}, matches: 2, winRate: 0.5}]
  }}};
  const text = formatPlayer(profile, ['zh-cn', 'en-us']);
  assert.match(text, /六武众/);
  assert.match(text, /Six Samurai/);
  assert.match(text, /等级分: 1200/);
  assert.match(text, /Points: 1200/);
  assert.equal(text.match(/Alice/g).length, 2);
  assert.match(text, /75\.00%/);
  assert.match(text, /总战绩 \| 排名: 2/);
  assert.match(text, /所选月战绩 \| 排名: 4/);
  assert.match(text, /5000/);
  const rank = formatMonthly({ladder: [{rank: 1, name: 'Alice', duelPoints: 1200, wins: 3, losses: 1, diff: 2}]}, '202609', ['zh-cn', 'en-us']);
  assert.equal(rank.match(/Alice/g).length, 1);
});

test('chart uses every match returned by the configured public API limit plus baseline and renders a PNG', async () => {
  const matches = Array.from({length: 12}, (_, index) => ({pointsBefore: 1000 + index, pointsAfter: 1001 + index}));
  const values = chartValues(matches);
  assert.equal(values.length, 13);
  assert.equal(values[0], 1000);
  const png = await chartPng(matches);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('production JSON overrides arrays and rejects invalid multilingual targets', () => {
  const merged = mergeConfig({qq: {groups: [{groupOpenId: 'example'}], enabled: true}},
    {qq: {groups: [{groupOpenId: 'real'}]}});
  assert.deepEqual(merged.qq.groups, [{groupOpenId: 'real'}]);
  assert.throws(() => validateConfig({
    gameApi: {baseUrl: 'https://game.example.com', roomPollSeconds: 5, timeoutMs: 1000},
    matching: {cooldownSeconds: 60}, monthlyTop10: {timezone: 'Asia/Shanghai', hour: 4},
    qq: {enabled: true, apiBaseUrl: 'https://api.bot.qq.com', appId: 'id', appSecret: 'secret', groups: [{groupOpenId: 'real', languages: ['zh-cn', 'zh-cn']}]},
    discord: {enabled: false}, logging: {file: 'logs/bot.log', scheduleStateFile: 'data/state.json'}
  }), /languages/);
});

test('Discord Public Key is rejected when pasted into botToken', () => {
  assert.throws(() => validateConfig({
    gameApi: {baseUrl: 'https://game.example.com', roomPollSeconds: 5, timeoutMs: 1000},
    matching: {cooldownSeconds: 60}, monthlyTop10: {timezone: 'Asia/Shanghai', hour: 4},
    qq: {enabled: false},
    discord: {enabled: true, applicationId: '123456789012345678', botToken: 'a'.repeat(64), guilds: [{
      guildId: '123456789012345678', channels: [{channelId: '223456789012345678', languages: ['zh-cn']}]
    }]},
    logging: {file: 'logs/bot.log', scheduleStateFile: 'data/state.json'}
  }), /Public Key/);
});

test('QQ groups without proactive permission write each would-be alert to the log', async () => {
  const entries = [];
  const adapter = Object.create(QqAdapter.prototype);
  adapter.logger = {write: async (event, fields) => { entries.push({event, fields}); }};
  adapter.denied = new Set();
  adapter.ready = true;
  adapter.bot = {sendText: async () => { throw {code: '40034102'}; }};
  const group = {groupOpenId: 'group-1', proactiveEnabled: true};
  await adapter.proactive(group, 'match_waiting', '当前有人正在等待天梯匹配');
  await adapter.proactive(group, 'monthly_top10', '月榜');
  assert.equal(entries[0].event, 'qq_proactive_failed');
  assert.equal(entries[1].event, 'qq_proactive_skipped');
  assert.equal(entries[1].fields.content, '月榜');
});

test('QQ current proactive permission error disables later pushes in the same process', async () => {
  const entries = [];
  const adapter = Object.create(QqAdapter.prototype);
  adapter.logger = {write: async (event, fields) => { entries.push({event, fields}); }};
  adapter.denied = new Set();
  adapter.ready = true;
  adapter.bot = {sendText: async () => { throw {bizCode: 40034105}; }};
  const group = {groupOpenId: 'group-2', proactiveEnabled: true};
  await adapter.proactive(group, 'match_waiting', '当前有人正在等待天梯匹配');
  await adapter.proactive(group, 'match_waiting', '当前有人正在等待天梯匹配');
  assert.deepEqual(entries.map(entry => entry.event), ['qq_proactive_failed', 'qq_proactive_skipped']);
  assert.equal(entries[0].fields.code, '40034105');
});

test('QQ temp target binds the first test group and handles that same command', async () => {
  const entries = [], sent = [];
  const template = {groupOpenId: 'temp', commands: true, languages: ['zh-cn']};
  const adapter = Object.create(QqAdapter.prototype);
  adapter.groups = new Map([['temp', template]]);
  adapter.unknownGroups = new Set();
  adapter.logger = {write: async (event, fields) => { entries.push({event, fields}); }};
  adapter.service = {rooms: async () => ({messages: ['room-a\nroom-b']})};
  adapter.bot = {sendText: async (_target, content) => { sent.push(content); }};
  await adapter.onMessage({
    kind: 'group', groupOpenid: 'actual-openid', content: '房间', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    replyTarget: {scope: 'group', targetId: 'actual-openid', msgId: 'message-id'}
  });
  assert.equal(template.groupOpenId, 'actual-openid');
  assert.deepEqual(sent, ['room-a\nroom-b']);
  assert.equal(entries[0].event, 'qq_group_discovered');
});

test('QQ at-message with an unknown command replies with help in every configured language', async () => {
  const sent = [];
  const group = {groupOpenId: 'group-3', commands: true, languages: ['zh-cn', 'en-us']};
  const adapter = Object.create(QqAdapter.prototype);
  adapter.groups = new Map([[group.groupOpenId, group]]);
  adapter.unknownGroups = new Set();
  adapter.logger = logger;
  adapter.service = {};
  adapter.bot = {sendText: async (_target, content) => { sent.push(content); }};
  await adapter.onMessage({
    kind: 'group', groupOpenid: group.groupOpenId, content: '你好', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    replyTarget: {scope: 'group', targetId: group.groupOpenId, msgId: 'message-id'}
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /可用指令/);
  assert.match(sent[0], /Available commands/);

  await adapter.onMessage({
    kind: 'group', groupOpenid: group.groupOpenId, content: '你好', rawEventType: 'GROUP_MESSAGE_CREATE',
    replyTarget: {scope: 'group', targetId: group.groupOpenId, msgId: 'message-id-2'}
  });
  assert.equal(sent.length, 1);
});
