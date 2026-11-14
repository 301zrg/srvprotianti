'use strict';
// Read-only query of the applications managed by the running PM2 daemon, without the PM2 CLI.
// Usage: node pm2-apps-readonly.cjs <pm2Cli> <pm2Home> <daemonPid>
// Reuses windows-backup.cjs queryAppsReadOnly: direct axon RPC over rpc.sock (never loads PM2's
// CLI/Client, so it cannot start a daemon), binds the pipe to <daemonPid> before and after the
// query and checks the daemon's PM2_HOME. Prints whitelisted fields only, never the env.
const {queryAppsReadOnly} = require('../windows-backup.cjs');

function summarizeApps(apps) {
  if (!Array.isArray(apps)) throw new Error('PM2 returned no application list');
  return apps.map((app) => {
    const env = app && typeof app.pm2_env === 'object' && app.pm2_env ? app.pm2_env : {};
    const scalar = (value) => (['string', 'number', 'boolean'].includes(typeof value) ? value : null);
    return {name: scalar(app && app.name), script: scalar(env.pm_exec_path), cwd: scalar(env.pm_cwd),
      exec_mode: scalar(env.exec_mode), watch: scalar(env.watch), status: scalar(env.status), pid: scalar(app && app.pid)};
  });
}

async function main(argv, query = queryAppsReadOnly) {
  if (argv.length !== 3 || !/^[1-9][0-9]*$/.test(argv[2])) throw new Error('usage: node pm2-apps-readonly.cjs <pm2Cli> <pm2Home> <daemonPid>');
  const apps = await query({pm2Script: argv[0], pm2Home: argv[1]}, {pid: Number(argv[2])});
  return summarizeApps(apps);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((summary) => {
    process.stdout.write(JSON.stringify(summary) + '\n');
  }, (error) => {
    process.stderr.write('pm2-apps-readonly: ' + error.message + '\n');
    process.exitCode = 2;
  });
}

module.exports = {summarizeApps, main};
