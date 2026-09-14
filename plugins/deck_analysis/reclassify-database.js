'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {Client} = require('pg');
const {decodeDeck} = require('../../data-manager/DeckEncoder');
const deckClassifierPlugin = require('./index');

const CONFIRMATION = 'APPLY-DECK-RECLASSIFICATION';
const rootDir = path.resolve(__dirname, '../..');
const normalizeName = value => String(value || '').trim().toLowerCase();

function usage() {
  return [
    'Usage:',
    '  node plugins/deck_analysis/reclassify-database.js audit [--use-host-config] [--report <path>]',
    '  node plugins/deck_analysis/reclassify-database.js simulate [--use-host-config] [--report <path>]',
    `  node plugins/deck_analysis/reclassify-database.js apply --confirm ${CONFIRMATION} [--use-host-config] [--report <path>]`,
    '',
    'Environment connection variables:',
    '  SRVPRO_LADDER_DATABASE_URL, or',
    '  SRVPRO_LADDER_PG_HOST / _PORT / _DATABASE / _USERNAME / _PASSWORD',
    '  Optional: SRVPRO_LADDER_PG_SSL=true'
  ].join('\n');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const mode = args.shift() || 'audit';
  if (mode === '--help' || mode === '-h') return {mode: 'audit', help: true};
  if (!['audit', 'simulate', 'apply'].includes(mode)) throw new Error(`Unknown mode: ${mode}\n${usage()}`);
  const options = {mode, useHostConfig: false, report: null, confirm: null, help: false};
  while (args.length) {
    const value = args.shift();
    if (value === '--use-host-config') options.useHostConfig = true;
    else if (value === '--report') options.report = args.shift();
    else if (value === '--confirm') options.confirm = args.shift();
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${value}\n${usage()}`);
  }
  if (options.report === undefined || options.confirm === undefined) throw new Error(`An option is missing its value.\n${usage()}`);
  if (mode === 'apply' && options.confirm !== CONFIRMATION) {
    throw new Error(`Formal application requires: --confirm ${CONFIRMATION}`);
  }
  return options;
}

function parseSsl(value) {
  if (!value || /^(false|0|off)$/i.test(value)) return undefined;
  return true;
}

function connectionConfig(options) {
  if (options.useHostConfig) {
    const hostConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'config/config.json'), 'utf8'));
    const config = hostConfig?.modules?.mysql?.db;
    if (!config) throw new Error('Host database configuration was not found.');
    if (config.type && config.type !== 'postgres') throw new Error('This tool supports PostgreSQL only.');
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
    return {connectionString: process.env.SRVPRO_LADDER_DATABASE_URL, ssl: parseSsl(process.env.SRVPRO_LADDER_PG_SSL)};
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

function loadClassifier() {
  const readJson = filename => {
    const target = path.join(__dirname, filename);
    return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {};
  };
  const config = {...readJson('config.default.json'), ...readJson('config.json')};
  let classifier = null;
  deckClassifierPlugin.register({
    rootDir: __dirname,
    config,
    provide(name, value) {
      if (name === 'deckClassifier') classifier = value;
    }
  });
  if (!classifier) throw new Error('Deck classifier service could not be initialized.');
  const templateDirectory = path.resolve(__dirname, config.templateDirectory || 'deck_templates');
  const hash = crypto.createHash('sha256');
  for (const filename of fs.readdirSync(templateDirectory).filter(name => /^\d+\.ydk$/i.test(name)).sort()) {
    hash.update(filename).update('\0').update(fs.readFileSync(path.join(templateDirectory, filename))).update('\0');
  }
  return {classifier, templateDirectory, templateSha256: hash.digest('hex')};
}

function normalizeId(value) {
  return value == null || value === '' ? null : String(value);
}

function chooseG1Reference(match) {
  const references = new Set((match.g1GameDuelLogIds || []).map(normalizeId).filter(Boolean));
  const matchReference = normalizeId(match.matchDuelLogId);
  if (matchReference) references.add(matchReference);
  if (!references.size) return {reason: 'missing_g1_reference'};
  if (references.size !== 1) return {reason: 'conflicting_g1_references'};
  return {duelLogId: [...references][0]};
}

function addCount(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function buildPlan(matchRows, gameRows, duelPlayerRows, classifyEncoded) {
  const gamesByMatch = new Map();
  for (const game of gameRows) {
    const list = gamesByMatch.get(String(game.matchId)) || [];
    list.push(game);
    gamesByMatch.set(String(game.matchId), list);
  }
  const playersByLog = new Map();
  for (const player of duelPlayerRows) {
    const list = playersByLog.get(String(player.duelLogId)) || [];
    list.push(player);
    playersByLog.set(String(player.duelLogId), list);
  }

  const updates = [];
  const skipped = [];
  const transitions = new Map();
  let changedMatches = 0;
  let changedGameRows = 0;
  for (const match of matchRows) {
    const id = String(match.id);
    const playerA = normalizeName(match.playerAName);
    const playerB = normalizeName(match.playerBName);
    if (!playerA || !playerB || playerA === playerB) {
      skipped.push({matchId: id, reason: 'invalid_match_players'});
      continue;
    }
    const games = gamesByMatch.get(id) || [];
    const gamesValid = games.every(game => {
      const player = normalizeName(game.playerName);
      const opponent = normalizeName(game.opponentName);
      return (player === playerA && opponent === playerB) || (player === playerB && opponent === playerA);
    });
    if (!gamesValid) {
      skipped.push({matchId: id, reason: 'invalid_game_players'});
      continue;
    }
    const reference = chooseG1Reference(match);
    if (!reference.duelLogId) {
      skipped.push({matchId: id, reason: reference.reason});
      continue;
    }
    const players = (playersByLog.get(reference.duelLogId) || []).filter(player => Number(player.pos) === 0 || Number(player.pos) === 1);
    const names = [...new Set(players.map(player => normalizeName(player.name)))];
    if (players.length !== 2 || names.length !== 2 || !names.includes(playerA) || !names.includes(playerB) ||
        players.some(player => Number(player.duelCount) !== 1)) {
      skipped.push({matchId: id, reason: 'invalid_g1_players'});
      continue;
    }
    const classified = new Map();
    try {
      for (const player of players) {
        const buffer = player.startDeckBuffer || player.currentDeckBuffer;
        if (typeof buffer !== 'string' || !buffer) throw new Error('missing buffer');
        classified.set(normalizeName(player.name), Number(classifyEncoded(buffer)));
      }
    } catch (_error) {
      skipped.push({matchId: id, reason: 'invalid_g1_deck_buffer'});
      continue;
    }
    const aType = classified.get(playerA);
    const bType = classified.get(playerB);
    if (!Number.isInteger(aType) || !Number.isInteger(bType)) {
      skipped.push({matchId: id, reason: 'invalid_classifier_result'});
      continue;
    }
    const oldAType = Number(match.playerADeckTypeId);
    const oldBType = Number(match.playerBDeckTypeId);
    if (oldAType !== aType || oldBType !== bType) changedMatches++;
    if (oldAType !== aType) addCount(transitions, `${oldAType}->${aType}`);
    if (oldBType !== bType) addCount(transitions, `${oldBType}->${bType}`);
    for (const game of games) {
      const expectedDeck = normalizeName(game.playerName) === playerA ? aType : bType;
      const expectedOpponent = normalizeName(game.opponentName) === playerA ? aType : bType;
      if (Number(game.deckTypeId) !== expectedDeck || Number(game.opponentDeckTypeId) !== expectedOpponent) changedGameRows++;
    }
    updates.push({matchId: id, aType, bType});
  }
  return {
    updates,
    skipped,
    changedMatches,
    changedGameRows,
    transitions: [...transitions].map(([key, playerSides]) => {
      const [from, to] = key.split('->').map(Number);
      return {from, to, playerSides};
    }).sort((left, right) => right.playerSides - left.playerSides || left.from - right.from || left.to - right.to)
  };
}

async function validateSchema(client) {
  const result = await client.query(`
    SELECT
      to_regclass('public.ladder_match') IS NOT NULL AS matches,
      to_regclass('public.ladder_match_game') IS NOT NULL AS games,
      to_regclass('public.duel_log') IS NOT NULL AS logs,
      to_regclass('public.duel_log_player') IS NOT NULL AS players
  `);
  if (!Object.values(result.rows[0]).every(Boolean)) {
    throw new Error('Required ladder or DuelLog tables are missing. Complete the ladder history migration first.');
  }
  const columns = await client.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND (
      (table_name = 'ladder_match' AND column_name IN ('duelLogId', 'playerADeckTypeId', 'playerBDeckTypeId')) OR
      (table_name = 'ladder_match_game' AND column_name IN ('duelLogId', 'deckTypeId', 'opponentDeckTypeId', 'duelCount', 'isMain'))
    )
  `);
  if (columns.rowCount !== 8) throw new Error('Required deck-type/G1 columns are missing. Complete the ladder history migration first.');
}

