import fs from 'node:fs/promises';
import path from 'node:path';
import {platformErrorCode} from '../../bot-core/src/logger.mjs';

export function statusCardText(status, introUrl) {
  const time = status.checkedAt ? `<t:${Math.floor(status.checkedAt / 1000)}:R>` : '—';
  if (!status.available) {
    return `🔴 **OCG 1103 Nexus Ladder Server**\nRoom data temporarily unavailable / 暂时无法获取房间数据\nLast check / 上次检查: ${time}\n${introUrl}`;
  }
  return `🟢 **OCG 1103 Nexus Ladder Server**\n` +
    `Rooms / 房间: **${status.rooms}** · Duels / 对局中: **${status.playing}**\n` +
    `People in rooms / 房间内人数估算: **${status.players}** · Ranked rooms waiting / 天梯单人等待房: **${status.waiting}**\n` +
    `Updated / 更新: ${time}\n${introUrl}`;
}

export class StatusCard {
  constructor({client, service, logger, root, config}) {
    Object.assign(this, {client, service, logger, config});
    this.stateFile = path.resolve(root, config.stateFile);
    this.messageId = null;
    this.running = false;
    this.timer = null;
  }

  async load() {
    try {
      const state = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      if (state.guildId === this.config.guildId && state.channelId === this.config.channelId &&
          /^\d+$/.test(String(state.messageId))) this.messageId = state.messageId;
    } catch (error) {
      if (error.code !== 'ENOENT') await this.logger.write('status_card_state_invalid', {code: platformErrorCode(error)});
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.stateFile), {recursive: true});
    const temp = `${this.stateFile}.tmp`;
    await fs.writeFile(temp, JSON.stringify({guildId: this.config.guildId,
      channelId: this.config.channelId, messageId: this.messageId}), 'utf8');
    await fs.rename(temp, this.stateFile);
  }

  async update() {
    const channel = await this.client.channels.fetch(this.config.channelId);
    if (!channel?.isTextBased() || typeof channel.send !== 'function' || !channel.messages ||
        channel.guildId !== this.config.guildId) throw new Error('Status channel is unavailable');
    const content = statusCardText(await this.service.getStatus({cached: true}), this.service.guide.introUrl);
    if (!this.messageId) {
      // Recover after moving a deployment without its local state file.
      const recent = await channel.messages.fetch({limit: 100});
      const existing = [...recent.values()].find(message => message.author.id === this.client.user.id &&
        message.content.includes('**OCG 1103 Nexus Ladder Server**'));
      if (existing) {
        this.messageId = existing.id;
        await this.save();
      }
    }
    if (this.messageId) {
      try {
        const message = await channel.messages.fetch(this.messageId);
        if (message.author.id !== this.client.user.id) throw new Error('Status card message is not owned by bot');
        if (message.content !== content) await message.edit({content, allowedMentions: {parse: []}});
        return;
      } catch (error) {
        // A missing message can be recreated; permission/network errors must not create duplicates.
        if (String(error.code) !== '10008') throw error;
        this.messageId = null;
      }
    }
    const message = await channel.send({content, allowedMentions: {parse: []}});
    this.messageId = message.id;
    await this.save();
    await this.logger.write('status_card_created', {channel: this.config.channelId});
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        if (!this.loaded) { await this.load(); this.loaded = true; }
        await this.update();
      } catch (error) {
        await this.logger.write('status_card_update_failed', {channel: this.config.channelId, code: platformErrorCode(error)});
      }
      if (this.running) this.timer = setTimeout(loop, this.config.intervalSeconds * 1000);
    };
    void loop();
  }

  stop() { this.running = false; clearTimeout(this.timer); }
}
