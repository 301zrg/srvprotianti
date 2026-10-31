let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify(JSON.parse(input).filter(p =>
    ['discord-bot', 'discord-proxy'].includes(p.name)
  ).map(p => ({name: p.name, pid: p.pid, status: p.pm2_env.status,
    script: p.pm2_env.pm_exec_path}))));
});
