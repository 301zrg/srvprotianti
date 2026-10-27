import path from 'node:path';
import {GameApi} from './api.mjs';
import {FileLogger} from './logger.mjs';
import {MatchMonitor} from './monitor.mjs';
import {DailyRankingScheduler} from './daily-ranking-scheduler.mjs';
import {CommunityService} from './service.mjs';
import {WinStreakMonitor} from './win-streaks.mjs';
import {MonthlyReports} from './monthly-report.mjs';
import {MonthlyReportScheduler} from './monthly-report-scheduler.mjs';
import {QqScheduler} from './qq-scheduler.mjs';

export async function startRuntime({root, platform, config, createAdapter}) {
  const logger = new FileLogger(path.resolve(root, config.logging.file));
  const api = new GameApi(config.gameApi);
  const monthlyReports = new MonthlyReports({api, root, config: config.monthlyReports, guide: config.guide});
  const service = new CommunityService({api, logger, guide: config.guide, monthlyReports});
  const adapter = createAdapter(service, logger);
  service.adapter = adapter;
  if (platform === 'discord') await logger.write('discord_runtime_config', {configPath: path.join(root, 'config.json'),
    dailyTop10Targets: (adapter.top10Targets?.() || []).map(target => target.channelId),
    monthlyReportTargets: (adapter.monthlyReportTargets?.() || []).map(target => target.channelId)});
  const monitor = new MatchMonitor({
    api, intervalMs: config.gameApi.roomPollSeconds * 1000,
    cooldownMs: config.matching.cooldownSeconds * 1000,
    onWaiting: () => service.notifyWaiting(), logger
  });
  service.monitor = monitor;
  const scheduler = platform === 'discord' ? new DailyRankingScheduler({
    stateFile: path.resolve(root, config.logging.scheduleStateFile), api, adapter, logger
  }) : new QqScheduler({root, kind: 'daily', stateFile: config.logging.scheduleStateFile,
    adapter, config: config.monthlyTop10, logger
  });
  service.scheduler = scheduler;
  const streakMonitor = config.winStreaks?.enabled ? new WinStreakMonitor({
    api, stateFile: path.resolve(root, config.winStreaks.stateFile), intervalMs: config.winStreaks.pollSeconds * 1000,
    canNotify: () => adapter.canNotifyWinStreak(),
    onStreak: (row, deadline) => adapter.notifyWinStreak(row, deadline), logger
  }) : null;
  void Promise.resolve(adapter.start()).catch(error => logger.write(`${platform}_start_failed`, {code: error.code || 'unknown'}));
  monitor.start();
  await scheduler.start();
  if (streakMonitor) await streakMonitor.start();
  const reportScheduler = platform === 'discord' ? new MonthlyReportScheduler({reports: monthlyReports, adapter, logger}) :
    new QqScheduler({root, kind: 'monthly', stateFile: monthlyReports.config.stateFile, adapter, config: monthlyReports.config, logger});
  service.reportScheduler = reportScheduler;
  if (reportScheduler) await reportScheduler.start().catch(error => logger.write('monthly_report_scheduler_disabled', {code: error.code || 'invalid_state'}));
  if (monthlyReports) await logger.write('monthly_reports_ready', {enabled: monthlyReports.config.enabled,
    autoTargets: platform === 'qq' ? adapter.scheduledTargets?.('monthly').length || 0 : adapter.monthlyReportTargets?.().length || 0});
  await logger.write(`${platform}_bot_started`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    monitor.stop();
    scheduler.stop();
    streakMonitor?.stop();
    reportScheduler?.stop();
    adapter.stop();
    void logger.write(`${platform}_bot_stopped`);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return {service, adapter, monitor, scheduler, streakMonitor, monthlyReports, reportScheduler, stop};
}
