import {QQBot} from '@tencent-connect/qqbot-nodejs';
import {formatHelp, message} from './i18n.mjs';
import {platformErrorCode} from './logger.mjs';
import {splitLines} from './service.mjs';

const GROUP_AND_C2C_INTENT = 1 << 25;

export function parseQqCommand(content) {
  const cleaned = String(content || '').replace(/<@!?[^>]+>/g, '').replace(/^@\S+\s*/, '').trim();
  if (/^(房间|\/rooms)$/i.test(cleaned)) return {name: 'rooms'};
  const player = /^(?:战绩|\/player)\s+(.+)$/i.exec(cleaned);
  return player ? {name: 'player', id: player[1].trim()} : null;
}

export class QqAdapter {
  constructor(config, service, logger) {
    this.config = config;
    this.service = service;
    this.logger = logger;
    this.groups = new Map(config.groups.map(group => [group.groupOpenId, group]));
    this.denied = new Set();
    this.unknownGroups = new Set();
    this.ready = false;
    const sdkLogger = {
      debug() {}, info() {},
      warn: () => { void this.logger.write('qq_sdk_warning'); },
      error: error => { void this.logger.write('qq_sdk_error', {code: platformErrorCode(error)}); }
    };
    this.bot = new QQBot({
      appId: config.appId,
      appSecret: config.appSecret,
      baseUrl: config.apiBaseUrl,
      intents: GROUP_AND_C2C_INTENT,
      logger: sdkLogger
    });
    this.bot.on('ready', () => {
      this.ready = true;
      void this.logger.write('qq_ready', {apiBaseUrl: config.apiBaseUrl, intents: GROUP_AND_C2C_INTENT});
    });
    this.bot.on('resumed', () => { this.ready = true; void this.logger.write('qq_resumed'); });
    this.bot.on('error', error => { void this.logger.write('qq_error', {code: platformErrorCode(error)}); });
    this.bot.on('message', async (_context, incoming) => this.onMessage(incoming));
  }

  start() {
    // Tencent's start() stays pending until stop(), so run it independently of
    // Discord and the game API monitor.
    void this.bot.start().catch(error => {
      this.ready = false;
      void this.logger.write('qq_start_failed', {code: platformErrorCode(error)});
    });
  }

  stop() { this.bot.stop(); }

  async onMessage(incoming) {
    if (incoming.kind !== 'group' || !incoming.groupOpenid) return;
    let group = this.groups.get(incoming.groupOpenid);
    const placeholder = this.groups.get('temp');
    if (!group && placeholder) {
      this.groups.delete('temp');
      placeholder.groupOpenId = incoming.groupOpenid;
      this.groups.set(incoming.groupOpenid, placeholder);
      group = placeholder;
      await this.logger.write('qq_group_discovered', {group: incoming.groupOpenid});
    } else if (!group && !this.unknownGroups.has(incoming.groupOpenid)) {
      this.unknownGroups.add(incoming.groupOpenid);
      await this.logger.write('qq_unconfigured_group', {group: incoming.groupOpenid});
    }
    if (!group?.commands || !incoming.replyTarget?.msgId) return;
    const command = parseQqCommand(incoming.content);
    const mentioned = incoming.rawEventType === 'GROUP_AT_MESSAGE_CREATE' ||
      (Array.isArray(incoming.mentions) && incoming.mentions.some(value => value?.is_you === true));
    await this.logger.write('qq_group_message_received', {
      group: incoming.groupOpenid,
      eventType: incoming.rawEventType || 'unknown',
      command: command?.name || (mentioned ? 'help' : 'ignored')
    });
    if (!command && !mentioned) return;
    const response = !command ? {messages: [formatHelp(group.languages)]} :
      command.name === 'rooms' ? await this.service.rooms(group.languages) :
        await this.service.player(command.id, group.languages);
    const target = incoming.replyTarget;
    try {
      for (const value of response.messages) {
        for (const chunk of splitLines(value, 1600)) await this.bot.sendText(target, chunk);
      }
      if (response.image) {
        try { await this.bot.sendImage(target, {buffer: response.image}); }
        catch (error) {
          await this.logger.write('qq_chart_send_failed', {group: group.groupOpenId, code: platformErrorCode(error)});
          await this.bot.sendText(target, message('unavailable', group.languages));
        }
      }
    } catch (error) {
      await this.logger.write('qq_reply_failed', {group: group.groupOpenId, code: platformErrorCode(error)});
    }
  }

  async proactive(group, kind, text) {
    if (!group.proactiveEnabled || this.denied.has(group.groupOpenId)) {
      await this.logger.write('qq_proactive_skipped', {kind, group: group.groupOpenId, content: text, reason: 'permission_disabled'});
      return;
    }
    if (!this.ready) {
      await this.logger.write('qq_proactive_skipped', {kind, group: group.groupOpenId, content: text, reason: 'connection_unavailable'});
      return;
    }
    try {
      await this.bot.sendText({scope: 'group', targetId: group.groupOpenId}, text);
      await this.logger.write('qq_proactive_sent', {kind, group: group.groupOpenId});
    } catch (error) {
      const code = platformErrorCode(error);
      if (code === '40034102' || code === '40034105') this.denied.add(group.groupOpenId);
      await this.logger.write('qq_proactive_failed', {kind, group: group.groupOpenId, content: text, code});
    }
  }

  async notifyWaiting(format) {
    for (const group of this.config.groups.filter(group => group.matchAlerts)) {
      await this.proactive(group, 'match_waiting', format(group.languages));
    }
  }

  async notifyMonthly(format) {
    for (const group of this.config.groups.filter(group => group.monthlyTop10)) {
      await this.proactive(group, 'monthly_top10', format(group.languages));
    }
  }
}