async function loadSourceRows(client) {
  const matches = await client.query(`
    SELECT m.id::text AS id,
      m."playerAName" AS "playerAName", m."playerBName" AS "playerBName",
      m."playerADeckTypeId" AS "playerADeckTypeId", m."playerBDeckTypeId" AS "playerBDeckTypeId",
      m."duelLogId"::text AS "matchDuelLogId",
      COALESCE((
        SELECT ARRAY_AGG(DISTINCT g."duelLogId"::text ORDER BY g."duelLogId"::text)
        FROM ladder_match_game g
        WHERE g."matchId" = m.id AND (g."duelCount" = 1 OR g."isMain" = 1) AND g."duelLogId" IS NOT NULL
      ), ARRAY[]::text[]) AS "g1GameDuelLogIds"
    FROM ladder_match m ORDER BY m.id
  `);
  const games = await client.query(`
    SELECT "matchId"::text AS "matchId", "playerName", "opponentName", "deckTypeId", "opponentDeckTypeId"
    FROM ladder_match_game ORDER BY "matchId", "duelCount", id
  `);
  const references = [...new Set(matches.rows.flatMap(match => {
    const selected = chooseG1Reference(match);
    return selected.duelLogId ? [selected.duelLogId] : [];
  }))];
  let players = {rows: []};
  if (references.length) {
    players = await client.query(`
      SELECT l.id::text AS "duelLogId", l."duelCount" AS "duelCount",
        p.name, p.pos, p."startDeckBuffer" AS "startDeckBuffer", p."currentDeckBuffer" AS "currentDeckBuffer"
      FROM duel_log l
      JOIN duel_log_player p ON p."duelLogId" = l.id AND p.pos IN (0, 1)
      WHERE l.id = ANY($1::bigint[])
      ORDER BY l.id, p.pos
    `, [references]);
  }
  return {matches: matches.rows, games: games.rows, players: players.rows};
}

