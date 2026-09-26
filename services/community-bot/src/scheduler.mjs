import fs from 'node:fs/promises';
import path from 'node:path';
import {shanghaiDay} from './api.mjs';

export class MonthlyScheduler {
  constructor({stateFile, onMonthly, logger, now = () => new Date()}) {
    Object.assign(this, {stateFile, onMonthly, logger, now});
    this.timer = null;
    this.running = false;
    this.lastAttempt = null;
  }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      this.lastAttempt = typeof data.lastAttempt === 'string' ? data.lastAttempt : null;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.stateFile), {recursive: true});
    const temp = `${this.stateFile}.tmp`;
    await fs.writeFile(temp, JSON.stringify({lastAttempt: this.lastAttempt}), 'utf8');
    await fs.rename(temp, this.stateFile);
  }

  async tick() {
    const current = shanghaiDay(this.now());
    if (current.hour !== 4 || current.minute !== 0 || this.lastAttempt === current.date) return false;
    // Record the attempt before sending so a restart within 04:00 cannot spam
    // the same day. A failed attempt is deliberately not replayed later.
    this.lastAttempt = current.date;
    await this.save();
    try { await this.onMonthly(); }
    catch (error) { await this.logger.write('monthly_delivery_failed', {date: current.date, status: error.status || null, code: error.code || 'unknown'}); }
    return true;
  }

  async start() {
    if (this.running) return;
    await this.load();
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try { await this.tick(); }
      catch (error) { await this.logger.write('monthly_scheduler_failed', {code: error.code || 'unknown'}); }
      if (this.running) this.timer = setTimeout(loop, 15000);
    };
    void loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }
}
