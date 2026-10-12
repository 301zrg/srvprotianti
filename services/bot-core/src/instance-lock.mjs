import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function acquireInstanceLock(root, platform = 'discord') {
  if (!['discord', 'qq'].includes(platform)) throw new Error('Invalid bot platform');
  const filename = path.join(root, 'data', `${platform}-instance.lock`);
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  const id = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(filename, JSON.stringify({pid: process.pid, id}), {flag: 'wx'});
      const release = () => {
        try { if (JSON.parse(fs.readFileSync(filename, 'utf8')).id === id) fs.unlinkSync(filename); }
        catch (error) { if (error.code !== 'ENOENT') process.stderr.write(`Unable to release ${platform} instance lock\n`); }
      };
      process.once('exit', release);
      return release;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error(`Invalid ${platform} instance lock`);
      const lock = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!Number.isSafeInteger(lock.pid) || lock.pid < 1 || typeof lock.id !== 'string') throw new Error(`Invalid ${platform} instance lock`);
      try { process.kill(lock.pid, 0); }
      catch (cause) {
        if (cause.code === 'ESRCH') {
          // Recheck identity before removing a stale owner's lock.
          if (JSON.parse(fs.readFileSync(filename, 'utf8')).id === lock.id) fs.unlinkSync(filename);
          continue;
        }
        throw cause;
      }
      throw Object.assign(new Error(`${platform} bot is already running (PID ${lock.pid})`), {code: 'BOT_ALREADY_RUNNING'});
    }
  }
  throw new Error(`Unable to acquire ${platform} instance lock`);
}