async function createPlan(client, classifier) {
  const source = await loadSourceRows(client);
  const cache = new Map();
  const classifyEncoded = encoded => {
    if (cache.has(encoded)) return cache.get(encoded);
    const deck = decodeDeck(Buffer.from(encoded, 'base64'));
    const cards = [...(deck.main || []), ...(deck.extra || [])];
    const type = classifier.classify(cards);
    cache.set(encoded, type);
    return type;
  };
  return {
    sourceCounts: {matches: source.matches.length, gameRows: source.games.length, distinctDeckBuffers: cache.size},
    plan: buildPlan(source.matches, source.games, source.players, classifyEncoded),
    deckCache: cache
  };
}

async function stagePlan(client, updates) {
  await client.query(`CREATE TEMP TABLE deck_reclass_plan (
    match_id bigint PRIMARY KEY,
    a_type integer NOT NULL,
    b_type integer NOT NULL
  ) ON COMMIT DROP`);
  const batchSize = 500;
  for (let offset = 0; offset < updates.length; offset += batchSize) {
    const values = [];
    const tuples = updates.slice(offset, offset + batchSize).map(update => {
      values.push(update.matchId, update.aType, update.bType);
      const index = values.length;
      return `($${index - 2}::bigint, $${index - 1}::integer, $${index}::integer)`;
    });
    await client.query(`INSERT INTO deck_reclass_plan(match_id, a_type, b_type) VALUES ${tuples.join(', ')}`, values);
  }
}

async function applyPlan(client) {
  const matches = await client.query(`
    UPDATE ladder_match m SET
      "playerADeckTypeId" = p.a_type,
      "playerBDeckTypeId" = p.b_type
    FROM deck_reclass_plan p
    WHERE m.id = p.match_id AND (
      m."playerADeckTypeId" IS DISTINCT FROM p.a_type OR m."playerBDeckTypeId" IS DISTINCT FROM p.b_type
    )
  `);
  const games = await client.query(`
    UPDATE ladder_match_game g SET
      "deckTypeId" = CASE
        WHEN LOWER(g."playerName") = LOWER(m."playerAName") THEN p.a_type ELSE p.b_type END,
      "opponentDeckTypeId" = CASE
        WHEN LOWER(g."opponentName") = LOWER(m."playerAName") THEN p.a_type ELSE p.b_type END
    FROM ladder_match m
    JOIN deck_reclass_plan p ON p.match_id = m.id
    WHERE g."matchId" = m.id AND (
      g."deckTypeId" IS DISTINCT FROM CASE
        WHEN LOWER(g."playerName") = LOWER(m."playerAName") THEN p.a_type ELSE p.b_type END
      OR g."opponentDeckTypeId" IS DISTINCT FROM CASE
        WHEN LOWER(g."opponentName") = LOWER(m."playerAName") THEN p.a_type ELSE p.b_type END
    )
  `);
  return {updatedMatches: matches.rowCount, updatedGameRows: games.rowCount};
}

