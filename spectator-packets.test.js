'use strict';

const assert = require('assert');
const {SpectatorPacketForwarder, sendReplaysOnce} = require('./spectator-packets');

const packet = (type, payload = Buffer.alloc(0)) => {
  const result = Buffer.alloc(3 + payload.length);
  result.writeUInt16LE(payload.length + 1, 0);
  result[2] = type;
  payload.copy(result, 3);
  return result;
};

(async () => {
  const events = [];
  let releaseReplay;
  const replayReady = new Promise(resolve => { releaseReplay = resolve; });
  const forwarder = new SpectatorPacketForwarder({
    duelEndType: 0x16,
    beforeDuelEnd: async () => {
      await replayReady;
      events.push('replay');
    },
    onPacket: async current => { events.push(`packet:${current[2]}`); },
    afterDuelEnd: async () => { events.push('closed'); }
  });
  const chat = packet(0x19, Buffer.from('hello'));
  const end = packet(0x16);
  await forwarder.push(chat.subarray(0, 1));
  await forwarder.push(chat.subarray(1));
  const terminal = forwarder.push(Buffer.concat([end, packet(0x19)]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(events, ['packet:25'], 'the final packet must wait for replay capture');
  releaseReplay();
  await terminal;
  await forwarder.push(packet(0x19));
  assert.deepStrictEqual(events, ['packet:25', 'replay', 'packet:22', 'closed'],
    'send replay before DUEL_END, finish the connection after it, and ignore late packets');

  const splitEnd = new SpectatorPacketForwarder({
    duelEndType: 0x16,
    onPacket: current => { events.push(`split:${current[2]}`); }
  });
  await splitEnd.push(end.subarray(0, 2));
  assert.strictEqual(events.length, 4);
  await splitEnd.push(end.subarray(2));
  assert.strictEqual(events[4], 'split:22', 'a split DUEL_END must be forwarded only when complete');

  const catchupEvents = [];
  let releaseHistory;
  const historyReady = new Promise(resolve => { releaseHistory = resolve; });
  const catchingUp = new SpectatorPacketForwarder({
    duelEndType: 0x16,
    beforeDuelEnd: async () => { await historyReady; catchupEvents.push('replay'); },
    onPacket: async current => {
      await historyReady;
      catchupEvents.push(`packet:${current[2]}`);
    }
  });
  const livePacket = catchingUp.push(chat);
  const liveEnd = catchingUp.push(end);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(catchupEvents, [], 'live packets must wait for a new spectator\'s history');
  catchupEvents.push('history');
  releaseHistory();
  await Promise.all([livePacket, liveEnd]);
  assert.deepStrictEqual(catchupEvents, ['history', 'packet:25', 'replay', 'packet:22'],
    'history, live packets, replay and terminal packet must reach a late spectator in order');

  const client = {};
  let releaseSend, sendCount = 0;
  const sendReady = new Promise(resolve => { releaseSend = resolve; });
  const firstSend = sendReplaysOnce(client, async () => {
    sendCount++;
    await sendReady;
  });
  const secondSend = sendReplaysOnce(client, () => { sendCount++; });
  assert.strictEqual(firstSend, secondSend, 'a second finalizer must wait for the first replay send');
  releaseSend();
  await Promise.all([firstSend, secondSend]);
  assert.strictEqual(sendCount, 1, 'concurrent finalizers must send each replay only once');
  console.log('spectator packet tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
