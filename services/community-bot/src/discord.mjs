import {AttachmentBuilder, Client, Events, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder} from 'discord.js';
import {platformErrorCode} from './logger.mjs';
import {splitLines} from './service.mjs';

const commandBodies = [
  new SlashCommandBuilder().setName('rooms').setDescription('List all joinable room names'),
  new SlashCommandBuilder().setName('player').setDescription('Show public player statistics')
    .addStringOption(option => option.setName('id').setDescription('Exact player ID').setRequired(true))
].map(command => command.toJSON());

export class DiscordAdapter {
  constructor(config, service, logger) {
    this.config = config;
    this.service = service;
    this.logger = logger;
    this.channels = new Map(config.guilds.flatMap(guild => guild.channels.map(channel => [channel.channelId, {...channel, guildId: guild.guildId}])));
    this.client = new Client({intents: [GatewayIntentBits.Guilds]});
    this.ready = false;
    this.client.on(Events.ClientReady, () => { this.ready = true; void this.logger.write('discord_ready'); });
    this.client.on(Events.InteractionCreate, interaction => { void this.onInteraction(interaction); });
    this.client.on(Events.Error, error => { void this.logger.write('discord_error', {code: platformErrorCode(error)}); });
  }

  async start() {
    const rest = new REST({version: '10'}).setToken(this.config.botToken);
    for (const guild of this.config.guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(this.config.applicationId, guild.guildId), {body: commandBodies});
      } catch (error) {
        await this.logger.write('discord_command_registration_failed', {guild: guild.guildId, code: platformErrorCode(error)});
      }
    }
    try { await this.client.login(this.config.botToken); }
    catch (error) { await this.logger.write('discord_start_failed', {code: platformErrorCode(error)}); }
  }

  stop() { this.client.destroy(); }

  async onInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;
    const channel = this.channels.get(interaction.channelId);
    if (!channel || channel.guildId !== interaction.guildId || !channel.commands) {
      await interaction.reply({content: 'This command is not enabled in this channel.', flags: MessageFlags.Ephemeral}).catch(() => {});
      return;
    }
    if (!['rooms', 'player'].includes(interaction.commandName)) return;
    try {
      await interaction.deferReply();
      const response = interaction.commandName === 'rooms' ? await this.service.rooms(channel.languages) :
        await this.service.player(interaction.options.getString('id', true), channel.languages);
      const chunks = response.messages.flatMap(value => splitLines(value, 1800));
      const first = chunks.shift() || '—';
      await interaction.editReply({content: first, files: response.image ? [new AttachmentBuilder(response.image, {name: 'rating.png'})] : [],
        allowedMentions: {parse: []}});
      for (const content of chunks) await interaction.followUp({content, allowedMentions: {parse: []}});
    } catch (error) {
      await this.logger.write('discord_reply_failed', {channel: channel.channelId, code: platformErrorCode(error)});
      if (interaction.deferred) await interaction.editReply({content: 'The query is temporarily unavailable.'}).catch(() => {});
    }
  }

  async proactive(channelConfig, kind, text) {
    if (!this.ready) {
      await this.logger.write('discord_proactive_skipped', {kind, channel: channelConfig.channelId, reason: 'connection_unavailable'});
      return;
    }
    try {
      const channel = await this.client.channels.fetch(channelConfig.channelId);
      if (!channel?.isTextBased() || typeof channel.send !== 'function') throw new Error('Channel is not text based');
      await channel.send({content: text, allowedMentions: {parse: []}});
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
}
