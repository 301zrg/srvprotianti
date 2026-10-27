import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {GameApi} from '../src/api.mjs';
import {validateConfig} from '../src/config.mjs';
import {formatMonthly, formatPlay, formatWinStreak} from '../src/i18n.mjs';
import {MatchMonitor} from '../src/monitor.mjs';
import {MonthlyScheduler} from '../src/scheduler.mjs';
import {startRuntime} from '../src/runtime.mjs';
import {CommunityService, roomStatus, splitLines} from '../src/service.mjs';
import {WinStreakMonitor} from '../src/win-streaks.mjs';

const logger = {write: async () => {}};
const room = (id, users, istart = 'wait') => ({roomid: String(id), roomname: `M#TT,RANDOM#${id}`, users, istart});

test('status matches rooms.html occupancy while TT alerts use actual duelist seats', async () => {
  const rooms = [room(1, [{pos: 0}, {pos: 7}]), room(2, [{pos: 0}, {pos: 1}], 'start')];
  assert.deepEqual({...roomStatus(rooms, 123)}, {rooms: 2, playing: 1, players: 4, waiting: 1, checkedAt: 123});
  let snapshot = [], alerts = 0;
  const monitor = new MatchMonitor({api: {getRooms: async () => snapshot}, intervalMs: 5000, cooldownMs: 60000,
    onWaiting: async () => { alerts++; }, logger});
  await monitor.poll();
  snapshot = rooms;
  await monitor.poll();
  await monitor.poll();
  assert.equal(alerts, 1);
  assert.equal(monitor.getSnapshot().available, true);
  const service = new CommunityService({api: {getRooms: async () => rooms}, logger, monitor});
  assert.equal((await service.getStatus({cached: true})).players, 4);
  assert.equal((await service.getStatus()).waiting, 1);
});

test('API failure marks cached status unavailable without replaying waiting alerts on recovery', async () => {
  let fail = false, snapshot = [], alerts = 0;
  const monitor = new MatchMonitor({api: {getRooms: async () => { if (fail) throw new Error('offline'); return snapshot; }},
    intervalMs: 5000, cooldownMs: 0, onWaiting: async () => { alerts++; }, logger});
  await monitor.poll();
  fail = true;
  await monitor.poll();
  assert.equal(monitor.getSnapshot().available, false);
  fail = false;
  snapshot = [room(1, [{pos: 0}])];
  await monitor.poll();
  assert.equal(alerts, 0);
  assert.equal(monitor.getSnapshot().available, true);
});

test('top command uses the public monthly API and preserves server ordering', async () => {
  const calls = [];
  const api = new GameApi({baseUrl: 'http://localhost:5000', timeoutMs: 1000}, async (url, options) => {
    calls.push({url: String(url), options});
    return new Response(JSON.stringify({ladder: [{name: 'B', rank: 1}, {name: 'A', rank: 2}]}),
      {status: 200, headers: {'Content-Type': 'application/json'}});
  });
  const response = await new CommunityService({api, logger}).top(['en-us']);
  assert.ok(response.messages[0].indexOf('B') < response.messages[0].indexOf('A'));
  assert.match(calls[0].url, /api\/ladder\?type=month&month=\d{6}&page=1&pageSize=10/);
  assert.equal(calls[0].options.method, undefined);
});

test('ranking appends localized win rate after the existing columns with two decimal places', () => {
  const ladder = [
    {rank: 1, name: 'A', duelPoints: 1200, wins: 2, losses: 1, diff: 1},
    {rank: 2, name: 'B', duelPoints: 1100, wins: '1', losses: '2', diff: -1},
    {rank: 3, name: 'C', duelPoints: 1000, wins: 0, losses: 0, diff: 0},
    {rank: 4, name: 'D', duelPoints: 900, wins: 3, losses: 0, diff: 3}
  ];
  const headers = {
    'zh-cn': '等级分 | 胜场 | 负场 | 胜负差 | 胜率',
    'en-us': 'Points | Wins | Losses | W-L | Win rate',
    'ja-jp': 'レート | 勝 | 敗 | 勝敗差 | 勝率',
    'ko-kr': '점수 | 승 | 패 | 승패차 | 승률'
  };
  for (const [language, header] of Object.entries(headers)) {
    const lines = formatMonthly({ladder}, '202610', [language]).split('\n');
    assert.equal(lines[1], header);
    assert.deepEqual(lines.slice(2), [
      '1. A | 1200 | 2 | 1 | 1 | 66.67%',
      '2. B | 1100 | 1 | 2 | -1 | 33.33%',
      '3. C | 1000 | 0 | 0 | 0 | 0.00%',
      '4. D | 900 | 3 | 0 | 3 | 100.00%'
    ]);
  }
  const combined = formatMonthly({ladder}, '202610', ['en-us', 'zh-cn']);
  assert.ok(combined.split('\n')[1].endsWith('Win rate / 胜率'));
});

