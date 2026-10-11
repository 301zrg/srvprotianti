import fs from 'node:fs/promises';
import path from 'node:path';

export class WinStreakMonitor {
  constructor({api, stateFile, intervalMs, canNotify, onStreak, logger, now = Date.now}) {
    Object.assign(this, {api, stateFile, intervalMs, canNotify, onStreak, logger, now});
    this.attempted = new Map();
    this.running = false;
    this.timer = null;
  }

  async load() {
    try {
      const state = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      for (const [key, expiresAt] of Object.entries(state.attempted || {})) {
        if (/^match:\d+$/.test(key) && Number.isFinite(expiresAt) && expiresAt > this.now()) {
          this.attempted.set(key, expiresAt);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.attempted.clear();
        await this.logger.write('win_streak_state_invalid', {code: error.code || error.name});
      }
    }
  }

  async save() {
    for (const [key, deadline] of this.attempted) if (deadline <= this.now()) this.attempted.delete(key);
    await fs.mkdir(path.dirname(this.stateFile), {recursive: true});
    const temporary = `${this.stateFile}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({attempted: Object.fromEntries(this.attempted)}), 'utf8');
    await fs.rename(temporary, this.stateFile);
  }

  async poll() {
    if (!this.canNotify()) return;
    const requestedAt = this.now();
    const received = await this.api.getWinStreaks();
    const serverTime = Date.parse(received.serverTime);
    const latest = new Map();
    for (const row of received.streaks) {
      const previous = latest.get(row.player);
      if (!previous || Date.parse(row.settledAt) > Date.parse(previous.settledAt) ||
          row.settledAt === previous.settledAt && row.matchId > previous.matchId) latest.set(row.player, row);
    }
    for (const row of latest.values()) {
      const remaining = Math.min(60000, Date.parse(row.expiresAt) - serverTime);
      if (Date.parse(row.settledAt) > serverTime || remaining <= 0 || this.attempted.has(row.eventId)) continue;
      // Use server-relative age so a different PC clock cannot revive old wins.
      const deadline = requestedAt + remaining;
      if (deadline <= this.now() || !this.canNotify()) continue;
      // Best effort delivery: remember the attempt before sending. A crash or
      // failed send may omit a post, but cannot cause an old streak backlog.
      this.attempted.set(row.eventId, deadline);
      await this.save();
      if (deadline <= this.now()) continue;
      try { await this.onStreak(row, deadline); }
      catch (error) { await this.logger.write('win_streak_send_failed', {eventId: row.eventId, code: error.code || 'unknown'}); }
    }
    await this.save();
  }

  async start() {
    await this.load();
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try { await this.poll(); }
      catch (error) { await this.logger.write('win_streak_poll_failed', {code: error.code || 'unknown', status: error.status || null}); }
      if (this.running) this.timer = setTimeout(tick, this.intervalMs);
    };
    void tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }
}
