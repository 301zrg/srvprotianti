'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');

const approved = {guildId: '1504410444876484658', channelId: '1554786350845141002', botRoot: 'C:/srvpro-runtime/discord-bot'};
const legacyGeneralId = '1504410446130839603';
const text = Object.freeze({
  start: '【维护开始】服务器即将短暂停服，更新卡组分类模板并重新分类历史对局。暂时停止接受新入房，恢复后会在本频道通知。\n\n[Maintenance started] The server will briefly go offline to update deck classification templates and reclassify historical matches. New room joins are temporarily disabled. We will announce service restoration in this channel.\n\n【メンテナンス開始】デッキ分類テンプレートの更新と過去の対戦データの再分類のため、サーバーを一時停止します。新規入室を一時停止しています。再開後、このチャンネルでお知らせします。\n\n[점검 시작] 덱 분류 템플릿 업데이트와 과거 대전 기록 재분류를 위해 서버가 잠시 중단됩니다. 새 방 입장은 일시 중지되며, 서비스가 재개되면 이 채널에서 안내하겠습니다.',
  success: '【维护结束】服务器已恢复开放。卡组模板更新与历史重分类处理已完成，感谢等待。\n\n[Maintenance completed] The server is open again. Deck template updates and historical match reclassification are complete. Thank you for your patience.\n\n【メンテナンス終了】サーバーへの参加を再開しました。デッキテンプレートの更新と過去の対戦データの再分類処理が完了しました。お待ちいただきありがとうございました。\n\n[점검 완료] 서버 이용이 재개되었습니다. 덱 템플릿 업데이트와 과거 대전 기록 재분류 작업이 완료되었습니다. 기다려 주셔서 감사합니다.',
  rollback: '【维护结束】服务器已恢复开放。本次更新未完成，已恢复原有卡组模板与历史对局分类。\n\n【メンテナンス終了】サーバーへの参加を再開しました。今回の更新は完了せず、以前のデッキテンプレートと対戦履歴の分類に復元しました。\n\n[Maintenance completed] The server is open again. The update was not completed; the previous templates and classifications of historical matches have been restored.\n\n[점검 완료] 서버 이용이 재개되었습니다. 이번 업데이트를 완료하지 못해 이전 덱 템플릿과 과거 대전 기록 분류를 복구했습니다.',
  cancel: '【维护结束】服务器已恢复开放。\n\n【メンテナンス終了】サーバーへの参加を再開しました。\n\n[Maintenance completed] The server is open again.\n\n[점검 완료] 서버 이용이 재개되었습니다.'
});
const serverUpdateText = Object.freeze({
  start: '【维护开始】服务器即将短暂停服进行更新，暂时停止接受新入房。恢复后会在本频道通知。\n\n[Maintenance started] The server will briefly go offline for an update. New room joins are temporarily disabled. We will announce service restoration in this channel.\n\n【メンテナンス開始】サーバー更新のため一時的にサービスを停止します。新規入室を一時停止しています。再開後、このチャンネルでお知らせします。\n\n[점검 시작] 서버 업데이트를 위해 서비스가 잠시 중단되며 새 방 입장이 일시 중지됩니다. 서비스가 재개되면 이 채널에서 안내하겠습니다.',
  success: '【维护结束】服务器更新已完成，现已恢复开放。感谢等待。\n\n[Maintenance completed] The server update has completed successfully and the server is open again. Thank you for your patience.\n\n【メンテナンス終了】サーバーの更新が完了し、参加を再開しました。お待ちいただきありがとうございました。\n\n[점검 완료] 서버 업데이트가 완료되어 이용이 재개되었습니다. 기다려 주셔서 감사합니다.',
  rollback: '【维护结束】本次更新未完成，已恢复更新前版本并重新开放服务器。\n\n[Maintenance completed] The update could not be completed. The previous version has been restored and the server is open again.\n\n【メンテナンス終了】今回の更新は完了しなかったため、更新前のバージョンに復元して参加を再開しました。\n\n[점검 완료] 이번 업데이트를 완료하지 못해 이전 버전으로 복구했으며 서버 이용이 재개되었습니다.',
  cancel: text.cancel
});
class NotificationError extends Error {}
const check = (value, code) => { if (!value) throw new NotificationError(code); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' && /^[0-9]{17,20}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function validateNotifications(settings) {
  if (settings == null) return null;
  check(object(settings) && Object.keys(settings).length === 4 &&
    ['deck-templates', 'server-update'].includes(settings.kind) &&
    settings.guildId === approved.guildId && settings.botRoot === approved.botRoot &&
    (settings.channelId === approved.channelId || settings.kind === 'deck-templates' && settings.channelId === legacyGeneralId), 'notifications_config_invalid');
  return {...settings};
}

