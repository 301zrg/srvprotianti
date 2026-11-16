'use strict';
// Prints a whitelisted JSON summary of a PM2 dump.pm2 file. Environment variables and other
// fields are never printed: dump.pm2 stores each app's full environment, which may include
// credentials. Node's JSON parser is used because Windows PowerShell 5.1 ConvertFrom-Json
// rejects keys that differ only by case (dump env commonly has both username and USERNAME).
const fs = require('node:fs');

function summarize(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('dump.pm2 is not a JSON array');
  return data.map((app) => {
    if (!app || typeof app !== 'object') throw new Error('dump.pm2 entry is not an object');
    const pick = (key) => (typeof app[key] === 'string' || typeof app[key] === 'boolean' || typeof app[key] === 'number' ? app[key] : null);
    return {name: pick('name'), script: pick('pm_exec_path'), cwd: pick('pm_cwd'), exec_mode: pick('exec_mode'),
      watch: pick('watch'), autorestart: pick('autorestart'), status: pick('status')};
  });
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node pm2-dump-summary.cjs <dump.pm2>');
    process.stdout.write(JSON.stringify(summarize(fs.readFileSync(process.argv[2], 'utf8'))) + '\n');
  } catch (error) {
    process.stderr.write('pm2-dump-summary: ' + error.message + '\n');
    process.exitCode = 2;
  }
}

module.exports = {summarize};
