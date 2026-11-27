#!/usr/bin/env node
'use strict';

// Admin password reset (design 2.7). Run on the server, after verifying the
// player's identity out of band:
//
//   node plugins/ladder-core/reset-password.js <nickname> [--length N]
//
// Prints a random temporary password ONCE. It is stored as scrypt-temp$...;
// after logging in with it the player is reminded to change it. Refuses to
// run unless passwordHash.mode is "hashed". Database connection: the same
// environment variables as migrations/202609-history-repair/migrate.js.

const {resetPassword, openPgStore, describeError} = require('./credential-tools');

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {nickname: null, length: null};
  while (args.length) {
    const value = args.shift();
    if (value === '--length') {
      const raw = args.shift();
      if (!/^\d+$/.test(String(raw))) throw new Error('--length needs a positive integer.');
      options.length = Number(raw);
    } else if (value === '--help' || value === '-h') {
      options.help = true;
    } else if (options.nickname === null) {
      options.nickname = value;
    } else {
      throw new Error(`Unexpected argument: ${value}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help || !options.nickname) {
    console.log('Usage: node plugins/ladder-core/reset-password.js <nickname> [--length N]');
    process.exitCode = options.help ? 0 : 2;
    return;
  }
  const store = await openPgStore();
  try {
    const result = await resetPassword(store, options.nickname, {length: options.length});
    if (result.warning) console.error(`WARNING: ${result.warning}`);
    console.log(`Account: ${result.account}`);
    console.log(`Temporary password (shown once, ${result.length} characters): ${result.temporaryPassword}`);
  } finally {
    await store.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Reset failed: ${describeError(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {parseArgs};
