import {spawn} from 'node:child_process';
import path from 'node:path';

export function createWorkerSupervisor({root, platform, spawnImpl = spawn, schedule = setTimeout, cancel = clearTimeout, now = Date.now,
  env = process.env, write = value => process.stderr.write(value), exited = code => { process.exitCode = code; }}) {
  let child, timer, stopping = false, delay = 5000;
  const start = () => {
    if (stopping) return;
    const began = now();
    child = spawnImpl(process.execPath, [path.join(root, 'src', 'index.mjs')], {
      cwd: root, stdio: 'inherit', windowsHide: true,
      env: platform === 'discord' ? {...env, BOT_CONFIG_PATH: path.join(root, 'config.json')} : {...env}
    });
    child.once('error', error => write(`${platform} worker could not start: ${error.code || 'unknown'}\n`));
    child.once('close', code => {
      if (stopping) return;
      if (code === 73) { stopping = true; exited(code); return; }
      if (now() - began > 300000) delay = 5000;
      write(`${platform} worker exited; restarting in ${delay / 1000}s\n`);
      timer = schedule(start, delay); delay = Math.min(delay * 2, 60000);
    });
  };
  const stop = () => { if (stopping) return; stopping = true; cancel(timer); child?.kill(); };
  return {start, stop};
}