function releaseContent(notes) {
  return `【更新说明】\n${notes.zh}\n\n【更新内容】\n${notes.ja}\n\n[Update notes]\n${notes.en}\n\n[업데이트 안내]\n${notes.ko}`;
}

function validateReleaseNotes(notes) {
  if (notes == null) return null;
  check(object(notes) && Object.keys(notes).length === 4 && ['zh', 'ja', 'en', 'ko'].every(language =>
    Object.hasOwn(notes, language) && typeof notes[language] === 'string' && notes[language].trim().length > 0 &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|<@|@(?:everyone|here)\b/i.test(notes[language])) &&
    releaseContent(notes).length <= 2000, 'release_notes_invalid');
  return {...notes};
}

function loadPackages(root) {
  const req = createRequire(path.join(root, 'package.json'));
  const {REST, Routes} = req('discord.js'), {ProxyAgent} = req('undici');
  return {REST, Routes, ProxyAgent};
}

function permissions(guild, roles, member, channel, botId) {
  check(Array.isArray(roles) && Array.isArray(member.roles) && member.roles.every(id) && Array.isArray(channel.permission_overwrites), 'notification_permissions_invalid');
  const bits = value => { check(typeof value === 'string' && /^[0-9]{1,30}$/.test(value), 'notification_permissions_invalid'); return BigInt(value); };
  const everyone = roles.find(role => role.id === guild.id);
  check(everyone, 'notification_permissions_invalid');
  let value = bits(everyone.permissions);
  for (const roleId of member.roles) { const role = roles.find(item => item.id === roleId); check(role, 'notification_permissions_invalid'); value |= bits(role.permissions); }
  if (guild.owner_id === botId || (value & 8n)) return;
  const overwrites = channel.permission_overwrites;
  const apply = overwrite => { value = (value & ~bits(overwrite.deny)) | bits(overwrite.allow); };
  for (const overwrite of overwrites.filter(item => item.id === guild.id && item.type === 0)) apply(overwrite);
  let allow = 0n, deny = 0n;
  for (const overwrite of overwrites.filter(item => item.type === 0 && member.roles.includes(item.id))) { allow |= bits(overwrite.allow); deny |= bits(overwrite.deny); }
  value = (value & ~deny) | allow;
  for (const overwrite of overwrites.filter(item => item.type === 1 && item.id === botId)) apply(overwrite);
  check((value & 68608n) === 68608n, 'notification_permissions_missing'); // ViewChannel, SendMessages, ReadMessageHistory.
}

function createDiscordNotifications(options) {
  const settings = validateNotifications(options.manifest.notifications);
  return createDelivery(options, settings, settings?.kind === 'server-update' ? serverUpdateText : text, 'discord-notifications.json');
}

function createReleaseAnnouncement(options) {
  const notes = validateReleaseNotes(options.manifest.releaseNotes);
  return createDelivery(options, notes ? {kind: 'server-update', ...approved} : null,
    notes ? {release: releaseContent(notes)} : {}, 'release-announcement.json');
}

