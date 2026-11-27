'use strict';

// Host side of design 2.4: realName without passwords, recover refused, and
// the admin playername filter. Synthetic data only.
require('reflect-metadata');
global.PrimaryKeyType = 'integer';
global.DbDateType = 'datetime';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'ygopro-server.coffee'), 'utf8').replace(/\r\n/g, '\n');

(async () => {
  // ---- realName and recover (source checks on the shipped host) ----
  assert.match(source, /realName: player\.name\n/, 'duel logs store the nickname only');
  assert.doesNotMatch(source, /realName: player\.name_vpass/);
  assert.match(source, /RECOVER_ALLOWED = global\.RECOVER_ALLOWED = false/);
  assert.match(source, /info\.pass\.toUpperCase\(\)=="RC" and RECOVER_ALLOWED and/, 'RC search is refused in code');
  assert.match(source, /if RECOVER_ALLOWED and settings\.modules\.tournament_mode\.enable_recover and \(param = rule\.match/, 'recover rooms are refused in code');
  const compiled = fs.readFileSync(path.join(__dirname, 'ygopro-server.js'), 'utf8');
  assert.ok(compiled.includes('realName: player.name,') && compiled.includes('RECOVER_ALLOWED = global.RECOVER_ALLOWED = false'),
    'ygopro-server.js must be rebuilt from the coffee source');

  // ---- admin playername filter matches by nickname ----
  const {DataManager} = require('./data-manager/DataManager');
  const dataManager = new DataManager({type: 'sqljs'}, {info() {}, warn() {}});
  await dataManager.init();
  const player = (realName, pos) => ({name: realName.split('$')[0], pos, realName, startDeckBuffer: null, deck: {main: [], side: []},
    isFirst: pos === 0, winner: pos === 0, ip: '127.0.0.1', score: 1, lp: 8000, cardCount: 0});
  await dataManager.saveDuelLog('room-old', 1, 0, 'a.yrp', 1, 1, [player('Alice$synthetic-pw', 0), player('Bob', 1)]);
  await dataManager.saveDuelLog('room-new', 2, 0, 'b.yrp', 1, 1, [player('Alice', 0), player('Carol', 1)]);
  await dataManager.saveDuelLog('room-like', 3, 0, 'c.yrp', 1, 1, [player('Al_ce', 0), player('A%', 1)]);
  const rooms = async name => (await dataManager.getDuelLogFromCondition({playerName: name})).map(log => log.name).sort();
  assert.deepStrictEqual(await rooms('Alice'), ['room-new', 'room-old'], 'before and after cleanup');
  assert.deepStrictEqual(await rooms('Alice$anything'), ['room-new', 'room-old'], 'old full-form parameters still work');
  assert.deepStrictEqual(await rooms('Al_ce'), ['room-like'], 'LIKE wildcards are escaped');
  assert.deepStrictEqual(await rooms('A%'), ['room-like']);
  assert.deepStrictEqual(await rooms('Ali'), [], 'no prefix matches');
  await dataManager.getConnection().close();

  // TT reconnect stays on the original rules: a password cannot change
  // during a live match (ladder-core refuses it), so no account grant exists.
  assert.doesNotMatch(source, /reconnect_authorize|reconnect_commit|account_binding/);

  console.log('host password tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
