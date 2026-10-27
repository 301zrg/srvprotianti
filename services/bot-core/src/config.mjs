import fs from 'node:fs';
import path from 'node:path';
import {MONTHLY_REPORT_DEFAULTS} from './monthly-report.mjs';
import {LANGUAGE_KEYS} from './languages.mjs';

const languageCodes = new Set(Object.keys(LANGUAGE_KEYS));

export function mergeConfig(base, override) {
  if (Array.isArray(override)) return override;
  if (!override || typeof override !== 'object') return override;
  const output = base && typeof base === 'object' && !Array.isArray(base) ? {...base} : {};
  for (const [key, value] of Object.entries(override)) output[key] = mergeConfig(output[key], value);
  return output;
}

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
}

function webUrl(value, label, httpsOnly = false) {
  required(value, label);
  const url = new URL(value);
  if ((httpsOnly ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol)) ||
      url.username || url.password || url.hostname === 'example.invalid') {
    throw new Error(`${label} must be a real ${httpsOnly ? 'HTTPS' : 'HTTP or HTTPS'} URL without credentials`);
  }
}

function validateLanguages(languages, label) {
  if (!Array.isArray(languages) || !languages.length || languages.some(code => !languageCodes.has(code)) ||
      new Set(languages).size !== languages.length) {
    throw new Error(`${label}.languages must be a nonempty list of unique zh-cn, ja-jp, en-us, ko-kr values`);
  }
}

function relativeFile(root, value, label) {
  required(value, label);
  const target = path.resolve(root, value);
  if (!target.startsWith(root + path.sep)) throw new Error(`${label} must stay within the service directory`);
}

function validateQq(config) {
  webUrl(config.apiBaseUrl, 'qq.apiBaseUrl', true);
  required(config.appId, 'qq.appId');
  required(config.appSecret, 'qq.appSecret');
  if (!Array.isArray(config.groups) || !config.groups.length) throw new Error('qq.groups is required');
  const ids = new Set();
  for (const group of config.groups) {
    required(group.groupOpenId, 'qq.groups[].groupOpenId');
    validateLanguages(group.languages, 'qq.groups[]');
    for (const key of ['commands', 'matchAlerts', 'monthlyTop10', 'monthlyReport', 'winStreakAlerts', 'proactiveEnabled']) {
      if (group[key] !== undefined && typeof group[key] !== 'boolean') {
        throw new Error(`qq.groups[].${key} must be a boolean`);
      }
    }
    if (ids.has(group.groupOpenId)) throw new Error(`Duplicate QQ group ${group.groupOpenId}`);
    ids.add(group.groupOpenId);
  }
}

function validateDiscord(config, card, root) {
  required(config.applicationId, 'discord.applicationId');
  required(config.botToken, 'discord.botToken');
  if (/^[0-9a-f]{64}$/i.test(config.botToken)) {
    throw new Error('discord.botToken looks like a Discord Public Key; copy the Token from Developer Portal > Bot instead');
  }
  if (!Array.isArray(config.guilds) || !config.guilds.length) throw new Error('discord.guilds is required');
  const guildIds = new Set(), channelIds = new Set();
  for (const guild of config.guilds) {
    required(guild.guildId, 'discord.guilds[].guildId');
    if (guildIds.has(guild.guildId)) throw new Error(`Duplicate Discord guild ${guild.guildId}`);
    guildIds.add(guild.guildId);
    if (!Array.isArray(guild.channels) || !guild.channels.length) throw new Error(`discord guild ${guild.guildId} needs channels`);
    for (const channel of guild.channels) {
      required(channel.channelId, 'discord.guilds[].channels[].channelId');
      validateLanguages(channel.languages, 'discord.guilds[].channels[]');
      if (channel.winStreakAlerts !== undefined && typeof channel.winStreakAlerts !== 'boolean') {
        throw new Error('discord.guilds[].channels[].winStreakAlerts must be a boolean');
      }
      for (const key of ['monthlyReport', 'adminResendTest']) {
        if (channel[key] !== undefined && typeof channel[key] !== 'boolean') throw new Error(`discord.guilds[].channels[].${key} must be a boolean`);
      }
      if (channelIds.has(channel.channelId)) throw new Error(`Duplicate Discord channel ${channel.channelId}`);
      channelIds.add(channel.channelId);
    }
  }
  if (!Number.isInteger(card.intervalSeconds) || card.intervalSeconds < 30 || card.intervalSeconds > 3600) {
    throw new Error('statusCard.intervalSeconds must be 30..3600');
  }
  relativeFile(root, card.stateFile, 'statusCard.stateFile');
  if (card.enabled) {
    required(card.guildId, 'statusCard.guildId');
    required(card.channelId, 'statusCard.channelId');
    if (!guildIds.has(card.guildId)) throw new Error('statusCard.guildId must be configured in discord.guilds');
    if (channelIds.has(card.channelId)) throw new Error('statusCard.channelId must be a separate status channel');
  }
}

