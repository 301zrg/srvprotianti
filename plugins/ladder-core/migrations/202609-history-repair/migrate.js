'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {Client} = require('pg');
const deepmerge = require('deepmerge');
const {decodeDeck} = require('../../../../data-manager/DeckEncoder');
const deckClassifierPlugin = require('../../../deck_analysis');

const MIGRATION_ID = '202609-ladder-history-repair';
const CONFIRMATION = 'APPLY-LADDER-HISTORY-202609';
const rootDir = path.resolve(__dirname, '../../../..');
const sql = filename => fs.readFileSync(path.join(__dirname, filename), 'utf8');
const normalizeName = value => String(value || '').trim().toLowerCase();

function usage() {
  return [
    'Usage:',
    '  node migrate.js audit [--use-host-config] [--report <path>]',
    '  node migrate.js simulate [--use-host-config] [--report <path>]',
    `  node migrate.js apply --confirm ${CONFIRMATION} [--use-host-config] [--report <path>]`,
    '  node migrate.js verify [--use-host-config] [--report <path>]',
    '',
    'Environment connection variables:',
    '  SRVPRO_LADDER_DATABASE_URL, or',
    '  SRVPRO_LADDER_PG_HOST / _PORT / _DATABASE / _USERNAME / _PASSWORD',
    '  Optional: SRVPRO_LADDER_PG_SSL=true'
  ].join('\n');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') return {mode: 'audit', useHostConfig: false, confirm: null, report: null, help: true};
  const mode = args.shift() || 'audit';
  if (!['audit', 'simulate', 'apply', 'verify'].includes(mode)) throw new Error(`Unknown mode: ${mode}\n${usage()}`);
  const options = {mode, useHostConfig: false, confirm: null, report: null};
  while (args.length) {
    const value = args.shift();
    if (value === '--use-host-config') options.useHostConfig = true;
    else if (value === '--confirm') options.confirm = args.shift();
    else if (value === '--report') options.report = args.shift();
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${value}\n${usage()}`);
  }
  if (options.mode === 'apply' && options.confirm !== CONFIRMATION) {
    throw new Error(`Formal application requires: --confirm ${CONFIRMATION}`);
  }
  return options;
}

function connectionConfig(options) {
  if (options.useHostConfig) {
    // This is an explicit compatibility option for a local restored database.
    // The file is never modified and credentials are never printed or reported.
    const hostConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'config/config.json'), 'utf8'));
    const config = hostConfig?.modules?.mysql?.db;
    if (!config) throw new Error('Host database configuration was not found.');
    if (config.type && config.type !== 'postgres') throw new Error('This migration supports PostgreSQL only.');
    return {
      host: config.host,
      port: Number(config.port || 5432),
      database: config.database,
      user: config.username || config.user,
      password: config.password,
      ssl: config.ssl
    };
  }
  if (process.env.SRVPRO_LADDER_DATABASE_URL) {
    return {
      connectionString: process.env.SRVPRO_LADDER_DATABASE_URL,
      ssl: parseSsl(process.env.SRVPRO_LADDER_PG_SSL)
    };
  }
  const config = {
    host: process.env.SRVPRO_LADDER_PG_HOST,
    port: Number(process.env.SRVPRO_LADDER_PG_PORT || 5432),
    database: process.env.SRVPRO_LADDER_PG_DATABASE,
    user: process.env.SRVPRO_LADDER_PG_USERNAME,
    password: process.env.SRVPRO_LADDER_PG_PASSWORD,
    ssl: parseSsl(process.env.SRVPRO_LADDER_PG_SSL)
  };
  if (!config.host || !config.database || !config.user) {
    throw new Error(`PostgreSQL environment variables are incomplete.\n${usage()}`);
  }
  return config;
}

function parseSsl(value) {
  if (!value || /^(false|0|off)$/i.test(value)) return undefined;
  // Set this only for a server whose certificate is already trusted by Node.
  return true;
}

function digest(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function preservationSnapshot(client) {
  const users = await client.query(`
    SELECT name, wins, losses, "monthWins", "monthLosses", "duelPoints", "monthDuelPoints", "monthKey"
    FROM ladder_user ORDER BY name
  `);
  const months = await client.query(`
    SELECT id::text, name, "monthKey", "duelPoints", wins, losses, "scoreDiff"
    FROM ladder_month_record ORDER BY id
  `);
  const matches = await client.query(`
    SELECT id::text, "monthKey", "winnerName", "loserName",
      "playerAName", "playerBName", "playerADuelPointsDelta", "playerBDuelPointsDelta",
      "playerADuelPointsBefore", "playerBDuelPointsBefore",
      "playerADuelPointsAfter", "playerBDuelPointsAfter", "createTime"
    FROM ladder_match ORDER BY id
  `);
  return {
    users: {rows: users.rowCount, sha256: digest(users.rows)},
    months: {rows: months.rowCount, sha256: digest(months.rows)},
    matches: {rows: matches.rowCount, sha256: digest(matches.rows)}
  };
}

async function tableState(client) {
  const result = await client.query(`
    SELECT
      to_regclass('public.ladder_match_game') IS NOT NULL AS live_table,
      to_regclass('public.ladder_match_game_legacy_202609') IS NOT NULL AS archive_table,
      to_regclass('public.ladder_match_game_rebuild_202609') IS NOT NULL AS rebuild_table
  `);
  return result.rows[0];
}

async function databasePermissions(client) {
  const result = await client.query(`
    SELECT
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
      BOOL_AND(pg_has_role(current_user, tableowner, 'MEMBER')) AS can_act_as_table_owners
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('ladder_user', 'ladder_month_record', 'ladder_match',
        'ladder_match_game', 'duel_log', 'duel_log_player')
  `);
  return result.rows[0];
}

async function audit(client) {
  const state = await tableState(client);
  const permissions = await databasePermissions(client);
  const auditResult = await client.query(sql('00-audit.sql'));
  const matchKeyColumn = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ladder_match' AND column_name = 'matchKey'
    ) AS present
  `);
  let duplicateMatchKeys = 0;
  if (matchKeyColumn.rows[0].present) {
    const duplicates = await client.query(`
      SELECT COUNT(*)::int AS count FROM (
        SELECT "matchKey" FROM ladder_match
        WHERE "matchKey" IS NOT NULL AND "matchKey" <> ''
        GROUP BY "matchKey" HAVING COUNT(*) > 1
      ) duplicate_keys
    `);
    duplicateMatchKeys = duplicates.rows[0].count;
  }
  const displayResult = await client.query(`
    SELECT LOWER(u.name) AS name,
      COALESCE(ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.name ORDER BY p.name), NULL), ARRAY[]::varchar[]) AS observed_spellings
    FROM ladder_user u
    LEFT JOIN duel_log_player p ON LOWER(p.name) = LOWER(u.name)
    GROUP BY LOWER(u.name)
    HAVING COUNT(DISTINCT p.name) <> 1
    ORDER BY LOWER(u.name)
  `);
  const overrides = loadDisplayOverrides();
  return {
    migrationId: MIGRATION_ID,
    mode: 'audit',
    schema: state,
    permissions,
    counts: {...auditResult.rows[0], duplicate_match_keys: duplicateMatchKeys},
    displayNamesRequiringDecision: displayResult.rows.map(row => ({
      name: row.name,
      observedSpellings: row.observed_spellings,
      configuredOverride: overrides.get(row.name) || null
    })),
    unresolvedDisplayNames: displayResult.rows
      .filter(row => !overrides.has(row.name))
      .map(row => ({name: row.name, observedSpellings: row.observed_spellings}))
  };
}

