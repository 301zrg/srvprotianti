'use strict';

require('reflect-metadata');
global.PrimaryKeyType = 'integer';
global.DbDateType = 'datetime';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {Readable} = require('stream');
const {PluginHost} = require('../../plugin-system');
const {LadderUser, LadderMatch, LadderMatchGame} = require('../ladder-core/entities');
const {encodeDeck} = require('../../data-manager/DeckEncoder');

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
  const pluginI18n = {i18ns: JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/i18n.json'), 'utf8')), reloadI18nR() {}};
  host.applyTranslations(pluginI18n);
  assert.strictEqual(pluginI18n.i18ns['zh-cn'].ladder_profile_points, '你好，你的本月等级分为');
  assert.ok(!JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/i18n.json'), 'utf8'))['zh-cn'].ladder_profile_points,
    'ladder translations must not remain in the host dictionary');

  // DataManager must be loaded after the test's database type globals, just as
  // the real server does during initialization.
  const {DataManager} = require('../../data-manager/DataManager');
  const dataManager = new DataManager(runtime.databaseConfig, log);
  dataManager.registerEntities(host.entities);
  await dataManager.init();
  await host.init({settings, log, dataManager, runtime});

  for (const pathname of ['/rooms.html', '/replays.html', '/ladder.html', '/deck-stats.html', '/intro.html', '/player-stats.html', '/usage-stats.html', '/deck-detail.html']) {
    const pageResponse = {writeHead(status) { this.status = status; }, end(body) { this.body = body; }};
    const pageHandled = await host.call('http_request', {method: 'GET'}, pageResponse, {pathname, query: {}});
    assert.ok(pageHandled.includes(true), `${pathname} must be handled by the configured web routes`);
    assert.strictEqual(pageResponse.status, 200, `${pathname} must resolve to an existing HTML file`);
    assert.ok(Buffer.byteLength(pageResponse.body) > 0, `${pathname} must not return an empty page`);
    const pageHtml = String(pageResponse.body);
    for (const localizedTitle of ['游戏王OCG201103天梯服务器', '遊戯王OCG 201103 ランキングサーバー', 'Yu-Gi-Oh! OCG 201103 Ladder Server', '유희왕 OCG 201103 랭킹 서버']) {
      assert.ok(pageHtml.includes(localizedTitle), `${pathname} must provide the ${localizedTitle} title translation`);
    }
    if (pathname === '/intro.html') {
      assert.ok(pageHtml.includes('https://ygocdb.com/card/80604091'), 'the Ultimate Offering text must link to its card page');
      assert.ok(pageHtml.includes('data-i18n="server_intro_reconnect"'), 'the introduction must state reconnect and cloud replay support');
      for (const languageCommand of ['/zh切换为中文', '/jaと入力すると日本語に切り替わります', '/en to switch to English', '/ko를 입력하면 한국어로 전환됩니다']) {
        assert.ok(pageHtml.includes(languageCommand), `the ladder usage tip must include ${languageCommand}`);
      }
    }
    if (pathname === '/player-stats.html') assert.ok(pageHtml.includes('data-i18n="modeTips"'), 'player stats must explain public and password views');
  }

  const assetResponse = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
  const assetHandled = await host.call('http_request', {method: 'GET'}, assetResponse, {
    pathname: '/assets/common.css', query: {}
  });
  assert.ok(assetHandled.includes(true));
  assert.strictEqual(assetResponse.status, 200);
  assert.strictEqual(assetResponse.headers['Content-Type'], 'text/css; charset=utf-8');
  assert.ok(Buffer.byteLength(assetResponse.body) > 0);

  const badAssetResponse = {writeHead(status) { this.status = status; }, end(body) { this.body = body; }};
  const badAssetHandled = await host.call('http_request', {method: 'GET'}, badAssetResponse, {
    pathname: '/assets/%2e%2e%2fintro.html', query: {}
  });
  assert.ok(badAssetHandled.includes(true));
  assert.strictEqual(badAssetResponse.status, 400, 'asset routes must reject path traversal and non-whitelisted extensions');

  const exampleDeckResponse = {writeHead(status) { this.status = status; }, end(body) { this.body = body; }};
  const exampleDeckHandled = await host.call('http_request', {method: 'GET'}, exampleDeckResponse, {
    pathname: '/api/example-decks', query: {}
  });
  assert.ok(exampleDeckHandled.includes(true));
  assert.strictEqual(exampleDeckResponse.status, 200);
  const exampleDeckGroups = JSON.parse(exampleDeckResponse.body).groups;
  assert.strictEqual(exampleDeckGroups.length, 4);
  assert.strictEqual(exampleDeckGroups.reduce((count, group) => count + group.decks.length, 0), 24);

  const profileMessages = [];
  global.ygopro = {
    constants: {DUEL_STAGE: {BEGIN: 0, DUELING: 3, SIDING: 4}, COLORS: {PINK: 12, BABYBLUE: 11}},
    stoc_send_chat(client, message) { profileMessages.push({client, message}); }
  };
  const publicRoom = (name, values = {}) => ({
    process_pid: Number(name.replace(/\D/g, '')) || 1,
    name,
    established: true,
    random_type: 'TT',
    duel_stage: 0,
    hostinfo: {mode: 1},
    players: [],
    scores: {},
    getMaskedPlayerName(player) { return player.name; },
    ...values
  });
  global.ROOM_all = [
    publicRoom('M#TT,RANDOM#1'),
    publicRoom('M#TT,RANDOM#2', {players: [{name: 'ghost', isClosed: true}]}),
    publicRoom('M#TT,RANDOM#3', {players: [{name: 'waiting', isClosed: false, pos: 0}]}),
    publicRoom('M#TT,RANDOM#4', {players: [{name: 'deleting', isClosed: false, pos: 0}], deleting: true}),
    publicRoom('M#TT,RANDOM#5', {duel_stage: 3, duel_count: 1, turn: 3, players: [{name: 'dueling', pos: 0}]}),
    publicRoom('M#TT,RANDOM#6', {duel_stage: 4, duel_count: 1, turn: 9, players: [{name: 'siding', pos: 0}]})
  ];
  const roomResponse = {writeHead(status) { this.status = status; }, end(body) { this.body = body; }};
  const roomHandled = await host.call('http_request', {method: 'GET'}, roomResponse, {pathname: '/api/public/rooms', query: {}});
  assert.ok(roomHandled.includes(true));
  const publicRooms = JSON.parse(roomResponse.body).rooms;
  assert.deepStrictEqual(publicRooms.map(room => room.roomname), ['M#TT,RANDOM#3', 'M#TT,RANDOM#5', 'M#TT,RANDOM#6'],
    'empty, closed-client and deleting random rooms must stay out of the public list');
  assert.strictEqual(publicRooms.find(room => room.roomname.endsWith('#5')).istart, 'Duel:1 Turn:3');
  assert.strictEqual(publicRooms.find(room => room.roomname.endsWith('#6')).istart, 'Duel:1 Siding');

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
  assert.strictEqual(ladder.getRepository('LadderMatch'), dataManager.getRepository(ladder.entities.LadderMatch));
  assert.throws(() => ladder.getRepository('UnknownEntity'), /Unknown ladder entity/);
  const originalAuthenticate = ladder.authenticate;
  ladder.authenticate = async () => { throw new Error('database unavailable'); };
  const authenticationFailure = await host.call('before_join_room', {name: 'PlayerA', vpass: 'secret'},
    {random_type: 'TT', process_pid: 998, players: []});
  assert.ok(authenticationFailure.some(result => result?.error), 'ladder authentication errors must reject the join');
  ladder.authenticate = originalAuthenticate;
  const template = classifier.parseYdk(fs.readFileSync(path.resolve(__dirname, '../deck_analysis/deck_templates/1027.ydk'), 'utf8'));
  const actualDeck = template.main.concat(template.extra);
  const deckTypeId = classifier.classify(actualDeck);
  const templateResponse = {writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; }};
  const templateHandled = await host.call('http_request', {method: 'GET'}, templateResponse, {
    pathname: '/api/ladder/deck-template', query: {deckTypeId}
  });
  assert.ok(templateHandled.includes(true));
  assert.strictEqual(templateResponse.status, 200);
  assert.match(String(templateResponse.body), /#main/);
  assert.match(templateResponse.headers['Content-Disposition'], /attachment/);
  await ladder.authenticate('PlayerA', 'pass-a');
  await ladder.authenticate('PlayerB', 'pass-b');
  await host.call('client_joined_game', {name: 'PlayerA'}, {random_type: 'TT'});
  assert.strictEqual(profileMessages.length, 2, 'entering a ladder room must show the monthly profile and language switch tip');
  assert.ok(profileMessages.some(item => item.message === '${ladder_language_switch_tip}'));
  await host.call('client_language_changed', {name: 'PlayerA'}, {random_type: 'TT'});
  assert.strictEqual(profileMessages.length, 3, 'changing language in a ladder room must resend the monthly profile');
  assert.ok(profileMessages[2].message.includes('${ladder_profile_points}'));
  assert.ok(!profileMessages[2].message.includes('你好'), 'the monthly profile must use i18n placeholders instead of hard-coded Chinese');
  const room = {process_pid: 123, random_type: 'TT'};
  await host.call('room_started', room, []);
  const ladderDuelLog = await dataManager.saveDuelLog('TT-test', 123, 0, 'ladder-g1.yrp', 1, 1, [
    {name: 'PlayerA', pos: 0, realName: 'PlayerA', startDeckBuffer: encodeDeck({main: actualDeck, side: []}), deck: {main: actualDeck, side: []}, isFirst: true, winner: true, ip: '127.0.0.1', score: 1, lp: 8000, cardCount: 5},
    {name: 'PlayerB', pos: 1, realName: 'PlayerB', startDeckBuffer: encodeDeck({main: actualDeck, side: []}), deck: {main: actualDeck, side: []}, isFirst: false, winner: false, ip: '127.0.0.2', score: 0, lp: 0, cardCount: 0}
  ]);
  await host.call('duel_log_saved', {roomId: 123, randomType: 'TT', duelCount: 1, duelLogId: ladderDuelLog.id});
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
  ], {cause: 'duel_end', matchCompleted: true, explicitForfeit: false, duelEndSeen: true});

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
  fs.writeFileSync(path.join(replayRoot, 'ladder-g1.yrp'), Buffer.from([7, 8, 9]));
  const filteredReplayResponse = {writeHead(status) { this.status = status; }, end(body) { this.body = body; }};
  const filteredReplayHandled = await host.call('http_request', {method: 'GET'}, filteredReplayResponse, {
    pathname: '/api/public/replays', query: {deckTypeId: String(deckTypeId)}
  });
  assert.ok(filteredReplayHandled.includes(true));
  assert.strictEqual(filteredReplayResponse.status, 200);
  const filteredReplays = JSON.parse(filteredReplayResponse.body);
  assert.strictEqual(filteredReplays.total, 1, 'deck filtering must only retain replays involving the requested G1 type');
  assert.strictEqual(filteredReplays.replays[0].name, 'ladder-g1.yrp');
  assert.ok(filteredReplays.replays[0].players.every(player => player.deckTypeId === deckTypeId));
  assert.ok(filteredReplays.deckTypes.some(deck => deck.id === deckTypeId));
  const usersAfterMatch = await dataManager.getRepository(LadderUser).find();
  assert.strictEqual(usersAfterMatch.find(user => user.name === 'playerb').duelPoints, 1010);
  assert.strictEqual(usersAfterMatch.find(user => user.name === 'playera').duelPoints, 990);

  const playerAnalytics = host.services.get('ladderAnalytics');
  const publicProfile = await playerAnalytics.profile({player: 'PlayerA', month: savedMatch.monthKey, page: 1}, 'wrong');
  assert.strictEqual(publicProfile.found, true);
  assert.strictEqual(publicProfile.authenticated, false);
  assert.strictEqual(publicProfile.matches.length, 1);
  assert.strictEqual(publicProfile.matches[0].score, '1-2');
  assert.strictEqual(publicProfile.matches[0].pointsAfter, 990);
  assert.strictEqual(publicProfile.matches[0].opponentPointsAfter, 1010);
  const privateProfile = await playerAnalytics.profile({player: 'playera', month: savedMatch.monthKey, page: 1}, 'pass-a');
  assert.strictEqual(privateProfile.authenticated, true);
  assert.strictEqual(privateProfile.total, 1);
  assert.deepStrictEqual(privateProfile.chart.map(point => point.pointsAfter), [990]);
  const playerRequest = Readable.from([Buffer.from(JSON.stringify({player: 'PlayerA', password: 'pass-a', month: savedMatch.monthKey, page: 1}))]);
  playerRequest.method = 'POST';
  const playerResponse = {writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; }};
  const playerHandled = await host.call('http_request', playerRequest, playerResponse, {pathname: '/api/ladder/player', query: {}});
  assert.ok(playerHandled.includes(true));
  assert.strictEqual(playerResponse.status, 200);
  assert.strictEqual(playerResponse.headers['Cache-Control'], 'no-store');
  assert.strictEqual(JSON.parse(playerResponse.body).authenticated, true);
  assert.ok(!String(playerResponse.body).includes('pass-a'), 'player API must not echo the password');
  if (host.services.get('cardCatalog').metadataAvailable && template.extra.length) {
    const downloaded = await playerAnalytics.profileDeck({player: 'playera', matchId: savedMatch.id, side: 'player'}, 'pass-a');
    assert.ok(downloaded.contents.includes(`#extra\r\n${template.extra[0]}`), 'downloaded YDK must restore extra-deck cards using CDB types');
  }
  const winsRanking = await playerAnalytics.ranking({type: 'total', rankingBasis: 'wins'});
  assert.strictEqual(winsRanking.rankingBasis, 'wins');
  assert.strictEqual(winsRanking.ladder[0].name, 'PlayerB');
  const usageStats = await host.services.get('ladderUsageAnalytics').deckUsage({period: 'all'});
  const expectedUsageSamples = host.services.get('cardCatalog').metadataAvailable ? 2 : 0;
  assert.strictEqual(usageStats.coverage.allDecks, expectedUsageSamples,
    'each Match must produce two deck-usage perspectives when the authoritative CDB is available');
  const initialDetail = await host.services.get('ladderUsageAnalytics').deckDetail({deckTypeId, period: 'all'});
  assert.strictEqual(initialDetail.overall.matches, 2, 'same-deck Match detail must contain both player perspectives');
  assert.strictEqual(initialDetail.overall.games, 6, 'three physical games must contain six player perspectives');
  if (expectedUsageSamples) {
    assert.strictEqual(usageStats.coverage.validCardDecks, 2);
    const monsterUsage = await host.services.get('ladderUsageAnalytics').cardUsage({period: 'all', metric: 'monster'});
    assert.ok(monsterUsage.cards.length > 0, 'a valid G1 snapshot must contribute card facts and aggregates');
    assert.ok(monsterUsage.cards.every(card => card.deckCount === 2), 'both identical player snapshots must increment each card aggregate');
    if (template.extra.length) {
      const extraUsage = await host.services.get('ladderUsageAnalytics').cardUsage({period: 'all', metric: 'extra'});
      assert.ok(extraUsage.cards.length > 0, 'CDB card types must split extra-deck cards from UPDATE_DECK main+extra payloads');
    }
    const monthlyMonsterUsage = await host.services.get('ladderUsageAnalytics').cardUsage({period: 'month', month: savedMatch.monthKey, metric: 'monster'});
    assert.strictEqual(monthlyMonsterUsage.coverage.validCardDecks, 2);
    assert.ok(monthlyMonsterUsage.cards.length > 0, 'daily aggregates must combine into the selected China-time month');
  }

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
  ], {cause: 'duel_end', matchCompleted: true, explicitForfeit: false, duelEndSeen: true});
  assert.strictEqual(await dataManager.getRepository(LadderMatch).count(), 1, 'inconsistent score/game winners must not settle');

  const partialRoom = {process_pid: 125, random_type: 'TT'};
  await host.call('room_started', partialRoom, []);
  await host.call('duel_result', {
    roomId: 125, roomName: 'M#TT,RANDOM#3', randomType: 'TT', duelCount: 1,
    winnerPosition: 0, winnerName: 'PlayerA', capturedAt: new Date(),
    players: [
      {name: 'PlayerA', position: 0, isFirst: true, main: actualDeck, side: []},
      {name: 'PlayerB', position: 1, isFirst: false, main: actualDeck, side: []}
    ]
  });
  await host.call('room_deleted', partialRoom, [
    {name: 'PlayerA', name_vpass: 'PlayerA$pass-a', score: 1},
    {name: 'PlayerB', name_vpass: 'PlayerB$pass-b', score: 0}
  ], {cause: 'process_exit', matchCompleted: false, explicitForfeit: false, duelEndSeen: false});
  assert.strictEqual(await dataManager.getRepository(LadderMatch).count(), 1, 'a process exit must not settle a partial non-tied score');

  const matchRepo = dataManager.getRepository(LadderMatch);
  const gameRepo = dataManager.getRepository(LadderMatchGame);
  const syntheticMatch = values => matchRepo.save(matchRepo.create({
    matchKey: values.matchKey,
    monthKey: savedMatch.monthKey,
    winnerName: values.winnerName || 'playera',
    loserName: values.winnerName === 'playerb' ? 'playera' : 'playerb',
    playerAName: 'playera', playerBName: 'playerb',
    playerADeckTypeId: values.playerADeckTypeId || deckTypeId,
    playerBDeckTypeId: values.playerBDeckTypeId || deckTypeId,
    g1FirstPlayer: values.g1FirstPlayer,
    createTime: new Date()
  }));
  const syntheticGames = (match, firstA, firstB) => gameRepo.save([
    gameRepo.create({
      matchId: match.id, playerName: 'playera', opponentName: 'playerb',
      deckTypeId: match.playerADeckTypeId, opponentDeckTypeId: match.playerBDeckTypeId,
      winnerName: match.winnerName, duelCount: 1, isFirst: firstA, isMain: 1, createTime: new Date()
    }),
    gameRepo.create({
      matchId: match.id, playerName: 'playerb', opponentName: 'playera',
      deckTypeId: match.playerBDeckTypeId, opponentDeckTypeId: match.playerADeckTypeId,
      winnerName: match.winnerName, duelCount: 1, isFirst: firstB, isMain: 1, createTime: new Date()
    })
  ]);

  // A Match without a trustworthy G1 first player is dirty as a whole. Even
  // plausible attached game rows must not leak into Match or game statistics.
  const dirtyFirstMatch = await syntheticMatch({matchKey: 'dirty-first', g1FirstPlayer: null});
  await syntheticGames(dirtyFirstMatch, 1, 0);
  const foreignFirstMatch = await syntheticMatch({matchKey: 'foreign-first', g1FirstPlayer: 'not-a-player'});
  await syntheticGames(foreignFirstMatch, 1, 0);

  // A valid Match remains eligible for Match statistics, but a physical game
  // whose mirrored rows both claim to be second is excluded from game stats.
  const dirtyGameMatch = await syntheticMatch({matchKey: 'dirty-game', g1FirstPlayer: 'playera'});
  await syntheticGames(dirtyGameMatch, 0, 0);

  const rabbitTemplate = classifier.parseYdk(fs.readFileSync(path.resolve(__dirname, '../deck_analysis/deck_templates/514.ydk'), 'utf8'));
  const rabbitDeckTypeId = classifier.classify(rabbitTemplate.main.concat(rabbitTemplate.extra));
  const crossMatch = await syntheticMatch({
    matchKey: 'cross-match', g1FirstPlayer: 'playera', winnerName: 'playerb',
    playerADeckTypeId: deckTypeId, playerBDeckTypeId: rabbitDeckTypeId
  });
  assert.ok(crossMatch.id, 'the cross-deck complement sample must be persisted');

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
    [4, 2, 2, 1, 2, 1]
  );
  assert.deepStrictEqual(
    [statistics.stats[`${group.id}::all`].games, statistics.stats[`${group.id}::all`].gameWins],
    [6, 3]
  );
  const rabbitGroup = statistics.decks.find(deck => deck.members.includes(rabbitDeckTypeId));
  assert.ok(rabbitGroup, `template ${rabbitDeckTypeId} must belong to a displayed statistics group`);
  const firstAgainstRabbit = statistics.stats[`${group.id}::${rabbitGroup.id}`];
  const secondAgainstSynchro = statistics.stats[`${rabbitGroup.id}::${group.id}`];
  assert.deepStrictEqual([firstAgainstRabbit.firstMatches, firstAgainstRabbit.firstWins], [1, 0]);
  assert.deepStrictEqual([secondAgainstSynchro.secondMatches, secondAgainstSynchro.secondWins], [1, 1]);
  assert.strictEqual(
    firstAgainstRabbit.firstWins / firstAgainstRabbit.firstMatches + secondAgainstSynchro.secondWins / secondAgainstSynchro.secondMatches,
    1,
    'A-vs-B Match first rate and B-vs-A Match second rate must be complementary'
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

  // Search narrows the result set and pagination, but must not recalculate the
  // player's rank inside that smaller set. PlayerA remains second behind B.
  const searchedTotalRanking = await host.services.get('ladderAnalytics').ranking({type: 'total', search: 'playera', page: 1, pageSize: 1});
  assert.strictEqual(searchedTotalRanking.total, 1);
  assert.strictEqual(searchedTotalRanking.ladder[0].name, 'playera');
  assert.strictEqual(searchedTotalRanking.ladder[0].rank, 2);
  const searchedMonthlyRanking = await host.services.get('ladderAnalytics').ranking({type: 'month', search: 'playera', page: 1, pageSize: 1});
  assert.strictEqual(searchedMonthlyRanking.total, 1);
  assert.strictEqual(searchedMonthlyRanking.ladder[0].rank, 2);

  await dataManager.getConnection().close();
  fs.rmSync(replayRoot, {recursive: true, force: true});
  console.log('plugin integration test passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
