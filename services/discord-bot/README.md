# Discord bot

服务导航见 [services](../README.md)；独立复制部署步骤见 [DEPLOYMENT](DEPLOYMENT.md)。

`/meta`、独立月报频道、每月 1 日 10:00 播报与四图素材的完整规则见
[月报设计](../bot-core/MONTHLY_REPORT_DESIGN.md)。自动月报默认关闭；现用服务器实例已保留用户此前在 PC 开启的配置，正式频道为 `PLAY / #monthly-meta`。

This service runs independently from QQ and the game server. Source code imports shared logic from `../bot-core`; `node ../bot-tools/build-release.mjs` makes a portable folder with its own copied core, lockfile and default config.

## Source setup

Install with `npm ci` here and in `../bot-core` (Node.js 20+). Run with this service's own private `config.json`:

```powershell
npm start
```

Discord always reads this service folder's `config.json` and ignores inherited `BOT_CONFIG_PATH` overrides. A portable deployment needs its own private `config.json` based on `config.default.json`; set `discord.enabled: true`, application ID, Bot Token, Guild ID and current channel IDs. The default channel IDs reflect the 2026-09-30 guild construction, with separate matchmaking alerts, 04:00 ranking and status targets. `config.json`, logs and runtime state stay outside Git. The bot needs working Discord Gateway and REST connectivity on its host. QQ settings are not needed.

The bot registers `/rooms`, `/player id:`, `/status`, `/play [language]`, `/help`, `/top`, `/meta` and `/resend` at startup. The two old commands and match waiting / 04:00 monthly Top 10 posts keep their configured targets. Ordinary commands only respond in channels with `commands: true`; `/resend` uses its dedicated target/test-channel rules. Replies use the Discord user's locale; `/play` can explicitly choose English, Japanese, Korean or Chinese. `/play` includes the published browser client at `https://ocg1103nexus.com/` with the selected `lang` parameter, plus the Windows KoishiPro game pack for new players and the desktop assistant ZIP for players with a compatible YGOPro/KoishiPro installation. The assistant goes beside `ygopro.exe` and installs the 1103 environment, but does not include or update the game client. The guide warns that the old ADS Gateball Server client is unsupported. `/status` uses `GET /api/public/rooms`, counting room occupants as `rooms.html` does. No game server modification is required.

The live `#bot-commands` (`1504412164038066388`) and `#replays-decklists` (`1554786521066905633`) are under
`COMMUNITY` (`1554786332298055720`), following the owner's choice to move both on 2026-10-11.
Their IDs, histories and permission overwrites are preserved, so command routing still uses the same configured ID.
`PLAY` holds matchmaking alerts, daily rankings, win streaks and monthly reports. Existing announcements, welcome,
four-language guides and the command pin were edited in place to reflect the browser launch and `/meta`;
the original message IDs and pins were retained. The public browser URL and official site's client entry were checked live.

Maintenance, service updates and restoration notices use INFORMATION / `#announcements` (`1554786350845141002`).
Members can view the channel and history; posting and threads are restricted to the owner/administrators and bots.
`#general` remains the chat channel and `#server-status` retains its existing live status card.
The [release monitor](../../ops/docs/windows-release-monitor.md) sends explicitly declared four-language maintenance notices
through this running bot's REST credentials and existing loopback proxy, with mentions disabled and durable delivery receipts.
No second Gateway connection or bot restart is needed. Historical release batches retain their original general-channel receipts.

`statusCard.enabled` is **false** in the default template. The local PC deployment enabled it after the owner approved and created `#server-status`. Once enabled, the bot maintains one message in that channel, records the message ID in `data/status-card.json`, and recovers its own recent card if that local state file is lost. A missing old message is recreated; permission or network errors do not create another card. The card shows a relative last check time because the bot cannot update it while offline. The bot needs View Channel, Send Messages and Read Message History there. It only edits its own message. The current live card is pinned.

If a leftover instance of the removed combined `community-bot` is still running, stop it before starting this bot. Preserve `data/` when upgrading. Legacy daily attempt state is recovered by checking the configured channel history, because an attempt alone does not prove delivery. `npm start` supervises the worker and restarts it after a crash (5?60 seconds); `data/discord-instance.lock` rejects duplicate workers. Run `npm test` here for platform behavior. This bot must not create, move or rename Discord channels as part of startup.

## Optional proxy and running elsewhere

