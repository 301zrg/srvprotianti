import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const languageCodes = new Set(['zh-cn', 'ja-jp', 'en-us', 'ko-kr']);

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

function validateLanguages(languages, label) {
  if (!Array.isArray(languages) || !languages.length || languages.some(code => !languageCodes.has(code)) ||
      new Set(languages).size !== languages.length) {
    throw new Error(`${label}.languages must be a nonempty list of unique zh-cn, ja-jp, en-us, ko-kr values`);
  }
}

function validateTargets(config) {
  if (config.qq.enabled) {
    const apiBase = new URL(config.qq.apiBaseUrl);
    if (apiBase.protocol !== 'https:' || apiBase.username || apiBase.password) {
      throw new Error('qq.apiBaseUrl must be an HTTPS URL without credentials');
    }
    required(config.qq.appId, 'qq.appId');
    required(config.qq.appSecret, 'qq.appSecret');
    if (!Array.isArray(config.qq.groups) || !config.qq.groups.length) throw new Error('qq.groups is required');
    const ids = new Set();
    for (const group of config.qq.groups) {
      required(group.groupOpenId, 'qq.groups[].groupOpenId');
      validateLanguages(group.languages, 'qq.groups[]');
      if (ids.has(group.groupOpenId)) throw new Error(`Duplicate QQ group ${group.groupOpenId}`);
      ids.add(group.groupOpenId);
    }
  }
  if (config.discord.enabled) {
    required(config.discord.applicationId, 'discord.applicationId');
    required(config.discord.botToken, 'discord.botToken');
    if (/^[0-9a-f]{64}$/i.test(config.discord.botToken)) {
      throw new Error('discord.botToken looks like a Discord Public Key; copy the Token from Developer Portal > Bot instead');
    }
    if (!Array.isArray(config.discord.guilds) || !config.discord.guilds.length) throw new Error('discord.guilds is required');
    const guildIds = new Set(), channelIds = new Set();
    for (const guild of config.discord.guilds) {
      required(guild.guildId, 'discord.guilds[].guildId');
      if (guildIds.has(guild.guildId)) throw new Error(`Duplicate Discord guild ${guild.guildId}`);
      guildIds.add(guild.guildId);
      if (!Array.isArray(guild.channels) || !guild.channels.length) throw new Error(`discord guild ${guild.guildId} needs channels`);
      for (const channel of guild.channels) {
        required(channel.channelId, 'discord.guilds[].channels[].channelId');
        validateLanguages(channel.languages, 'discord.guilds[].channels[]');
        if (channelIds.has(channel.channelId)) throw new Error(`Duplicate Discord channel ${channel.channelId}`);
        channelIds.add(channel.channelId);
      }
    }
  }
}

export function validateConfig(config) {
  if (!config.qq?.enabled && !config.discord?.enabled) throw new Error('Enable at least one platform in config.json');
  const base = new URL(config.gameApi?.baseUrl || '');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.hostname === 'example.invalid') {
    throw new Error('gameApi.baseUrl must be a real HTTP or HTTPS URL without credentials');
  }
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
  validateTargets(config);
  for (const key of ['file', 'scheduleStateFile']) {
    required(config.logging?.[key], `logging.${key}`);
    const target = path.resolve(serviceRoot, config.logging[key]);
    if (!target.startsWith(serviceRoot + path.sep)) throw new Error(`logging.${key} must stay within the service directory`);
  }
  return config;
}

export function loadConfig() {
  const defaults = JSON.parse(fs.readFileSync(path.join(serviceRoot, 'config.default.json'), 'utf8'));
  const localPath = path.join(serviceRoot, 'config.json');
  if (!fs.existsSync(localPath)) throw new Error(`Create ${localPath} from config.default.json and fill in your deployment settings`);
  const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
  return validateConfig(mergeConfig(defaults, local));
}