async function verifyPlan(client) {
  const result = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM ladder_match m JOIN deck_reclass_plan p ON p.match_id = m.id
        WHERE m."playerADeckTypeId" IS DISTINCT FROM p.a_type OR m."playerBDeckTypeId" IS DISTINCT FROM p.b_type
      ) AS match_mismatches,
      (SELECT COUNT(*)::int FROM ladder_match_game g
        JOIN ladder_match m ON m.id = g."matchId"
        JOIN deck_reclass_plan p ON p.match_id = m.id
        WHERE g."deckTypeId" IS DISTINCT FROM CASE
            WHEN LOWER(g."playerName") = LOWER(m."playerAName") THEN p.a_type ELSE p.b_type END
          OR g."opponentDeckTypeId" IS DISTINCT FROM CASE
            WHEN LOWER(g."opponentName") = LOWER(m."playerAName") THEN p.a_type ELSE p.b_type END
      ) AS game_mismatches
  `);
  const verification = result.rows[0];
  if (Number(verification.match_mismatches) !== 0 || Number(verification.game_mismatches) !== 0) {
    throw new Error(`Deck-type verification failed: ${JSON.stringify(verification)}`);
  }
  return {matchMismatches: 0, gameMismatches: 0};
}

function summarizeSkipped(skipped) {
  const counts = new Map();
  for (const item of skipped) addCount(counts, item.reason);
  return Object.fromEntries([...counts].sort((left, right) => left[0].localeCompare(right[0])));
}

async function execute(options) {
  const loaded = loadClassifier();
  const client = new Client(connectionConfig(options));
  await client.connect();
  let transactionOpen = false;
  try {
    if (options.mode === 'audit') {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    } else {
      await client.query('BEGIN');
    }
    transactionOpen = true;
    if (options.mode !== 'audit') {
      await client.query('LOCK TABLE ladder_match, ladder_match_game IN ACCESS EXCLUSIVE MODE');
      await client.query('LOCK TABLE duel_log, duel_log_player IN SHARE MODE');
    }
    await validateSchema(client);
    const created = await createPlan(client, loaded.classifier);
    created.sourceCounts.distinctDeckBuffers = created.deckCache.size;
    const {plan} = created;
    let writes = {updatedMatches: 0, updatedGameRows: 0};
    let verification = null;
    if (options.mode !== 'audit') {
      await stagePlan(client, plan.updates);
      writes = await applyPlan(client);
      if (writes.updatedMatches !== plan.changedMatches || writes.updatedGameRows !== plan.changedGameRows) {
        throw new Error(`Changed-row count drifted while applying the plan: expected ${plan.changedMatches}/${plan.changedGameRows}, got ${writes.updatedMatches}/${writes.updatedGameRows}.`);
      }
      verification = await verifyPlan(client);
    }
    const committed = options.mode === 'apply';
    await client.query(committed ? 'COMMIT' : 'ROLLBACK');
    transactionOpen = false;
    const report = {
      tool: 'deck-template-database-reclassifier',
      mode: options.mode,
      committed,
      generatedAt: new Date().toISOString(),
      templates: {
        directory: path.relative(rootDir, loaded.templateDirectory).replaceAll('\\', '/'),
        count: loaded.classifier.templateCount,
        sha256: loaded.templateSha256,
        otherDeckTypeId: loaded.classifier.otherDeckTypeId
      },
      counts: {
        totalMatches: created.sourceCounts.matches,
        totalGameRows: created.sourceCounts.gameRows,
        distinctG1DeckBuffers: created.sourceCounts.distinctDeckBuffers,
        reclassifiableMatches: plan.updates.length,
        skippedMatches: plan.skipped.length,
        changedMatches: plan.changedMatches,
        unchangedMatches: plan.updates.length - plan.changedMatches,
        changedGameRows: plan.changedGameRows,
        writtenMatches: writes.updatedMatches,
        writtenGameRows: writes.updatedGameRows
      },
      skippedByReason: summarizeSkipped(plan.skipped),
      transitions: plan.transitions,
      skipped: plan.skipped,
      verification
    };
    if (options.report) {
      const target = path.resolve(process.cwd(), options.report);
      fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    return report;
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

function publicSummary(report) {
  return {
    mode: report.mode,
    committed: report.committed,
    templates: report.templates,
    counts: report.counts,
    skippedByReason: report.skippedByReason,
    transitions: report.transitions,
    verification: report.verification
  };
}

if (require.main === module) {
  let options;
  try {
    options = parseArgs(process.argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      process.exitCode = 0;
    } else {
      execute(options).then(report => {
        process.stdout.write(`${JSON.stringify(publicSummary(report), null, 2)}\n`);
      }).catch(error => {
        process.stderr.write(`${error.stack || error.message || error}\n`);
        process.exitCode = 1;
      });
    }
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CONFIRMATION,
  parseArgs,
  chooseG1Reference,
  buildPlan,
  summarizeSkipped,
  publicSummary,
  execute
};
