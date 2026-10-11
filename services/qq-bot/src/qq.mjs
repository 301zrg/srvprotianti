import {QQBot} from '@tencent-connect/qqbot-nodejs';
import {formatWinStreak, message} from '../../bot-core/src/i18n.mjs';
import {platformErrorCode} from '../../bot-core/src/logger.mjs';
import {splitLines} from '../../bot-core/src/service.mjs';

const GROUP_AND_C2C_INTENT = 1 << 25;

export function parseQqCommand(content) {
  const cleaned = String(content || '').replace(/<@!?[^>]+>/g, '').replace(/^@\S+\s*/, '').trim();
  if (/^(房间|\/rooms)$/i.test(cleaned)) return {name: 'rooms'};
  if (/^(状态|\/status)$/i.test(cleaned)) return {name: 'status'};
  if (/^(玩法|\/play)$/i.test(cleaned)) return {name: 'play'};
  if (/^(帮助|\/help)$/i.test(cleaned)) return {name: 'help'};
  if (/^(排行|排行榜|\/top)$/i.test(cleaned)) return {name: 'top'};
  const player = /^(?:战绩|\/player)\s+(.+)$/i.exec(cleaned);
  return player ? {name: 'player', id: player[1].trim()} : null;
}

export class QqAdapter {
  constructor(config, service, logger, {fetchImpl = fetch, now = Date.now} = {}) {
    this.config = config;
    this.service = service;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.now = now;
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

  stop() { this.ready = false; this.bot.stop(); }

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
    const response = !command ? this.service.help(group.languages, 'qq') :
      command.name === 'rooms' ? await this.service.rooms(group.languages) :
      command.name === 'player' ? await this.service.player(command.id, group.languages) :
      command.name === 'status' ? await this.service.status(group.languages) :
      command.name === 'top' ? await this.service.top(group.languages) :
      command.name === 'play' ? this.service.play(group.languages) : this.service.help(group.languages, 'qq');
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

  async proactive(group, kind, text, {deadline = Infinity} = {}) {
    if (!group.proactiveEnabled || this.denied.has(group.groupOpenId)) {
      await this.logger.write('qq_proactive_skipped', {kind, group: group.groupOpenId, content: text, reason: 'permission_disabled'});
      return;
    }
    if (!this.ready || group.groupOpenId === 'temp') {
      await this.logger.write('qq_proactive_skipped', {kind, group: group.groupOpenId, content: text,
        reason: this.ready ? 'group_unresolved' : 'connection_unavailable'});
      return;
    }
    try {
      if (Number.isFinite(deadline)) {
        if (this.now() >= deadline) return;
        const token = await this.bot.api.getToken();
        const remaining = deadline - this.now();
        if (remaining <= 0 || !this.ready) {
          await this.logger.write('qq_proactive_skipped', {kind, group: group.groupOpenId, reason: 'window_expired_or_offline'});
          return;
        }
        // sendText() has no caller deadline. Reuse the SDK token but bound the
        // entire HTTP request, including its body, to the fresh-win window.
        const response = await this.fetch(`${this.config.apiBaseUrl.replace(/\/+$/, '')}/v2/groups/${encodeURIComponent(group.groupOpenId)}/messages`, {
          method: 'POST', signal: AbortSignal.timeout(Math.ceil(remaining)),
          headers: {'Authorization': `QQBot ${token}`, 'Content-Type': 'application/json'},
          body: JSON.stringify({msg_type: 0, content: text})
        });
        const result = await response.json();
        if (!response.ok || result.code !== undefined && Number(result.code) !== 0) {
          throw {bizCode: result.code ?? result.err_code, httpStatus: response.status};
        }
      } else {
        await this.bot.sendText({scope: 'group', targetId: group.groupOpenId}, text);
      }
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

  canNotifyWinStreak() {
    return this.ready && [...this.groups.values()].some(group => group.groupOpenId !== 'temp' &&
      group.winStreakAlerts === true && group.proactiveEnabled === true && !this.denied.has(group.groupOpenId));
  }

  async notifyWinStreak(row, deadline) {
    for (const group of this.groups.values()) if (group.winStreakAlerts === true && this.now() < deadline) {
      await this.proactive(group, 'win_streak', formatWinStreak(row), {deadline});
    }
  }
}