function createDelivery(options, settings, messages, receiptName) {
  const {manifest, batch} = options;
  if (!settings) return {preflight: async () => ({status: 'DISABLED', enabled: false}), notify: async () => null, close: async () => {}};
  const channelName = settings.channelId === approved.channelId ? 'announcements' : 'general';
  check(/^[a-z0-9][a-z0-9-]{0,79}$/.test(manifest.id), 'notification_batch_invalid');
  const now = options.now || Date.now, timeoutMs = options.timeoutMs || 12000;
  check(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 12000, 'notification_timeout_invalid');
  const filename = path.join(batch, receiptName), settingsSha256 = hash(JSON.stringify(settings));
  let rest, Routes, agent, botId, ready = false, busy = false;
  const nonce = phase => hash(manifest.id + ':' + phase).slice(0, 24);
  const blankReceipt = () => ({schemaVersion: 1, batchId: manifest.id, settingsSha256, botId, phases: {}});
  function readReceipt() {
    if (!fs.existsSync(filename)) return blankReceipt();
    try {
      check(!fs.lstatSync(filename).isSymbolicLink() && fs.statSync(filename).size <= 32768, 'notification_receipt_invalid');
      const value = JSON.parse(fs.readFileSync(filename, 'utf8')), {receiptSha256, ...body} = value;
      check(receiptSha256 === hash(JSON.stringify(body)) && body.schemaVersion === 1 && body.batchId === manifest.id &&
        body.settingsSha256 === settingsSha256 && id(body.botId) && object(body.phases), 'notification_receipt_invalid');
      for (const [phase, entry] of Object.entries(body.phases)) {
        check(Object.hasOwn(messages, phase) && object(entry) && entry.contentSha256 === hash(messages[phase]) && entry.nonce === nonce(phase) &&
          ['attempted', 'uncertain', 'confirmed'].includes(entry.status) && Number.isSafeInteger(entry.attemptedAt) && entry.attemptedAt > 0 &&
          Number.isSafeInteger(entry.lastAttemptAt) && entry.lastAttemptAt >= entry.attemptedAt &&
          Number.isInteger(entry.attempts) && entry.attempts >= 1 && entry.attempts <= 2 &&
          (entry.messageId == null || id(entry.messageId)) && (entry.status !== 'confirmed' || id(entry.messageId)), 'notification_receipt_invalid');
      }
      return body;
    } catch { throw new NotificationError('notification_receipt_invalid'); }
  }
  function writeReceipt(receipt) {
    const temporary = filename + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx');
      fs.writeFileSync(fd, JSON.stringify({...receipt, receiptSha256: hash(JSON.stringify(receipt))}, null, 2));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, filename);
    } catch { throw new NotificationError('notification_receipt_write_failed'); }
    finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  async function bounded(operation, duration = timeoutMs) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => { ready = false; Promise.resolve().then(() => agent?.destroy()).catch(() => {}); reject(new NotificationError('notification_request_timeout')); }, duration);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function request(method, route, init) {
    try { return await bounded(() => rest[method](route, init)); }
    catch { throw new NotificationError('notification_request_failed'); }
  }
  async function close() {
    ready = false;
    const current = agent; agent = null; rest = null;
    if (current) {
      try { await bounded(() => current.close(), Math.min(timeoutMs, 4000)); }
      catch { Promise.resolve().then(() => current.destroy()).catch(() => {}); }
    }
  }
  async function preflight(apps) {
    try {
      check(!ready && !agent && !rest, 'notification_already_initialized');
      const previous = readReceipt();
      const bots = Array.isArray(apps) ? apps.filter(app => app.name === 'discord-bot') : [];
      check(bots.length === 1 && bots[0].pid > 0 && bots[0].pm2_env?.status === 'online', 'notification_bot_offline');
      const env = bots[0].pm2_env, root = path.resolve(settings.botRoot), script = path.resolve(env.pm_exec_path || '');
      check(script.toLowerCase().startsWith(root.toLowerCase() + path.sep), 'notification_bot_moved');
      // Follow the bot's own route: its loopback proxy when it has one, otherwise direct.
      let proxy = null;
      if (env.DISCORD_PROXY_URL) {
        try { proxy = new URL(env.DISCORD_PROXY_URL); } catch { throw new NotificationError('notification_proxy_invalid'); }
        check(['http:', 'https:'].includes(proxy.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(proxy.hostname), 'notification_proxy_invalid');
      }
      // Token and the existing proxy stay in this closure; receipts contain only public identity and status.
      const config = (options.readConfig || (file => JSON.parse(fs.readFileSync(file, 'utf8'))))(path.join(settings.botRoot, 'config.json'));
      check(typeof config?.discord?.botToken === 'string' && config.discord.botToken.length > 0, 'notification_token_missing');
      const packages = (options.loadPackages || loadPackages)(settings.botRoot); Routes = packages.Routes;
      agent = proxy ? new packages.ProxyAgent(proxy.href) : null;
      rest = new packages.REST({version: '10', ...(agent ? {agent} : {}), timeout: Math.min(timeoutMs, 7000), retries: 0}).setToken(config.discord.botToken);
      const me = await request('get', Routes.user('@me'));
      check(id(me?.id) && me.bot === true && (!previous.botId || previous.botId === me.id), 'notification_bot_identity_invalid'); botId = me.id;
      const guild = await request('get', Routes.guild(settings.guildId));
      check(guild?.id === settings.guildId, 'notification_guild_changed');
      const channels = await request('get', Routes.guildChannels(settings.guildId));
      const target = Array.isArray(channels) ? channels.filter(channel => channel.name === channelName && channel.type === 0) : [];
      check(target.length === 1 && target[0].id === settings.channelId && target[0].guild_id === settings.guildId, 'notification_channel_changed');
      const member = await request('get', Routes.guildMember(settings.guildId, botId));
      check(member?.user?.id === botId && member.user.bot === true, 'notification_bot_identity_invalid');
      const roles = await request('get', Routes.guildRoles(settings.guildId));
      permissions(guild, roles, member, target[0], botId);
      check(Array.isArray(await request('get', Routes.channelMessages(settings.channelId), {query: new URLSearchParams({limit: '1'})})), 'notification_history_invalid');
      ready = true;
      return {enabled: true, status: 'READY', botId, guildId: settings.guildId, channelId: settings.channelId};
    } catch (error) {
      await close();
      if (error instanceof NotificationError && error.message !== 'notification_request_failed') throw error;
      throw new NotificationError('notification_preflight_failed');
    }
  }
  function matches(message, phase, entry) {
    return id(message?.id) && message.channel_id === settings.channelId && message.author?.id === botId && message.author.bot === true &&
      message.content === messages[phase] && !message.mention_everyone && Array.isArray(message.mentions) && !message.mentions.length &&
      Array.isArray(message.mention_roles) && !message.mention_roles.length && (message.nonce == null || String(message.nonce) === entry.nonce);
  }
  async function readback(messageId, phase, entry) {
    let message;
    try { message = await request('get', Routes.channelMessage(settings.channelId, messageId)); }
    catch { throw new NotificationError('notification_readback_failed'); }
    check(message?.id === messageId && matches(message, phase, entry), 'notification_readback_invalid');
    return message.id;
  }
  async function reconcile(phase, entry) {
    let before;
    // A bounded full history window is required to prove absence; a recent page alone cannot do that.
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({limit: '100'}); if (before) query.set('before', before);
      const messages = await request('get', Routes.channelMessages(settings.channelId), {query});
      check(Array.isArray(messages) && messages.length <= 100, 'notification_history_invalid');
      const found = messages.filter(message => matches(message, phase, entry) &&
        (String(message.nonce) === entry.nonce || Date.parse(message.timestamp) >= entry.attemptedAt && Date.parse(message.timestamp) <= entry.lastAttemptAt + timeoutMs + 5000));
      check(found.length <= 1, 'notification_history_ambiguous');
      if (found.length) return {messageId: await readback(found[0].id, phase, entry), complete: true};
      if (!messages.length) return {complete: true};
      check(messages.every(message => id(message.id) && Number.isFinite(Date.parse(message.timestamp))), 'notification_history_invalid');
      if (messages.length < 100 || messages.some(message => Date.parse(message.timestamp) < entry.attemptedAt)) return {complete: true};
      const oldest = messages[messages.length - 1].id;
      check(!before || BigInt(oldest) < BigInt(before), 'notification_history_invalid'); before = oldest;
    }
    return {complete: false};
  }
  async function notify(phase) {
    check(Object.hasOwn(messages, phase), 'notification_phase_invalid');
    check(ready && !busy, 'notification_not_ready'); busy = true;
    try {
      const receipt = readReceipt(); check(!receipt.botId || receipt.botId === botId, 'notification_receipt_invalid'); receipt.botId = botId;
      let entry = receipt.phases[phase];
      if (entry?.status === 'confirmed') return await readback(entry.messageId, phase, entry);
      if (entry) {
        if (entry.messageId) {
          await readback(entry.messageId, phase, entry); entry.status = 'confirmed'; writeReceipt(receipt); return entry.messageId;
        }
        let result;
        try { result = await reconcile(phase, entry); } catch { throw new NotificationError('notification_delivery_uncertain'); }
        if (result.messageId) { entry.status = 'confirmed'; entry.messageId = result.messageId; writeReceipt(receipt); return result.messageId; }
        // Same-nonce retries are limited to a short window after a complete, readable history scan.
        check(result.complete && entry.attempts < 2 && now() >= entry.lastAttemptAt && now() - entry.attemptedAt <= 120000, 'notification_delivery_uncertain');
        entry.attempts++; entry.lastAttemptAt = now(); entry.status = 'attempted';
      } else {
        entry = receipt.phases[phase] = {status: 'attempted', contentSha256: hash(messages[phase]), nonce: nonce(phase), attemptedAt: now(), lastAttemptAt: now(), attempts: 1};
      }
      // Persist and fsync before POST: losing the reply must never look like an unattempted phase.
      writeReceipt(receipt);
      try {
        const message = await request('post', Routes.channelMessages(settings.channelId), {body: {content: messages[phase], allowed_mentions: {parse: []}, nonce: entry.nonce, enforce_nonce: true}});
        check(matches(message, phase, entry), 'notification_readback_invalid');
        entry.messageId = message.id; writeReceipt(receipt);
        entry.messageId = await readback(message.id, phase, entry); entry.status = 'confirmed'; writeReceipt(receipt); return entry.messageId;
      } catch {
        entry.status = 'uncertain'; writeReceipt(receipt);
        try {
          const result = await reconcile(phase, entry);
          if (result.messageId) { entry.status = 'confirmed'; entry.messageId = result.messageId; writeReceipt(receipt); return result.messageId; }
        } catch {}
        throw new NotificationError('notification_delivery_uncertain');
      }
    } finally { busy = false; }
  }
  return {preflight, notify, close};
}

module.exports = {validateNotifications, createDiscordNotifications, validateReleaseNotes, createReleaseAnnouncement};
