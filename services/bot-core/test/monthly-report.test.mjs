import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inflateRawSync} from 'node:zlib';
import test from 'node:test';
import sharp from 'sharp';
import {GameApi} from '../src/api.mjs';
import {MonthlyReports, normalizeReportMonth, reportUsageUrl, imageNames, RequestQueue} from '../src/monthly-report.mjs';
import {MonthlyReportScheduler, monthlyReportDue} from '../src/monthly-report-scheduler.mjs';
import {CARD_METRICS, captionWeightedLength, formatMonthlyReport, reportCaption, reportPercent} from '../src/monthly-report-text.mjs';
import {renderMonthlyReport, renderCardQuery} from '../src/monthly-report-render.mjs';
import {reportZip} from '../src/monthly-report-zip.mjs';
import {validateConfig} from '../src/config.mjs';
import {CommunityService} from '../src/service.mjs';

const now = () => new Date('2026-10-01T02:00:00Z');
const logger = {write: async () => {}};
const fakeRender = async model => imageNames(model.month).map(name => ({name, data: Buffer.from('fake PNG'), description: 'Test figure'}));
function fixture() {
  const stats = {calls: [], active: 0, peak: 0};
  const coverage = {allDecks: 1000, validCardDecks: 800};
  const decks = Array.from({length: 16}, (_, i) => ({deckTypeId: 100 + i, count: 32 - i, usageRate: (32 - i) / 1000,
    names: {en: `Deck ${i}`, ja: `デッキ${i}`, zh: `卡组${i}`, ko: `덱${i}`}}));
  decks.push({deckTypeId: 4095, count: 608, usageRate: .608, names: {en: 'Other'}});
  const call = async (kind, args, result) => {
    stats.calls.push([kind, ...args]); stats.active++; stats.peak = Math.max(stats.peak, stats.active);
    await new Promise(resolve => setImmediate(resolve)); stats.active--;
    return structuredClone(result);
  };
  const api = {
    getDeckUsage: month => call('usage', [month], {month, period: 'month', coverage, decks}),
    getDeckDetail: (month, id) => {
      const d = decks.find(d => d.deckTypeId === id);
      return call('detail', [month, id], {month, period: 'month', selected: {id}, usage: {count: d.count, usageRate: d.usageRate},
        overall: {matches: 30, matchWins: 13}, opponents: [
          {deckTypeId: id, values: {matches: 4, matchWins: 2}},
          {deckTypeId: id === 100 ? 101 : 100, values: {matches: 10, matchWins: 4}},
          {deckTypeId: 999, values: {matches: 16, matchWins: 7}}
        ]});
    },
    getCardUsage: (month, metric, lang) => call('cards', [month, metric, lang], {month, period: 'month', coverage, metric, page: 1,
      cards: Array.from({length: 12}, (_, i) => ({cardId: 10000 + i, deckCount: 800 - i * 20, usageRate: (800 - i * 20) / 800,
        name: lang === 'ja' ? `カード ${i}` : lang === 'ko' ? `카드 ${i}` : lang === 'zh' ? `卡片 ${i}` : `Card ${i}`}))})
  };
  return {api, stats};
}
async function harness(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'srvpro-monthly-'));
  // Only remove this freshly created directory; never a configured artifact root.
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('srvpro-monthly-'));
    await fs.rm(root, {recursive: true, force: true});
  });
  const {api, stats} = fixture();
  return {root, api, stats, reports: new MonthlyReports({api, root, guide: {introUrl: 'https://web.test/1103/intro.html'}, now, render: fakeRender, ...options})};
}