function loadDisplayOverrides() {
  const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, 'display-name-overrides.json'), 'utf8'));
  const overrides = new Map();
  for (const [rawKey, rawDisplay] of Object.entries(parsed)) {
    const key = normalizeName(rawKey);
    const display = String(rawDisplay || '').trim();
    if (!key || !display || display.length > 64) throw new Error(`Invalid display-name override for ${rawKey}.`);
    if (overrides.has(key)) throw new Error(`Duplicate normalized display-name override: ${key}.`);
    overrides.set(key, display);
  }
  return overrides;
}

async function resolveDisplayNames(client) {
  const overrides = loadDisplayOverrides();
  const result = await client.query(`
    SELECT LOWER(u.name) AS name,
      COALESCE(ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.name ORDER BY p.name), NULL), ARRAY[]::varchar[]) AS observed_spellings
    FROM ladder_user u
    LEFT JOIN duel_log_player p ON LOWER(p.name) = LOWER(u.name)
    GROUP BY LOWER(u.name)
    ORDER BY LOWER(u.name)
  `);
  const unresolved = [];
  const resolutions = [];
  for (const row of result.rows) {
    const observed = row.observed_spellings || [];
    const displayName = overrides.get(row.name) || (observed.length === 1 ? observed[0] : null);
    if (!displayName) unresolved.push({name: row.name, observedSpellings: observed});
    else resolutions.push({name: row.name, displayName});
  }
  if (unresolved.length) {
    throw new Error(`Display names still require a decision:\n${JSON.stringify(unresolved, null, 2)}`);
  }
  for (const item of resolutions) {
    await client.query('UPDATE ladder_user SET "displayName" = $1 WHERE LOWER(name) = $2', [item.displayName, item.name]);
  }
  await client.query(`
    UPDATE ladder_match m SET
      "playerADisplayName" = COALESCE((SELECT u."displayName" FROM ladder_user u WHERE LOWER(u.name) = LOWER(m."playerAName")), m."playerAName"),
      "playerBDisplayName" = COALESCE((SELECT u."displayName" FROM ladder_user u WHERE LOWER(u.name) = LOWER(m."playerBName")), m."playerBName")
  `);
  return new Map(resolutions.map(item => [item.name, item.displayName]));
}

