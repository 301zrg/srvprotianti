import assert from 'node:assert/strict';
import test from 'node:test';
import {parseQqCommand, QqAdapter} from '../src/qq.mjs';
import {postScheduled, responseParts, sendResponse} from '../src/messages.mjs';
import {formatHelp, formatQqReportUsage} from '../../bot-core/src/i18n.mjs';

test('QQ daily ranking snapshot includes localized win rate as its last column', async () => {
  const adapter = Object.create(QqAdapter.prototype);
  adapter.service = {api: {getMonthlyTop10: async month => {
    assert.equal(month, '202610');
    return {ladder: [{rank: 1, name: 'A', duelPoints: 1200, wins: 2, losses: 1, diff: 1}]};
  }}};
  const snapshot = await adapter.prepareScheduled('daily', {languages: ['zh-cn']}, '2026-10-21');
  assert.equal(snapshot.parts.length, 1);
  assert.equal(snapshot.parts[0].content.split('\n')[2], '等级分 | 胜场 | 负场 | 胜负差 | 胜率');
  assert.ok(snapshot.parts[0].content.endsWith('1. A | 1200 | 2 | 1 | 1 | 66.67%'));
});

test('QQ keeps the existing Chinese commands after a mention', () => {
  for (const [input, expected] of [['房间', 'rooms'], ['战绩 Alice', 'player'], ['状态', 'status'],
    ['玩法', 'play'], ['帮助', 'help'], ['排行', 'top'], ['排行榜', 'top']]) {
    assert.equal(parseQqCommand(input)?.name, expected);
    assert.equal(parseQqCommand(`@机器人 ${input}`)?.name, expected);
    assert.equal(parseQqCommand(`<@!bot-id> ${input}`)?.name, expected);
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
  for (const content of ['房间', '战绩 Alice', '月报', '卡组 202609', '卡片 副卡', '@机器人 状态']) {
    await adapter.onMessage({...incoming(content), rawEventType: 'GROUP_MESSAGE_CREATE'});
  }
  await adapter.onMessage({...incoming('状态'), rawEventType: 'GROUP_MESSAGE_CREATE', mentions: [{is_you: false}]});
  assert.equal(sent.length, 6);
  await adapter.onMessage({...incoming('状态'), rawEventType: 'GROUP_MESSAGE_CREATE', mentions: [{is_you: true}]});
  assert.equal(sent.at(-1), 'status');
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

test('QQ streaks use selected proactive groups and the configured language selection', async () => {
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
  assert.equal(body.content.split('\n\n').length, 1);
  assert.ok(!body.content.includes('Player '));
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

test('QQ monthly commands use Chinese words and positional months and categories', () => {
  assert.deepEqual(parseQqCommand('@机器人 月报'), {name: 'meta', month: undefined, view: 'report'});
  assert.deepEqual(parseQqCommand('月报 2026-09'), {name: 'meta', month: '2026-09', view: 'report'});
  assert.deepEqual(parseQqCommand('卡组 202609'), {name: 'meta', month: '202609', view: 'decks'});
  assert.deepEqual(parseQqCommand('卡片 副卡 202609'), {name: 'meta', month: '202609', view: 'side'});
  for (const [category, view] of [['怪兽','monster'],['魔法','spell'],['陷阱','trap'],['额外','extra'],['副卡','side']]) {
    assert.deepEqual(parseQqCommand(`@机器人 卡片 ${category}`), {name: 'meta', month: undefined, view});
    assert.deepEqual(parseQqCommand(`@机器人 卡片 ${category} 2026-09`), {name: 'meta', month: '2026-09', view});
  }
  for (const input of ['月报 month:202609', '月报 view:decks', '卡组 副卡', '卡片', '卡片 unknown',
    '卡片 constructor', '卡片 side', '卡片 202609 副卡', '卡片 副卡 202609 extra', '月报 202609 202608']) {
    assert.equal(parseQqCommand(input).invalid, true);
  }
});
test('QQ does not parse Discord slash commands or named parameters', () => {
  for (const input of ['/rooms', '/player Alice', '/status', '/play', '/help', '/top', '/meta',
    '/meta month:202609 view:spell', '/resend', '@机器人 /meta']) assert.equal(parseQqCommand(input), null);
});
test('QQ help uses mention commands in each configured language while Discord retains its syntax', () => {
  const languages=['ja-jp','zh-cn','en-us','ko-kr'];
  const help=formatHelp(languages,'qq');
  for (const block of help.split('\n\n')) {
    assert.match(block, /@机器人 月报 \[YYYY-MM\]/);
    assert.match(block, /@机器人 卡组 \[YYYY-MM\]/);
    assert.match(block, /@机器人 卡片 <怪兽\|魔法\|陷阱\|额外\|副卡>/);
    assert.doesNotMatch(block, /\/meta|month:|view:|\/rooms/);
  }
  const usage=formatQqReportUsage(languages);
  assert.match(usage.split('\n\n')[0], /月間統計/);
  assert.match(usage.split('\n\n')[1], /完整四图月报/);
  assert.match(formatHelp(['en-us'],'discord'), /\/meta \[month:YYYY-MM\]/);
});
test('QQ invalid report arguments and slash commands show mention-based guidance without querying', async () => {
  const replies=[], group={groupOpenId:'one',commands:true,languages:['zh-cn','en-us']};
  const adapter=streakAdapter([group],async()=>{throw Error('unexpected request');});
  adapter.service={help:(languages,platform)=>({messages:[formatHelp(languages,platform)]}),
    metaForLanguages:async()=>{throw Error('invalid syntax must not query reports');}};
  adapter.bot.sendText=async(_target,text)=>replies.push(text);
  for(const content of ['卡片','月报 view:decks','/meta month:202609'])await adapter.onMessage({kind:'group',groupOpenid:'one',content,
    rawEventType:'GROUP_AT_MESSAGE_CREATE',replyTarget:{scope:'group',targetId:'one',msgId:'request'}});
  assert.equal(replies.length,3);
  for(const text of replies){assert.match(text,/@机器人 月报/);assert.match(text,/@机器人 卡片/);assert.doesNotMatch(text,/\/meta|month:|view:/);}
});
test('QQ routes reports using the entire group language selection and sends four images within reply budget', async () => {
  const group = {groupOpenId: 'one', commands: true, languages: ['ja-jp', 'zh-cn']}, calls = [], images = [];
  const adapter = Object.create(QqAdapter.prototype);
  adapter.groups = new Map([['one', group]]); adapter.unknownGroups = new Set(); adapter.logger = {write: async () => {}};
  adapter.service = {metaForLanguages: async value => { calls.push(value); return {messages: ['日本語', '中文'],
    files: Array.from({length: 4}, (_, i) => ({name: `${i}.png`, data: Buffer.from(String(i))}))}; }};
  adapter.bot = {sendText: async () => { throw new Error('introduction should share first image'); },
    sendImage: async (_target, source, options) => images.push({source, options})};
  await adapter.onMessage({kind: 'group', groupOpenid: 'one', content: '月报 202609', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    replyTarget: {scope: 'group', targetId: 'one', msgId: 'request'}});
  assert.deepEqual(calls[0].languages, ['ja-jp', 'zh-cn']); assert.equal(calls[0].month, '202609');
  assert.equal(images.length, 4); assert.equal(images[0].options.content, '日本語\n\n中文');
});
test('QQ response planning preserves text and images and refuses oversized replies before sending', async () => {
  const response = {messages: ['one', 'two'], image: Buffer.from('PNG')};
  assert.equal(responseParts(response)[0].content, 'one\n\ntwo');
  let sent = 0;
  await assert.rejects(sendResponse({sendText: async () => sent++}, {}, {messages: Array.from({length: 6}, () => 'a'.repeat(1500))}), /budget/);
  assert.equal(sent, 0);
});
test('QQ scheduled media uses per-group editions, explicit acknowledgements and no borrowed passive message IDs', async () => {
  const group = {groupOpenId: 'one', monthlyReport: true, monthlyTop10: true, proactiveEnabled: true, languages: ['ko-kr', 'zh-cn']};
  const adapter = streakAdapter([group], async (_url, request) => { requests.push(JSON.parse(request.body)); return new Response(JSON.stringify({id: 'ack'})); });
  const requests = [], selections = [], uploads = [];
  const report = {batch: 'a'.repeat(24), model: {month: '202609', generatedAt: 'now', decks: [], cards: {}, usageUrl: 'https://web.test/usage-stats.html?L=en'},
    files: Array.from({length: 4}, (_, i) => ({name: `${i}.png`, data: Buffer.from(String(i))}))};
  adapter.service = {monthlyReports: {get: async (month, languages) => { selections.push([month, languages]); return report; },
    readBatch: async () => report}};
  adapter.bot.uploadMedia = async value => { uploads.push(value); return {file_info: 'media'}; };
  const snapshot = await adapter.prepareScheduled('monthly', group, '202609');
  assert.equal(snapshot.total, 4); assert.deepEqual(selections[0], ['202609', ['ko-kr', 'zh-cn']]);
  const prepared = await adapter.prepareScheduledPart(group, snapshot, 0);
  assert.equal(await adapter.sendScheduledPart(group, prepared), 'ack');
  assert.equal(uploads[0].srvSendMsg, false); assert.equal(requests[0].msg_type, 7);
  assert.equal(requests[0].msg_id, undefined); assert.deepEqual(requests[0].media, {file_info: 'media'});
  assert.ok(requests[0].content.includes('L=ko')); assert.ok(requests[0].content.includes('L=zh')); assert.ok(!requests[0].content.includes('L=en'));
});
test('QQ scheduled failures distinguish explicit rejection from uncertain network delivery and stop denied groups', async () => {
  const group = {groupOpenId: 'one'}, adapter = {config: {apiBaseUrl: 'https://api.test'}, denied: new Set(), fetch: async () => {
    return new Response(JSON.stringify({code: 40034105}), {status: 403}); }};
  await assert.rejects(postScheduled(adapter, group, {token: 'private', body: {content: 'text'}}), error => error.deliveryUncertain === false);
  assert.ok(adapter.denied.has('one'));
  adapter.fetch = async () => { throw new Error('timeout'); };
  await assert.rejects(postScheduled(adapter, group, {token: 'private', body: {}}), error => error.deliveryUncertain === true);
  adapter.fetch = async () => new Response(JSON.stringify({}), {status: 200});
  await assert.rejects(postScheduled(adapter, group, {token: 'private', body: {}}), error => error.deliveryUncertain === true);
});
