import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {shanghaiDay} from './api.mjs';
import {monthlyReportDue} from './monthly-report-scheduler.mjs';

// QQ group posts have no history reconciliation. A persisted send without an
// acknowledgement is held, never guessed to be absent and blindly replayed.
export class QqScheduler {
  constructor({root, stateFile, kind, adapter, config, logger, now = () => new Date()}) {
    Object.assign(this, {root: path.resolve(root), kind, adapter, config, logger, now});
    this.stateFile = path.resolve(root, stateFile);
    if (!this.stateFile.startsWith(this.root + path.sep)) throw new Error('Invalid QQ schedule path');
    this.state = {version: 1, deliveries: {}}; this.running = false; this.busy = false;
  }
  async ensureDirectory() {
    let current = this.root;
    for (const part of path.relative(this.root, path.dirname(this.stateFile)).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe QQ schedule directory');
    }
  }
  async load() {
    await this.ensureDirectory();
    try {
      const stat = await fs.lstat(this.stateFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid QQ schedule state');
      const state = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      if (this.kind === 'daily' && state.version === undefined && typeof state.lastAttempt === 'string') {
        this.state.legacyAttempt = state.lastAttempt;
        return;
      }
      if (state.version !== 1 || !state.deliveries || typeof state.deliveries !== 'object' || Array.isArray(state.deliveries)) throw new Error('Invalid QQ schedule state');
      for (const [key, entry] of Object.entries(state.deliveries)) {
        if (!/^[^:]+:[0-9-]+$/.test(key) || !['pending', 'sending', 'sent', 'uncertain', 'missed'].includes(entry?.status) ||
            !Number.isInteger(entry.next) || entry.next < 0 || !Array.isArray(entry.receipts) || entry.receipts.length !== entry.next ||
            entry.receipts.some(id => typeof id !== 'string' || !id) || entry.snapshot &&
            (entry.snapshot.kind !== this.kind || !Number.isInteger(entry.snapshot.total) || entry.snapshot.total < 1 || entry.snapshot.total > 20 || entry.next > entry.snapshot.total) ||
            entry.status === 'sent' && (!entry.snapshot || entry.next !== entry.snapshot.total)) throw new Error('Invalid QQ schedule state');
        if (entry.status === 'sending') entry.status = 'uncertain';
      }
      this.state = state;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async save() {
    await this.ensureDirectory();
    const stat = await fs.lstat(this.stateFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Invalid QQ schedule state');
    const temp = `${this.stateFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(this.state, null, 2) + '\n', {flag: 'wx'});
      await fs.rename(temp, this.stateFile);
    } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  due() {
    if (this.kind === 'monthly') return monthlyReportDue(this.now(), this.config);
    const current = shanghaiDay(this.now());
    return {month: current.date, eligible: current.hour >= 4, missed: false};
  }
  async deliver(target, period, entry) {
    const canContinue = () => {
      const due = this.due();
      return !this.stopped && this.adapter.canNotifyScheduled(target) && due.eligible && due.month === period;
    };
    if (!entry.snapshot) {
      entry.snapshot = await this.adapter.prepareScheduled(this.kind, target, period);
      if (!entry.snapshot) { entry.retryAt = this.now().getTime() + 300000; await this.save(); return; }
      await this.save();
    }
    while (entry.next < entry.snapshot.total) {
      if (!canContinue()) return;
      // Upload/token failures happen before a visible send and remain retryable.
      const prepared = await this.adapter.prepareScheduledPart(target, entry.snapshot, entry.next);
      if (!canContinue()) return;
      entry.status = 'sending'; await this.save();
      if (!canContinue()) { entry.status = 'pending'; await this.save(); return; }
      let id;
      try { id = await this.adapter.sendScheduledPart(target, prepared); }
      catch (error) {
        entry.status = error.deliveryUncertain === false ? 'pending' : 'uncertain';
        throw error;
      }
      if (typeof id !== 'string' || !id) { entry.status = 'uncertain'; throw new Error('Missing QQ delivery acknowledgement'); }
      entry.receipts.push(id); entry.next++;
      entry.status = entry.next === entry.snapshot.total ? 'sent' : 'pending';
      try { await this.save(); }
      catch (error) { entry.status = 'uncertain'; throw error; }
      await this.logger.write('qq_scheduled_part_sent', {kind: this.kind, group: target.groupOpenId, period, part: entry.next, total: entry.snapshot.total, messageId: id});
    }
  }
  async tick() {
    if (this.busy || this.stopped || !this.adapter.ready || this.kind === 'monthly' && !this.config.enabled) return false;
    const {month: period, eligible, missed} = this.due();
    if (!eligible && !missed) return false;
    this.busy = true;
    try {
      for (const target of this.adapter.scheduledTargets(this.kind)) {
        if (this.stopped || !this.adapter.canNotifyScheduled(target)) continue;
        const key = `${target.groupOpenId}:${period}`;
        const entry = this.state.deliveries[key] ||= {status: this.state.legacyAttempt === period ? 'uncertain' : missed ? 'missed' : 'pending', next: 0, receipts: []};
        if (entry.status === 'pending' && missed) entry.status = 'missed';
        if (['sent', 'uncertain', 'missed'].includes(entry.status) || this.now().getTime() < (entry.retryAt || 0)) continue;
        try { await this.deliver(target, period, entry); }
        catch (error) {
          entry.retryAt = this.now().getTime() + (this.kind === 'daily' ? 60000 : 300000);
          await this.save().catch(() => {});
          await this.logger.write('qq_scheduled_delivery_failed', {kind: this.kind, group: target.groupOpenId, period, status: entry.status, code: error.code || 'unknown'});
        }
      }
      // Bound local receipts while retaining enough history to explain recovery.
      const cutoff = this.now().getTime() - 400 * 86400000;
      for (const [key] of Object.entries(this.state.deliveries)) {
        const selected = key.split(':').at(-1), date = this.kind === 'daily' ? selected : `${selected.slice(0, 4)}-${selected.slice(4)}-01`;
        if (Date.parse(`${date}T00:00:00+08:00`) < cutoff) delete this.state.deliveries[key];
      }
      await this.save(); return true;
    } finally { this.busy = false; }
  }
  async start() {
    if (this.running) return;
    await this.load(); this.running = true; this.stopped = false;
    const loop = async () => {
      if (!this.running) return;
      try { await this.tick(); }
      catch (error) { await this.logger.write('qq_scheduler_failed', {kind: this.kind, code: error.code || 'unknown'}); }
      if (this.running) this.timer = setTimeout(loop, 15000);
    };
    void loop();
  }
  stop() { this.running = false; this.stopped = true; clearTimeout(this.timer); }
}
