#!/usr/bin/env node
'use strict';

// Bulk conversion of ladder_user.pass to scrypt hashes (design 2.8 / 6.2).
//
//   node migrate.js --dry-run              count only, writes nothing
//   node migrate.js --apply --confirm HASH-LADDER-PASSWORDS
//
// --apply refuses to run unless passwordHash.mode is "hashed", and stops at
// once if the mode is switched away (e.g. to frozen) while it runs. Every row
// is written with a conditional update, so a concurrent password change or
// reset is never overwritten. Damaged rows (a hash prefix with an invalid
// body) are listed by account name and make the run fail. Acceptance:
// "remaining non-empty legacy plaintext = 0". Re-running is safe (idempotent).
// No password or hash is ever printed.

const {convertPasswords, remainingLegacy, openPgStore, describeError} = require('../../credential-tools');

const CONFIRMATION = 'HASH-LADDER-PASSWORDS';

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {apply: false, dryRun: false, confirm: null, batchSize: 200};
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
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 5000) throw new Error('--batch-size must be 1-5000.');
  return options;
}

function report(summary, remaining) {
  const lines = [
    `mode: ${summary.apply ? 'apply' : 'dry-run'}`,
    `scanned: ${summary.scanned}`,
    `empty: ${summary.empty}`,
    `already hashed: ${summary.hashed} (temporary: ${summary.temporary})`,
    `legacy plaintext found: ${summary.legacy}`,
    `converted: ${summary.converted} (conditional-update retries: ${summary.retried})`,
    `damaged: ${summary.damaged.length}${summary.damaged.length ? ` -> ${summary.damaged.join(', ')}` : ''}`,
    `unresolved conflicts: ${summary.conflicts.length}${summary.conflicts.length ? ` -> ${summary.conflicts.join(', ')}` : ''}`
  ];
  if (summary.stoppedBecauseMode) lines.push(`STOPPED: passwordHash.mode became ${summary.stoppedBecauseMode}`);
  if (remaining) lines.push(`remaining non-empty legacy plaintext: ${remaining.legacy} (damaged: ${remaining.damaged})`);
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log(`Usage: node migrate.js --dry-run | --apply --confirm ${CONFIRMATION} [--batch-size N]`);
    return;
  }
  const store = await openPgStore();
  try {
    let lastPrinted = 0;
    const summary = await convertPasswords(store, {apply: options.apply, batchSize: options.batchSize, onProgress: current => {
      if (current.converted - lastPrinted >= 100) { lastPrinted = current.converted; console.error(`converted ${current.converted}...`); }
    }});
    const remaining = options.apply ? await remainingLegacy(store) : null;
    console.log(report(summary, remaining));
    const failed = summary.damaged.length || summary.conflicts.length || summary.stoppedBecauseMode || (remaining && remaining.legacy);
    process.exitCode = failed ? 1 : 0;
  } finally {
    await store.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Conversion failed: ${describeError(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {parseArgs, report, CONFIRMATION};
