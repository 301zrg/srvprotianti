import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let child, timer, stopping = false, delay = 5000;
const start = () => {
  const began = Date.now();
  child = spawn(process.execPath, [path.join(root, 'src', 'index.mjs')], {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: {...process.env, BOT_CONFIG_PATH: path.join(root, 'config.json')}
  });
  child.once('error', error => {
    process.stderr.write(`Discord worker could not start: ${error.code || 'unknown'}\n`);
  });
  child.once('close', code => {
    if (stopping) return;
    if (code === 73) { stopping = true; process.exitCode = code; return; }
    if (Date.now() - began > 300000) delay = 5000;
    process.stderr.write(`Discord worker exited; restarting in ${delay / 1000}s\n`);
    timer = setTimeout(start, delay);
    delay = Math.min(delay * 2, 60000);
  });
};
const stop = () => {
  if (stopping) return;
  stopping = true; clearTimeout(timer); child?.kill();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
start();
