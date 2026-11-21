import {ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, MessageFlags, PermissionsBitField, REST, Routes, SlashCommandBuilder} from 'discord.js';
import {createHash, randomUUID} from 'node:crypto';
import {platformErrorCode} from '../../bot-core/src/logger.mjs';
import {splitLines} from '../../bot-core/src/service.mjs';
import {StatusCard} from './status-card.mjs';
import {formatMonthly, formatWinStreak} from '../../bot-core/src/i18n.mjs';
import {shanghaiDay} from '../../bot-core/src/api.mjs';
import {displayMonth, formatMonthlyReport, reportLabel} from '../../bot-core/src/monthly-report-text.mjs';
import {normalizeReportMonth, ReportError, reportImages} from '../../bot-core/src/monthly-report.mjs';

const metaViews = [
  {name: 'Monthly report', value: 'report'}, {name: 'Decks & matchups', value: 'decks'},
  {name: 'Main Deck monsters', value: 'monster'}, {name: 'Main Deck spells', value: 'spell'}, {name: 'Main Deck traps', value: 'trap'},
  {name: 'Extra Deck', value: 'extra'}, {name: 'Side Deck', value: 'side'},
  {name: 'Download X assets (administrator, private)', value: 'export'},
  {name: 'Preview four-language announcement (administrator)', value: 'preview'}
];
const adminViews = new Set(['export', 'preview']);
const canManageReports = interaction => Boolean(interaction.guildId &&
  (interaction.user?.id && interaction.guild?.ownerId === interaction.user.id ||
    interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)));

export const commandBodies = [
  new SlashCommandBuilder().setName('rooms').setDescription('List all joinable room names'),
  new SlashCommandBuilder().setName('player').setDescription('Show public player statistics')
    .addStringOption(option => option.setName('id').setDescription('Exact player ID').setRequired(true)),
  new SlashCommandBuilder().setName('status').setDescription('Show current room activity'),
  new SlashCommandBuilder().setName('play').setDescription('Show client downloads, desktop assistant and connection steps')
    .addStringOption(option => option.setName('language').setDescription('Guide language')
      .addChoices({name: 'English', value: 'en-us'}, {name: '日本語', value: 'ja-jp'},
        {name: '한국어', value: 'ko-kr'}, {name: '中文', value: 'zh-cn'})),
  new SlashCommandBuilder().setName('help').setDescription('List bot commands'),
  new SlashCommandBuilder().setName('top').setDescription('Show this month’s top 10 players'),
  new SlashCommandBuilder().setName('meta').setDescription('Monthly deck usage, Match win rates and card usage')
    .addStringOption(option => option.setName('month').setDescription('YYYY-MM or YYYYMM; default: last month').setMaxLength(7))
    .addStringOption(option => option.setName('view').setDescription('Data to show; default: four-image report').setAutocomplete(true))
    .addStringOption(option => option.setName('language').setDescription('Query language').addChoices(
      {name: 'English', value: 'en-us'}, {name: '日本語', value: 'ja-jp'}, {name: '한국어', value: 'ko-kr'}, {name: '中文', value: 'zh-cn'})),
  new SlashCommandBuilder().setName('resend').setDescription('管理员补发：本月天梯前10／上月四图月报')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
].map(command => command.toJSON());

const localeLanguage = locale => ({'zh-CN': 'zh-cn', 'zh-TW': 'zh-cn', ja: 'ja-jp', ko: 'ko-kr'}[locale] || 'en-us');

export class DiscordAdapter {
  constructor(config, service, logger, {root, statusCard, transport} = {}) {
    this.config = config;
    this.service = service;
    this.logger = logger;
    this.channels = new Map(config.guilds.flatMap(guild => guild.channels.map(channel => [channel.channelId, {...channel, guildId: guild.guildId}])));
    this.restOptions = transport?.restOptions || {};
    this.client = new Client({intents: [GatewayIntentBits.Guilds], rest: this.restOptions});
    this.statusCard = statusCard?.enabled ? new StatusCard({client: this.client, service, logger, root, config: statusCard}) : null;
    this.ready = false;
    this.stopped = false;
    this.resendSessions = new Map();
    this.client.on(Events.ClientReady, () => {
      this.ready = true;
      void this.logger.write('discord_ready');
      this.statusCard?.start();
    });
    this.client.on(Events.InteractionCreate, interaction => { void this.onInteraction(interaction); });
    this.client.on(Events.Error, error => { void this.logger.write('discord_error', {code: platformErrorCode(error)}); });
    this.client.on(Events.ShardDisconnect, () => { this.ready = false; });
    this.client.on(Events.ShardResume, () => { this.ready = true; });
  }

