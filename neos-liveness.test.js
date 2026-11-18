'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const coffee = require('coffeescript');

const source = fs.readFileSync(path.join(__dirname, 'ygopro-server.coffee'), 'utf8').replace(/\r\n/g, '\n');
function extract(start, end) {
  const offset = source.indexOf(start);
  const until = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && until > offset, `Missing server section ${start}`);
  return source.slice(offset, until);
}
const code = coffee.compile(extract('NEOS_PING_MAX_MISSED =', '\nneosRequestListener ='), {bare: true});
const BEGIN = 0, DUELING = 3;

function harness() {
  const logs = [];
  const context = {
    _: require('underscore'), RoomLifecycle: require('./room-lifecycle'), ROOM_all: [],
    ygopro: {constants: {DUEL_STAGE: {BEGIN, DUELING}}},
    log: {info: (fields) => logs.push(fields)}
  };
  context.global = context;
  vm.runInNewContext(code, context);
  return {context, logs, check: clients => context.NEOS_check_liveness(clients)};
}
function wsClient(extra = {}) {
  return Object.assign({readyState: 1, pings: 0, terminated: false,
    ping() { this.pings++; }, terminate() { this.terminated = true; this.readyState = 3; }}, extra);
}
const pong = client => { client.neos_ping_pending = false; client.neos_ping_missed = 0; };

// A client that answers is never dropped.
{
  const {check} = harness();
  const client = wsClient();
  for (let i = 0; i < 5; i++) { check([client]); pong(client); }
  assert.strictEqual(client.terminated, false);
  assert.strictEqual(client.pings, 5);
}

// A silent client outside any room is dropped only after two missed pings.
{
  const {check, logs} = harness();
  const client = wsClient();
  check([client]);
  check([client]);
  assert.strictEqual(client.terminated, false, 'one missed ping is tolerated');
  check([client]);
  assert.strictEqual(client.terminated, true);
  assert.deepStrictEqual(logs.map(entry => entry.action), ['terminate']);
  assert.ok(!JSON.stringify(logs).includes('ip'), 'liveness logs carry no address');
}

// The sole player of a waiting room is dropped; a waiting room with someone
// else in it, a started match, or a reconnecting client is only observed.
{
  const {context, check, logs} = harness();
  const alone = wsClient({rid: 0, pos: 0, name: 'Stale'});
  context.ROOM_all[0] = {duel_stage: BEGIN, players: [alone], name: 'M#TT,RANDOM#1', process_pid: 7};
  const shared = wsClient({rid: 1, pos: 0});
  context.ROOM_all[1] = {duel_stage: BEGIN, players: [shared, {pos: 1}]};
  const dueling = wsClient({rid: 2, pos: 0});
  context.ROOM_all[2] = {duel_stage: DUELING, players: [dueling]};
  const reconnecting = wsClient({pre_reconnecting: true});
  const watcher = wsClient({rid: 2, is_post_watcher: true});
  const clients = [alone, shared, dueling, reconnecting, watcher];
  for (let i = 0; i < 6; i++) check(clients);
  assert.strictEqual(alone.terminated, true, 'a stale waiting seat is released');
  assert.strictEqual(watcher.terminated, true, 'a silent spectator loses nothing');
  for (const kept of [shared, dueling, reconnecting]) assert.strictEqual(kept.terminated, false);
  const observed = logs.filter(entry => entry.action === 'observe');
  assert.strictEqual(observed.length, 2, 'each kept client is logged once, not on every tick');
  assert.ok(observed.some(entry => entry.duelStage === DUELING));
  dueling.neos_ping_pending = false; dueling.neos_ping_missed = 0;
  check([dueling]);
  assert.strictEqual(dueling.neos_ping_missed, 0, 'an answer resets the count');
}

// Closing sockets are skipped and a ping that throws does not stop the sweep.
{
  const {check} = harness();
  const closing = wsClient({readyState: 2});
  const throwing = wsClient({ping() { throw new Error('closed'); }});
  const healthy = wsClient();
  check([closing, throwing, healthy]);
  assert.strictEqual(closing.pings, 0);
  assert.strictEqual(healthy.pings, 1);
}

console.log('neos liveness tests passed');
