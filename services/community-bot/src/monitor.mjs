const ttRoom = room => /^M?#?TT,RANDOM#/.test(String(room?.roomname || ''));
const playingCount = room => (room.users || []).filter(user => user?.pos != null && Number.isInteger(Number(user.pos)) &&
  Number(user.pos) >= 0 && Number(user.pos) < 4).length;

export function isSingleWaitingTt(room) {
  return ttRoom(room) && room.istart === 'wait' && playingCount(room) === 1;
}

export class MatchMonitor {
  constructor({api, intervalMs, cooldownMs, onWaiting, logger}) {
    Object.assign(this, {api, intervalMs, cooldownMs, onWaiting, logger});
    this.known = new Set();
    this.pending = new Set();
    this.recent = new Map();
    this.ready = false;
    this.running = false;
    this.timer = null;
    this.failureCount = 0;
  }

  async poll() {
    let rooms;
    try {
      rooms = await this.api.getRooms();
    } catch (error) {
      this.ready = false;
      this.failureCount++;
      await this.logger.write('room_poll_failed', {status: error.status || null, code: error.code || 'unknown'});
      return;
    }
    const now = Date.now();
    const next = new Set();
    const pending = new Set();
    for (const room of rooms) {
      const key = `${String(room.roomid)}:${String(room.roomname)}`;
      next.add(key);
      const newOrPending = !this.known.has(key) || this.pending.has(key);
      if (this.ready && newOrPending && isSingleWaitingTt(room) &&
          now - (this.recent.get(key) || 0) >= this.cooldownMs) {
        this.recent.set(key, now);
        try { await this.onWaiting(); }
        catch (error) { await this.logger.write('match_alert_failed', {code: error.code || 'unknown'}); }
      } else if (newOrPending && ttRoom(room) && room.istart === 'wait' && playingCount(room) === 0) {
        pending.add(key);
      }
    }
    this.known = next;
    this.pending = pending;
    this.ready = true;
    this.failureCount = 0;
    for (const [key, time] of this.recent) if (now - time > Math.max(this.cooldownMs, 60000)) this.recent.delete(key);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      await this.poll();
      if (this.running) {
        const backoff = Math.min(60000, this.intervalMs * 2 ** Math.min(this.failureCount, 4));
        this.timer = setTimeout(tick, backoff);
      }
    };
    void tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }
}
