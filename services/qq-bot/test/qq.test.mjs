import assert from 'node:assert/strict';
import test from 'node:test';
import {parseQqCommand, QqAdapter} from '../src/qq.mjs';

test('QQ parses the four new commands and keeps old ones', () => {
  for (const [input, expected] of [['房间', 'rooms'], ['战绩 Alice', 'player'], ['状态', 'status'],
    ['玩法', 'play'], ['帮助', 'help'], ['排行', 'top'], ['/top', 'top']]) {
    assert.equal(parseQqCommand(input)?.name, expected);
  }
  assert.deepEqual(parseQqCommand('战绩 Alice'), {name: 'player', id: 'Alice'});
  assert.equal(parseQqCommand('普通聊天'), null);
});

test('QQ routes commands to shared services and ignores unrelated group chat', async () => {
  const called = [], sent = [];
  const adapter = Object.create(QqAdapter.prototype);
  adapter.groups = new Map([['group', {groupOpenId: 'group', commands: true, languages: ['zh-cn']}]]);
  adapter.unknownGroups = new Set();
  adapter.logger = {write: async () => {}};
  adapter.service = Object.fromEntries(['rooms', 'player', 'status', 'play', 'help', 'top'].map(name =>
    [name, (...args) => { called.push([name, ...args]); return {messages: [name]}; }]));
  adapter.bot = {sendText: async (_target, text) => { sent.push(text); }};
  const incoming = content => ({kind: 'group', groupOpenid: 'group', content, rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    replyTarget: {scope: 'group', targetId: 'group', msgId: 'm1'}});
  for (const command of ['房间', '战绩 Alice', '状态', '玩法', '帮助', '排行']) await adapter.onMessage(incoming(command));
  assert.deepEqual(called.map(row => row[0]), ['rooms', 'player', 'status', 'play', 'help', 'top']);
  assert.deepEqual(sent, ['rooms', 'player', 'status', 'play', 'help', 'top']);
  await adapter.onMessage({...incoming('hello'), rawEventType: 'GROUP_MESSAGE_CREATE'});
  assert.equal(sent.length, 6);
});

test('QQ proactive permission denial does not disable later command replies', async () => {
  const entries = [], replies = [];
  const adapter = Object.create(QqAdapter.prototype);
  adapter.groups = new Map([['group', {groupOpenId: 'group', commands: true, languages: ['zh-cn'], proactiveEnabled: true}]]);
  adapter.unknownGroups = new Set();
  adapter.denied = new Set();
  adapter.ready = true;
  adapter.logger = {write: async (event, fields) => { entries.push({event, fields}); }};
  adapter.service = {status: async () => ({messages: ['status']})};
  adapter.bot = {sendText: async (target, content) => {
    if (!target.msgId) throw {bizCode: 40034105};
    replies.push(content);
  }};
  const group = adapter.groups.get('group');
  await adapter.proactive(group, 'match_waiting', 'waiting');
  await adapter.proactive(group, 'match_waiting', 'waiting');
  await adapter.onMessage({kind: 'group', groupOpenid: 'group', content: '状态', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    replyTarget: {scope: 'group', targetId: 'group', msgId: 'm1'}});
  assert.deepEqual(entries.slice(0, 2).map(row => row.event), ['qq_proactive_failed', 'qq_proactive_skipped']);
  assert.deepEqual(replies, ['status']);
});

const streak = {eventId: 'match:8', player: 'Alice', streak: 8, points: 1234, wins: 8, losses: 2, diff: 6, winRate: 0.8};

function streakAdapter(groups, fetchImpl, now = Date.now) {
  const adapter = Object.create(QqAdapter.prototype);
  adapter.config = {apiBaseUrl: 'https://api.bot.qq.com', groups};
  adapter.groups = new Map(groups.map(group => [group.groupOpenId, group]));
  adapter.denied = new Set();
  adapter.unknownGroups = new Set();
  adapter.ready = true;
  adapter.now = now;
  adapter.fetch = fetchImpl;
  adapter.logger = {write: async () => {}};
  adapter.bot = {api: {getToken: async () => 'test-token'}};
  return adapter;
}