function validateMonthlyReports(config, platform, root) {
  const monthly = {...MONTHLY_REPORT_DEFAULTS, ...config.monthlyReports};
  if (config.monthlyReports !== undefined && (!config.monthlyReports || typeof config.monthlyReports !== 'object' || Array.isArray(config.monthlyReports))) throw new Error('monthlyReports must be an object');
  if (typeof monthly.enabled !== 'boolean') throw new Error('monthlyReports.enabled must be a boolean');
  if (monthly.timezone !== 'Asia/Shanghai' || monthly.day !== 1 || monthly.hour !== 10 || monthly.minute !== 0) throw new Error('monthlyReports must run on day 1 at 10:00 Asia/Shanghai');
  if (!Number.isInteger(monthly.catchUpHours) || monthly.catchUpHours < 0 || monthly.catchUpHours > 168) throw new Error('monthlyReports.catchUpHours must be 0..168');
  for (const key of ['stateFile', 'artifactDir']) relativeFile(root, monthly[key], `monthlyReports.${key}`);
  if (platform === 'qq' && path.resolve(root, monthly.stateFile) === path.resolve(root, config.logging.scheduleStateFile)) throw new Error('QQ daily and monthly state files must be separate');
  if (monthly.webBaseUrl !== '') webUrl(monthly.webBaseUrl, 'monthlyReports.webBaseUrl');
  if (monthly.enabled && platform === 'discord' && !config.discord.guilds.some(g => g.channels.some(c => c.monthlyReport))) throw new Error('monthlyReports.enabled needs a channel with monthlyReport: true');
  if (monthly.enabled && platform === 'qq' && !config.qq.groups.some(g => g.monthlyReport === true && g.proactiveEnabled === true)) throw new Error('monthlyReports.enabled needs a QQ group with monthlyReport: true and proactiveEnabled: true');
  return monthly;
}

export function validateConfig(config, platform, root) {
  if (!['qq', 'discord'].includes(platform)) throw new Error('Unknown bot platform');
  if (config[platform]?.enabled !== true) throw new Error(`Set ${platform}.enabled to true in config.json`);
  webUrl(config.gameApi?.baseUrl, 'gameApi.baseUrl');
  if (!Number.isInteger(config.gameApi.roomPollSeconds) || config.gameApi.roomPollSeconds < 1 || config.gameApi.roomPollSeconds > 300) {
    throw new Error('gameApi.roomPollSeconds must be 1..300');
  }
  if (!Number.isInteger(config.gameApi.timeoutMs) || config.gameApi.timeoutMs < 500 || config.gameApi.timeoutMs > 30000) {
    throw new Error('gameApi.timeoutMs must be 500..30000');
  }
  if (!Number.isInteger(config.matching.cooldownSeconds) || config.matching.cooldownSeconds < 0) {
    throw new Error('matching.cooldownSeconds must be a nonnegative integer');
  }
  if (config.monthlyTop10.timezone !== 'Asia/Shanghai' || config.monthlyTop10.hour !== 4) {
    throw new Error('monthlyTop10 must run at 04:00 Asia/Shanghai');
  }
  webUrl(config.guide?.clientDownloadUrl, 'guide.clientDownloadUrl', true);
  webUrl(config.guide?.desktopDownloadUrl, 'guide.desktopDownloadUrl', true);
  webUrl(config.guide?.introUrl, 'guide.introUrl');
  webUrl(config.guide?.discordInviteUrl, 'guide.discordInviteUrl', true);
  required(config.guide?.gameHost, 'guide.gameHost');
  if (/[:/@\s]/.test(config.guide.gameHost)) throw new Error('guide.gameHost must be a host without protocol or port');
  if (!Number.isInteger(config.guide.gamePort) || config.guide.gamePort < 1 || config.guide.gamePort > 65535) {
    throw new Error('guide.gamePort must be 1..65535');
  }
  for (const key of ['file', 'scheduleStateFile']) relativeFile(root, config.logging?.[key], `logging.${key}`);
  if (platform === 'qq') validateQq(config.qq);
  else validateDiscord(config.discord, config.statusCard, root);
  config.monthlyReports = validateMonthlyReports(config, platform, root);
  const streaks = config.winStreaks;
  if (streaks !== undefined) {
    if (!streaks || typeof streaks !== 'object' || Array.isArray(streaks)) throw new Error('winStreaks must be an object');
    if (typeof streaks.enabled !== 'boolean') throw new Error('winStreaks.enabled must be a boolean');
    if (!Number.isInteger(streaks.pollSeconds) || streaks.pollSeconds < 1 || streaks.pollSeconds > 60) {
      throw new Error('winStreaks.pollSeconds must be 1..60');
    }
    relativeFile(root, streaks.stateFile, 'winStreaks.stateFile');
    if (streaks.enabled && platform === 'discord' &&
        !config.discord.guilds.some(guild => guild.channels.some(channel => channel.winStreakAlerts))) {
      throw new Error('winStreaks.enabled needs a channel with winStreakAlerts: true');
    }
    if (streaks.enabled && platform === 'qq' &&
        !config.qq.groups.some(group => group.winStreakAlerts === true && group.proactiveEnabled === true)) {
      throw new Error('winStreaks.enabled needs a QQ group with winStreakAlerts: true and proactiveEnabled: true');
    }
  }
  return config;
}

export function loadConfig(root, platform) {
  const defaults = JSON.parse(fs.readFileSync(path.join(root, 'config.default.json'), 'utf8'));
  // Discord has its own deployment configuration. An inherited migration-era
  // BOT_CONFIG_PATH must never redirect it to the combined bot's targets.
  const localPath = path.resolve(root, platform === 'discord' ? 'config.json' : process.env.BOT_CONFIG_PATH || 'config.json');
  if (!fs.existsSync(localPath)) throw new Error(`Create ${localPath} from config.default.json and fill in your deployment settings`);
  const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
  return validateConfig(mergeConfig(defaults, local), platform, root);
}
