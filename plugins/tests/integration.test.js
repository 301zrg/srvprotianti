'use strict';

require('reflect-metadata');
global.PrimaryKeyType = 'integer';
global.DbDateType = 'datetime';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {PluginHost} = require('../../plugin-system');
const {LadderUser, LadderMatch, LadderMatchGame} = require('../ladder-core/entities');

const log = {info() {}, warn() {}};

(async () => {
  const replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro-replay-test-'));
  const settings = {modules: {
    mysql: {enabled: true, db: {type: 'sqljs'}},
    tournament_mode: {replay_path: replayRoot},
    reconnect: {enabled: true}
  }};
  const runtime = {databaseConfig: settings.modules.mysql.db};
  const host = new PluginHost('./plugins', log);
  await host.register({settings, log, runtime});

  // DataManager must be loaded after the test's database type globals, just as
  // the real server does during initialization.
  const {DataManager} = require('../../data-manager/DataManager');
  const dataManager = new DataManager(runtime.databaseConfig, log);
  dataManager.registerEntities(host.entities);
  await dataManager.init();
  await host.init({settings, log, dataManager, runtime});

  for (const pathname of ['/rooms.html', '/replays.html', '/ladder.html', '/deck-stats.html', '/intro.html']) {
    const pageResponse = {writeHead(status) { this.status = status; }, end(body) { this.body = body; }};
    const pageHandled = await host.call('http_request', {method: 'GET'}, pageResponse, {pathname, query: {}});
    assert.ok(pageHandled.includes(true), `${pathname} must be handled by the configured web routes`);
    assert.strictEqual(pageResponse.status, 200, `${pathname} must resolve to an existing HTML file`);
    assert.ok(Buffer.byteLength(pageResponse.body) > 0, `${pathname} must not return an empty page`);
  }

  // Public replay discovery is based on files. DuelLog enriches the response,
  // while incomplete historical database links must not hide valid replays.
  const replayName = '测试-public-replay.yrp';
  const orphanReplayName = 'test-replay-without-log.yrp';
  fs.writeFileSync(path.join(replayRoot, replayName), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(replayRoot, orphanReplayName), Buffer.from([4, 5, 6]));
  await dataManager.saveDuelLog('TT-test', 999, 0, replayName, 1, 2, [
    {name: 'PlayerA', pos: 0, realName: 'PlayerA', startDeckBuffer: Buffer.alloc(0), deck: {main: [], side: []}, isFirst: true, winner: true, ip: '127.0.0.1', score: 1, lp: 8000, cardCount: 5},
    {name: 'PlayerB', pos: 1, realName: 'PlayerB', startDeckBuffer: Buffer.alloc(0), deck: {main: [], side: []}, isFirst: false, winner: false, ip: '127.0.0.2', score: 0, lp: 0, cardCount: 0}
  ]);

  const response = {writeHead(status) { this.status = status; }, end(body) { this.body = body; }};
  const handled = await host.call('http_request', {method: 'GET'}, response, {pathname: '/api/public/replays', query: {}});
  assert.ok(handled.includes(true));
  assert.strictEqual(response.status, 200);
  const publicReplays = JSON.parse(response.body);
  assert.strictEqual(publicReplays.total, 2);
  assert.strictEqual(publicReplays.replays.length, 2);
  const enrichedReplay = publicReplays.replays.find(replay => replay.name === replayName);
  assert.strictEqual(enrichedReplay.duelCount, 2);
  assert.strictEqual(enrichedReplay.winner, 'PlayerA');
  const orphanReplay = publicReplays.replays.find(replay => replay.name === orphanReplayName);
  assert.ok(orphanReplay, 'a replay file without DuelLog metadata must remain downloadable');
  assert.strictEqual(orphanReplay.winner, null);

  const downloadResponse = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
  const downloadHandled = await host.call('http_request', {method: 'GET'}, downloadResponse, {
    pathname: `/api/public/replay/${encodeURIComponent(replayName)}`,
    query: {}
  });
  assert.ok(downloadHandled.includes(true));
  assert.strictEqual(downloadResponse.status, 200);
  assert.deepStrictEqual(downloadResponse.body, Buffer.from([1, 2, 3]));
  assert.match(downloadResponse.headers['Content-Disposition'], /filename\*=UTF-8''/);
  assert.doesNotMatch(downloadResponse.headers['Content-Disposition'], /[^\x00-\x7f]/, 'HTTP response headers must stay ASCII-safe');

  const ladder = host.services.get('ladderCore');
  const classifier = host.services.get('deckClassifier');
  const template = classifier.parseYdk(fs.readFileSync(path.resolve(__dirname, '../deck_analysis/deck_templates/1027.ydk'), 'utf8'));
  const actualDeck = template.main.concat(template.extra);
  const deckTypeId = classifier.classify(actualDeck);
  await ladder.authenticate('PlayerA', 'pass-a');
  await ladder.authenticate('PlayerB', 'pass-b');
  const room = {process_pid: 123, random_type: 'TT'};
  await host.call('room_started', room, []);
  await host.call('rps_winner', {roomId: 123, randomType: 'TT', playerName: 'PlayerB'});
  const emitDuel = async (duelCount, winnerName, firstName, main) => host.call('duel_result', {
    roomId: 123, roomName: 'M#TT,RANDOM#1', randomType: 'TT', duelCount,
    winnerPosition: winnerName === 'PlayerA' ? 0 : 1, winnerName, capturedAt: new Date(),
    players: [
      {name: 'PlayerA', key: 'PlayerA$pass-a', position: 0, isFirst: firstName === 'PlayerA', main, side: []},
      {name: 'PlayerB', key: 'PlayerB$pass-b', position: 1, isFirst: firstName === 'PlayerB', main, side: []}
    ]
  });
  await emitDuel(1, 'PlayerA', 'PlayerA', actualDeck);
  // Deliberately make post-side buffers unclassifiable. Persisted G2/G3 deck
  // types must still use each player's G1 archetype.
  await emitDuel(2, 'PlayerB', 'PlayerB', []);
  await emitDuel(3, 'PlayerB', 'PlayerA', []);
  await host.call('room_deleted', room, [
    {name: 'PlayerA', name_vpass: 'PlayerA$pass-a', score: 1},
    {name: 'PlayerB', name_vpass: 'PlayerB$pass-b', score: 2}
  ]);

  assert.strictEqual(await dataManager.getRepository(LadderMatch).count(), 1);
  const savedMatch = await dataManager.getRepository(LadderMatch).findOne();
  assert.strictEqual(savedMatch.winnerName, 'playerb');
  assert.strictEqual(savedMatch.loserName, 'playera');
  assert.strictEqual(savedMatch.coinWinner, 'playerb');
  const games = await dataManager.getRepository(LadderMatchGame).find();
  assert.strictEqual(games.length, 6, 'three real games must create six player-perspective rows');
  assert.deepStrictEqual([...new Set(games.filter(game => game.duelCount === 1).map(game => game.winnerName))], ['playera']);
  assert.deepStrictEqual([...new Set(games.filter(game => game.duelCount > 1).map(game => game.winnerName))], ['playerb']);
  assert.ok(games.every(game => game.deckTypeId === deckTypeId), 'all games must retain the G1 deck type');
  assert.ok(games.every(game => game.opponentDeckTypeId === deckTypeId), 'all opponent deck types must retain G1');
  const usersAfterMatch = await dataManager.getRepository(LadderUser).find();
  assert.strictEqual(usersAfterMatch.find(user => user.name === 'playerb').duelPoints, 1010);
  assert.strictEqual(usersAfterMatch.find(user => user.name === 'playera').duelPoints, 990);

  const inconsistentRoom = {process_pid: 124, random_type: 'TT'};
  await host.call('room_started', inconsistentRoom, []);
  await host.call('duel_result', {
    roomId: 124, roomName: 'M#TT,RANDOM#2', randomType: 'TT', duelCount: 1,
    winnerPosition: 0, winnerName: 'PlayerA', capturedAt: new Date(),
    players: [
      {name: 'PlayerA', position: 0, isFirst: true, main: actualDeck, side: []},
      {name: 'PlayerB', position: 1, isFirst: false, main: actualDeck, side: []}
    ]
  });
  await host.call('room_deleted', inconsistentRoom, [
    {name: 'PlayerA', name_vpass: 'PlayerA$pass-a', score: 0},
    {name: 'PlayerB', name_vpass: 'PlayerB$pass-b', score: 1}
  ]);
  assert.strictEqual(await dataManager.getRepository(LadderMatch).count(), 1, 'inconsistent score/game winners must not settle');

  // Old deployments have two player-perspective rows per game but no explicit
  // opponentDeckTypeId. The analytics query derives it from the counterpart.
  await dataManager.getConnection().query('DROP INDEX "ix_ladder_game_month_query"');
  await dataManager.getConnection().query('ALTER TABLE "ladder_match_game" DROP COLUMN "opponentDeckTypeId"');

  // Mirrored player perspectives make the same-deck overall rate exactly 50%.
  const statistics = await host.services.get('ladderAnalytics').deckStats({});
  const group = statistics.decks.find(deck => deck.members.includes(deckTypeId));
  assert.ok(group, `template ${deckTypeId} must belong to a displayed statistics group`);
  const sameDeck = statistics.stats[`${group.id}::${group.id}`];
  assert.strictEqual(sameDeck.games, 6);
  assert.strictEqual(sameDeck.gameWins, 3);
  assert.deepStrictEqual(
    [sameDeck.firstGames, sameDeck.firstGameWins, sameDeck.secondGames, sameDeck.secondGameWins],
    [3, 2, 3, 1]
  );
  assert.deepStrictEqual(
    [sameDeck.matches, sameDeck.matchWins, sameDeck.firstMatches, sameDeck.firstWins, sameDeck.secondMatches, sameDeck.secondWins],
    [2, 1, 1, 0, 1, 1]
  );
  assert.deepStrictEqual(
    [statistics.stats[`${group.id}::all`].games, statistics.stats[`${group.id}::all`].gameWins],
    [6, 3]
  );

  // A restored production database can predate displayName. Ranking must stay
  // readable and temporarily fall back to the normalized account key.
  await dataManager.getConnection().query('ALTER TABLE "ladder_user" DROP COLUMN "displayName"');
  const totalRanking = await host.services.get('ladderAnalytics').ranking({type: 'total'});
  assert.strictEqual(totalRanking.total, 2);
  assert.ok(totalRanking.ladder.some(user => user.name === 'playera'));
  const monthlyRanking = await host.services.get('ladderAnalytics').ranking({type: 'month'});
  assert.strictEqual(monthlyRanking.total, 2);
  assert.ok(monthlyRanking.ladder.some(user => user.name === 'playera'));

  await dataManager.getConnection().close();
  fs.rmSync(replayRoot, {recursive: true, force: true});
  console.log('plugin integration test passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
