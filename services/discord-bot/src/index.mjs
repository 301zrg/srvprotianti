import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../../bot-core/src/config.mjs';
import {startRuntime} from '../../bot-core/src/runtime.mjs';
import {DiscordAdapter} from './discord.mjs';
import {acquireInstanceLock} from '../../bot-core/src/instance-lock.mjs';
import {createDiscordProxyTransport} from './proxy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  const config = loadConfig(root, 'discord');
  acquireInstanceLock(root);
  const transport = createDiscordProxyTransport();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void transport.close(); });
  process.env.BOT_CONFIG_PATH = path.join(root, 'config.json');
  await startRuntime({root, platform: 'discord', config,
    createAdapter: (service, logger) => new DiscordAdapter(config.discord, service, logger, {root, statusCard: config.statusCard, transport})});
} catch (error) {
  process.stderr.write(`Discord bot startup failed: ${error.message}\n`);
  process.exit(error.code === 'BOT_ALREADY_RUNNING' ? 73 : 1);
}
