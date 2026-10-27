'use strict';

require('reflect-metadata');
global.PrimaryKeyType = 'integer';
global.DbDateType = 'datetime';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {DataManager} = require('../../data-manager/DataManager');
const {LadderUser, LadderMonthRecord, LadderMatch, LadderMatchGame} = require('./entities');
const core = require('./index')._test;
const analytics = require('../ladder-analytics')._test;
const log = {warn() {}, info() {}};

test('M streaks start at zero, persist across restarts, reset on loss and only expose fresh latest results', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-streak-'));
  const dataManager = new DataManager({type: 'sqljs'}, log);
  try {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
    fs.writeFileSync(path.join(root, 'config.default.json'), JSON.stringify(config));
    dataManager.registerEntities([LadderUser, LadderMonthRecord, LadderMatch, LadderMatchGame]);
    await dataManager.init();
    // DataManager skips SQL.js transactions in its ordinary integration mode.
    // Use the driver's real transaction here to exercise rollback semantics.
    dataManager.pluginTransaction = callback => dataManager.getConnection().transaction(callback);
    const emitted = [];
    const classifier = {classify() { return 4095; }, otherDeckTypeId: 4095};
    const api = {rootDir: root, config, dataManager, log,
      get: name => name === 'deckClassifier' ? classifier : null,
      emit: async (name, event) => { emitted.push(event); }};
    let ladder = core.createService(api);
    const service = analytics.createService({...api,
      get: name => name === 'ladderCore' ? ladder : api.get(name)});
    const users = dataManager.getRepository(LadderUser), matches = dataManager.getRepository(LadderMatch);
    const monthly = dataManager.getRepository(LadderMonthRecord), month = core.monthKey();
    await ladder.authenticate('Streak-A', 'test');
    await ladder.authenticate('Streak-B', 'test');
    await monthly.save(monthly.create({name: 'streak-a', monthKey: month, wins: 2, losses: 1, duelPoints: 1200}));
    assert.strictEqual((await ladder.getMonthlyProfile('Streak-A')).currentWinStreak, 0);
    assert.deepStrictEqual((await service.recentWinStreaks()).streaks, [], 'old monthly wins do not initialize a streak');
    let roomId = 20000;
    const names = ['Streak-A', 'Streak-B'];
    const play = async (winner, outcome = {matchCompleted: true}) => {
      const room = {process_pid: ++roomId, random_type: 'TT'};
      // A 2-1 Match has three G results but increments the streak only once.
      [winner, 1 - winner, winner].forEach((side, index) => ladder.captureGame({
        roomId, randomType: 'TT', duelCount: index + 1, winnerName: names[side], capturedAt: new Date(),
        players: names.map((name, i) => ({name, isFirst: i === 0, main: [], side: []}))
      }));
      const scores = names.map((name, index) => ({name, name_vpass: `${name}$test`, score: index === winner ? 2 : 1}));
      await ladder.settle(room, scores, outcome);
      return {room, scores, outcome};
    };
    for (let i = 1; i <= 4; ++i) {
      await play(0);
      assert.strictEqual((await ladder.getMonthlyProfile('Streak-A')).currentWinStreak, i);
      assert.deepStrictEqual((await service.recentWinStreaks()).streaks, [], 'fewer than five wins are not announced');
    }
    ladder = core.createService(api);
    assert.strictEqual((await ladder.getMonthlyProfile('Streak-A')).currentWinStreak, 4, 'a restart retains newly accumulated wins');
    const fifth = await play(0);
    let feed = await service.recentWinStreaks();
    assert.strictEqual(feed.streaks.length, 1);
    const row = feed.streaks[0];
    assert.strictEqual(row.streak, 5);
    assert.deepStrictEqual([row.wins, row.losses, row.diff, row.winRate], [7, 1, 6, 0.875]);
    assert.strictEqual(row.points, (await monthly.findOne({where: {name: 'streak-a', monthKey: month}})).duelPoints);
    assert.strictEqual(Date.parse(row.expiresAt) - Date.parse(row.settledAt), 60000);
    assert.ok(Math.abs(Date.parse(row.settledAt) - Date.now()) < 5000, 'date hydration must preserve UTC on a UTC+8 host');
    assert.ok(!['password', 'pass', 'opponent', 'deck', 'ip'].some(key => key in row));
    const webRoot = path.resolve(__dirname, '../ladder-web');
    let httpHandler;
    const webServices = {ladderAnalytics: service, deckClassifier: classifier, ladderUsageAnalytics: {}};
    require('../ladder-web').init({rootDir: webRoot, config: {routesFile: 'routes.json'}, log,
      get: name => webServices[name],
      hook: (name, handler) => { if (name === 'http_request') httpHandler = handler; }});
    const response = {headers: {}, setHeader(key, value) { this.headers[key] = value; },
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
      end(body) { this.body = body; }};
    assert.strictEqual(await httpHandler({method: 'GET'}, response, {pathname: '/api/ladder/streaks'}), true);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers['Cache-Control'], 'no-store');
    assert.strictEqual(JSON.parse(response.body).streaks[0].streak, 5);
    await ladder.settle(fifth.room, fifth.scores, fifth.outcome);
    assert.strictEqual((await users.findOne('streak-a')).currentWinStreak, 5, 'repeated room deletion must not count again');
    assert.strictEqual(await matches.count(), 5);
    await play(0);
    feed = await service.recentWinStreaks();
    assert.deepStrictEqual(feed.streaks.map(value => value.streak), [6], 'only the latest result is visible');
    await matches.update(feed.streaks[0].matchId, {createTime: new Date(Date.now() - 61000)});
    assert.deepStrictEqual((await service.recentWinStreaks()).streaks, [], 'old wins expire');
    await play(1);
    assert.strictEqual((await users.findOne('streak-a')).currentWinStreak, 0);
    assert.deepStrictEqual((await service.recentWinStreaks()).streaks, [], 'a loss invalidates earlier streak posts');
    for (let i = 0; i < 7; ++i) await play(0);
    await users.update('streak-a', {monthKey: '200001'});
    await play(0, {matchCompleted: false, cause: 'process_exit'});
    assert.strictEqual((await users.findOne('streak-a')).currentWinStreak, 7, 'unsettled rooms have no effect');
    const before = await matches.count(), originalTransaction = dataManager.pluginTransaction.bind(dataManager);
    dataManager.pluginTransaction = callback => originalTransaction(async manager => {
      await callback(manager);
      throw new Error('forced rollback');
    });
    await assert.rejects(play(0), /forced rollback/);
    assert.strictEqual((await users.findOne('streak-a')).currentWinStreak, 7);
    assert.strictEqual(await matches.count(), before);
    assert.strictEqual(emitted.length, before, 'rollback must not publish a committed event');
    dataManager.pluginTransaction = originalTransaction;
    await play(0, {explicitForfeit: true});
    assert.strictEqual((await ladder.getMonthlyProfile('Streak-A')).currentWinStreak, 8, 'streaks survive month changes');
  } finally {
    if (dataManager.ready) await dataManager.getConnection().close();
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('migration initializes all existing users to zero without reading matches or changing statistics', async () => {
  const SQL = await require('sql.js')(), db = new SQL.Database();
  try {
    db.run('CREATE TABLE ladder_user (name TEXT PRIMARY KEY, wins INTEGER, losses INTEGER, "duelPoints" INTEGER, "monthWins" INTEGER, "monthLosses" INTEGER, "monthDuelPoints" INTEGER)');
    const stats = [
      ['experienced', 82, 35, 1290, 17, 8, 1090],
      ['new', 0, 0, 1000, 0, 0, 1000]
    ];
    for (const row of stats) db.run('INSERT INTO ladder_user VALUES (?, ?, ?, ?, ?, ?, ?)', row);
    // Run the actual DDL, omitting only psql commands and PostgreSQL's lock.
    // No Match table exists here, so any historical dependency would fail.
    const migration = fs.readFileSync(path.join(__dirname, 'migrations/202610-win-streaks/apply.sql'), 'utf8')
      .replace(/^\\.*$/gm, '').replace(/^LOCK TABLE .*;$/gm, '');
    db.run(migration);
    assert.deepStrictEqual(db.exec('SELECT name, wins, losses, "duelPoints", "monthWins", "monthLosses", "monthDuelPoints" FROM ladder_user ORDER BY name')[0].values, stats);
    assert.deepStrictEqual(db.exec('SELECT name, "currentWinStreak", "lastMatchId" FROM ladder_user ORDER BY name')[0].values,
      [['experienced', 0, null], ['new', 0, null]]);
    db.run('INSERT INTO ladder_user (name) VALUES (\'later\')');
    assert.deepStrictEqual(db.exec('SELECT "currentWinStreak", "lastMatchId" FROM ladder_user WHERE name = \'later\'')[0].values, [[0, null]]);
    db.run('UPDATE ladder_user SET "currentWinStreak" = 6, "lastMatchId" = 99 WHERE name = \'experienced\'');
    assert.throws(() => db.run(migration), /duplicate column/);
    db.run('ROLLBACK');
    assert.deepStrictEqual(db.exec('SELECT "currentWinStreak", "lastMatchId" FROM ladder_user WHERE name = \'experienced\'')[0].values, [[6, 99]], 'reapplying cannot reset live streaks');
  } finally { db.close(); }
});