test('04:00 schedule persists the attempt across restart and never backfills', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srvpro-bot-'));
  let current = new Date('2026-09-21T19:59:00Z'), calls = 0;
  const stateFile = path.join(dir, 'schedule.json');
  try {
    const make = () => new MonthlyScheduler({stateFile, logger, now: () => current, onMonthly: async () => { calls++; }});
    const first = make();
    await first.load();
    assert.equal(await first.tick(), false);
    current = new Date('2026-09-21T20:00:05Z');
    assert.equal(await first.tick(), true);
    const restarted = make();
    await restarted.load();
    assert.equal(await restarted.tick(), false);
    current = new Date('2026-09-22T20:05:00Z');
    assert.equal(await restarted.tick(), false);
    assert.equal(calls, 1);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('each bot validates only its own platform and keeps status card disabled by default', async () => {
  const root = path.resolve('..', 'discord-bot');
  const config = JSON.parse(await fs.readFile(path.join(root, 'config.default.json'), 'utf8'));
  config.gameApi.baseUrl = 'http://game.example.test:7922';
  config.discord = {enabled: true, applicationId: '123', botToken: 'token', guilds: [{guildId: 'guild',
    channels: [{channelId: 'commands', languages: ['en-us'], commands: true}]}]};
  config.qq = {enabled: false, appSecret: ''};
  assert.equal(validateConfig(config, 'discord', root).statusCard.enabled, false);
  const qqRoot = path.resolve('..', 'qq-bot');
  const qq = JSON.parse(await fs.readFile(path.join(qqRoot, 'config.default.json'), 'utf8'));
  qq.gameApi.baseUrl = 'http://game.example.test:7922';
  qq.qq = {enabled: true, apiBaseUrl: 'https://api.bot.qq.com', appId: 'id', appSecret: 'secret',
    groups: [{groupOpenId: 'group', languages: ['zh-cn']}]};
  qq.discord = {enabled: false, botToken: ''};
  assert.equal(validateConfig(qq, 'qq', qqRoot).qq.enabled, true);
});

test('play guide offers the game pack and the published assistant as distinct paths', async () => {
  const root = path.resolve('..', 'discord-bot');
  const config = JSON.parse(await fs.readFile(path.join(root, 'config.default.json'), 'utf8'));
  const guide = formatPlay(config.guide, ['en-us']);
  assert.match(guide, /A\. New players:.*KoishiPro pack/);
  assert.match(guide, /B\. Already have a compatible YGOPro\/KoishiPro/);
  assert.match(guide, /old ADS client used for ADS Gateball Server is no longer supported/);
  assert.match(guide, /Use a current ADS client or the KoishiPro pack/);
  assert.match(guide, /releases\/latest\/download\/srvprotianti-desktop-windows-x64\.zip/);
  assert.match(guide, /beside ygopro\.exe/);
  assert.match(guide, /install\/update the 1103 environment/);
  assert.match(guide, /does not include the game/);
  for (const language of ['zh-cn', 'ja-jp', 'ko-kr']) {
    const localized = formatPlay(config.guide, [language]);
    assert.ok(localized.includes(config.guide.desktopDownloadUrl));
    assert.ok(localized.includes('ADS Gateball Server'));
  }
  for (const language of ['zh-cn', 'en-us', 'ja-jp', 'ko-kr']) {
    assert.ok(splitLines(formatPlay(config.guide, [language]), 1800).every(chunk => chunk.length <= 1800));
  }
});

const streakRow = (matchId, streak, now) => ({eventId: `match:${matchId}`, matchId, player: 'Player A', streak,
  points: 1234, wins: 8, losses: 2, diff: 6, winRate: 0.8,
  settledAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 59000).toISOString()});

test('streak posts contain all four complete translations and the requested monthly fields', () => {
  const text = formatWinStreak(streakRow(8, 8, Date.now()));
  assert.ok(text.startsWith('Player A玩家当前8连胜！本月等级分1234、胜场8、胜负差6、胜率80.00%。'));
  assert.match(text, /8-match winning streak! This month: rating 1234, wins 8, win-loss difference 6, win rate 80.00%/);
  assert.match(text, /現在8連勝中！今月のレート1234、勝利数8、勝敗差6、勝率80.00%/);
  assert.match(text, /현재 8연승 중입니다! 이번 달 레이팅 1234, 승리 8, 승패차 6, 승률 80.00%/);
  assert.equal(text.split('\n\n').length, 4);
  assert.ok(text.length < 1800);
  assert.ok(!formatWinStreak({...streakRow(8, 8, Date.now()), player: '@everyone\nFake'}).includes('@everyone'));
});

test('streak polling sends only the fresh latest win and persists attempts across restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srvpro-streak-monitor-'));
  let now = Date.now(), ready = false;
  let snapshot = {serverTime: new Date(now).toISOString(), streaks: [streakRow(8, 8, now)]};
  const sent = [], api = {getWinStreaks: async () => snapshot};
  const make = () => new WinStreakMonitor({api, stateFile: path.join(dir, 'state.json'), intervalMs: 5000,
    canNotify: () => ready, onStreak: async row => { sent.push(row.matchId); }, logger, now: () => now});
  try {
    const first = make();
    await first.load();
    await first.poll();
    assert.deepEqual(sent, [], 'wait until Discord is ready');
    ready = true;
    await first.poll();
    await first.poll();
    const restarted = make();
    await restarted.load();
    await restarted.poll();
    assert.deepEqual(sent, [8], 'offline wins 5 through 7 are not reconstructed');
    now += 61000;
    snapshot = {serverTime: new Date(now).toISOString(), streaks: [streakRow(9, 9, now - 61000)]};
    await restarted.poll();
    assert.deepEqual(sent, [8], 'expired results are not replayed');
    snapshot.streaks = [streakRow(10, 10, now), streakRow(11, 11, now)];
    await restarted.poll();
    assert.deepEqual(sent, [8, 11], 'same-player results coalesce to the newest win');
    snapshot.streaks = [];
    await restarted.poll();
    assert.deepEqual(sent, [8, 11], 'a defeated player leaves no pending backlog');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('streak delivery failures are skipped and a later new win can still post', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srvpro-streak-attempt-'));
  const now = Date.now();
  let row = streakRow(5, 5, now), attempts = 0;
  const monitor = new WinStreakMonitor({stateFile: path.join(dir, 'state.json'), intervalMs: 5000,
    api: {getWinStreaks: async () => ({serverTime: new Date(now).toISOString(), streaks: [row]})},
    canNotify: () => true, onStreak: async () => { attempts++; throw new Error('network'); }, logger, now: () => now});
  try {
    await monitor.poll(); await monitor.poll();
    assert.equal(attempts, 1);
    row = streakRow(6, 6, now);
    await monitor.poll();
    assert.equal(attempts, 2);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('streak windows use server-relative time and expire while earlier sends are slow', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srvpro-streak-clock-'));
  let localNow = Date.now();
  const serverNow = localNow - 3600000;
  const row = streakRow(5, 5, serverNow), sent = [];
  const second = {...streakRow(6, 5, serverNow), player: 'Player B', expiresAt: new Date(serverNow + 2000).toISOString()};
  const monitor = new WinStreakMonitor({stateFile: path.join(dir, 'state.json'), intervalMs: 5000,
    api: {getWinStreaks: async () => ({serverTime: new Date(serverNow).toISOString(), streaks: [row, second]})},
    canNotify: () => true, logger, now: () => localNow,
    onStreak: async value => { sent.push(value.matchId); localNow += 3000; }});
  try {
    await monitor.poll();
    assert.deepEqual(sent, [5]);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('streak API validates its public response and never requests player credentials', async () => {
  const now = Date.now(), calls = [];
  let response = {serverTime: new Date(now).toISOString(), windowSeconds: 60, streaks: [streakRow(8, 8, now)]};
  const api = new GameApi({baseUrl: 'http://game.example.test', timeoutMs: 1000}, async (url, options) => {
    calls.push({url: String(url), options}); return new Response(JSON.stringify(response));
  });
  assert.equal((await api.getWinStreaks()).streaks[0].streak, 8);
  assert.match(calls[0].url, /api\/ladder\/streaks$/);
  assert.equal(calls[0].options.body, undefined);
  response = {...response, streaks: [{...response.streaks[0], streak: '8'}]};
  await assert.rejects(api.getWinStreaks(), /invalid win streak data/);
});

test('win streak switches require explicit enablement and a configured target channel', async () => {
  const root = path.resolve('..', 'discord-bot');
  const config = JSON.parse(await fs.readFile(path.join(root, 'config.default.json'), 'utf8'));
  config.gameApi.baseUrl = 'http://game.example.test';
  config.discord = {enabled: true, applicationId: '123', botToken: 'token', guilds: [{guildId: 'guild',
    channels: [{channelId: 'streaks', languages: ['zh-cn'], winStreakAlerts: false}]}]};
  assert.equal(validateConfig(config, 'discord', root).winStreaks.enabled, false);
  config.winStreaks.enabled = true;
  assert.throws(() => validateConfig(config, 'discord', root), /needs a channel/);
  config.discord.guilds[0].channels[0].winStreakAlerts = true;
  assert.equal(validateConfig(config, 'discord', root).winStreaks.enabled, true);
  config.discord.guilds[0].channels[0].winStreakAlerts = 'true';
  assert.throws(() => validateConfig(config, 'discord', root), /must be a boolean/);
});

test('QQ streak switches require both group alerts and proactive permission without changing old configs', async () => {
  const root = path.resolve('..', 'qq-bot');
  const config = JSON.parse(await fs.readFile(path.join(root, 'config.default.json'), 'utf8'));
  config.gameApi.baseUrl = 'http://game.example.test';
  const group = {groupOpenId: 'group', languages: ['zh-cn']};
  config.qq = {enabled: true, apiBaseUrl: 'https://api.bot.qq.com', appId: 'id', appSecret: 'secret', groups: [group]};
  assert.equal(validateConfig(config, 'qq', root).winStreaks.enabled, false);
  config.winStreaks.enabled = true;
  assert.throws(() => validateConfig(config, 'qq', root), /needs a QQ group/);
  group.winStreakAlerts = true;
  assert.throws(() => validateConfig(config, 'qq', root), /proactiveEnabled: true/);
  group.proactiveEnabled = true;
  assert.equal(validateConfig(config, 'qq', root).winStreaks.enabled, true);
  group.proactiveEnabled = 'true';
  assert.throws(() => validateConfig(config, 'qq', root), /proactiveEnabled must be a boolean/);
  group.proactiveEnabled = true;
  group.winStreakAlerts = 'true';
  assert.throws(() => validateConfig(config, 'qq', root), /winStreakAlerts must be a boolean/);
  group.winStreakAlerts = true;
  config.winStreaks.pollSeconds = 0;
  assert.throws(() => validateConfig(config, 'qq', root), /pollSeconds must be 1..60/);
  config.winStreaks.pollSeconds = 5;
  config.winStreaks.stateFile = '../outside.json';
  assert.throws(() => validateConfig(config, 'qq', root), /must stay within/);
});

for (const platform of ['qq', 'discord']) {
  test(`${platform} runtime starts the streak monitor and persists fresh-win deduplication`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'srvpro-runtime-'));
    const defaults = JSON.parse(await fs.readFile(path.resolve('..', `${platform}-bot`, 'config.default.json'), 'utf8'));
    let resolveSent;
    const delivered = new Promise(resolve => { resolveSent = resolve; });
    const sends = [];
    let releaseFirstPoll;
    const firstPollGate = new Promise(resolve => { releaseFirstPoll = resolve; });
    const server = http.createServer((request, response) => {
      const now = Date.now();
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url === '/api/ladder/streaks' ?
        {serverTime: new Date(now).toISOString(), windowSeconds: 60, streaks: [streakRow(8, 8, now)]} :
        request.url.startsWith('/api/ladder?') ? {ladder: []} : {rooms: []}));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let runtime, timeout;
    try {
      defaults.gameApi.baseUrl = `http://127.0.0.1:${server.address().port}`;
      defaults.winStreaks.enabled = true;
      runtime = await startRuntime({root, platform, config: defaults, createAdapter: () => ({
        start() {}, stop() {}, canNotifyWinStreak: () => true,
        notifyWaiting: async () => {}, notifyMonthly: async () => {},
        notifyWinStreak: async (row, deadline) => { sends.push({row, deadline}); resolveSent(); await firstPollGate; }
      })});
      assert.ok(runtime.streakMonitor, 'both platforms must be wired to the shared monitor');
      await Promise.race([delivered, new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('no streak delivered')), 2000);
      })]);
      // The initial background poll still performs a final state write after delivery.
      // Wait for it before invoking another poll, rather than racing the shared temp file.
      let finishFirstPoll;
      const firstPollFinished = new Promise(resolve => { finishFirstPoll = resolve; });
      const save = runtime.streakMonitor.save.bind(runtime.streakMonitor);
      runtime.streakMonitor.save = async () => { await save(); finishFirstPoll(); };
      releaseFirstPoll();
      await firstPollFinished;
      await runtime.streakMonitor.poll();
      assert.equal(sends.length, 1);
      assert.equal(sends[0].row.streak, 8);
      assert.ok(sends[0].deadline > Date.now());
      const state = JSON.parse(await fs.readFile(path.join(root, defaults.winStreaks.stateFile), 'utf8'));
      assert.ok(state.attempted['match:8']);
    } finally {
      clearTimeout(timeout);
      releaseFirstPoll();
      if (runtime) {
        runtime.stop();
        process.removeListener('SIGINT', runtime.stop);
        process.removeListener('SIGTERM', runtime.stop);
        await runtime.service.logger.pending;
      }
      await new Promise(resolve => server.close(resolve));
      await fs.rm(root, {recursive: true, force: true});
    }
  });
}
