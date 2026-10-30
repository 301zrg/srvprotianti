let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify(JSON.parse(input).map(p => ({
    name: p.name, pid: p.pid, status: p.pm2_env.status,
    started: p.pm2_env.pm_uptime, restarts: p.pm2_env.restart_time,
    watch: p.pm2_env.watch, discordProxy: Boolean(p.pm2_env.DISCORD_PROXY_URL)
  }))));
});
