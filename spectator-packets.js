'use strict';

// Native watcher sockets are TCP streams. Keep complete STOC packets in order
// so a terminal packet cannot overtake a delayed replay or a split packet.
class SpectatorPacketForwarder {
  constructor({duelEndType, beforeDuelEnd, onPacket, afterDuelEnd}) {
    this.duelEndType = duelEndType;
    this.beforeDuelEnd = beforeDuelEnd;
    this.onPacket = onPacket;
    this.afterDuelEnd = afterDuelEnd;
    this.pending = Buffer.alloc(0);
    this.task = Promise.resolve();
    this.ended = false;
  }

  push(chunk) {
    this.task = this.task.then(async () => {
      if (this.ended) return;
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= 2) {
        const length = this.pending.readUInt16LE(0);
        if (length < 1) throw new Error('Invalid STOC packet length');
        if (this.pending.length < length + 2) break;
        const packet = this.pending.subarray(0, length + 2);
        this.pending = this.pending.subarray(length + 2);
        if (packet[2] === this.duelEndType) {
          this.ended = true;
          if (this.beforeDuelEnd) await this.beforeDuelEnd();
          await this.onPacket(packet);
          if (this.afterDuelEnd) await this.afterDuelEnd();
          this.pending = Buffer.alloc(0);
          break;
        }
        await this.onPacket(packet);
      }
    });
    return this.task;
  }

  idle() {
    return this.task.catch(() => false);
  }
}

function sendReplaysOnce(client, send) {
  if (client.replays_send_task) return client.replays_send_task;
  if (client.replays_sent) return Promise.resolve(false);
  client.replays_sent = true;
  client.replays_send_task = Promise.resolve().then(send);
  return client.replays_send_task;
}

module.exports = {SpectatorPacketForwarder, sendReplaysOnce};
