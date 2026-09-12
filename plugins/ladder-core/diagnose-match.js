'use strict';

const {Client} = require('pg');
const {connectionConfig} = require('./migrations/202609-history-repair/migrate');

async function main() {
  const names = process.argv.slice(2).filter(value => value !== '--use-host-config').map(value => value.trim().toLowerCase());
  if (names.length !== 2 || names.some(name => !name)) {
    throw new Error('Usage: node diagnose-match.js <player-a> <player-b> [--use-host-config]');
  }
  const useHostConfig = process.argv.includes('--use-host-config');
  const client = new Client({...connectionConfig({useHostConfig}), application_name: 'srvpro-ladder-match-diagnostic'});
  await client.connect();
  try {
    const matches = await client.query(`
      SELECT id::text, "playerAName", "playerBName", "winnerName", "loserName",
        "coinWinner", "g1FirstPlayer", "playerADuelPointsDelta", "playerBDuelPointsDelta", "createTime"
      FROM ladder_match
      WHERE LEAST(LOWER("playerAName"), LOWER("playerBName")) = LEAST($1, $2)
        AND GREATEST(LOWER("playerAName"), LOWER("playerBName")) = GREATEST($1, $2)
      ORDER BY id DESC LIMIT 10
    `, names);
    const matchIds = matches.rows.map(row => row.id);
    const games = matchIds.length ? await client.query(`
      SELECT "matchId"::text, "duelLogId"::text, "playerName", "opponentName", "winnerName",
        "duelCount", "isFirst", "isMain", "deckTypeId", "opponentDeckTypeId", "createTime"
      FROM ladder_match_game WHERE "matchId" = ANY($1::bigint[])
      ORDER BY "matchId" DESC, "duelCount", "playerName"
    `, [matchIds]) : {rows: []};
    const users = await client.query(`
      SELECT name, wins, losses, "duelPoints", "monthWins", "monthLosses", "monthDuelPoints"
      FROM ladder_user WHERE LOWER(name) = ANY($1::text[]) ORDER BY name
    `, [names]);
    const deckMismatches = matchIds.length ? await client.query(`
      SELECT COUNT(*)::int AS count
      FROM ladder_match_game g JOIN ladder_match m ON m.id = g."matchId"
      WHERE g."matchId" = ANY($1::bigint[])
        AND (g."deckTypeId" IS DISTINCT FROM CASE
          WHEN LOWER(g."playerName") = LOWER(m."playerAName") THEN m."playerADeckTypeId" ELSE m."playerBDeckTypeId" END
        OR g."opponentDeckTypeId" IS DISTINCT FROM CASE
          WHEN LOWER(g."opponentName") = LOWER(m."playerAName") THEN m."playerADeckTypeId" ELSE m."playerBDeckTypeId" END)
    `, [matchIds]) : {rows: [{count: 0}]};
    const logs = await client.query(`
      SELECT l.id::text, l.name AS room, l."duelCount", l.time,
        p.name, p.pos, p.winner, p."isFirst", p.score
      FROM duel_log l JOIN duel_log_player p ON p."duelLogId" = l.id
      WHERE EXISTS (
        SELECT 1 FROM duel_log_player member
        WHERE member."duelLogId" = l.id AND LOWER(member.name) = ANY($1::text[])
      )
      ORDER BY l.id DESC, p.pos LIMIT 30
    `, [names]);
    process.stdout.write(`${JSON.stringify({
      matches: matches.rows,
      games: games.rows,
      users: users.rows,
      deckTypeMismatchCount: deckMismatches.rows[0].count,
      duelLogs: logs.rows
    }, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Diagnostic failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
