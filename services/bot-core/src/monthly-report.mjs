import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {shanghaiDay} from './api.mjs';
import {CARD_METRICS, reportCaption, reportSummary} from './monthly-report-text.mjs';
import {reportZip} from './monthly-report-zip.mjs';

export const MONTHLY_REPORT_DEFAULTS = Object.freeze({enabled: false, timezone: 'Asia/Shanghai', day: 1, hour: 10, minute: 0,
  catchUpHours: 72, webBaseUrl: '', stateFile: 'data/monthly-report-state.json', artifactDir: 'data/monthly-reports'});
export class ReportError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function normalizeReportMonth(input, now = new Date()) {
  const current = shanghaiDay(now).month;
  if (input === undefined || input === null || input === '') {
    const y = Number(current.slice(0, 4)), m = Number(current.slice(4));
    return `${m === 1 ? y - 1 : y}${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`;
  }
  if (typeof input !== 'string' || !/^[1-9]\d{3}-?(0[1-9]|1[0-2])$/.test(input)) throw new ReportError('invalid');
  const month = input.replace('-', '');
  if (month > current) throw new ReportError('invalid');
  return month;
}
export function reportUsageUrl({webBaseUrl = '', introUrl}, month) {
  const base = webBaseUrl ? new URL(webBaseUrl) : new URL('.', introUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new ReportError('invalid_web_url');
  base.search = ''; base.hash = '';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const url = new URL('usage-stats.html', base);
  url.search = new URLSearchParams({period: 'month', month, metric: 'deck', L: 'en'}).toString();
  url.hash = '';
  return url.toString();
}
const integer = value => Number.isSafeInteger(value) && value >= 0;
const rate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const bad = () => { throw new ReportError('invalid_response'); };
function coverage(data, month) {
  if (data?.month !== month || data.period !== 'month' || !integer(data.coverage?.allDecks) || !integer(data.coverage?.validCardDecks) ||
      data.coverage.validCardDecks > data.coverage.allDecks) bad();
  return data.coverage;
}
function equalCoverage(a, b) {
  if (a.allDecks !== b.allDecks || a.validCardDecks !== b.validCardDecks) throw new ReportError('inconsistent_response');
}
function checkedNames(names, id) {
  if (!names || typeof names !== 'object') bad();
  const result = {};
  for (const lang of ['en', 'ja', 'zh', 'ko']) if (typeof names[lang] === 'string') result[lang] = names[lang].replace(/[\x00-\x1f]/g, ' ').slice(0, 256);
  if (!Object.keys(result).length) result.zh = String(id);
  return result;
}
function winStat(values) {
  if (!integer(values?.matches) || !integer(values?.matchWins) || values.matchWins > values.matches) bad();
  return {matches: values.matches, wins: values.matchWins, rate: values.matches ? values.matchWins / values.matches : null};
}
const validUsageRate = (count, denominator, value) => rate(value) && Math.abs(value - (denominator ? count / denominator : 0)) < 1e-8;

export class RequestQueue {
  constructor(limit = 2) { this.limit = limit; this.active = 0; this.waiting = []; }
  async run(operation) {
    if (this.active >= this.limit) await new Promise(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await operation(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
}

export class MonthlyReports {
  constructor({api, root, config = {}, guide, now = () => new Date(), render, cacheTtlMs = 300000}) {
    Object.assign(this, {api, root: path.resolve(root), guide, now, render, cacheTtlMs});
    this.config = {...MONTHLY_REPORT_DEFAULTS, ...config};
    this.artifactDir = path.resolve(this.root, this.config.artifactDir);
    if (!this.artifactDir.startsWith(this.root + path.sep)) throw new ReportError('invalid_artifact_path');
    this.queue = new RequestQueue(2);
    this.cache = new Map(); this.inflight = new Map(); this.renderQueue = new RequestQueue(1);
  }
  async fetchModel(month) {
    const usage = await this.queue.run(() => this.api.getDeckUsage(month));
    const totals = coverage(usage, month);
    if (!Array.isArray(usage.decks) || usage.decks.length > 10000) bad();
    const ids = new Set();
    for (const deck of usage.decks) {
      if (!integer(deck.deckTypeId) || !deck.deckTypeId || ids.has(deck.deckTypeId) || !integer(deck.count) || deck.count > totals.allDecks ||
          !validUsageRate(deck.count, totals.allDecks, deck.usageRate)) bad();
      ids.add(deck.deckTypeId);
    }
    if (usage.decks.reduce((n, d) => n + d.count, 0) !== totals.allDecks) bad();
    const selected = usage.decks.filter(d => d.deckTypeId !== 4095).sort((a, b) => b.count - a.count || a.deckTypeId - b.deckTypeId).slice(0, 15);
    const details = await Promise.all(selected.map(d => this.queue.run(() => this.api.getDeckDetail(month, d.deckTypeId))));
    const decks = selected.map((deck, i) => {
      const detail = details[i];
      if (detail?.month !== month || detail.period !== 'month' || detail.selected?.id !== deck.deckTypeId || !Array.isArray(detail.opponents)) bad();
      if (detail.usage?.count !== deck.count || detail.usage?.usageRate !== deck.usageRate) throw new ReportError('inconsistent_response');
      const byId = new Map();
      for (const opponent of detail.opponents) {
        if (!integer(opponent.deckTypeId) || byId.has(opponent.deckTypeId)) bad();
        byId.set(opponent.deckTypeId, winStat(opponent.values));
      }
      const overall = winStat(detail.overall);
      if ([...byId.values()].reduce((n, s) => n + s.matches, 0) !== overall.matches ||
          [...byId.values()].reduce((n, s) => n + s.wins, 0) !== overall.wins) bad();
      return {deckTypeId: deck.deckTypeId, names: checkedNames(deck.names, deck.deckTypeId), count: deck.count, usageRate: deck.usageRate,
        overall, matchups: selected.map(other => byId.get(other.deckTypeId) || {matches: 0, wins: 0, rate: null})};
    });
    const cards = {};
    await Promise.all(CARD_METRICS.map(async metric => {
      const responses = await Promise.all(['en', 'ja'].map(lang => this.queue.run(() => this.api.getCardUsage(month, metric, lang))));
      const lists = responses.map(data => {
        equalCoverage(totals, coverage(data, month));
        if (data.metric !== metric || data.page !== 1 || !Array.isArray(data.cards) || data.cards.length > 50) bad();
        const cardIds = new Set();
        data.cards.forEach(card => {
          if (!integer(card.cardId) || !card.cardId || cardIds.has(card.cardId) || typeof card.name !== 'string' || !integer(card.deckCount) ||
              card.deckCount > totals.validCardDecks || !validUsageRate(card.deckCount, totals.validCardDecks, card.usageRate)) bad();
          cardIds.add(card.cardId);
        });
        return data.cards.slice(0, 10);
      });
      if (lists[0].length !== lists[1].length) throw new ReportError('inconsistent_response');
      cards[metric] = lists[0].map((card, i) => {
        const jp = lists[1][i];
        if (card.cardId !== jp.cardId || card.deckCount !== jp.deckCount || card.usageRate !== jp.usageRate) throw new ReportError('inconsistent_response');
        return {cardId: card.cardId, names: checkedNames({en: card.name, ja: jp.name}, card.cardId), deckCount: card.deckCount, usageRate: card.usageRate};
      });
    }));
    return {schemaVersion: 1, layoutVersion: 1, month, generatedAt: this.now().toISOString(), partial: month === shanghaiDay(this.now()).month,
      coverage: totals, decks, cards, otherRate: usage.decks.find(d => d.deckTypeId === 4095)?.usageRate || 0,
      topRate: decks.reduce((sum, d) => sum + d.usageRate, 0),
      usageUrl: reportUsageUrl({webBaseUrl: this.config.webBaseUrl, introUrl: this.guide.introUrl}, month)};
  }
  async get(input) {
    const month = normalizeReportMonth(input, this.now()), cached = this.cache.get(month);
    if (cached && this.now().getTime() - cached.time < this.cacheTtlMs) return cached.report;
    if (this.inflight.has(month)) return this.inflight.get(month);
    const task = this.generate(month).then(report => {
      this.cache.delete(month); this.cache.set(month, {time: this.now().getTime(), report});
      while (this.cache.size > 3 || [...this.cache.values()].reduce((n, c) => n + c.report.files.reduce((s, f) => s + f.data.length, 0), 0) > 24 * 1024 * 1024) this.cache.delete(this.cache.keys().next().value);
      return report;
    }).finally(() => this.inflight.delete(month));
    this.inflight.set(month, task);
    return task;
  }
  async generate(month) {
    let model;
    try { model = await this.fetchModel(month); }
    catch (error) { if (error.code !== 'inconsistent_response') throw error; model = await this.fetchModel(month); }
    if (!model.coverage.allDecks) return {model, files: [], batch: null};
    return this.renderQueue.run(async () => {
      const renderer = this.render || (await import('./monthly-report-render.mjs')).renderMonthlyReport;
      const images = await renderer(model);
      if (images.length !== 4 || images.some((f, i) => f.name !== imageNames(month)[i] || !Buffer.isBuffer(f.data) || !f.data.length || f.data.length > 4 * 1024 * 1024)) throw new ReportError('invalid_images');
      const files = [...images,
        {name: 'x-caption.txt', data: Buffer.from(reportCaption(model) + '\n')},
        {name: 'x-alt-text.txt', data: Buffer.from(images.map(f => `${f.name}\n${f.description}`).join('\n\n') + '\n')},
        {name: 'report-data.json', data: Buffer.from(JSON.stringify(model, null, 2) + '\n')},
        {name: 'report-summary.txt', data: Buffer.from(reportSummary(model) + '\n')}];
      const batch = createHash('sha256').update(JSON.stringify(model)).digest('hex').slice(0, 24);
      const manifest = {version: 1, month, batch, generatedAt: model.generatedAt,
        files: files.map(f => ({name: f.name, description: f.description || null, bytes: f.data.length, sha256: createHash('sha256').update(f.data).digest('hex')}))};
      files.push({name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n')});
      const report = {model, batch, files};
      await this.save(report);
      return report;
    });
  }
  async safeDirectory(directory, create = true) {
    const resolved = path.resolve(directory);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) throw new ReportError('unsafe_path');
    const relative = path.relative(this.root, resolved);
    let current = this.root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (create) await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ReportError('unsafe_path');
    }
    return resolved;
  }
  async save(report) {
    const monthDir = await this.safeDirectory(path.join(this.artifactDir, report.model.month));
    const target = path.join(monthDir, report.batch), temp = await this.safeDirectory(path.join(monthDir, `.tmp-${randomUUID()}`));
    for (const file of report.files) await fs.writeFile(path.join(temp, file.name), file.data, {flag: 'wx'});
    try { await fs.rename(temp, target); }
    catch (error) {
      // A failed commit is kept for inspection; never replace an existing published batch.
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      await this.readBatch(report.model.month, report.batch);
    }
  }
  async readBatch(month, batch) {
    if (!/^[1-9]\d{3}(0[1-9]|1[0-2])$/.test(month) || !/^[a-f0-9]{24}$/.test(batch)) throw new ReportError('unsafe_path');
    const dir = await this.safeDirectory(path.join(this.artifactDir, month, batch), false);
    const read = async (name, max = 4 * 1024 * 1024) => {
      const file = path.join(dir, name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new ReportError('invalid_artifact');
      return fs.readFile(file);
    };
    const manifest = JSON.parse(await read('manifest.json', 65536));
    const allowed = new Set([...imageNames(month), 'x-caption.txt', 'x-alt-text.txt', 'report-data.json', 'report-summary.txt']);
    if (manifest.version !== 1 || manifest.month !== month || manifest.batch !== batch || !Array.isArray(manifest.files) ||
        manifest.files.length !== allowed.size || new Set(manifest.files.map(f => f.name)).size !== allowed.size) throw new ReportError('invalid_artifact');
    const files = [];
    for (const entry of manifest.files) {
      if (!allowed.has(entry.name)) throw new ReportError('invalid_artifact');
      const data = await read(entry.name);
      if (data.length !== entry.bytes || createHash('sha256').update(data).digest('hex') !== entry.sha256) throw new ReportError('invalid_artifact');
      files.push({name: entry.name, data, description: entry.description});
    }
    files.push({name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n')});
    const model = JSON.parse(files.find(f => f.name === 'report-data.json').data);
    if (model.month !== month || model.schemaVersion !== 1 || createHash('sha256').update(JSON.stringify(model)).digest('hex').slice(0, 24) !== batch) throw new ReportError('invalid_artifact');
    return {model, batch, files};
  }
  async markPublished(report) {
    const directory = await this.safeDirectory(path.join(this.artifactDir, report.model.month));
    const temp = path.join(directory, `.published-${randomUUID()}.tmp`);
    await fs.writeFile(temp, JSON.stringify({version: 1, batch: report.batch}) + '\n', {flag: 'wx'});
    await fs.rename(temp, path.join(directory, 'published.json'));
  }
  async export(input) {
    const month = normalizeReportMonth(input, this.now());
    let report, reference, published = false;
    try {
      const monthDir = await this.safeDirectory(path.join(this.artifactDir, month), false);
      const file = path.join(monthDir, 'published.json'), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new ReportError('invalid_artifact');
      reference = JSON.parse(await fs.readFile(file, 'utf8'));
      if (reference.version !== 1) throw new ReportError('invalid_artifact');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (reference) { report = await this.readBatch(month, reference.batch); published = true; }
    else report = await this.get(month);
    return {...report, published, archive: report.files.length ? {name: `ocg1103-meta-${month}.zip`, data: reportZip(report.files)} : null};
  }
  async cardQuery(input, metric, language) {
    const month = normalizeReportMonth(input, this.now());
    if (!CARD_METRICS.includes(metric) || !['en', 'ja', 'zh', 'ko'].includes(language)) throw new ReportError('invalid');
    const response = await this.queue.run(() => this.api.getCardUsage(month, metric, language));
    const totals = coverage(response, month);
    if (response.metric !== metric || response.page !== 1 || !Array.isArray(response.cards) || response.cards.length > 50) bad();
    const ids = new Set();
    const cards = response.cards.slice(0, 10).map(card => {
      if (!integer(card.cardId) || !card.cardId || ids.has(card.cardId) || typeof card.name !== 'string' || !integer(card.deckCount) ||
          card.deckCount > totals.validCardDecks || !validUsageRate(card.deckCount, totals.validCardDecks, card.usageRate)) bad();
      ids.add(card.cardId);
      return {cardId: card.cardId, names: checkedNames({[language]: card.name}, card.cardId), deckCount: card.deckCount, usageRate: card.usageRate};
    });
    return {month, coverage: totals, generatedAt: this.now().toISOString(), partial: month === shanghaiDay(this.now()).month,
      decks: [], cards: {[metric]: cards}, usageUrl: reportUsageUrl({webBaseUrl: this.config.webBaseUrl, introUrl: this.guide.introUrl}, month)};
  }
}
export const imageNames = month => [`01-decks-${month}.png`, `02-monsters-${month}.png`, `03-spells-traps-${month}.png`, `04-extra-side-${month}.png`];
export const reportImages = report => report.files.filter(f => f.name.endsWith('.png'));
