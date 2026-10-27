import {splitLines} from '../../bot-core/src/service.mjs';
import {platformErrorCode} from '../../bot-core/src/logger.mjs';

export function responseParts(response) {
  const text = (response.messages || []).join('\n\n');
  const chunks = splitLines(text, 1600);
  const files = response.files || (response.image ? [{name: 'rating.png', data: response.image}] : []);
  // A four-image passive report must fit QQ's five-reply budget. Put its
  // introduction on the first image instead of spending a separate reply.
  const parts = files.length ? [{type: 'image', file: files[0], content: chunks.shift() || ' '},
    ...chunks.map(content => ({type: 'text', content})), ...files.slice(1).map(file => ({type: 'image', file, content: ' '}))] :
    chunks.map(content => ({type: 'text', content}));
  return parts;
}
export async function sendResponse(bot, target, response) {
  const parts = responseParts(response);
  if (parts.length > 5) throw Object.assign(new Error('QQ reply budget exceeded'), {code: 'attachment_limit'});
  for (const [index, part] of parts.entries()) {
    try {
      if (part.type === 'image') await bot.sendImage(target, {buffer: part.file.data}, {content: part.content});
      else await bot.sendText(target, part.content);
    } catch (error) { throw Object.assign(new Error('QQ reply failed'), {code: platformErrorCode(error), replyAttempts: index + 1}); }
  }
}
export async function postScheduled(adapter, target, prepared) {
  let response, result;
  try {
    response = await adapter.fetch(`${adapter.config.apiBaseUrl.replace(/\/+$/, '')}/v2/groups/${encodeURIComponent(target.groupOpenId)}/messages`, {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: {'Authorization': `QQBot ${prepared.token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(prepared.body)
    });
    result = await response.json();
  } catch (error) { throw Object.assign(new Error('QQ send result is uncertain'), {code: platformErrorCode(error), deliveryUncertain: true}); }
  const rejected = result?.code ?? result?.err_code;
  if (!response.ok || rejected !== undefined && Number(rejected) !== 0) {
    const code = String(rejected ?? response.status);
    if (['40034102', '40034105'].includes(code)) adapter.denied.add(target.groupOpenId);
    // A gateway 5xx without a platform rejection cannot prove non-delivery.
    throw Object.assign(new Error('QQ scheduled send failed'), {code, deliveryUncertain: response.status >= 500 && rejected === undefined});
  }
  if (typeof result?.id !== 'string' || !result.id) throw Object.assign(new Error('QQ send acknowledgement is missing'), {deliveryUncertain: true});
  return result.id;
}
