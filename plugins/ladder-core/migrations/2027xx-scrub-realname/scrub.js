#!/usr/bin/env node
'use strict';

// One-off cleanup of duel_log_player."realName" (design 2.4): strip the
// "$password" part that old hosts stored. Intentionally irreversible; recover
// is disabled in code and the admin filter matches by nickname, so nothing
// needs the password part afterwards.
//
//   node scrub.js --dry-run
//   node scrub.js --apply --confirm SCRUB-REALNAME [--batch-size 10000]
//
// Runs in id-ordered batches, one short transaction each, so no long lock is
// held. Re-running is safe. Prints counts only, never a realName.

const {openPgStore, describeError} = require('../../credential-tools');

const CONFIRMATION = 'SCRUB-REALNAME';
const COUNT_SQL = `SELECT count(*)::bigint AS n FROM duel_log_player WHERE "realName" LIKE '%$%'`;
const BATCH_SQL = `
  UPDATE duel_log_player SET "realName" = split_part("realName", '$', 1)
  WHERE id IN (
    SELECT id FROM duel_log_player WHERE "realName" LIKE '%$%' AND id > $1 ORDER BY id LIMIT $2
  )
  RETURNING id`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {apply: false, dryRun: false, confirm: null, batchSize: 10000};
  while (args.length) {
    const value = args.shift();
    if (value === '--apply') options.apply = true;
    else if (value === '--dry-run') options.dryRun = true;
    else if (value === '--confirm') options.confirm = args.shift();
    else if (value === '--batch-size') options.batchSize = Number(args.shift());
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (options.apply === options.dryRun && !options.help) throw new Error('Choose exactly one of --dry-run or --apply.');
  if (options.apply && options.confirm !== CONFIRMATION) throw new Error(`--apply requires --confirm ${CONFIRMATION}`);
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 100 || options.batchSize > 50000) throw new Error('--batch-size must be 100-50000.');
  return options;
}

// `query(sql, params)` returns {rows}. Separated for tests.
async function scrub(query, {apply, batchSize, onBatch = null}) {
  const before = Number((await query(COUNT_SQL)).rows[0].n);
  if (!apply) return {before, updated: 0, after: before};
  let updated = 0;
  let lastId = 0;
  for (;;) {
    const result = await query(BATCH_SQL, [lastId, batchSize]);
    if (!result.rows.length) break;
    updated += result.rows.length;
    lastId = result.rows.reduce((max, row) => Math.max(max, Number(row.id)), lastId);
    onBatch?.(updated);
  }
  const after = Number((await query(COUNT_SQL)).rows[0].n);
  return {before, updated, after};
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log(`Usage: node scrub.js --dry-run | --apply --confirm ${CONFIRMATION} [--batch-size N]`);
    return;
  }
  const store = await openPgStore();
  try {
    const result = await scrub((sql, params) => store.client.query(sql, params), {
      apply: options.apply, batchSize: options.batchSize, onBatch: count => console.error(`updated ${count}...`)
    });
    console.log(`rows with "$" before: ${result.before}`);
    console.log(`updated: ${result.updated}`);
    console.log(`rows with "$" after: ${result.after}`);
    process.exitCode = options.apply && result.after !== 0 ? 1 : 0;
  } finally {
    await store.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Scrub failed: ${describeError(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {parseArgs, scrub, COUNT_SQL, BATCH_SQL, CONFIRMATION};
