import path from 'node:path';
import {GameApi} from './api.mjs';
import {loadConfig, serviceRoot} from './config.mjs';
import {DiscordAdapter} from './discord.mjs';
import {FileLogger} from './logger.mjs';
import {MatchMonitor} from './monitor.mjs';
import {MonthlyScheduler} from './scheduler.mjs';
import {CommunityService} from './service.mjs';
import {QqAdapter} from './qq.mjs';

async function main() {
  const config = loadConfig();
  const logger = new FileLogger(path.resolve(serviceRoot, config.logging.file));
  const api = new GameApi(config.gameApi);
  const service = new CommunityService({api, qq: null, discord: null, logger});
  const qq = config.qq.enabled ? new QqAdapter(config.qq, service, logger) : null;
  const discord = config.discord.enabled ? new DiscordAdapter(config.discord, service, logger) : null;
  service.qq = qq;
  service.discord = discord;
  qq?.start();
  if (discord) void discord.start();

  const monitor = new MatchMonitor({
    api, intervalMs: config.gameApi.roomPollSeconds * 1000,
    cooldownMs: config.matching.cooldownSeconds * 1000,
    onWaiting: () => service.notifyWaiting(), logger
  });
  const scheduler = new MonthlyScheduler({
    stateFile: path.resolve(serviceRoot, config.logging.scheduleStateFile),
    onMonthly: () => service.notifyMonthly(), logger
  });
  monitor.start();
  await scheduler.start();
  await logger.write('community_bot_started', {qq: !!qq, discord: !!discord});

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    monitor.stop();
    scheduler.stop();
    qq?.stop();
    discord?.stop();
    void logger.write('community_bot_stopped');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch(error => {
  process.stderr.write(`Community bot startup failed: ${error.message}\n`);
  process.exitCode = 1;
});