function createDeckClassifier() {
  const pluginDir = path.resolve(__dirname, '../../../deck_analysis');
  const readJson = filename => {
    const target = path.join(pluginDir, filename);
    return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {};
  };
  const config = deepmerge(readJson('config.default.json'), readJson('config.json'), {
    arrayMerge: (_destination, source) => source
  });
  let classifier = null;
  deckClassifierPlugin.register({
    rootDir: pluginDir,
    config,
    provide(name, value) {
      if (name === 'deckClassifier') classifier = value;
    }
  });
  if (!classifier) throw new Error('Deck classifier service could not be initialized.');
  return classifier;
}

async function loadRebuildRows(client, displayNames) {
  const result = await client.query(`
    SELECT
      sl.match_id::text,
      l.id::text AS duel_log_id,
      l."duelCount" AS duel_count,
      l.time AS create_time,
      m."playerAName" AS player_a_name,
      m."playerBName" AS player_b_name,
      p.name,
      p.pos,
      p."isFirst" AS is_first,
      p.winner,
      COALESCE(p."startDeckBuffer", p."currentDeckBuffer") AS deck_buffer
    FROM ladder_repair_session_log sl
    JOIN duel_log l ON l.id = sl.log_id
    JOIN ladder_match m ON m.id = sl.match_id
    JOIN duel_log_player p ON p."duelLogId" = l.id AND p.pos IN (0, 1)
    ORDER BY sl.match_id, l."duelCount", p.pos
  `);
  const logs = new Map();
  for (const row of result.rows) {
    const group = logs.get(row.duel_log_id) || [];
    group.push(row);
    logs.set(row.duel_log_id, group);
  }

  const classifier = createDeckClassifier();
  const deckCache = new Map();
  const classify = encoded => {
    if (deckCache.has(encoded)) return deckCache.get(encoded);
    if (typeof encoded !== 'string' || !encoded) throw new Error('A selected DuelLog has no usable deck buffer.');
    const deck = decodeDeck(Buffer.from(encoded, 'base64'));
    // Historical UPDATE_DECK buffers normally merge main and extra into main.
    // Concatenating both remains correct if a future decoder separates them.
    const mainAndExtra = [...(deck.main || []), ...(deck.extra || [])];
    const deckTypeId = classifier.classify(mainAndExtra);
    deckCache.set(encoded, deckTypeId);
    return deckTypeId;
  };

  // Establish one immutable type per player and Match from G1. Later DuelLog
  // buffers contain side changes and must never redefine the archetype.
  const g1DeckTypes = new Map();
  for (const players of logs.values()) {
    if (Number(players[0].duel_count) !== 1) continue;
    for (const player of players) {
      g1DeckTypes.set(`${player.match_id}:${normalizeName(player.name)}`, classify(player.deck_buffer));
    }
  }

  const rebuilt = [];
  for (const [duelLogId, players] of logs) {
    if (players.length !== 2) throw new Error(`DuelLog ${duelLogId} does not have exactly two selected players.`);
    const [left, right] = players;
    const pair = [normalizeName(left.name), normalizeName(right.name)].sort();
    const matchPair = [normalizeName(left.player_a_name), normalizeName(left.player_b_name)].sort();
    if (pair[0] !== matchPair[0] || pair[1] !== matchPair[1]) throw new Error(`DuelLog ${duelLogId} player pair changed during rebuild.`);
    if (Number(left.duel_count) !== Number(right.duel_count) || ![1, 2, 3].includes(Number(left.duel_count))) {
      throw new Error(`DuelLog ${duelLogId} has an invalid duelCount.`);
    }
    if (Number(left.is_first) + Number(right.is_first) !== 1) throw new Error(`DuelLog ${duelLogId} has an invalid first-player marker.`);
    if (Number(left.winner) + Number(right.winner) !== 1) throw new Error(`DuelLog ${duelLogId} has an invalid winner marker.`);
    const winner = players.find(player => Number(player.winner) === 1);
    const deckTypes = players.map(player => g1DeckTypes.get(`${player.match_id}:${normalizeName(player.name)}`));
    if (deckTypes.some(value => value == null)) throw new Error(`DuelLog ${duelLogId} has no usable G1 deck type.`);
    for (let index = 0; index < 2; index++) {
      const player = players[index];
      const opponent = players[1 - index];
      const playerName = normalizeName(player.name);
      const opponentName = normalizeName(opponent.name);
      const playerDisplayName = displayNames.get(playerName);
      const opponentDisplayName = displayNames.get(opponentName);
      if (!playerDisplayName || !opponentDisplayName) throw new Error(`DuelLog ${duelLogId} references an unknown ladder user.`);
      rebuilt.push([
        player.match_id,
        duelLogId,
        playerName,
        playerDisplayName,
        opponentName,
        opponentDisplayName,
        deckTypes[index],
        deckTypes[1 - index],
        normalizeName(winner.name),
        Number(player.duel_count),
        Number(player.is_first),
        Number(player.duel_count) === 1 ? 1 : 0,
        player.create_time
      ]);
    }
  }
  return {rows: rebuilt, physicalDuels: logs.size, deckBuffers: deckCache.size, templateCount: classifier.templateCount};
}

