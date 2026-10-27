import {chartPng} from './chart.mjs';
import {shanghaiDay} from './api.mjs';
import {formatMonthly, formatPlayer, formatRooms, formatWaiting, message} from './i18n.mjs';

export function splitLines(value, limit) {
  const chunks = [], lines = String(value).split('\n');
  let current = '';
  for (const line of lines) {
    if (line.length > limit) throw new Error('One output line exceeds the platform message limit');
    if (current && current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

export class CommunityService {
  constructor({api, qq, discord, logger}) {
    Object.assign(this, {api, qq, discord, logger});
  }

  async notifyWaiting() {
    const deliveries = [];
    if (this.qq) deliveries.push(this.qq.notifyWaiting(formatWaiting));
    if (this.discord) deliveries.push(this.discord.notifyWaiting(formatWaiting));
    await Promise.allSettled(deliveries);
  }

  async notifyMonthly() {
    const month = shanghaiDay().month;
    const ranking = await this.api.getMonthlyTop10(month);
    await this.logger.write('monthly_rank_fetched', {month, rankingBasis: ranking.rankingBasis || 'unknown'});
    const deliveries = [];
    if (this.qq) deliveries.push(this.qq.notifyMonthly(languages => formatMonthly(ranking, month, languages)));
    if (this.discord) deliveries.push(this.discord.notifyMonthly(languages => formatMonthly(ranking, month, languages)));
    await Promise.allSettled(deliveries);
  }

  async rooms(languages) {
    try { return {messages: [formatRooms(await this.api.getRooms(), languages)]}; }
    catch (error) {
      await this.logger.write('room_query_failed', {status: error.status || null, code: error.code || 'unknown'});
      return {messages: [message('unavailable', languages)]};
    }
  }

  async player(id, languages) {
    const normalized = String(id || '').trim();
    if (!normalized || normalized.length > 64 || normalized.includes('$') || /[\r\n]/.test(normalized)) {
      return {messages: [message('noPlayer', languages)]};
    }
    try {
      const profile = await this.api.getPublicPlayer(normalized, shanghaiDay().month);
      if (!profile.found) return {messages: [message('noPlayer', languages)]};
      const image = await chartPng(profile.chart);
      return {messages: [formatPlayer(profile, languages), ...(!image ? [message('noChart', languages)] : [])], image};
    } catch (error) {
      await this.logger.write('player_query_failed', {status: error.status || null, code: error.code || 'unknown'});
      return {messages: [message('unavailable', languages)]};
    }
  }
}