test('QQ report editions fetch only configured card languages, isolate order-sensitive caches and preserve archives', async t => {
  const {reports, stats} = await harness(t);
  const first = await reports.get('202609', ['zh-cn', 'ko-kr']);
  assert.deepEqual(first.model.languages, ['zh', 'ko']);
  assert.deepEqual(Object.keys(first.model.cards.side[0].names), ['zh', 'ko']);
  assert.equal(first.model.cards.side[0].names.zh, '卡片 0');
  assert.equal(first.model.cards.side[0].names.ko, '카드 0');
  assert.equal(stats.calls.length, 26);
  assert.ok(stats.calls.filter(c => c[0] === 'cards').every(c => ['zh', 'ko'].includes(c[3])));
  assert.equal(await reports.get('202609', ['zh-cn', 'ko-kr']), first);
  const second = await reports.get('202609', ['ko-kr', 'zh-cn']);
  assert.notEqual(first.batch, second.batch); assert.equal(reports.cache.size, 2);
  assert.deepEqual((await reports.readBatch(first.model.month, first.batch)).model.languages, ['zh', 'ko']);
  const model = await reports.cardQuery('202609', 'side', ['ja-jp', 'zh-cn']);
  assert.deepEqual(Object.keys(model.cards.side[0].names), ['ja', 'zh']);
});

test('QQ report queries apply group languages to localized images, summaries, errors and links', async t => {
  const {reports} = await harness(t), service = new CommunityService({monthlyReports: reports, logger});
  const response = await service.metaForLanguages({month: '202609', view: 'report', languages: ['ko-kr', 'zh-cn']});
  assert.equal(response.files.length, 4); assert.ok(response.messages[0].includes('월간 통계')); assert.ok(response.messages[1].includes('天梯月报'));
  assert.ok(response.messages[0].includes('L=ko')); assert.ok(response.messages[1].includes('L=zh'));
  const invalid = await service.metaForLanguages({month: '999901', languages: ['zh-cn']});
  assert.match(invalid.messages[0], /不能查询未来月份/); assert.equal(invalid.files, undefined);
  const forbidden = await service.metaForLanguages({month: '202609', view: 'export', languages: ['zh-cn']});
  assert.equal(forbidden.files, undefined);
});

test('multilingual QQ card queries reject conflicting coverage and translated card order', async t => {
  const {reports, api} = await harness(t), original = api.getCardUsage;
  api.getCardUsage = async (...args) => { const response = await original(...args); if (args[2] === 'ko') response.cards.reverse(); return response; };
  await assert.rejects(reports.cardQuery('202609', 'side', ['zh-cn', 'ko-kr']), /inconsistent_response/);
});

test('month validation uses Shanghai, crosses years and rejects silent API fallbacks', () => {
  assert.equal(normalizeReportMonth(null, new Date('2026-12-31T16:00:00Z')), '202612');
  assert.equal(normalizeReportMonth(null, new Date('2026-01-10T00:00:00Z')), '202512');
  assert.equal(normalizeReportMonth('2026-09', now()), '202609');
  assert.equal(normalizeReportMonth('202610', now()), '202610');
  for (const input of ['2026-13', '2026-00', '26-09', '2026-11', ' 202609', '202609x', '../202609']) assert.throws(() => normalizeReportMonth(input, now()), /invalid/);
  const url = new URL(reportUsageUrl({introUrl: 'https://public.test/1103/intro.html?x=y#old'}, '202609'));
  assert.equal(url.pathname, '/1103/usage-stats.html');
  assert.equal(url.search, '?period=month&month=202609&metric=deck&L=en');
  assert.equal(new URL(reportUsageUrl({webBaseUrl: 'https://public.test/a?old=yes#old'}, '202609')).pathname, '/a/usage-stats.html');
  assert.throws(() => reportUsageUrl({webBaseUrl: 'https://u:p@public.test/'}, '202609'));
});

test('public API client supplies fine classification IDs and card API language, not display groups', async () => {
  const requests = [];
  const api = new GameApi({baseUrl: 'https://api.test/', timeoutMs: 1000}, async url => {
    requests.push(new URL(url)); return {ok: true, json: async () => ({})};
  });
  await api.getDeckUsage('202609'); await api.getDeckDetail('202609', 1733); await api.getCardUsage('202609', 'side', 'ja');
  assert.equal(requests[0].pathname, '/api/ladder/usage/decks');
  assert.equal(requests[1].searchParams.get('deckTypeId'), '1733');
  assert.equal(requests[2].searchParams.get('lang'), 'ja');
  assert.equal(requests[2].searchParams.get('page'), '1');
});

