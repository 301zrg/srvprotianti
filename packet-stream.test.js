'use strict';

const assert = require('assert');
const {YGOProMessagesHelper} = require('./YGOProMessages');

async function run() {
  const helper = new YGOProMessagesHelper();
  for (const [direction, packet] of [
    ['CTOS', helper.prepareMessage('CTOS_TIME_CONFIRM')],
    ['STOC', helper.prepareMessage('STOC_TIME_LIMIT', {player: 0, left_time: 180})]
  ]) {
    for (let cut = 1; cut < packet.length; cut++) {
      const stream = {};
      const first = await helper.handleStreamBuffer(packet.subarray(0, cut), direction, stream);
      assert.deepStrictEqual(first, {datas: [], feedback: null}, `${direction} fragment ${cut} must wait`);
      const second = await helper.handleStreamBuffer(packet.subarray(cut), direction, stream);
      assert.strictEqual(second.feedback, null);
      assert.strictEqual(second.datas.length, 1, `${direction} fragment ${cut} must be reassembled`);
      assert.ok(second.datas[0].equals(packet));
    }
  }

  const packet = helper.prepareMessage('CTOS_TIME_CONFIRM');
  const coalescedStream = {};
  const first = await helper.handleStreamBuffer(Buffer.concat([packet, packet, packet.subarray(0, 1)]), 'CTOS', coalescedStream);
  assert.strictEqual(first.datas.length, 2, 'complete packets ahead of a fragment must be processed');
  assert.strictEqual((await helper.handleStreamBuffer(packet.subarray(1), 'CTOS', coalescedStream)).datas.length, 1,
    'the trailing fragment must complete on the next data event');
  const streamA = {};
  const streamB = {};
  assert.strictEqual((await helper.handleStreamBuffer(packet.subarray(0, 2), 'CTOS', streamA)).datas.length, 0);
  assert.strictEqual((await helper.handleStreamBuffer(packet, 'CTOS', streamB)).datas.length, 1,
    'another connection must not consume the first connection’s fragment');
  assert.strictEqual((await helper.handleStreamBuffer(packet.subarray(2), 'CTOS', streamA)).datas.length, 1);

  const invalid = await helper.handleStreamBuffer(Buffer.from([0, 0, 21]), 'CTOS', streamA);
  assert.strictEqual(invalid.feedback.type, 'INVALID_PACKET');
  assert.strictEqual((await helper.handleStreamBuffer(packet, 'CTOS', streamA)).datas.length, 1,
    'an invalid frame must not poison later input on the same connection');
  console.log('packet stream tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
