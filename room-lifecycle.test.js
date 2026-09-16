'use strict';

const assert = require('assert');
const {
  activeWaitingPlayers,
  seatedWaitingPlayers,
  isEmptyWaitingRoom,
  shouldReapEmptyWaitingRoom,
  reconnectTimeoutAction
} = require('./room-lifecycle');

const BEGIN = 0;
const empty = {players: [], duel_stage: BEGIN};
assert.deepStrictEqual(activeWaitingPlayers(empty), []);
assert.strictEqual(isEmptyWaitingRoom(empty, BEGIN), true);
assert.strictEqual(shouldReapEmptyWaitingRoom(empty, 1000, 30000, BEGIN), false);
assert.strictEqual(empty.empty_waiting_since, 1000);
assert.strictEqual(shouldReapEmptyWaitingRoom(empty, 30999, 30000, BEGIN), false);
assert.strictEqual(shouldReapEmptyWaitingRoom(empty, 31000, 30000, BEGIN), true);

const pending = {players: [{isClosed: false}], duel_stage: BEGIN, empty_waiting_since: 1000};
assert.strictEqual(isEmptyWaitingRoom(pending, BEGIN), false, 'a live client awaiting its seat is not an orphan');
assert.deepStrictEqual(seatedWaitingPlayers(pending), [], 'a pending client must not expose an empty-looking room yet');
assert.strictEqual(shouldReapEmptyWaitingRoom(pending, 50000, 30000, BEGIN), false);
assert.strictEqual(pending.empty_waiting_since, null);
pending.players = [];
assert.strictEqual(shouldReapEmptyWaitingRoom(pending, 60000, 30000, BEGIN), false, 'becoming empty starts a new grace period');
assert.strictEqual(pending.empty_waiting_since, 60000);

const closedGhost = {players: [{isClosed: true}], duel_stage: BEGIN};
assert.strictEqual(isEmptyWaitingRoom(closedGhost, BEGIN), true, 'a closed pre-join client must not keep a room alive');

const observerOnly = {players: [{isClosed: false, pos: 7}], duel_stage: BEGIN};
assert.strictEqual(isEmptyWaitingRoom(observerOnly, BEGIN), true, 'an observer alone must not keep a waiting room alive');

const seated = {players: [{isClosed: false, pos: 0}], duel_stage: BEGIN};
assert.strictEqual(seatedWaitingPlayers(seated).length, 1);

const started = {players: [], duel_stage: 1, empty_waiting_since: 1000};
assert.strictEqual(isEmptyWaitingRoom(started, BEGIN), false);
assert.strictEqual(shouldReapEmptyWaitingRoom(started, 50000, 30000, BEGIN), false);

const bothDisconnected = [{pos: 0, isClosed: true}, {pos: 1, isClosed: true}];
assert.strictEqual(reconnectTimeoutAction(bothDisconnected, [{expired: true}, {expired: false}]), 'wait',
  'the first timeout must wait while the other reconnect window is open');
assert.strictEqual(reconnectTimeoutAction(bothDisconnected, [{expired: true}, {expired: true}]), 'neutral',
  'a room with both reconnect windows exhausted must end without a forfeit when the policy is enabled');
assert.strictEqual(reconnectTimeoutAction([{pos: 0, isClosed: true}, {pos: 1, isClosed: false}], [{expired: true}]), 'forfeit',
  'an expired player forfeits normally after the opponent reconnects');

console.log('room lifecycle tests passed');