test('Top 15 preserve denominators, include outside opponents overall, zero cells, five zones and bilingual names', async t => {
  const {reports, stats} = await harness(t);
  const [a, b] = await Promise.all([reports.get(), reports.get('2026-09')]);
  assert.equal(a, b);
  assert.equal(stats.calls.length, 26); assert.equal(stats.peak, 2);
  assert.equal(a.model.decks.length, 15); assert.equal(a.model.decks[0].deckTypeId, 100);
  assert.equal(a.model.decks[0].usageRate, .032); assert.equal(a.model.otherRate, .608);
  assert.equal(a.model.decks[0].overall.rate, 13 / 30);
  assert.equal(a.model.decks[0].matchups[0].rate, .5);
  assert.equal(a.model.decks[0].matchups[1].rate, .4);
  assert.deepEqual(a.model.decks[0].matchups[2], {matches: 0, wins: 0, rate: null});
  assert.equal(reportPercent(null), '—');
  for (const metric of CARD_METRICS) {
    assert.equal(a.model.cards[metric].length, 10);
    assert.equal(a.model.cards[metric][0].usageRate, 1);
    assert.equal(a.model.cards[metric][0].names.ja, 'カード 0');
  }
  assert.equal(a.files.length, 9);
  assert.equal((await reports.get()).batch, a.batch); assert.equal(stats.calls.length, 26);
  assert.equal((await reports.readBatch(a.model.month, a.batch)).batch, a.batch);
  const text = formatMonthlyReport(a.model);
  assert.ok(text.length < 1800);
  for (const token of ['Main Deck monsters', 'Main Deck spells', 'Main Deck traps', 'Extra Deck', 'Side Deck', '日本語', '한국어', '主卡怪兽', '主卡魔法', '主卡陷阱']) assert.ok(text.includes(token));
  assert.equal((text.match(/https:\/\//g) || []).length, 1);
  assert.ok(captionWeightedLength(reportCaption(a.model)) <= 280);
});

test('inconsistent snapshots retry the complete batch once; malformed or failed responses never save half a report', async t => {
  const {reports, api, stats} = await harness(t);
  const original = api.getCardUsage; let once = true;
  api.getCardUsage = async (...args) => {
    const data = await original(...args);
    if (once) { once = false; data.coverage.validCardDecks--; }
    return data;
  };
  await reports.get(); assert.equal(stats.calls.filter(c => c[0] === 'usage').length, 2);
  reports.cache.clear();
  api.getCardUsage = async (...args) => { const data = await original(...args); data.cards[0].deckCount = -1; return data; };
  await assert.rejects(reports.get(), /invalid_response/);
  reports.cache.clear();
  api.getDeckUsage = async () => { throw Object.assign(new Error('down'), {status: 503}); };
  await assert.rejects(reports.get('202608'), /down/);
  await assert.rejects(fs.stat(path.join(reports.artifactDir, '202608')), {code: 'ENOENT'});
});

test('card query fetches only one localized endpoint; current month is labeled; empty reports do not render', async t => {
  const {reports, api, stats} = await harness(t);
  const query = await reports.cardQuery('202610', 'side', 'ko');
  assert.equal(query.partial, true); assert.equal(query.cards.side[0].names.ko, '카드 0');
  assert.deepEqual(stats.calls, [['cards', '202610', 'side', 'ko']]);
  api.getDeckUsage = async month => ({month, period: 'month', coverage: {allDecks: 0, validCardDecks: 0}, decks: []});
  api.getCardUsage = async (month, metric) => ({month, period: 'month', coverage: {allDecks: 0, validCardDecks: 0}, metric, page: 1, cards: []});
  const empty = await reports.export('202609'); assert.equal(empty.archive, null); assert.deepEqual(empty.files, []);
});

test('published export retains the exact batch across restart and rejects corruption or missing published images', async t => {
  const {reports, api, root} = await harness(t);
  const report = await reports.get(); await reports.markPublished(report);
  api.getDeckUsage = async () => { throw new Error('must not query published history'); };
  const restarted = new MonthlyReports({api, root, guide: reports.guide, now, render: fakeRender});
  assert.equal((await restarted.export()).batch, report.batch);
  assert.equal((await restarted.export()).published, true);
  const png = path.join(reports.artifactDir, '202609', report.batch, imageNames('202609')[0]);
  await fs.writeFile(png, 'changed'); await assert.rejects(restarted.export(), /invalid_artifact/);
  await fs.unlink(png); await assert.rejects(restarted.export(), {code: 'ENOENT'});
  await assert.rejects(restarted.readBatch('../202609', report.batch), /unsafe_path/);
});

test('archives are standard ZIP32 with lossless PNGs, deflated UTF-8 text and known CRC', () => {
  const zip = reportZip([{name: '01.png', data: Buffer.from('123456789')}, {name: 'caption.txt', data: Buffer.from('English 日本語 한국어 中文')}]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(14), 0xcbf43926);
  assert.equal(zip.readUInt16LE(8), 0);
  const next = 30 + zip.readUInt16LE(26) + 9;
  assert.equal(zip.readUInt16LE(next + 8), 8);
  const payload = next + 30 + zip.readUInt16LE(next + 26);
  assert.equal(inflateRawSync(zip.subarray(payload, payload + zip.readUInt32LE(next + 18))).toString(), 'English 日本語 한국어 中文');
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 14), 2);
  assert.throws(() => reportZip([{name: '../token', data: Buffer.from('x')}]), /Invalid/);
});

test('queue limits concurrent work and continues after a failed request', async () => {
  const queue = new RequestQueue(2); let active = 0, peak = 0;
  const results = await Promise.allSettled(Array.from({length: 10}, (_, i) => queue.run(async () => {
    active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--;
    if (i === 2) throw new Error('failed'); return i;
  })));
  assert.equal(peak, 2); assert.equal(results.filter(r => r.status === 'fulfilled').length, 9); assert.equal(queue.active, 0);
});

test('cache expires after five minutes and keeps at most three reports across different months', async t => {
  let instant = now();
  const {reports, stats} = await harness(t, {now: () => instant});
  const first = await reports.get('202609');
  instant = new Date(instant.getTime() + 300001);
  assert.notEqual((await reports.get('202609')).batch, first.batch);
  assert.equal(stats.calls.filter(c => c[0] === 'usage').length, 2);
  for (const month of ['202608', '202607', '202606']) await reports.get(month);
  assert.equal(reports.cache.size, 3); assert.equal(reports.cache.has('202609'), false);
});

test('artifact paths reject directory junctions instead of following them', async t => {
  const {reports, root} = await harness(t);
  const target = path.join(root, 'unexpected'); await fs.mkdir(target);
  await fs.symlink(target, path.join(root, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(reports.get(), /unsafe_path/);
  assert.deepEqual(await fs.readdir(target), []);
});

test('normal queries and exports do not create schedule state; past the window a pending delivery becomes missed', async t => {
  let instant = now();
  const {reports, root} = await harness(t, {config: {enabled: true}, now: () => instant});
  await reports.get(); await reports.export();
  await assert.rejects(fs.stat(path.join(root, reports.config.stateFile)), {code: 'ENOENT'});
  const adapter = {ready: true, monthlyReportTargets: () => [{guildId: 'g', channelId: 'c'}],
    findMonthlyReport: async () => { throw new Error('permission denied'); }, sendMonthlyReport: async () => { throw new Error('must not send'); }};
  const scheduler = new MonthlyReportScheduler({reports, adapter, logger, now: () => instant});
  await scheduler.load(); await scheduler.tick();
  instant = new Date('2026-10-04T02:00:00Z'); await scheduler.tick();
  assert.equal(scheduler.state.deliveries['g:c:202609'].status, 'missed');
});

test('monthly due time handles missed startup, the 72-hour window, exact minute and year rollover', () => {
  const config = {catchUpHours: 72};
  assert.equal(monthlyReportDue(new Date('2026-10-01T01:59:59Z'), config).eligible, false);
  assert.equal(monthlyReportDue(new Date('2026-10-02T03:00:00Z'), config).eligible, true);
  assert.equal(monthlyReportDue(new Date('2026-10-04T02:00:00Z'), config).missed, true);
  assert.equal(monthlyReportDue(new Date('2026-10-01T02:00:59Z'), {catchUpHours: 0}).eligible, true);
  assert.equal(monthlyReportDue(new Date('2026-10-01T02:01:00Z'), {catchUpHours: 0}).eligible, false);
  assert.equal(monthlyReportDue(new Date('2027-01-01T02:00:00Z'), config).month, '202612');
});

test('scheduler persists sending before I/O, isolates target failures and recovers acknowledged sends after restart', async t => {
  let instant = now();
  const {reports, root} = await harness(t, {config: {enabled: true}, now: () => instant});
  const targets = [{guildId: 'g', channelId: 'a'}, {guildId: 'g', channelId: 'b'}], posts = new Map(); let sends = 0;
  const adapter = {ready: true, monthlyReportTargets: () => targets,
    findMonthlyReport: async target => posts.get(target.channelId),
    sendMonthlyReport: async (target, report) => {
      const state = JSON.parse(await fs.readFile(path.join(root, reports.config.stateFile), 'utf8'));
      assert.equal(state.deliveries[`g:${target.channelId}:202609`].status, 'sending');
      assert.equal(state.deliveries[`g:${target.channelId}:202609`].batch, report.batch);
      posts.set(target.channelId, `message-${target.channelId}`); sends++;
      if (target.channelId === 'a') throw Object.assign(new Error('ack lost'), {code: 'timeout'});
      return `message-${target.channelId}`;
    }};
  const scheduler = new MonthlyReportScheduler({reports, adapter, logger, now: () => instant});
  await scheduler.load(); await scheduler.tick();
  assert.equal(sends, 2); assert.equal(scheduler.state.deliveries['g:a:202609'].status, 'sending');
  assert.equal(scheduler.state.deliveries['g:b:202609'].status, 'sent');
  instant = new Date(instant.getTime() + 600000);
  const restarted = new MonthlyReportScheduler({reports, adapter, logger, now: () => instant});
  await restarted.load(); await restarted.tick(); assert.equal(sends, 2);
  assert.equal(restarted.state.deliveries['g:a:202609'].messageId, 'message-a');
  assert.equal((await reports.export()).published, true);
});

test('missing state reconciles history; denied history never sends; damaged state fails closed', async t => {
  const {reports, root} = await harness(t, {config: {enabled: true}}); let sends = 0;
  const adapter = {ready: true, monthlyReportTargets: () => [{guildId: 'g', channelId: 'c'}],
    findMonthlyReport: async () => { throw Object.assign(new Error('denied'), {code: '50013'}); }, sendMonthlyReport: async () => { sends++; }};
  const scheduler = new MonthlyReportScheduler({reports, adapter, logger, now});
  await scheduler.load(); await scheduler.tick(); assert.equal(sends, 0);
  assert.equal(scheduler.state.deliveries['g:c:202609'].status, 'pending');
  await fs.writeFile(path.join(root, reports.config.stateFile), '{bad');
  await assert.rejects(new MonthlyReportScheduler({reports, adapter, logger, now}).load());
});

test('manual last-month resend queues failures past the automatic window and recovers on restart', async t => {
  let instant = new Date('2026-10-11T20:00:00Z'), offline = true, sends = 0;
  const {reports, root} = await harness(t, {config: {enabled: true}, now: () => instant});
  const target = {guildId: 'g', channelId: 'c'}, posts = new Map();
  const adapter = {ready: true, monthlyReportTargets: () => [target], findMonthlyReport: async () => posts.get('id'),
    sendMonthlyReport: async () => { if (offline) throw {code: 'TIMEOUT'}; sends++; posts.set('id', 'posted'); return 'posted'; }};
  const scheduler = new MonthlyReportScheduler({reports, adapter, logger, now: () => instant}); await scheduler.load();
  await assert.rejects(scheduler.resend({...target, channelId: 'wrong'}), /wrong_delivery_channel/);
  await assert.rejects(scheduler.resend(target), error => error.code === 'TIMEOUT');
  const persisted = JSON.parse(await fs.readFile(path.join(root, reports.config.stateFile), 'utf8'));
  assert.equal(persisted.deliveries['g:c:202609'].manual, true);
  instant = new Date(instant.getTime() + 300000); offline = false;
  const restarted = new MonthlyReportScheduler({reports, adapter, logger, now: () => instant}); await restarted.load(); await restarted.tick();
  assert.equal(sends, 1); assert.equal(restarted.state.deliveries['g:c:202609'].status, 'sent');
  assert.equal((await restarted.resend(target)).status, 'existing'); assert.equal(sends, 1);
  posts.clear(); assert.equal((await restarted.resend(target)).status, 'sent'); assert.equal(sends, 2);
});

test('explicit monthly retries work with automatic publication off; corrupt state cannot be bypassed by resend', async t => {
  let instant = new Date('2026-10-11T20:00:00Z'), offline = true, sends = 0;
  const {reports, root} = await harness(t, {config: {enabled: false}, now: () => instant});
  const target = {guildId: 'g', channelId: 'c'};
  const adapter = {ready: true, monthlyReportTargets: () => [target], findMonthlyReport: async () => null,
    sendMonthlyReport: async () => { if (offline) throw {code: 'TIMEOUT'}; sends++; return 'posted'; }};
  const scheduler = new MonthlyReportScheduler({reports, adapter, logger, now: () => instant}); await scheduler.load();
  assert.equal(await scheduler.tick(), false); assert.deepEqual(scheduler.state.deliveries, {});
  await assert.rejects(scheduler.resend(target)); offline = false; instant = new Date(instant.getTime() + 300000);
  await scheduler.tick(); assert.equal(sends, 1);
  const file = path.join(root, reports.config.stateFile); await fs.writeFile(file, '{corrupt');
  const damaged = new MonthlyReportScheduler({reports, adapter, logger, now: () => instant});
  await assert.rejects(damaged.load()); await assert.rejects(damaged.resend(target), /invalid_schedule_state/);
  assert.equal(await fs.readFile(file, 'utf8'), '{corrupt');
});

test('configuration defaults remain off and reject invalid schedule, unsafe paths and missing targets', async () => {
  const root = path.resolve('../discord-bot'), config = JSON.parse(await fs.readFile(path.join(root, 'config.default.json'), 'utf8'));
  config.gameApi.baseUrl = 'https://api.test'; config.discord.enabled = true; config.discord.botToken = 'token'; config.discord.applicationId = 'id';
  assert.equal(validateConfig(config, 'discord', root).monthlyReports.enabled, false);
  config.monthlyReports.enabled = true; assert.throws(() => validateConfig(config, 'discord', root), /monthlyReport: true/);
  config.discord.guilds[0].channels[0].monthlyReport = true;
  assert.equal(validateConfig(config, 'discord', root).monthlyReports.enabled, true);
  config.monthlyReports.hour = 4; assert.throws(() => validateConfig(config, 'discord', root), /10:00/); config.monthlyReports.hour = 10;
  config.monthlyReports.catchUpHours = 169; assert.throws(() => validateConfig(config, 'discord', root), /0..168/); config.monthlyReports.catchUpHours = 72;
  config.monthlyReports.artifactDir = '../outside'; assert.throws(() => validateConfig(config, 'discord', root), /within/);
});

test('packaged font renders four real PNGs and localized card images with long multilingual names', async t => {
  const {reports} = await harness(t);
  const model = await reports.fetchModel('202609');
  model.cards.spell[0].names.en = 'Reinforcement of the Army & Long Name <test>';
  const files = await renderMonthlyReport(model);
  for (let i = 0; i < files.length; i++) {
    const meta = await sharp(files[i].data).metadata();
    assert.equal(meta.format, 'png'); assert.equal(meta.width, i === 0 ? 2880 : 1600); assert.equal(meta.height, i === 0 ? 1920 : 1800);
    assert.ok(files[i].data.length < 4 * 1024 * 1024);
  }
  for (const lang of ['en', 'ja', 'zh', 'ko']) {
    model.cards.side[0].names[lang] = 'English 日本語 한국어 中文 & <quoted>';
    const file = await renderCardQuery(model, 'side', lang);
    assert.ok(file.name.endsWith(`-${lang}.png`)); assert.equal((await sharp(file.data).metadata()).width, 1600);
  }
});