async function insertRebuildRows(client, rows) {
  const columns = [
    '"matchId"', '"duelLogId"', '"playerName"', '"playerDisplayName"',
    '"opponentName"', '"opponentDisplayName"', '"deckTypeId"', '"opponentDeckTypeId"',
    '"winnerName"', '"duelCount"', '"isFirst"', '"isMain"', '"createTime"'
  ];
  const batchSize = 300;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = [];
    const tuples = batch.map(row => {
      const placeholders = row.map(value => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(`INSERT INTO ladder_match_game_rebuild_202609 (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, values);
  }
}

async function runVerification(client) {
  const state = await tableState(client);
  if (!state.live_table) throw new Error('ladder_match_game is missing.');
  if (!state.archive_table) throw new Error('The legacy archive table is missing; this database has not completed this migration.');
  const result = await client.query(sql('04-verify.sql'));
  const verification = result.rows[0];
  for (const key of ['missing_display_names', 'missing_match_keys', 'invalid_duels', 'orphan_games', 'orphan_logs', 'deck_type_mismatches']) {
    if (Number(verification[key]) !== 0) throw new Error(`Verification failed: ${key}=${verification[key]}`);
  }
  if (Number(verification.required_unique_indexes) !== 3) throw new Error('Verification failed: required unique indexes are missing.');
  if (Number(verification.required_game_columns) !== 4) throw new Error('Verification failed: required game columns are missing.');
  if (Number(verification.retired_game_columns) !== 0) throw new Error('Verification failed: retired game columns still exist.');
  if (verification.match_key_nullable !== 'NO') throw new Error('Verification failed: ladder_match.matchKey is still nullable.');
  if (Number(verification.rebuilt_rows) !== Number(verification.physical_duels) * 2) {
    throw new Error('Verification failed: rebuilt rows are not two player perspectives per physical duel.');
  }
  return {schema: state, counts: verification};
}

async function migrate(client, mode) {
  const initialState = await tableState(client);
  if (!initialState.live_table) throw new Error('ladder_match_game does not exist.');
  if (initialState.archive_table || initialState.rebuild_table) {
    throw new Error('Migration archive/staging table already exists. Use verify, restore the backup, or resolve the prior run explicitly.');
  }
  const permissions = await databasePermissions(client);
  if (!permissions.can_create_in_public || (!permissions.is_superuser && !permissions.can_act_as_table_owners)) {
    throw new Error('This connection cannot perform the migration DDL. Use a PostgreSQL administrator or a role that can act as every source table owner and CREATE in schema public.');
  }
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '0'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('202609-ladder-history-repair'))");
    await client.query(`
      LOCK TABLE ladder_user, ladder_month_record, ladder_match, ladder_match_game,
        duel_log, duel_log_player IN ACCESS EXCLUSIVE MODE
    `);
    const lockedState = await tableState(client);
    if (lockedState.archive_table || lockedState.rebuild_table) {
      throw new Error('Migration archive/staging table appeared while acquiring locks.');
    }
    // Audit and preserve the exact snapshot protected by the table locks.
    const lockedBefore = await preservationSnapshot(client);
    const preAudit = await audit(client);
    if (Number(preAudit.counts.duplicate_normalized_users) !== 0) throw new Error('Case-insensitive duplicate ladder users must be resolved before migration.');
    if (Number(preAudit.counts.duplicate_month_rows) !== 0) throw new Error('Duplicate monthly rows must be resolved before migration.');
    if (Number(preAudit.counts.duplicate_match_keys) !== 0) throw new Error('Duplicate non-empty match keys must be resolved before migration.');
    if (preAudit.unresolvedDisplayNames.length) throw new Error('Display-name overrides are incomplete; run audit and request a human decision.');
    await client.query(sql('01-expand-schema.sql'));
    await client.query(sql('02-stage-sessions.sql'));
    const displayNames = await resolveDisplayNames(client);
    const rebuilt = await loadRebuildRows(client, displayNames);
    await insertRebuildRows(client, rebuilt.rows);

    const expected = await client.query('SELECT COALESCE(SUM(logs), 0)::int * 2 AS rows FROM ladder_repair_match_session');
    if (rebuilt.rows.length !== Number(expected.rows[0].rows)) {
      throw new Error(`Rebuild row mismatch: prepared ${rebuilt.rows.length}, expected ${expected.rows[0].rows}.`);
    }
    await client.query(`
      UPDATE ladder_match m SET
        "playerADeckTypeId" = a."deckTypeId",
        "playerBDeckTypeId" = b."deckTypeId"
      FROM ladder_match_game_rebuild_202609 a, ladder_match_game_rebuild_202609 b
      WHERE a."matchId" = m.id AND b."matchId" = m.id
        AND a."duelCount" = 1 AND b."duelCount" = 1
        AND LOWER(a."playerName") = LOWER(m."playerAName")
        AND LOWER(b."playerName") = LOWER(m."playerBName")
    `);
    await client.query(sql('03-finalize-schema.sql'));

    const after = await preservationSnapshot(client);
    if (JSON.stringify(lockedBefore) !== JSON.stringify(after)) {
      throw new Error(`Protected ladder counters or match rating history changed.\nBefore: ${JSON.stringify(lockedBefore)}\nAfter: ${JSON.stringify(after)}`);
    }
    const verification = await runVerification(client);
    const result = {
      migrationId: MIGRATION_ID,
      mode,
      committed: mode === 'apply',
      preAudit: preAudit.counts,
      protectedState: after,
      rebuild: {
        physicalDuels: rebuilt.physicalDuels,
        playerPerspectiveRows: rebuilt.rows.length,
        distinctDeckBuffers: rebuilt.deckBuffers,
        classifierTemplates: rebuilt.templateCount
      },
      verification: verification.counts
    };
    if (mode === 'simulate') await client.query('ROLLBACK');
    else await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

function printReport(report, target) {
  const output = JSON.stringify(report, null, 2);
  process.stdout.write(`${output}\n`);
  if (target) {
    const resolved = path.resolve(target);
    fs.writeFileSync(resolved, `${output}\n`, 'utf8');
    process.stdout.write(`Report written: ${resolved}\n`);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const client = new Client({
    ...connectionConfig(options),
    application_name: `srvpro-${MIGRATION_ID}-${options.mode}`
  });
  await client.connect();
  try {
    let report;
    if (options.mode === 'audit') report = await audit(client);
    else if (options.mode === 'verify') report = {migrationId: MIGRATION_ID, mode: 'verify', ...(await runVerification(client))};
    else report = await migrate(client, options.mode);
    printReport(report, options.report);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Migration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  parseArgs,
  parseSsl,
  connectionConfig,
  digest,
  loadDisplayOverrides,
  createDeckClassifier
};
