import {AttachmentBuilder, Client, Events, GatewayIntentBits, MessageFlags, PermissionsBitField, REST, Routes, SlashCommandBuilder} from 'discord.js';
import {createHash} from 'node:crypto';
import {platformErrorCode} from '../../bot-core/src/logger.mjs';
import {splitLines} from '../../bot-core/src/service.mjs';
import {StatusCard} from './status-card.mjs';
import {formatWinStreak} from '../../bot-core/src/i18n.mjs';
import {displayMonth, formatMonthlyReport, reportLabel} from '../../bot-core/src/monthly-report-text.mjs';
import {ReportError, reportImages} from '../../bot-core/src/monthly-report.mjs';

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
      {name: 'English', value: 'en-us'}, {name: '日本語', value: 'ja-jp'}, {name: '한국어', value: 'ko-kr'}, {name: '中文', value: 'zh-cn'}))
].map(command => command.toJSON());

const localeLanguage = locale => ({'zh-CN': 'zh-cn', 'zh-TW': 'zh-cn', ja: 'ja-jp', ko: 'ko-kr'}[locale] || 'en-us');

export class DiscordAdapter {
  constructor(config, service, logger, {root, statusCard} = {}) {
    this.config = config;
    this.service = service;
    this.logger = logger;
    this.channels = new Map(config.guilds.flatMap(guild => guild.channels.map(channel => [channel.channelId, {...channel, guildId: guild.guildId}])));
    this.client = new Client({intents: [GatewayIntentBits.Guilds]});
    this.statusCard = statusCard?.enabled ? new StatusCard({client: this.client, service, logger, root, config: statusCard}) : null;
    this.ready = false;
    this.client.on(Events.ClientReady, () => {
      this.ready = true;
      void this.logger.write('discord_ready');
      this.statusCard?.start();
    });
    this.client.on(Events.InteractionCreate, interaction => { void this.onInteraction(interaction); });
    this.client.on(Events.Error, error => { void this.logger.write('discord_error', {code: platformErrorCode(error)}); });
  }

  async start() {
    const rest = new REST({version: '10'}).setToken(this.config.botToken);
    for (const guild of this.config.guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(this.config.applicationId, guild.guildId), {body: commandBodies});
        await this.logger.write('discord_commands_registered', {guild: guild.guildId, commands: commandBodies.map(command => command.name)});
      } catch (error) {
        await this.logger.write('discord_command_registration_failed', {guild: guild.guildId, code: platformErrorCode(error)});
      }
    }
    try { await this.client.login(this.config.botToken); }
    catch (error) { await this.logger.write('discord_start_failed', {code: platformErrorCode(error)}); }
  }

  stop() { this.statusCard?.stop(); this.client.destroy(); }

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
    if (interaction.isAutocomplete?.()) return this.onMetaAutocomplete(interaction);
    if (!interaction.isChatInputCommand()) return;
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
  async sendMonthlyReport(target, report) {
    await this.monthlyChannel(target);
    const files = reportImages(report);
    const message = await this.client.rest.post(Routes.channelMessages(target.channelId), {
      body: {content: formatMonthlyReport(report.model), allowed_mentions: {parse: []},
        attachments: files.map((f, id) => ({id, filename: f.name, description: f.description + (id === 0 ? ` Edition ${report.batch}.` : '')})),
        nonce: createHash('sha256').update(`${target.guildId}:${target.channelId}:${report.model.month}`).digest('hex').slice(0, 24), enforce_nonce: true},
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
