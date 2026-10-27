import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import sharp from 'sharp';
import {QqScheduler} from '../src/qq-scheduler.mjs';
import {acquireInstanceLock} from '../src/instance-lock.mjs';
import {createWorkerSupervisor} from '../src/worker-supervisor.mjs';
import {formatWinStreak} from '../src/i18n.mjs';
import {chartSvg, chartPng} from '../src/chart.mjs';
import {localizedCardsFigure, localizedDeckFigure} from '../src/localized-report-render.mjs';
import {imageCopy} from '../src/languages.mjs';
import {validateConfig} from '../src/config.mjs';

const logger = {write: async () => {}};
async function harness(t, kind = 'daily') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'srvpro-qq-schedule-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fs.rm(root, {recursive: true, force: true});
  });
  let current = new Date(kind === 'daily' ? '2026-10-12T01:00:00Z' : '2026-10-01T02:00:00Z');
  const sent = [], groups = [{groupOpenId: 'one', languages: ['zh-cn']}];
  const adapter = {ready: true, scheduledTargets: () => groups, canNotifyScheduled: () => true,
    prepareScheduled: async (kind, group, period) => ({kind, period, languages: group.languages, total: kind === 'daily' ? 1 : 4}),
    prepareScheduledPart: async (group, snapshot, index) => ({group: group.groupOpenId, index}),
    sendScheduledPart: async (_group, part) => { sent.push(part); return `id-${sent.length}`; }};
  const stateFile = path.join(root, 'state.json'), config = {enabled: true, catchUpHours: 72};
  const make = () => new QqScheduler({root, stateFile, kind, adapter, config, logger, now: () => current});
  return {root, stateFile, sent, groups, adapter, config, make, advance: ms => { current = new Date(current.getTime() + ms); }, setTime: value => { current = new Date(value); }};
}
test('QQ daily catches up until midnight, persists receipts and never sends an older day', async t => {
  const h = await harness(t), scheduler = h.make();
  await scheduler.load(); await scheduler.tick(); assert.equal(h.sent.length, 1);
  const restart = h.make(); await restart.load(); await restart.tick(); assert.equal(h.sent.length, 1);
  h.setTime('2026-10-12T16:01:00Z'); await restart.tick(); assert.equal(h.sent.length, 1);
  h.setTime('2026-10-12T20:01:00Z'); await restart.tick(); assert.equal(h.sent.length, 2);
  assert.equal(restart.state.deliveries['one:2026-10-12'].status, 'sent');
});
test('QQ definite rejection retries after one minute, reuses snapshot and isolates groups', async t => {
  const h = await harness(t); h.groups.push({groupOpenId: 'two', languages: ['en-us']});
  let fail = true, snapshots = 0;
  const prepare = h.adapter.prepareScheduled;
  h.adapter.prepareScheduled = async (...args) => { snapshots++; return prepare(...args); };
  const send = h.adapter.sendScheduledPart;
  h.adapter.sendScheduledPart = async (target, part) => {
    if (fail && target.groupOpenId === 'one') throw {code: '429', deliveryUncertain: false};
    return send(target, part);
  };
  const scheduler = h.make(); await scheduler.load(); await scheduler.tick(); assert.equal(h.sent.length, 1);
  fail = false; await scheduler.tick(); assert.equal(h.sent.length, 1);
  h.advance(60000); await scheduler.tick(); assert.equal(h.sent.length, 2); assert.equal(snapshots, 2);
});
test('QQ acknowledgement loss holds that part across restart and does not resend it', async t => {
  const h = await harness(t);
  h.adapter.sendScheduledPart = async (_group, part) => { h.sent.push(part); throw {deliveryUncertain: true}; };
  const scheduler = h.make(); await scheduler.load(); await scheduler.tick(); assert.equal(h.sent.length, 1);
  h.advance(3600000); const restart = h.make(); await restart.load(); await restart.tick();
  assert.equal(h.sent.length, 1); assert.equal(restart.state.deliveries['one:2026-10-12'].status, 'uncertain');
});
test('QQ monthly resumes remaining images only, even when a group language config changes', async t => {
  const h = await harness(t, 'monthly'), send = h.adapter.sendScheduledPart;
  let fail = true;
  h.adapter.sendScheduledPart = async (group, part) => {
    if (fail && part.index === 2) throw {code: '22009', deliveryUncertain: false};
    return send(group, part);
  };
  const first = h.make(); await first.load(); await first.tick(); assert.equal(h.sent.length, 2);
  h.groups[0].languages = ['en-us']; h.advance(300000); fail = false;
  const restart = h.make(); await restart.load(); await restart.tick();
  assert.deepEqual(h.sent.map(p => p.index), [0, 1, 2, 3]);
  assert.deepEqual(restart.state.deliveries['one:202609'].snapshot.languages, ['zh-cn']);
});
test('QQ unacknowledged crash, legacy attempts and failed receipt persistence do not duplicate', async t => {
  const h = await harness(t);
  await fs.writeFile(h.stateFile, JSON.stringify({lastAttempt: '2026-10-12'}));
  const legacy = h.make(); await legacy.load(); await legacy.tick(); assert.equal(h.sent.length, 0);
  const entry = legacy.state.deliveries['one:2026-10-12'];
  entry.status = 'sending'; await legacy.save();
  const restart = h.make(); await restart.load(); await restart.tick(); assert.equal(h.sent.length, 0);
  entry.status = 'pending'; const save = legacy.save.bind(legacy);
  legacy.save = async () => { if (entry.next > 0) throw {code: 'EIO'}; return save(); };
  await assert.rejects(legacy.tick(), error => error.code === 'EIO'); assert.equal(h.sent.length, 1);
  const after = h.make(); await after.load(); await after.tick(); assert.equal(h.sent.length, 1);
});
test('QQ monthly respects disabled publication and the 72-hour window; temp groups wait', async t => {
  const h = await harness(t, 'monthly'), scheduler = h.make(); await scheduler.load();
  h.config.enabled = false; await scheduler.tick(); assert.equal(h.sent.length, 0);
  h.config.enabled = true; h.adapter.canNotifyScheduled = () => false; await scheduler.tick(); assert.equal(h.sent.length, 0);
  h.adapter.canNotifyScheduled = () => true; h.advance(72 * 3600000); await scheduler.tick();
  assert.equal(h.sent.length, 0); assert.equal(scheduler.state.deliveries['one:202609'].status, 'missed');
});
test('QQ stops before visible sending when upload crosses midnight or monthly recovery deadline', async t => {
  for (const kind of ['daily', 'monthly']) {
    const h = await harness(t, kind);
    h.setTime(kind === 'daily' ? '2026-10-12T15:59:30Z' : '2026-10-04T01:59:30Z');
    h.adapter.prepareScheduledPart = async () => { h.advance(60000); return {}; };
    const scheduler = h.make(); await scheduler.load(); await scheduler.tick(); assert.equal(h.sent.length, 0);
  }
});

