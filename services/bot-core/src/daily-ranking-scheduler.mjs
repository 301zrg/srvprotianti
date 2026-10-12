import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {shanghaiDay} from './api.mjs';

const failure = code => Object.assign(new Error(code), {code});
const retryMs = 60000;

// Discord keeps acknowledgements per channel. Legacy lastAttempt records are
// not acknowledgements: reconcile the channel history before consuming them.
export class DailyRankingScheduler {
  constructor({stateFile, api, adapter, logger, now = () => new Date()}) {
    Object.assign(this, {stateFile, api, adapter, logger, now});
    this.state = {version: 2, deliveries: {}};
    this.busy = false;
    this.running = false;
  }

  async load() {
    try {
      const stat = await fs.lstat(this.stateFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw failure('invalid_ranking_state');
      const data = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      if (data.version === undefined && typeof data.lastAttempt === 'string') return;
      if (data.version !== 2 || !data.deliveries || typeof data.deliveries !== 'object' || Array.isArray(data.deliveries)) throw failure('invalid_ranking_state');
      for (const [key, entry] of Object.entries(data.deliveries)) {
        if (!/^[^:]+:[^:]+:\d{4}-\d{2}-\d{2}$/.test(key) || !['pending', 'sending', 'sent'].includes(entry?.status) ||
            entry.status === 'sent' && (typeof entry.messageId !== 'string' || !entry.messageId) ||
            entry.ranking && !Array.isArray(entry.ranking.ladder) ||
            entry.retryAt !== undefined && !Number.isFinite(entry.retryAt)) throw failure('invalid_ranking_state');
      }
      this.state = data;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async save() {
    await fs.mkdir(path.dirname(this.stateFile), {recursive: true});
    const stat = await fs.lstat(this.stateFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw failure('invalid_ranking_state');
    const temp = `${this.stateFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(this.state, null, 2) + '\n', {flag: 'wx'});
      await fs.rename(temp, this.stateFile);
    } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async deliver(target, date, {recheck = false} = {}) {
    const key = `${target.guildId}:${target.channelId}:${date}`;
    const entry = this.state.deliveries[key] ||= {status: 'pending'};
    if (entry.status === 'sent' && !recheck) return {status: 'existing', messageId: entry.messageId};
    const since = new Date(`${date}T00:00:00+08:00`).getTime();
    try {
      // A timeout may hide a successful post. History failure must never be
      // interpreted as an absent post, even when an operator clicks resend.
      const found = await this.adapter.findDailyRanking(target, date, since);
      if (found) {
        entry.status = 'sent'; entry.messageId = found; delete entry.retryAt;
        await this.save();
        return {status: 'existing', messageId: found};
      }
      const month = date.slice(0, 7).replace('-', '');
      if (!entry.ranking) {
        const result = await this.api.getMonthlyTop10(month);
        entry.ranking = {rankingBasis: result.rankingBasis || 'unknown', ladder: result.ladder.slice(0, 10).map(row =>
          Object.fromEntries(['rank', 'name', 'duelPoints', 'wins', 'losses', 'diff'].map(field => [field, row[field]])))};
        await this.logger.write('monthly_rank_fetched', {month, rankingBasis: entry.ranking.rankingBasis});
      }
      entry.status = 'sending'; entry.attemptedAt = this.now().getTime();
      await this.save();
      const messageId = await this.adapter.sendDailyRanking(target, entry.ranking, month, date);
      if (typeof messageId !== 'string' || !messageId) throw failure('invalid_delivery_ack');
      entry.status = 'sent'; entry.messageId = messageId; delete entry.retryAt;
      await this.save();
      await this.logger.write('daily_ranking_sent', {date, channel: target.channelId, messageId});
      return {status: 'sent', messageId};
    } catch (error) {
      // Keep the delivery retryable when persistence, API or Discord I/O fails.
      entry.status = entry.ranking ? 'sending' : 'pending';
      entry.retryAt = this.now().getTime() + retryMs;
      await this.save().catch(() => {});
      await this.logger.write('daily_ranking_delivery_failed', {date, channel: target.channelId, code: error.code || 'unknown'});
      throw error;
    }
  }

  async resend(target) {
    if (this.busy) throw failure('delivery_busy');
    if (!this.adapter.top10Targets().some(t => t.guildId === target.guildId && t.channelId === target.channelId)) throw failure('wrong_delivery_channel');
    this.busy = true;
    try { return await this.deliver(target, shanghaiDay(this.now()).date, {recheck: true}); }
    finally { this.busy = false; }
  }

  async tick() {
    const current = shanghaiDay(this.now());
    if (this.busy || this.stopped || !this.adapter.ready || current.hour < 4) return false;
    this.busy = true;
    try {
      for (const target of this.adapter.top10Targets?.() || []) {
        if (this.stopped) break;
        const entry = this.state.deliveries[`${target.guildId}:${target.channelId}:${current.date}`];
        if (entry?.status === 'sent' || this.now().getTime() < (entry?.retryAt || 0)) continue;
        await this.deliver(target, current.date).catch(() => {});
      }
      // Retain recent receipts; missed older days are not posted as today's data.
      const cutoff = this.now().getTime() - 35 * 86400000;
      for (const key of Object.keys(this.state.deliveries)) if (Date.parse(`${key.split(':').at(-1)}T00:00:00+08:00`) < cutoff) delete this.state.deliveries[key];
      return true;
    } finally { this.busy = false; }
  }

  async start() {
    if (this.running) return;
    await this.load(); this.running = true; this.stopped = false;
    const loop = async () => {
      if (!this.running) return;
      try { await this.tick(); }
      catch (error) { await this.logger.write('daily_ranking_scheduler_failed', {code: error.code || 'unknown'}); }
      if (this.running) this.timer = setTimeout(loop, 15000);
    };
    void loop();
  }

  stop() { this.running = false; this.stopped = true; clearTimeout(this.timer); }
}
