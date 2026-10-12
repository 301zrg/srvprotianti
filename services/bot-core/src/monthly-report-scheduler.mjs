import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {shanghaiDay} from './api.mjs';
import {normalizeReportMonth, ReportError} from './monthly-report.mjs';

export function monthlyReportDue(now, config) {
  const current = shanghaiDay(now);
  const due = new Date(`${current.month.slice(0, 4)}-${current.month.slice(4)}-01T10:00:00+08:00`).getTime();
  const elapsed = now.getTime() - due, window = config.catchUpHours === 0 ? 60000 : config.catchUpHours * 3600000;
  return {month: normalizeReportMonth(null, now), due, eligible: elapsed >= 0 && elapsed < window, missed: elapsed >= window};
}

export class MonthlyReportScheduler {
  constructor({reports, adapter, logger, now = () => new Date()}) {
    Object.assign(this, {reports, adapter, logger, now});
    this.config = reports.config; this.stateFile = path.resolve(reports.root, this.config.stateFile);
    if (!this.stateFile.startsWith(reports.root + path.sep)) throw new ReportError('unsafe_path');
    this.state = {version: 1, deliveries: {}}; this.running = false; this.busy = false; this.retryAt = 0; this.loaded = false;
  }
  async load() {
    await this.reports.safeDirectory(path.dirname(this.stateFile));
    try {
      const stat = await fs.lstat(this.stateFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new ReportError('invalid_schedule_state');
      const state = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      if (state?.version !== 1 || !state.deliveries || typeof state.deliveries !== 'object' || Array.isArray(state.deliveries)) throw new ReportError('invalid_schedule_state');
      for (const [key, entry] of Object.entries(state.deliveries)) {
        if (!/^[^:]+:[^:]+:[1-9]\d{3}(0[1-9]|1[0-2])$/.test(key) || !['pending', 'sending', 'sent', 'missed'].includes(entry?.status) ||
            entry.batch !== null && !/^[a-f0-9]{24}$/.test(entry.batch) || entry.status === 'sent' && (!entry.batch || typeof entry.messageId !== 'string' || !entry.messageId) ||
            entry.status === 'sending' && (!entry.batch || !Number.isFinite(entry.attemptedAt)) ||
            entry.manual !== undefined && typeof entry.manual !== 'boolean') throw new ReportError('invalid_schedule_state');
      }
      this.state = state;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.loaded = true;
  }
  async save() {
    const dir = await this.reports.safeDirectory(path.dirname(this.stateFile)), temp = path.join(dir, `.monthly-state-${randomUUID()}.tmp`);
    // Replacing a symlink here would hide a damaged deployment. Refuse it instead.
    const stat = await fs.lstat(this.stateFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new ReportError('invalid_schedule_state');
    try {
      await fs.writeFile(temp, JSON.stringify(this.state, null, 2) + '\n', {flag: 'wx'});
      await fs.rename(temp, this.stateFile);
    } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async deliver(target, report, since) {
    const month = report.model.month, key = `${target.guildId}:${target.channelId}:${month}`;
    const entry = this.state.deliveries[key] ||= {status: 'pending', batch: null};
    const manual = entry.manual;
    entry.batch = report.batch; await this.save();
    try {
      const found = await this.adapter.findMonthlyReport(target, report, since);
      if (found) {
        await this.reports.markPublished(report); entry.status = 'sent'; entry.messageId = found; entry.manual = false;
        await this.save(); return {status: 'existing', messageId: found};
      }
      if (this.stopped) throw new ReportError('delivery_stopped');
      entry.status = 'sending'; entry.attemptedAt = this.now().getTime(); await this.save();
      const messageId = await this.adapter.sendMonthlyReport(target, report);
      if (typeof messageId !== 'string' || !messageId) throw new ReportError('invalid_delivery_ack');
      await this.reports.markPublished(report); entry.status = 'sent'; entry.messageId = messageId; entry.manual = false;
      await this.save();
      await this.logger.write('monthly_report_sent', {month, channel: target.channelId, messageId});
      return {status: 'sent', messageId};
    } catch (error) {
      entry.status = entry.attemptedAt ? 'sending' : 'pending';
      entry.manual = manual;
      await this.save().catch(() => {});
      throw error;
    }
  }
  async resend(target) {
    if (!this.loaded) throw new ReportError('invalid_schedule_state');
    if (this.busy) throw new ReportError('delivery_busy');
    if (!this.adapter.monthlyReportTargets().some(t => t.guildId === target.guildId && t.channelId === target.channelId)) throw new ReportError('wrong_delivery_channel');
    this.busy = true;
    const month = normalizeReportMonth(null, this.now()), key = `${target.guildId}:${target.channelId}:${month}`;
    try {
      // Explicit operator requests remain retryable beyond the automatic window.
      const entry = this.state.deliveries[key] ||= {status: 'pending', batch: null};
      entry.manual = true; entry.status = entry.attemptedAt ? 'sending' : 'pending';
      await this.save();
      const report = entry.batch ? await this.reports.readBatch(month, entry.batch) : await this.reports.export(month);
      if (!report.files.length) throw new ReportError('report_empty');
      return await this.deliver(target, report, new Date(`${month.slice(0, 4)}-${month.slice(4)}-01T00:00:00+08:00`).getTime());
    } catch (error) {
      this.retryAt = this.now().getTime() + 300000;
      await this.logger.write('monthly_report_delivery_failed', {month, channel: target.channelId, code: error.code || 'unknown', manual: true});
      throw error;
    } finally { this.busy = false; }
  }
  async tick() {
    if (this.busy || this.stopped || !this.adapter.ready || this.now().getTime() < this.retryAt) return false;
    if (!this.config.enabled && !Object.values(this.state.deliveries).some(entry => entry.manual && ['pending', 'sending'].includes(entry.status))) return false;
    this.busy = true;
    try {
      const {month, due, eligible, missed} = monthlyReportDue(this.now(), this.config);
      const targets = this.adapter.monthlyReportTargets();
      let changed = false;
      for (const target of targets) {
        const key = `${target.guildId}:${target.channelId}:${month}`;
        if (!this.state.deliveries[key] && this.config.enabled && (eligible || missed)) {
          this.state.deliveries[key] = {status: missed ? 'missed' : 'pending', batch: null}; changed = true;
        }
        if (missed && this.state.deliveries[key]?.status === 'pending' && !this.state.deliveries[key].manual) { this.state.deliveries[key].status = 'missed'; changed = true; }
      }
      if (changed) await this.save();
      const work = new Map();
      for (const target of targets) for (const [key, entry] of Object.entries(this.state.deliveries)) {
        if (!key.startsWith(`${target.guildId}:${target.channelId}:`) || !['pending', 'sending'].includes(entry.status)) continue;
        const selected = key.split(':').at(-1);
        if (!entry.manual && !(this.config.enabled && selected === month && eligible)) continue;
        if (!work.has(selected)) work.set(selected, []);
        work.get(selected).push(target);
      }
      for (const [selected, selectedTargets] of work) {
        const batches = new Set(targets.map(t => this.state.deliveries[`${t.guildId}:${t.channelId}:${selected}`]?.batch).filter(Boolean));
        if (batches.size > 1) throw new ReportError('inconsistent_schedule_state');
        const batch = [...batches][0];
        const report = batch ? await this.reports.readBatch(selected, batch) : await this.reports.export(selected);
        if (!report.files.length) { this.retryAt = this.now().getTime() + 300000; continue; }
        for (const target of selectedTargets) {
          if (this.stopped) break;
          const entry = this.state.deliveries[`${target.guildId}:${target.channelId}:${selected}`];
          try { await this.deliver(target, report, entry.manual ? Date.parse(`${selected.slice(0, 4)}-${selected.slice(4)}-01T00:00:00+08:00`) : entry.attemptedAt || due); }
          catch (error) {
            await this.logger.write('monthly_report_delivery_failed', {month: selected, channel: target.channelId, code: error.code || 'unknown'});
            this.retryAt = this.now().getTime() + 300000;
          }
        }
      }
      return work.size > 0;
    } finally { this.busy = false; }
  }
  async start() {
    if (this.running) return;
    await this.load(); this.running = true; this.stopped = false;
    const loop = async () => {
      if (!this.running) return;
      try { await this.tick(); }
      catch (error) {
        this.retryAt = this.now().getTime() + 300000;
        await this.logger.write('monthly_report_scheduler_failed', {code: error.code || 'unknown'});
      }
      if (this.running) this.timer = setTimeout(loop, 15000);
    };
    void loop();
  }
  stop() { this.running = false; this.stopped = true; clearTimeout(this.timer); }
}
