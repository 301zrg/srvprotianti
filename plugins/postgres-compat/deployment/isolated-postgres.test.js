#!/usr/bin/env node
'use strict';

// Opt-in integration test. It creates uniquely named synthetic databases;
// it never reads local application config or connects to a default PG port.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const {Client} = require('pg');
const {quote, root, checkedContract} = require('./contract');
const {verify} = require('./schema');

async function main() {
  if (process.env.SRVPRO_SCHEMA_TEST_CONFIRM !== 'isolated' || process.env.PGHOST !== '127.0.0.1' ||
      !process.env.PGPORT || process.env.PGPORT === '5432' || !process.env.PGUSER) {
    throw new Error('Requires SRVPRO_SCHEMA_TEST_CONFIRM=isolated, PGHOST=127.0.0.1, explicit non-5432 PGPORT, and PGUSER.');
  }
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    if (!['--pg-bin', '--report-dir'].includes(process.argv[index]) || !process.argv[index + 1]) throw new Error('Use --pg-bin DIR --report-dir DIR.');
    options[process.argv[index].slice(2)] = path.resolve(process.argv[index + 1]);
  }
  if (!options['pg-bin'] || !options['report-dir']) throw new Error('--pg-bin and --report-dir are required.');
  fs.mkdirSync(options['report-dir'], {recursive: true});
  const suffix = Date.now().toString(36) + '_' + process.pid;
  const database = 'srvpro_schema_drill_' + suffix;
  const restored = database + '_restore';
  const runtime = 'srvpro_schema_runtime_' + suffix;
  const args = {database, 'runtime-role': runtime};
  const admin = new Client({database: 'postgres'});
  const evidence = {platform: process.platform, pgHost: process.env.PGHOST, pgPort: process.env.PGPORT,
    database, restoredDatabase: restored, runtimeRole: runtime, startedAt: new Date().toISOString(), checks: []};
  const record = label => { evidence.checks.push(label); console.log('PASS ' + label); };
  const runSchema = (command, db, expectedStatus = 0, additional = []) => {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'schema.js'), command,
      '--database', db, '--runtime-role', runtime, ...additional], {cwd: root, env: process.env, encoding: 'utf8', timeout: 120000});
    assert.strictEqual(result.status, expectedStatus, (result.error ? result.error.message + '\n' : '') + result.stderr + result.stdout);
    return result;
  };
  let source;
  try {
    await admin.connect();
    evidence.postgresVersion = (await admin.query("SELECT current_setting('server_version') AS version")).rows[0].version;
    await admin.query('CREATE ROLE ' + quote(runtime) + ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await admin.query('CREATE DATABASE ' + quote(database));
    await admin.query('CREATE DATABASE ' + quote(restored));
    runSchema('init', database, 0, ['--confirm-empty', database]);
    record('Fresh empty database: all 20 tables, explicit DDL and runtime grants verified');
    runSchema('init', database, 1, ['--confirm-empty', database]);
    record('Repeated bootstrap refused without changing the existing schema');

    source = new Client({database}); await source.connect();
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const baseline = await verify(source, checkedContract(), args);
    assert(baseline.ok, JSON.stringify(baseline.errors));
    await source.query('COMMIT');
    const {Connection} = require('typeorm');
    const connection = new Connection({type: 'postgres', host: process.env.PGHOST, port: Number(process.env.PGPORT),
      username: runtime, database, synchronize: false,
      entities: [path.join(root, 'data-manager/entities/*.js').replace(/\\/g, '/'),
        ...Object.values(require('../../ladder-core/entities')), ...Object.values(require('../../ladder-usage-analytics/entities'))]});
    await connection.connect();
    try {
      const now = new Date('2026-10-11T00:00:00Z');
      const save = (name, value) => connection.getRepository(name).save(value);
      await save('CloudReplay', {id: 42, data: 'synthetic', date: now});
      await save('CloudReplayPlayer', {name: 'alpha', pos: 0, key: 'synthetic', cloudReplay: {id: 42}});
      const log = await save('DuelLog', {time: now, name: 'fixture', roomId: 1, cloudReplayId: 42,
        replayFileName: 'synthetic-only.yrp', roomMode: 1, duelCount: 1});
      await save('DuelLogPlayer', {name: 'alpha', pos: 0, realName: 'alpha', isFirst: 1, score: 1,
        winner: 1, duelLog: {id: log.id}});
      const match = await save('LadderMatch', {matchKey: 'fixture:' + suffix, winnerName: 'alpha', loserName: 'beta',
        playerAName: 'alpha', playerBName: 'beta', duelLogId: log.id, createTime: now});
      await save('LadderUser', {name: 'alpha', displayName: 'Alpha', wins: 11, losses: 4, duelPoints: 1250,
        currentWinStreak: 7, lastMatchId: match.id, monthKey: '202610'});
      await save('LadderMonthRecord', {name: 'alpha', monthKey: '202610', wins: 3, losses: 1, duelPoints: 1088});
      await save('LadderMatchGame', {matchId: match.id, duelLogId: log.id, playerName: 'alpha', opponentName: 'beta',
        winnerName: 'alpha', duelCount: 1, isFirst: 1, isMain: 1, createTime: now});
      const sample = await save('LadderUsageSample', {matchId: match.id, playerName: 'alpha', dayKey: '20261011', monthKey: '202610', projectedAt: now});
      await save('LadderDeckCardFact', {sampleId: sample.id, cardId: 123, zone: 'main', copies: 2});
      await save('LadderUsageDailySample', {dayKey: '20261011'});
      await save('LadderUsageDailyDeck', {dayKey: '20261011', deckTypeId: 4095});
      await save('LadderUsageDailyCard', {dayKey: '20261011', zone: 'main', cardId: 123});
      await save('LadderUsageTotalSample', {id: 1});
      await save('LadderUsageTotalDeck', {deckTypeId: 4095});
      await save('LadderUsageTotalCard', {zone: 'main', cardId: 123});
      await save('Ban', {ip: '127.0.0.10', name: 'fixture'});
      await save('RandomDuelBan', {ip: '127.0.0.10', time: now, count: 1, reasons: ['synthetic'], needTip: 0});
      await save('RandomDuelScore', {name: 'fixture'});
      await save('User', {key: 'synthetic'});
      record('Unprivileged runtime role writes all 20 entity tables through real TypeORM with synchronize=false');
      await assert.rejects(() => connection.query('CREATE TABLE public.forbidden_test (id int)'), /permission denied/);
      await assert.rejects(() => save('LadderMatchGame', {matchId: match.id, playerName: 'alpha', opponentName: 'beta',
        duelCount: 2, isMain: 1, isFirst: 1, createTime: now}), /ck_ladder_game_main_count/);
      await assert.rejects(() => save('LadderMatch', {matchKey: 'fixture:' + suffix, createTime: now}), /uq_ladder_match_match_key/);
      record('Runtime cannot CREATE schema objects; CHECK and unique identity constraints reject invalid writes');
      const second = await save('LadderUsageSample', {matchId: match.id, playerName: 'beta', dayKey: '20261011', monthKey: '202610', projectedAt: now});
      const fact = await save('LadderDeckCardFact', {sampleId: second.id, cardId: 321, zone: 'side', copies: 1});
      await connection.getRepository('LadderUsageSample').delete(second.id);
      assert.strictEqual(await connection.getRepository('LadderDeckCardFact').count({where: {id: fact.id}}), 0);
      record('Usage sample cascade deletion matches the explicit migration contract');
    } finally { await connection.close(); }

    const player = (await source.query('SELECT wins, losses, "duelPoints", "currentWinStreak", "lastMatchId" FROM ladder_user WHERE name = $1', ['alpha'])).rows[0];
    runSchema('verify', database);
    assert.deepStrictEqual((await source.query('SELECT wins, losses, "duelPoints", "currentWinStreak", "lastMatchId" FROM ladder_user WHERE name = $1', ['alpha'])).rows[0], player);
    record('Read-only verification preserves points, history counters, current streak and lastMatchId');
    await source.query('ALTER TABLE ladder_match_game ALTER COLUMN "winnerName" SET NOT NULL, ALTER COLUMN "duelCount" DROP DEFAULT, ALTER COLUMN "isFirst" DROP DEFAULT, ALTER COLUMN "isMain" DROP DEFAULT');
    const historic = JSON.parse(runSchema('verify', database).stdout);
    assert.strictEqual(historic.warnings.length, 4);
    record('Historical game NOT NULL and omitted defaults remain compatible and are reported');
    await source.query('DROP INDEX ix_ladder_game_player');
    runSchema('verify', database, 1);
    await source.query('CREATE INDEX ix_ladder_game_player ON ladder_match_game ("playerName")');
    await source.query('REVOKE SELECT ON ladder_user FROM ' + quote(runtime));
    runSchema('verify', database, 1);
    runSchema('grant', database);
    await source.query("SELECT setval(pg_get_serial_sequence('ladder_match_game', 'id'), 1, false)");
    runSchema('verify', database, 1);
    await source.query("SELECT setval(pg_get_serial_sequence('ladder_match_game', 'id'), (SELECT MAX(id) FROM ladder_match_game), true)");
    record('Verification detects missing indexes, missing runtime grants and colliding restored sequences');

    const pgTool = name => path.join(options['pg-bin'], name + (process.platform === 'win32' ? '.exe' : ''));
    const dump = path.join(options['report-dir'], 'synthetic.dump');
    let result = spawnSync(pgTool('pg_dump'), ['--format=custom', '--no-owner', '--no-privileges', '--file', dump, '--dbname', database], {env: process.env, encoding: 'utf8', timeout: 120000});
    assert.strictEqual(result.status, 0, (result.error ? result.error.message + '\n' : '') + result.stderr);
    result = spawnSync(pgTool('pg_restore'), ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', restored, dump], {env: process.env, encoding: 'utf8', timeout: 120000});
    assert.strictEqual(result.status, 0, (result.error ? result.error.message + '\n' : '') + result.stderr);
    runSchema('grant', restored);
    const restoredReport = JSON.parse(runSchema('verify', restored).stdout);
    const restoredClient = new Client({database: restored}); await restoredClient.connect();
    try {
      assert.deepStrictEqual((await restoredClient.query('SELECT wins, losses, "duelPoints", "currentWinStreak", "lastMatchId" FROM ladder_user WHERE name = $1', ['alpha'])).rows[0], player);
      const sourceReport = JSON.parse(runSchema('verify', database).stdout);
      assert.deepStrictEqual(restoredReport.tables, sourceReport.tables);
    } finally { await restoredClient.end(); }
    record('Real pg_dump/pg_restore into a new database preserves all 20 table counts, points and active streaks; grants and sequences validate');
    evidence.completedAt = new Date().toISOString(); evidence.ok = true;
    fs.writeFileSync(path.join(options['report-dir'], 'postgres-drill.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log('Evidence: ' + path.join(options['report-dir'], 'postgres-drill.json'));
  } finally {
    if (source) await source.end();
    await admin.end();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