The bot is independent of the game server: it only uses the public game API and can run on any machine that
reaches that API and Discord. Discord is reached directly by default. The optional `DISCORD_PROXY_URL` belongs
only to this worker and is needed only when the bot's own machine cannot reach Discord; [src/proxy.mjs](src/proxy.mjs)
then connects both Discord REST and Gateway, while fetch-based game API requests remain direct. Without the
variable nothing proxy-related is initialized. Which proxy to use is a deployment choice, not part of this
repository. Source/package tests cover REST/WSS CONNECT authentication and the direct game API. Packaging,
moving and the optional startup task are in [the deployment guide](DEPLOYMENT.md#separate-machine-and-optional-proxy).

## Automatic recovery and administrator resend

The daily ranking is due at 04:00 Asia/Shanghai. After that time it recovers the current day's missed post until midnight,
retrying failures once per minute while checking every 15 seconds. Delivery state is version 2 in `data/schedule-state.json`,
with a separate acknowledgement and ranking snapshot for each target/date. The old `lastAttempt` format is accepted but
does not count as success. History recovery and stable Discord nonces protect uncertain sends and restarts against duplicates.
The bot needs View Channel, Send Messages and Read Message History in `#ladder-stats`.

Use `/resend` as server owner or a member with Administrator permission. The command is registered with
[Administrator default permissions](https://docs.discord.com/developers/interactions/slash-commands#permissions),
and both command invocation and button clicks independently check permission. Its button panel is private to the requester
and expires after 15 minutes; buttons are bound to that requester, guild and channel.

- In `#ladder-stats`, it offers the current-month Top 10 button and posts in that same channel.
- In `#monthly-meta`, it offers last month's four-image report button and posts in that same channel.
- In a channel explicitly configured with `adminResendTest: true`, it offers both buttons and posts the exact content
  in that test channel without changing formal delivery state or marking a report published.

The live test channel is `#moderator-only` (`1504793818916982810`). Other command channels cannot run `/resend`.
Ordinary `commands: true` is not required in the two formal target channels. Existing formal posts are returned without
reposting; a confirmed deleted post can be recreated. Failed explicit monthly requests remain queued even outside the
72-hour automatic window and retry every five minutes. Preserve the complete `data/` directory when upgrading.

## Monthly reports and manual X posts

Restart this bot after upgrading to register `/meta`. In a channel with `commands: true`:

```text
/meta
/meta month:2026-09 view:decks language:English
/meta month:2026-09 view:side language:日本語
/meta month:2026-09 view:export
```

`month` accepts YYYY-MM or YYYYMM and defaults to last month in Asia/Shanghai. Current-month data is labeled in progress;
future and invalid months are rejected. Views are `report`, `decks`, `monster`, `spell`, `trap`, `extra`, `side`, `export` and `preview`.
Queries follow the requester locale unless `language` is supplied. Full reports use four shared English/Japanese images;
single-zone queries use the selected language. Every result links to the English usage page for the selected month.

For the first verification, use `/meta month:2026-09 view:preview` in `moderator-only`.
The bot must already be allowed to answer commands there. Server owners and members with Administrator
permission can publish this preview: one short four-language introduction and all four images, matching the monthly announcement.
The introduction explicitly names Main Deck monsters, Main Deck spells, Main Deck traps, Extra Deck and Side Deck.
The preview and scheduled announcement omit the X assets command from their public text; private export stays available separately.
Preview does not advance automatic delivery state. Ordinary queries remain available to members in allowed command channels.

The `view` field uses autocomplete. Ordinary members receive only the seven public report/card views;
`export` and `preview` are suggested only to the server owner or members with Administrator permission.
Manage Server alone does not grant these tools. Both actions check permissions again on submission, so manually
typing a hidden value is denied privately before any data query. Unknown values are also rejected privately.

`view:export` is administrator-only, defers privately and returns a ZIP with the four PNGs, `x-caption.txt`, `x-alt-text.txt`,
`report-data.json`, `report-summary.txt` and `manifest.json`. It prefers a published edition, verifies its hashes and
labels the generation time and edition. Download it from Discord, unzip and post the four PNGs with the caption on X manually.
The bot does not need X credentials or a paid API. If a ZIP exceeds the upload limit, its files are returned privately instead.

The persistent source is `data/monthly-reports/YYYYMM/<batch>/` under the running service. Discord attachments provide
access from another computer; the private export download is not the only copy. The optional public-URL CLI generates
the same bundle without reading private config or posting any messages:

```text
npm run report:prepare -- --month 2026-09 --api-url http://121.4.34.71:7922/ --web-url http://121.4.34.71:7922/
```

Auto publication requires `monthlyReports.enabled: true` and `monthlyReport: true` on the chosen channel; both are
off by default. Schedule is fixed to day 1, 10:00 Asia/Shanghai, with a default 72-hour recovery window.
Use a separate `#monthly-meta` channel after preview acceptance. The bot needs View Channel, Send Messages,
Attach Files and Read Message History. Startup does not create that channel. Configuration and Mac mini migration
steps are in [DEPLOYMENT](DEPLOYMENT.md). Preserve all `data/` when upgrading or moving the bot.

2026-10-11 本地实现与验证：bot-core 31 项、Discord 17 项、QQ 8 项源码测试通过；两个部署包的平台测试通过。
真实 202609 的四图已查看，ZIP 已用系统 ZIP 读取器校验；部署包渲染结果与源码四图逐字节一致，字体/许可证一致。
当时 PC 的 Discord 实例已重启，确认 `/meta` 注册成功和 Gateway 就绪；运行日志确认自动月报开启、月报目标数为 1。
正式频道 `PLAY / #monthly-meta` 为 `1558588099616055466`，成员可读，机器人和管理员可发帖。
202609 报告已补发并核对四个附件、正文及英语月份链接，投递状态为 `sent`；下一期为 2026-11-01 10:00 北京时间发布 202610。
管理员工具的动态候选和执行权限已测试；真实 macOS 验收仍需在迁移时完成。迁移必须保留私有配置及整个 `data/`。

## Win streak announcements

Deploy the game-side [streak migration](../../plugins/ladder-core/migrations/202610-win-streaks/README.md) and updated plugins first. The source template keeps announcements disabled. In the private Discord config, set `winStreaks.enabled: true` and add a selected channel to the existing `discord.guilds[].channels` array:

```json
{
  "channelId": "REPLACE_WITH_WIN_STREAK_CHANNEL_ID",
  "languages": ["zh-cn", "en-us", "ja-jp", "ko-kr"],
  "commands": false,
  "matchAlerts": false,
  "monthlyTop10": false,
  "winStreakAlerts": true
}
```

Use a dedicated `#win-streaks` channel with View Channel / Send Messages permissions for the bot. The bot does not create that channel. `winStreaks.pollSeconds` defaults to 5 (range 1–60); `stateFile` defaults to `data/win-streak-state.json` and must stay inside the service folder. Restart the bot after config changes.

The owner authorized the local PC deployment on 2026-10-09. `PLAY / #win-streaks` is channel `1557874652640976916`, readable by members with posting restricted to the bot and administrators. The private Discord config enables streaks and uses the public game API at `http://121.4.34.71:7922/`; the website proxy did not expose `/api/ladder/streaks` at setup time. The default template includes the channel ID but keeps the global streak switch disabled. Run this service with its own `config.json`; inherited `BOT_CONFIG_PATH` values are ignored by Discord. Preserve `data/schedule-state.json`, `data/status-card.json` and `data/win-streak-state.json` when restarting.

Since 2026-10-13 the active deployment runs on the Windows server under PM2 in `C:\srvpro-runtime`, currently
with an optional local proxy for Discord (a deployment choice recorded in the server handoff, not a requirement).
Game API calls use `http://127.0.0.1:7922/` directly. The PC supervisor and
worker were stopped, its private `discord.enabled` flag disabled, and the durable state and monthly artifacts
migrated with SHA verification. Preserve the server's private `config.json` and `data/`; never restart the old PC
instance alongside it. The independent `SRVPro-Discord` boot task was manually verified without changing any
running PID; actual reboot and the next scheduled publication still need acceptance. Detailed operation and
rollback rules are in [DEPLOYMENT](DEPLOYMENT.md#separate-machine-and-optional-proxy).

For a future standalone deployment without PM2, supervisor details are recorded in `data/discord-runtime.json`;
`data/discord-instance.lock` contains the worker PID. Stop its supervisor before its worker. Start only after
stopping the currently active server instance and restoring an explicitly reviewed configuration:

```powershell
npm start
```

Each post contains all four languages regardless of the target's `languages` list. It reports the current M streak, this month's rating, wins, win-loss difference and win rate. A result is eligible for only 60 seconds after settlement; only the player's latest winning result is eligible. At 5, 6, 7… the online bot attempts one post per newly observed result. Restarting after missing 5–7 may post a fresh 8, but never reconstructs the old posts. Losses invalidate older streaks. Attempts are persisted before sending; failures may be omitted. REST requests also expire at the deadline, and stable nonces reduce duplicates.

Keep `data/win-streak-state.json` during upgrades. All players start at zero when the game feature is first enabled; historical streaks are not restored. Wins accumulated after launch persist across restarts. The complete public response contract is maintained in [WEB_AND_ANALYTICS_SPEC.md](../../docs/WEB_AND_ANALYTICS_SPEC.md).
