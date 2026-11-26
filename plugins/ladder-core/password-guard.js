'use strict';

// Admission control around scrypt (design 2.1 "准入与并发", B5).
//   * FixedWindowLimiter: per-key request budgets checked BEFORE any scrypt
//     work (and before a cache lookup), so a burst cannot reach the slots.
//   * ScryptGate: a global pool of execution slots. The data site may hold at
//     most `webSlots`; the rest stay available to room joins. Each lane has a
//     bounded queue with a deadline; overflow and timeout fail fast.
//   * VerifyCache: remembers a successful data-site verification for a while,
//     keyed by an HMAC of (account, password) under a per-process random key,
//     and valid only while the stored hash is unchanged.

const crypto = require('crypto');

class FixedWindowLimiter {
  constructor({limit, windowMs, now = Date.now, maxKeys = 50000}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  bucket(key) {
    const time = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || time - bucket.start >= this.windowMs) {
      if (!bucket && this.buckets.size >= this.maxKeys) this.prune(time);
      bucket = {start: time, count: 0};
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  // Counts one attempt; false when the budget for this window is exhausted.
  take(key) {
    const bucket = this.bucket(key);
    if (bucket.count >= this.limit) return false;
    bucket.count++;
    return true;
  }

  // Inspect without counting (used for failure-only limits).
  exhausted(key) {
    const bucket = this.buckets.get(key);
    return !!bucket && this.now() - bucket.start < this.windowMs && bucket.count >= this.limit;
  }

  prune(time = this.now()) {
    for (const [key, bucket] of this.buckets) {
      if (time - bucket.start >= this.windowMs) this.buckets.delete(key);
    }
    // Still full: drop the oldest entries rather than grow without bound.
    while (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
  }
}

const gateError = (code, statusCode) => Object.assign(new Error(`Password verification ${code}.`), {code, statusCode});

class ScryptGate {
  constructor({slots = 4, webSlots = 2, webQueue = 8, webWaitMs = 2000, joinQueue = 16, joinWaitMs = 5000} = {}) {
    this.slots = slots;
    this.webSlots = Math.min(webSlots, slots);
    this.lanes = {
      web: {queue: [], max: webQueue, waitMs: webWaitMs},
      join: {queue: [], max: joinQueue, waitMs: joinWaitMs}
    };
    this.active = {web: 0, join: 0};
  }

  canStart(lane) {
    if (this.active.web + this.active.join >= this.slots) return false;
    return lane !== 'web' || this.active.web < this.webSlots;
  }

  // Runs `task` inside a slot. Rejects with code 'busy' (queue full) or
  // 'timeout' (waited too long) without ever running the task.
  run(lane, task) {
    const config = this.lanes[lane];
    if (!config) return Promise.reject(new TypeError(`Unknown lane ${lane}.`));
    if (this.canStart(lane) && !config.queue.length) return this.execute(lane, task);
    if (config.queue.length >= config.max) return Promise.reject(gateError('busy', 503));
    return new Promise((resolve, reject) => {
      const entry = {task, resolve, reject};
      entry.timer = setTimeout(() => {
        const index = config.queue.indexOf(entry);
        if (index >= 0) config.queue.splice(index, 1);
        reject(gateError('timeout', 503));
      }, config.waitMs);
      entry.timer.unref?.();
      config.queue.push(entry);
    });
  }

  async execute(lane, task) {
    this.active[lane]++;
    try {
      return await task();
    } finally {
      this.active[lane]--;
      this.drain();
    }
  }

  drain() {
    // Joins first: the data site must never starve room entry.
    for (const lane of ['join', 'web']) {
      const queue = this.lanes[lane].queue;
      while (queue.length && this.canStart(lane)) {
        const entry = queue.shift();
        clearTimeout(entry.timer);
        this.execute(lane, entry.task).then(entry.resolve, entry.reject);
      }
    }
  }
}

class VerifyCache {
  constructor({ttlMs = 10 * 60 * 1000, maxEntries = 10000, now = Date.now} = {}) {
    this.secret = crypto.randomBytes(32);
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  // The plaintext never stays in memory; only this one-way digest does.
  keyOf(account, password) {
    return crypto.createHmac('sha256', this.secret).update(`${account}\0${password}`, 'utf8').digest('base64');
  }

  // True only when a fresh entry exists AND the account still stores exactly
  // the credential it was verified against. A reset by the offline script or a
  // password change therefore invalidates it without any notification.
  hit(account, password, currentStored) {
    const key = this.keyOf(account, password);
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (this.now() - entry.at >= this.ttlMs || entry.stored !== currentStored) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  remember(account, password, stored) {
    if (this.entries.size >= this.maxEntries) {
      const time = this.now();
      for (const [key, entry] of this.entries) if (time - entry.at >= this.ttlMs) this.entries.delete(key);
      while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    }
    this.entries.set(this.keyOf(account, password), {stored, at: this.now()});
  }

  clear() { this.entries.clear(); }
}

module.exports = {FixedWindowLimiter, ScryptGate, VerifyCache};