  async start() {
    const rest = new REST({version: '10', ...this.restOptions}).setToken(this.config.botToken);
    for (const guild of this.config.guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(this.config.applicationId, guild.guildId), {body: commandBodies});
        await this.logger.write('discord_commands_registered', {guild: guild.guildId, commands: commandBodies.map(command => command.name)});
      } catch (error) {
        await this.logger.write('discord_command_registration_failed', {guild: guild.guildId, code: platformErrorCode(error)});
      }
    }
    const connect = async () => {
      if (this.stopped) return;
      try { await this.client.login(this.config.botToken); }
      catch (error) {
        this.ready = false;
        await this.logger.write('discord_start_failed', {code: platformErrorCode(error)});
        if (!this.stopped) this.loginTimer = setTimeout(connect, 30000);
      }
    };
    await connect();
  }

  stop() { this.stopped = true; this.ready = false; clearTimeout(this.loginTimer); this.statusCard?.stop(); this.client.destroy(); }

  async onMetaAutocomplete(interaction) {
    if (interaction.commandName !== 'meta') return;
    try {
      const channel = this.channels.get(interaction.channelId), focused = interaction.options.getFocused(true);
      if (!channel || channel.guildId !== interaction.guildId || !channel.commands || focused.name !== 'view') {
        await interaction.respond([]); return;
      }
      const administrator = canManageReports(interaction), search = String(focused.value || '').toLowerCase();
      // Static choices are identical for every member. Supply permission-filtered suggestions instead.
      const choices = metaViews.filter(choice => (administrator || !adminViews.has(choice.value)) &&
        (choice.name.toLowerCase().includes(search) || choice.value.includes(search)));
      await interaction.respond(choices);
    } catch (error) {
      await this.logger.write('discord_autocomplete_failed', {channel: interaction.channelId, code: platformErrorCode(error)});
    }
  }

  async onInteraction(interaction) {
    if (interaction.isButton?.()) return this.onResendButton(interaction);
    if (interaction.isAutocomplete?.()) return this.onMetaAutocomplete(interaction);
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'resend') return this.onResendPanel(interaction);
    const channel = this.channels.get(interaction.channelId);
    if (!channel || channel.guildId !== interaction.guildId || !channel.commands) {
      await interaction.reply({content: 'This command is not enabled in this channel.', flags: MessageFlags.Ephemeral}).catch(() => {});
      return;
    }
    if (!['rooms', 'player', 'status', 'play', 'help', 'top', 'meta'].includes(interaction.commandName)) return;
    const meta = interaction.commandName === 'meta', view = meta ? interaction.options.getString('view') || 'report' : null;
    const language = ['play', 'meta'].includes(interaction.commandName) && interaction.options.getString('language') || localeLanguage(interaction.locale);
    if (adminViews.has(view) && !canManageReports(interaction)) {
      await interaction.reply({content: reportLabel('denied', language), flags: MessageFlags.Ephemeral}).catch(() => {});
      return;
    }
    // Autocomplete permits arbitrary text. Validate submitted values independently of suggestions.
    if (meta && !metaViews.some(choice => choice.value === view)) {
      await interaction.reply({content: reportLabel('view', language), flags: MessageFlags.Ephemeral}).catch(() => {});
      return;
    }
    try {
      const privateReply = view === 'export';
      await interaction.deferReply(privateReply ? {flags: MessageFlags.Ephemeral} : undefined);
      const languages = [language];
      const response = interaction.commandName === 'rooms' ? await this.service.rooms(languages) :
        interaction.commandName === 'player' ? await this.service.player(interaction.options.getString('id', true), languages) :
        interaction.commandName === 'status' ? await this.service.status(languages) :
        interaction.commandName === 'play' ? this.service.play(languages) :
        interaction.commandName === 'top' ? await this.service.top(languages) :
        meta ? await this.service.meta({month: interaction.options.getString('month'), view, language}) : this.service.help(languages, 'discord');
      const chunks = response.messages.flatMap(value => splitLines(value, 1800));
      const first = chunks.shift() || '—';
      const limit = interaction.attachmentSizeLimit || 8 * 1024 * 1024;
      let files = response.files || (response.image ? [{name: 'rating.png', data: response.image}] : []);
      if (files.some(f => f.data.length > limit) && response.fallbackFiles) files = response.fallbackFiles;
      if (files.some(f => f.data.length > limit)) throw new ReportError('attachment_limit');
      const groups = [[]];
      for (const file of files) {
        const group = groups.at(-1);
        if (group.length >= 10 || group.reduce((n, f) => n + f.data.length, 0) + file.data.length > 24 * 1024 * 1024) groups.push([]);
        groups.at(-1).push(file);
      }
      const attach = group => group.map(f => new AttachmentBuilder(f.data, {name: f.name, description: f.description}));
      await interaction.editReply({content: first, files: attach(groups.shift()),
        allowedMentions: {parse: []}});
      for (const group of groups) await interaction.followUp({files: attach(group), allowedMentions: {parse: []}, ...(privateReply ? {flags: MessageFlags.Ephemeral} : {})});
      for (const content of chunks) await interaction.followUp({content, allowedMentions: {parse: []}, ...(privateReply ? {flags: MessageFlags.Ephemeral} : {})});
    } catch (error) {
      await this.logger.write('discord_reply_failed', {channel: channel.channelId, code: platformErrorCode(error)});
      if (interaction.deferred) await interaction.editReply({content: meta ? reportLabel(error.code === 'attachment_limit' ? 'attachment' : 'unavailable', language) : 'The query is temporarily unavailable.'}).catch(() => {});
    }
  }

  async onResendPanel(interaction) {
    const channel = this.channels.get(interaction.channelId);
    if (!canManageReports(interaction)) {
      await interaction.reply({content: '仅服务器所有者或管理员可以使用补发功能。', flags: MessageFlags.Ephemeral}).catch(() => {});
      return;
    }
    if (!channel || channel.guildId !== interaction.guildId || !(channel.monthlyTop10 || channel.monthlyReport || channel.adminResendTest)) {
      await interaction.reply({content: '请在 ladder-stats、monthly-meta 或已配置的管理员测试频道使用此命令。', flags: MessageFlags.Ephemeral}).catch(() => {});
      return;
    }
    const now = new Date(), date = shanghaiDay(now).date, month = normalizeReportMonth(null, now);
    const actions = channel.adminResendTest ? ['top', 'monthly'] :
      [...(channel.monthlyTop10 ? ['top'] : []), ...(channel.monthlyReport ? ['monthly'] : [])];
    const token = randomUUID();
    this.resendSessions ||= new Map();
    for (const [key, session] of this.resendSessions) if (session.expires <= Date.now()) this.resendSessions.delete(key);
    if (this.resendSessions.size >= 100) this.resendSessions.delete(this.resendSessions.keys().next().value);
    this.resendSessions.set(token, {userId: interaction.user.id, guildId: interaction.guildId, channelId: interaction.channelId,
      actions, date, month, test: Boolean(channel.adminResendTest), expires: Date.now() + 15 * 60000, busy: false});
    const row = new ActionRowBuilder().addComponents(actions.map(action => new ButtonBuilder()
      .setCustomId(`resend:${token}:${action}`).setStyle(ButtonStyle.Primary)
      .setLabel(action === 'top' ? '补发本月天梯前10' : `补发 ${displayMonth(month)} 月报`)));
    await interaction.reply({content: `${channel.adminResendTest ? '管理员频道测试：内容只会发到当前频道，不影响正式投递状态。' : '补发到当前正式频道；已存在的消息会直接返回，不重复发送。'}\n榜单日期：${date}；月报月份：${displayMonth(month)}。按钮有效期 15 分钟。`,
      components: [row], flags: MessageFlags.Ephemeral, allowedMentions: {parse: []}}).catch(() => {});
  }

  async onResendButton(interaction) {
    if (!interaction.customId?.startsWith('resend:')) return;
    const [, token, action, extra] = interaction.customId.split(':');
    const session = this.resendSessions?.get(token), channel = this.channels.get(interaction.channelId);
    const allowed = canManageReports(interaction) && session && !extra && session.userId === interaction.user.id &&
      session.guildId === interaction.guildId && session.channelId === interaction.channelId && session.expires > Date.now() &&
      session.date === shanghaiDay().date && session.month === normalizeReportMonth(null) && session.actions.includes(action) &&
      channel?.guildId === interaction.guildId && (session.test ? channel.adminResendTest : action === 'top' ? channel.monthlyTop10 : channel.monthlyReport);
    if (!allowed) {
      await interaction.reply({content: '无权限、频道不匹配或按钮已过期，请在对应频道重新运行 /resend。', flags: MessageFlags.Ephemeral}).catch(() => {});
      return;
    }
    if (session.busy) {
      await interaction.reply({content: '正在处理，请稍候。', flags: MessageFlags.Ephemeral}).catch(() => {});
      return;
    }
    session.busy = true;
    try {
      await interaction.deferReply({flags: MessageFlags.Ephemeral});
      let result;
      if (session.test) {
        if (action === 'top') {
          const month = shanghaiDay().month, ranking = await this.service.api.getMonthlyTop10(month);
          result = {status: 'sent', messageId: await this.sendDailyRanking(channel, ranking, month, session.date, {nonceKey: token})};
        } else {
          const report = await this.service.monthlyReports.export(session.month);
          if (!report.files.length) throw new ReportError('report_empty');
          result = {status: 'sent', messageId: await this.sendMonthlyReport(channel, report, {nonceKey: token})};
        }
      } else {
        result = action === 'top' ? await this.service.scheduler.resend(channel) : await this.service.reportScheduler.resend(channel);
      }
      await interaction.editReply({content: `${result.status === 'existing' ? '已有本期消息，无需重复发送。' : session.test ? '已发送到当前管理员测试频道。' : '已补发到当前正式频道。'}\nhttps://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${result.messageId}`,
        allowedMentions: {parse: []}});
    } catch (error) {
      await this.logger.write('discord_resend_failed', {channel: interaction.channelId, kind: action, test: session.test, code: platformErrorCode(error)});
      const text = error.code === 'delivery_busy' ? '自动投递正在处理，请稍后再试。' :
        error.code === 'report_empty' ? '上月暂无可发布数据，请稍后再试。' : session.test ? '测试发送失败，请稍后重新点击按钮。' : '补发暂未完成，任务会自动重试；可稍后重新点击按钮检查结果。';
      if (interaction.deferred) await interaction.editReply({content: text, allowedMentions: {parse: []}}).catch(() => {});
    } finally { session.busy = false; }
  }

  async proactive(channelConfig, kind, text, {deadline = Infinity, eventId} = {}) {
    if (!this.ready) {
      await this.logger.write('discord_proactive_skipped', {kind, channel: channelConfig.channelId, reason: 'connection_unavailable'});
      return;
    }
    try {
      const channel = await this.client.channels.fetch(channelConfig.channelId);
      if (!channel?.isTextBased() || typeof channel.send !== 'function') throw new Error('Channel is not text based');
      if (Date.now() >= deadline || !this.ready) return;
      if (Number.isFinite(deadline)) {
        const nonce = createHash('sha256').update(`${channelConfig.channelId}:${eventId}`).digest('hex').slice(0, 24);
        // Abort queued/retried REST requests at expiry too, so rate limiting
        // cannot turn a fresh streak into a late replay.
        await this.client.rest.post(Routes.channelMessages(channelConfig.channelId), {
          body: {content: text, allowed_mentions: {parse: []}, nonce, enforce_nonce: true},
          signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - Date.now())))
        });
      } else {
        await channel.send({content: text, allowedMentions: {parse: []}});
      }
      await this.logger.write('discord_proactive_sent', {kind, channel: channelConfig.channelId});
    } catch (error) {
      await this.logger.write('discord_proactive_failed', {kind, channel: channelConfig.channelId, code: platformErrorCode(error)});
    }
  }

  async notifyWaiting(format) {
    for (const channel of this.channels.values()) if (channel.matchAlerts) {
      await this.proactive(channel, 'match_waiting', format(channel.languages));
    }
  }

  async notifyMonthly(format) {
    for (const channel of this.channels.values()) if (channel.monthlyTop10) {
      await this.proactive(channel, 'monthly_top10', format(channel.languages));
    }
  }

  top10Targets() { return [...this.channels.values()].filter(channel => channel.monthlyTop10); }

  async rankingChannel(target) {
    if (!this.ready) throw new ReportError('connection_unavailable');
    const channel = await this.client.channels.fetch(target.channelId);
    if (channel?.guildId !== target.guildId || !channel.isTextBased() || !channel.messages?.fetch) throw new ReportError('invalid_ranking_channel');
    if (!channel.permissionsFor(this.client.user)?.has([PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory])) throw new ReportError('ranking_channel_permissions');
    return channel;
  }

  async findDailyRanking(target, date, since) {
    const channel = await this.rankingChannel(target), month = date.slice(0, 7).replace('-', '');
    let before;
    for (let page = 0; page < 10; page++) {
      const messages = await channel.messages.fetch({limit: 100, ...(before ? {before} : {})});
      for (const message of messages.values()) {
        if (message.author?.id !== this.client.user.id) continue;
        if (message.content?.startsWith(`${date} · Daily Ladder Top 10\n`)) return message.id;
        // Upgrade recovery recognizes the old unmarked daily post only on the
        // same Shanghai date and in this configured target channel.
        if (message.createdTimestamp >= since && message.createdTimestamp < since + 86400000 &&
            message.content?.startsWith(`${month}: `) && /本月天梯排行榜前10名|This month.*top 10|Monthly.*[Tt]op/.test(message.content)) return message.id;
      }
      if (messages.size < 100 || [...messages.values()].some(message => message.createdTimestamp < since)) return null;
      before = [...messages.values()].at(-1)?.id;
      if (!before) throw new ReportError('ranking_history_unavailable');
    }
    throw new ReportError('ranking_history_incomplete');
  }

  async sendDailyRanking(target, ranking, month, date, {nonceKey = date} = {}) {
    await this.rankingChannel(target);
    const content = `${date} · Daily Ladder Top 10\n${formatMonthly(ranking, month, target.languages)}`;
    if (content.length > 2000) throw new ReportError('ranking_message_too_long');
    const message = await this.client.rest.post(Routes.channelMessages(target.channelId), {
      body: {content, allowed_mentions: {parse: []}, nonce: createHash('sha256').update(`${target.guildId}:${target.channelId}:${nonceKey}`).digest('hex').slice(0, 24), enforce_nonce: true},
      signal: AbortSignal.timeout(30000)
    });
    await this.logger.write('discord_proactive_sent', {kind: 'monthly_top10', channel: target.channelId, date, messageId: message.id});
    return message.id;
  }

  monthlyReportTargets() { return [...this.channels.values()].filter(channel => channel.monthlyReport); }

  async monthlyChannel(target) {
    if (!this.ready) throw new ReportError('connection_unavailable');
    const channel = await this.client.channels.fetch(target.channelId);
    if (channel?.guildId !== target.guildId || !channel.isTextBased() || !channel.messages?.fetch) throw new ReportError('invalid_report_channel');
    const permissions = channel.permissionsFor(this.client.user);
    if (!permissions?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.ReadMessageHistory])) throw new ReportError('report_channel_permissions');
    return channel;
  }
  async findMonthlyReport(target, report, since) {
    const channel = await this.monthlyChannel(target), names = reportImages(report).map(f => f.name);
    let before;
    for (let page = 0; page < 10; page++) {
      const messages = await channel.messages.fetch({limit: 100, ...(before ? {before} : {})});
      for (const message of messages.values()) {
        if (message.author?.id !== this.client.user.id || !message.content?.startsWith(`${displayMonth(report.model.month)} · OCG 1103 Nexus Monthly Report`)) continue;
        const attachments = [...message.attachments.values()];
        if (attachments.length !== names.length || !names.every(name => attachments.some(a => a.name === name))) continue;
        // An edition marker prevents exporting a regenerated batch as if it were the posted image set.
        if (!attachments[0].description?.includes(`Edition ${report.batch}.`)) throw new ReportError('report_edition_needs_review');
        return message.id;
      }
      if (messages.size < 100 || [...messages.values()].some(message => message.createdTimestamp < since - 300000)) return null;
      before = [...messages.values()].at(-1)?.id;
      if (!before) throw new ReportError('report_history_unavailable');
    }
    throw new ReportError('report_history_incomplete');
  }
  async sendMonthlyReport(target, report, {nonceKey = report.model.month} = {}) {
    await this.monthlyChannel(target);
    const files = reportImages(report);
    const message = await this.client.rest.post(Routes.channelMessages(target.channelId), {
      body: {content: formatMonthlyReport(report.model), allowed_mentions: {parse: []},
        attachments: files.map((f, id) => ({id, filename: f.name, description: f.description + (id === 0 ? ` Edition ${report.batch}.` : '')})),
        nonce: createHash('sha256').update(`${target.guildId}:${target.channelId}:${nonceKey}`).digest('hex').slice(0, 24), enforce_nonce: true},
      files: files.map(f => ({name: f.name, data: f.data})), signal: AbortSignal.timeout(30000)
    });
    return message.id;
  }

  canNotifyWinStreak() {
    return this.ready && [...this.channels.values()].some(channel => channel.winStreakAlerts);
  }

  async notifyWinStreak(row, deadline) {
    for (const channel of this.channels.values()) if (channel.winStreakAlerts && Date.now() < deadline) {
      await this.proactive(channel, 'win_streak', formatWinStreak(row), {deadline, eventId: row.eventId});
    }
  }
}