test('QQ config validates report targets, all group switches and safe paths', async () => {
  const root = path.resolve('../qq-bot'), config = JSON.parse(await fs.readFile(path.join(root, 'config.default.json'), 'utf8'));
  config.gameApi.baseUrl = 'https://api.test'; config.qq.enabled = true; config.qq.appId = 'id'; config.qq.appSecret = 'secret';
  const group = config.qq.groups[0]; group.groupOpenId = 'one';
  assert.equal(validateConfig(config, 'qq', root).monthlyReports.enabled, false);
  config.monthlyReports.enabled = true; assert.throws(() => validateConfig(config, 'qq', root), /needs a QQ group/);
  group.monthlyReport = true; group.proactiveEnabled = true; validateConfig(config, 'qq', root);
  group.monthlyReport = 'true'; assert.throws(() => validateConfig(config, 'qq', root), /must be a boolean/);
  group.monthlyReport = true; config.monthlyReports.stateFile = '../escape.json'; assert.throws(() => validateConfig(config, 'qq', root), /must stay within/);
});
test('QQ lock excludes duplicate workers, is separate from Discord and releases cleanly', async t => {
  const h = await harness(t), qq = acquireInstanceLock(h.root, 'qq'), discord = acquireInstanceLock(h.root);
  try { assert.throws(() => acquireInstanceLock(h.root, 'qq'), error => error.code === 'BOT_ALREADY_RUNNING'); }
  finally { qq(); discord(); }
  const again = acquireInstanceLock(h.root, 'qq'); again();
});
test('QQ supervisor backs off, preserves migration config and stops on duplicate-worker exit', () => {
  const children = [], scheduled = [], cancelled = [];
  const supervisor = createWorkerSupervisor({root: 'root', platform: 'qq', env: {BOT_CONFIG_PATH: 'custom.json'}, write() {},
    spawnImpl: (_node, _args, options) => { assert.equal(options.env.BOT_CONFIG_PATH, 'custom.json'); assert.equal(options.windowsHide, true);
      const child = new EventEmitter(); child.kill = () => {}; children.push(child); return child; },
    schedule: (fn, ms) => { scheduled.push({fn, ms}); return scheduled.length; }, cancel: id => cancelled.push(id), exited: code => { assert.equal(code, 73); }});
  supervisor.start(); children[0].emit('close', 1); assert.equal(scheduled[0].ms, 5000);
  scheduled[0].fn(); children[1].emit('close', 1); assert.equal(scheduled[1].ms, 10000);
  scheduled[1].fn(); children[2].emit('close', 73); assert.equal(scheduled.length, 2);
});
test('configured languages select and order streaks and every chart label', async () => {
  const row = {player: 'Alice', streak: 5, points: 1000, wins: 5, diff: 5, winRate: 1};
  const text = formatWinStreak(row, ['ko-kr', 'zh-cn']);
  assert.ok(text.startsWith('Alice 플레이어')); assert.ok(text.indexOf('플레이어') < text.indexOf('玩家')); assert.ok(!text.includes('Player '));
  const svg = chartSvg([{pointsBefore: 1000, pointsAfter: 1100}], ['ja-jp', 'zh-cn']);
  assert.ok(svg.indexOf(imageCopy.ja.rating) < svg.indexOf(imageCopy.zh.rating)); assert.ok(!svg.includes(imageCopy.en.rating));
  const png = await chartPng([{pointsBefore: 1000, pointsAfter: 1100}], ['ja-jp', 'zh-cn']);
  assert.equal((await sharp(png).metadata()).height, 416);
});
test('localized image instructions exclude unselected languages and render all configured names', async () => {
  const names = {zh: '中文卡片', en: 'English Card', ja: '日本語カード', ko: '한국어 카드'};
  const model = {month: '202609', generatedAt: '2026-10-01T02:00:00Z', coverage: {allDecks: 100, validCardDecks: 80},
    topRate: .1, otherRate: .9, decks: [{names, count: 10, usageRate: .1, overall: {matches: 20, rate: .5}, matchups: [{matches: 20, rate: .5}]}],
    cards: {monster: [{names, cardId: 1, deckCount: 40, usageRate: .5}]}};
  const chinese = localizedCardsFigure(model, ['monster'], ['zh-cn']);
  assert.ok(chinese.texts.some(t => t.text === names.zh));
  for (const value of [names.en, names.ja, names.ko, imageCopy.en.generated, imageCopy.en.cardNote]) assert.ok(!chinese.texts.some(t => t.text.includes(value)));
  const all = localizedDeckFigure(model, ['ko-kr', 'zh-cn', 'ja-jp', 'en-us']);
  const renderedNames = all.texts.filter(t => Object.values(names).includes(t.text)).map(t => t.text);
  assert.deepEqual(renderedNames, [names.ko, names.zh, names.ja, names.en]);
  const image = await all.png(); assert.equal((await sharp(image).metadata()).width, 3080);
});