test('QQ streaks use selected proactive groups and the same official group endpoint with four languages', async () => {
  const requests = [];
  const adapter = streakAdapter([
    {groupOpenId: 'matching', matchAlerts: true, proactiveEnabled: true},
    {groupOpenId: 'streaks', winStreakAlerts: true, proactiveEnabled: true, languages: ['zh-cn']},
    {groupOpenId: 'disabled', winStreakAlerts: true, proactiveEnabled: false},
    {groupOpenId: 'denied', winStreakAlerts: true, proactiveEnabled: true}
  ], async (url, options) => { requests.push({url, ...options}); return new Response(JSON.stringify({id: 'sent'})); });
  adapter.denied.add('denied');
  assert.equal(adapter.canNotifyWinStreak(), true);
  await adapter.notifyWinStreak(streak, Date.now() + 5000);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.bot.qq.com/v2/groups/streaks/messages');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.Authorization, 'QQBot test-token');
  const body = JSON.parse(requests[0].body);
  assert.equal(body.msg_type, 0);
  assert.equal(body.msg_id, undefined, 'proactive posts never borrow a command message ID');
  assert.equal(body.content.split('\n\n').length, 4);
  assert.match(body.content, /Alice玩家当前8连胜！本月等级分1234、胜场8、胜负差6、胜率80.00%/);
  assert.ok(requests[0].signal instanceof AbortSignal);
  await adapter.notifyWinStreak(streak, Date.now() - 1);
  adapter.ready = false;
  assert.equal(adapter.canNotifyWinStreak(), false);
  await adapter.notifyWinStreak(streak, Date.now() + 5000);
  assert.equal(requests.length, 1, 'expired or offline sends are skipped');
});

test('QQ streaks wait for temp discovery without consuming events, including when commands are disabled', async () => {
  const adapter = streakAdapter([{groupOpenId: 'temp', commands: false, winStreakAlerts: true, proactiveEnabled: true}],
    async () => { throw new Error('unexpected request'); });
  assert.equal(adapter.canNotifyWinStreak(), false);
  await adapter.onMessage({kind: 'group', groupOpenid: 'real-group', content: 'hello'});
  assert.equal(adapter.canNotifyWinStreak(), true);
  assert.equal(adapter.config.groups[0].groupOpenId, 'real-group');
  adapter.denied.add('real-group');
  assert.equal(adapter.canNotifyWinStreak(), false);
});

test('QQ streak permission denial stops that group and preserves both other groups and passive replies', async () => {
  const requests = [], replies = [], logs = [];
  const adapter = streakAdapter([
    {groupOpenId: 'denied', commands: true, languages: ['zh-cn'], winStreakAlerts: true, proactiveEnabled: true},
    {groupOpenId: 'allowed', winStreakAlerts: true, proactiveEnabled: true}
  ], async url => {
    requests.push(url);
    return new Response(JSON.stringify(url.includes('/denied/') ? {code: 40034105} : {id: 'sent'}),
      {status: url.includes('/denied/') ? 403 : 200});
  });
  adapter.logger = {write: async (event, fields) => { logs.push({event, fields}); }};
  adapter.service = {status: async () => ({messages: ['status']})};
  adapter.bot.sendText = async (_target, text) => { replies.push(text); };
  await adapter.notifyWinStreak(streak, Date.now() + 5000);
  await adapter.notifyWinStreak({...streak, streak: 9}, Date.now() + 5000);
  assert.deepEqual(requests.map(url => /groups\/([^/]+)/.exec(url)[1]), ['denied', 'allowed', 'allowed']);
  assert.equal(adapter.denied.has('denied'), true);
  assert.equal(adapter.canNotifyWinStreak(), true);
  await adapter.onMessage({kind: 'group', groupOpenid: 'denied', content: '状态', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    replyTarget: {scope: 'group', targetId: 'denied', msgId: 'real-command'}});
  assert.deepEqual(replies, ['status']);
  assert.ok(JSON.stringify(logs).includes('40034105'));
  assert.ok(!JSON.stringify(logs).includes('test-token'), 'logs never serialize authorization');
});

test('QQ streaks expire during token refresh and never start a late send', async () => {
  let now = 1000, sends = 0;
  const adapter = streakAdapter([{groupOpenId: 'group', winStreakAlerts: true, proactiveEnabled: true}],
    async () => { sends++; }, () => now);
  adapter.bot.api.getToken = async () => { now = 3000; return 'test-token'; };
  await adapter.notifyWinStreak(streak, 2000);
  assert.equal(sends, 0);
});

test('QQ streak requests abort at expiry and a slow group cannot push later groups past their window', async () => {
  const sends = [], entries = [];
  const adapter = streakAdapter([
    {groupOpenId: 'slow', winStreakAlerts: true, proactiveEnabled: true},
    {groupOpenId: 'next', winStreakAlerts: true, proactiveEnabled: true}
  ], async (url, {signal}) => {
    sends.push(url);
    await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    });
  });
  adapter.logger = {write: async (event, fields) => { entries.push({event, fields}); }};
  // AbortSignal timers are unreferenced in Node; keep this isolated fake request alive.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await adapter.notifyWinStreak(streak, Date.now() + 25);
    assert.equal(sends.length, 1);
    assert.match(sends[0], /\/slow\//);
    assert.ok(entries.some(row => row.event === 'qq_proactive_failed'));
  } finally { clearTimeout(keepAlive); }
});
