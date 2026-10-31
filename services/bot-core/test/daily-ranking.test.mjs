import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DailyRankingScheduler} from '../src/daily-ranking-scheduler.mjs';
import {loadConfig} from '../src/config.mjs';
import {acquireInstanceLock} from '../src/instance-lock.mjs';

const logger = {write: async () => {}};
const target = {guildId: 'g', channelId: 'ladder'};
const ranking = {rankingBasis: 'points', ladder: [{rank: 1, name: 'A', duelPoints: 1000, wins: 3, losses: 1, diff: 2}]};

async function harness(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'srvpro-daily-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  let current = new Date('2026-10-11T20:00:00Z'), calls = 0;
  const posts = new Map();
  const adapter = {ready: true, top10Targets: () => [target],
    findDailyRanking: async (t, date) => posts.get(`${t.channelId}:${date}`),
    sendDailyRanking: async (t, data, month, date) => { calls++; posts.set(`${t.channelId}:${date}`, `id-${calls}`); return `id-${calls}`; }};
  const api = {getMonthlyTop10: async month => { assert.equal(month, '202610'); return ranking; }};
  const stateFile = path.join(root, 'schedule.json');
  const make = () => new DailyRankingScheduler({stateFile, api, adapter, logger, now: () => current});
  return {root, stateFile, api, adapter, posts, make, advance: ms => { current = new Date(current.getTime() + ms); },
    setTime: value => { current = new Date(value); }, calls: () => calls};
}

test('daily ranking catches up after 04:00 and legacy lastAttempt is reconciled per target', async t => {
  const h = await harness(t);
  await fs.writeFile(h.stateFile, JSON.stringify({lastAttempt: '2026-10-12'}));
  h.setTime('2026-10-11T19:59:59Z');
  const scheduler = h.make(); await scheduler.load(); assert.equal(await scheduler.tick(), false);
  h.setTime('2026-10-11T23:15:00Z');
  await scheduler.tick(); assert.equal(h.calls(), 1);
  const restarted = h.make(); await restarted.load(); await restarted.tick(); assert.equal(h.calls(), 1);
  assert.equal(restarted.state.deliveries['g:ladder:2026-10-12'].status, 'sent');
});

test('API failure and restart remain retryable after the original scheduled minute', async t => {
  const h = await harness(t); let offline = true;
  h.api.getMonthlyTop10 = async () => { if (offline) throw {code: 'ECONNRESET'}; return ranking; };
  const first = h.make(); await first.load(); await first.tick(); assert.equal(h.calls(), 0);
  offline = false;
  const restarted = h.make(); await restarted.load(); await restarted.tick(); assert.equal(h.calls(), 0);
  h.advance(60000); await restarted.tick(); assert.equal(h.calls(), 1);
});

test('lost acknowledgement recovers the actual message without reposting or refetching', async t => {
  const h = await harness(t), send = h.adapter.sendDailyRanking;
  h.adapter.sendDailyRanking = async (...args) => { await send(...args); throw {code: 'UND_ERR_CONNECT_TIMEOUT'}; };
  const first = h.make(); await first.load(); await first.tick(); assert.equal(h.calls(), 1);
  assert.equal(JSON.parse(await fs.readFile(h.stateFile, 'utf8')).deliveries['g:ladder:2026-10-12'].status, 'sending');
  h.api.getMonthlyTop10 = async () => { throw new Error('must reuse the receipt'); };
  h.advance(60000); const restarted = h.make(); await restarted.load(); await restarted.tick();
  assert.equal(h.calls(), 1); assert.equal(restarted.state.deliveries['g:ladder:2026-10-12'].messageId, 'id-1');
});

test('state save failure does not consume the day; sending is persisted before Discord I/O', async t => {
  const h = await harness(t), scheduler = h.make(); await scheduler.load();
  const save = scheduler.save.bind(scheduler); let fail = true;
  scheduler.save = async () => { if (fail) { fail = false; throw {code: 'ENOENT'}; } await save(); };
  await scheduler.tick(); assert.equal(h.calls(), 0);
  h.adapter.sendDailyRanking = async () => {
    assert.equal(JSON.parse(await fs.readFile(h.stateFile, 'utf8')).deliveries['g:ladder:2026-10-12'].status, 'sending');
    return 'posted';
  };
  h.advance(60000); await scheduler.tick(); assert.equal(scheduler.state.deliveries['g:ladder:2026-10-12'].status, 'sent');
});

test('history permission failure never means absent and target failures do not block other channels', async t => {
  const h = await harness(t), other = {...target, channelId: 'other'};
  h.adapter.top10Targets = () => [target, other];
  h.adapter.findDailyRanking = async t => { if (t.channelId === 'ladder') throw {code: '50013'}; return null; };
  const scheduler = h.make(); await scheduler.load(); await scheduler.tick();
  assert.equal(h.calls(), 1); assert.equal(scheduler.state.deliveries['g:ladder:2026-10-12'].status, 'pending');
  assert.equal(scheduler.state.deliveries['g:other:2026-10-12'].status, 'sent');
  await assert.rejects(scheduler.resend({...target, channelId: 'wrong'}), /wrong_delivery_channel/);
});

test('manual daily resend checks deleted messages and excludes concurrent automatic sends', async t => {
  const h = await harness(t), scheduler = h.make(); await scheduler.load(); await scheduler.tick();
  assert.equal((await scheduler.resend(target)).status, 'existing'); assert.equal(h.calls(), 1);
  h.posts.clear(); assert.equal((await scheduler.resend(target)).status, 'sent'); assert.equal(h.calls(), 2);
  let release;
  h.adapter.findDailyRanking = () => new Promise(resolve => { release = resolve; });
  const pending = scheduler.resend(target);
  await assert.rejects(scheduler.resend(target), /delivery_busy/);
  assert.equal(await scheduler.tick(), false); release('id-2'); await pending;
});

test('Discord ignores an inherited old config path and duplicate workers are rejected', async t => {
  const h = await harness(t);
  const config = JSON.parse(await fs.readFile(path.resolve('../discord-bot/config.default.json'), 'utf8'));
  config.gameApi.baseUrl = 'https://api.test'; config.discord.enabled = true;
  config.discord.botToken = 'test-token'; config.discord.applicationId = 'test-id';
  await fs.writeFile(path.join(h.root, 'config.default.json'), JSON.stringify(config));
  await fs.writeFile(path.join(h.root, 'config.json'), '{}');
  const original = process.env.BOT_CONFIG_PATH; process.env.BOT_CONFIG_PATH = '../missing-service/does-not-exist.json';
  try { assert.equal(loadConfig(h.root, 'discord').discord.applicationId, 'test-id'); }
  finally { if (original === undefined) delete process.env.BOT_CONFIG_PATH; else process.env.BOT_CONFIG_PATH = original; }
  const release = acquireInstanceLock(h.root);
  try { assert.throws(() => acquireInstanceLock(h.root), /already running/); }
  finally { release(); process.removeListener('exit', release); }
  const again = acquireInstanceLock(h.root); again(); process.removeListener('exit', again);
});
