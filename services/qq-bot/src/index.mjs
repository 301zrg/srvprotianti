import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../../bot-core/src/config.mjs';
import {startRuntime} from '../../bot-core/src/runtime.mjs';
import {QqAdapter} from './qq.mjs';
import {acquireInstanceLock} from '../../bot-core/src/instance-lock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  const config = loadConfig(root, 'qq');
  acquireInstanceLock(root, 'qq');
  await startRuntime({root, platform: 'qq', config,
    createAdapter: (service, logger) => new QqAdapter(config.qq, service, logger)});
} catch (error) {
  process.stderr.write(`QQ bot startup failed: ${error.message}\n`);
  process.exit(error.code === 'BOT_ALREADY_RUNNING' ? 73 : 1);
}
