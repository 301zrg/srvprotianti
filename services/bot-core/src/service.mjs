import {chartPng} from './chart.mjs';
import {shanghaiDay} from './api.mjs';
import {isSingleWaitingTt} from './monitor.mjs';
import {formatHelp, formatMonthly, formatPlay, formatPlayer, formatRooms, formatStatus, formatWaiting, message} from './i18n.mjs';
import {CARD_METRICS, formatMonthlyReport, formatReportQuery, languageKey, localizedUsageModel, reportLabel} from './monthly-report-text.mjs';
import {reportImages} from './monthly-report.mjs';

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

export function roomStatus(rooms, checkedAt = Date.now()) {
  return {
    rooms: rooms.length,
    playing: rooms.filter(room => room.istart !== 'wait').length,
    players: rooms.reduce((count, room) => count + (Array.isArray(room.users) ? room.users.length : 0), 0),
    waiting: rooms.filter(isSingleWaitingTt).length,
    checkedAt
  };
}

export class CommunityService {
  constructor({api, adapter = null, logger, guide, monitor = null, monthlyReports = null}) {
    Object.assign(this, {api, adapter, logger, guide, monitor, monthlyReports});
  }

  async notifyWaiting() {
    if (this.adapter) await this.adapter.notifyWaiting(formatWaiting);
  }

  async notifyMonthly() {
    const month = shanghaiDay().month;
    const ranking = await this.api.getMonthlyTop10(month);
    await this.logger.write('monthly_rank_fetched', {month, rankingBasis: ranking.rankingBasis || 'unknown'});
    if (this.adapter) await this.adapter.notifyMonthly(languages => formatMonthly(ranking, month, languages));
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
      const image = await chartPng(profile.chart, languages);
      return {messages: [formatPlayer(profile, languages), ...(!image ? [message('noChart', languages)] : [])], image};
    } catch (error) {
      await this.logger.write('player_query_failed', {status: error.status || null, code: error.code || 'unknown'});
      return {messages: [message('unavailable', languages)]};
    }
  }

  async top(languages) {
    const month = shanghaiDay().month;
    try {
      const ranking = await this.api.getMonthlyTop10(month);
      await this.logger.write('monthly_rank_fetched', {month, rankingBasis: ranking.rankingBasis || 'unknown', source: 'command'});
      return {messages: [formatMonthly(ranking, month, languages)]};
    } catch (error) {
      await this.logger.write('top_query_failed', {status: error.status || null, code: error.code || 'unknown'});
      return {messages: [message('unavailable', languages)]};
    }
  }

  async meta({month, view = 'report', language = 'en-us'}) {
    try {
      if (!this.monthlyReports || !['report', 'decks', 'export', 'preview', ...CARD_METRICS].includes(view)) throw new Error('Unavailable report');
      if (CARD_METRICS.includes(view)) {
        const model = await this.monthlyReports.cardQuery(month, view, languageKey(language));
        if (!model.cards[view].length) return {messages: [`${reportLabel('empty', language)}\n${model.usageUrl}`]};
        const file = await this.monthlyReports.renderQueue.run(async () => (await import('./monthly-report-render.mjs')).renderCardQuery(model, view, language));
        return {messages: [formatReportQuery(model, language, view)], files: [file]};
      }
      const report = view === 'export' ? await this.monthlyReports.export(month) : await this.monthlyReports.get(month);
      if (!report.files.length) return {messages: [`${reportLabel('empty', language)}\n${report.model.usageUrl}`]};
      if (view === 'export') return {messages: [`${report.model.month} · ${reportLabel(report.published ? 'published' : 'query', language)}\n${reportLabel('snapshot', language)}: ${report.model.generatedAt}\n${report.model.usageUrl}`], files: [report.archive], fallbackFiles: report.files};
      return {messages: [view === 'preview' ? formatMonthlyReport(report.model) : formatReportQuery(report.model, language, view)],
        files: view === 'decks' ? reportImages(report).slice(0, 1) : reportImages(report).map((file, i) => view === 'preview' && i === 0 ? {...file, description: `${file.description} Edition ${report.batch}.`} : file)};
    } catch (error) {
      await this.logger.write('monthly_report_query_failed', {code: error.code || 'unknown', view});
      return {messages: [reportLabel(error.code === 'invalid' ? 'invalid' : 'unavailable', language)]};
    }
  }

  async metaForLanguages({month, view = 'report', languages}) {
    try {
      if (!this.monthlyReports || !['report', 'decks', ...CARD_METRICS].includes(view)) throw new Error('Unavailable report');
      const single = CARD_METRICS.includes(view);
      const report = single ? null : await this.monthlyReports.get(month, languages);
      const model = single ? await this.monthlyReports.cardQuery(month, view, languages) : report.model;
      if (single ? !model.cards[view].length : !report.files.length) return {messages: languages.map(lang => reportLabel('empty', lang) + '\n' + localizedUsageModel(model, lang).usageUrl)};
      const files = single ? [await this.monthlyReports.renderQueue.run(async () => {
        const {localizedCardsFigure} = await import('./localized-report-render.mjs');
        return {name: `cards-${view}-${model.month}.png`, data: await localizedCardsFigure(model, [view], languages).png()};
      })] : view === 'decks' ? reportImages(report).slice(0, 1) : reportImages(report);
      return {messages: languages.map(language => formatReportQuery(localizedUsageModel(model, language), language, view)), files};
    } catch (error) {
      await this.logger.write('monthly_report_query_failed', {code: error.code || 'unknown', view, platform: 'qq'});
      return {messages: [languages.map(lang => reportLabel(error.code === 'invalid' ? 'invalid' : 'unavailable', lang)).join('\n')]};
    }
  }

  async getStatus({cached = false} = {}) {
    if (cached) {
      const snapshot = this.monitor?.getSnapshot();
      if (!snapshot?.available) return {available: false, checkedAt: snapshot?.checkedAt || null};
      return {available: true, ...roomStatus(snapshot.rooms, snapshot.checkedAt)};
    }
    try {
      return {available: true, ...roomStatus(await this.api.getRooms())};
    } catch (error) {
      await this.logger.write('status_query_failed', {status: error.status || null, code: error.code || 'unknown'});
      return {available: false, checkedAt: this.monitor?.getSnapshot()?.checkedAt || null};
    }
  }

  async status(languages) {
    return {messages: [formatStatus(await this.getStatus({cached: true}), languages)]};
  }

  play(languages) {
    return {messages: [formatPlay(this.guide, languages)]};
  }

  help(languages, platform) {
    return {messages: [formatHelp(languages, platform)]};
  }
}
