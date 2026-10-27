import {formatMonthly} from '../../bot-core/src/i18n.mjs';
import {formatReportQuery, localizedUsageModel} from '../../bot-core/src/monthly-report-text.mjs';
import {reportImages} from '../../bot-core/src/monthly-report.mjs';
import {responseParts} from './messages.mjs';

export async function prepareScheduled(adapter, kind, target, period) {
  let response, batch;
  if (kind === 'daily') {
    const month = period.replaceAll('-', '').slice(0, 6);
    const ranking = await adapter.service.api.getMonthlyTop10(month);
    response = {messages: [`${period}\n${formatMonthly(ranking, month, target.languages)}`]};
  } else {
    const report = await adapter.service.monthlyReports.get(period, target.languages);
    if (!report.files.length) return null;
    batch = report.batch;
    response = {messages: target.languages.map(lang => formatReportQuery(localizedUsageModel(report.model, lang), lang)), files: reportImages(report)};
  }
  const parts = responseParts(response).map(part => ({type: part.type, content: part.content, ...(part.file ? {name: part.file.name} : {})}));
  return {kind, period, languages: [...target.languages], batch: batch || null, parts, total: parts.length};
}
export async function prepareScheduledPart(adapter, target, snapshot, index) {
  const part = snapshot.parts[index];
  if (!part || !['text', 'image'].includes(part.type)) throw new Error('Invalid QQ delivery part');
  const body = {msg_type: part.type === 'image' ? 7 : 0, content: part.content};
  if (part.type === 'image') {
    const report = await adapter.service.monthlyReports.readBatch(snapshot.period, snapshot.batch);
    const file = reportImages(report).find(file => file.name === part.name);
    if (!file) throw new Error('Missing QQ report image');
    const media = await adapter.bot.uploadMedia({target: {scope: 'group', targetId: target.groupOpenId}, fileType: 1, buffer: file.data, srvSendMsg: false});
    if (typeof media.file_info !== 'string' || !media.file_info) throw new Error('Missing QQ media reference');
    body.media = {file_info: media.file_info};
  }
  const token = await adapter.bot.api.getToken();
  if (!adapter.canNotifyScheduled(target)) throw Object.assign(new Error('QQ group is unavailable'), {code: 'QQ_NOT_READY'});
  return {body, token};
}
