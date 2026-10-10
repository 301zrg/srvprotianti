# Discord bot

服务导航见 [services](../README.md)；独立复制部署步骤见 [DEPLOYMENT](DEPLOYMENT.md)。

`/meta`、独立月报频道、每月 1 日 10:00 播报与四图素材的完整规则见
[月报设计](../bot-core/MONTHLY_REPORT_DESIGN.md)。自动月报默认关闭；当前 PC 部署已按用户要求开启，正式频道为 `PLAY / #monthly-meta`。

This service runs independently from QQ and the game server. Source code imports shared logic from `../bot-core`; `node ../bot-tools/build-release.mjs` makes a portable folder with its own copied core, lockfile and default config.

## Source setup

Install with `npm ci` here and in `../bot-core` (Node.js 20+). For the first local cutover, the existing private config can be reused without copying the token:

```powershell
$env:BOT_CONFIG_PATH = '..\community-bot\config.json'
npm start
```

`BOT_CONFIG_PATH` is resolved from this service folder. A portable deployment instead needs its own private `config.json` based on `config.default.json`; set `discord.enabled: true`, application ID, Bot Token, Guild ID and current channel IDs. The default channel IDs reflect the 2026-09-30 guild construction, with separate matchmaking alerts, 04:00 ranking and status targets. `config.json`, logs and runtime state stay outside Git. The bot needs working Discord Gateway and REST connectivity on its host. QQ settings are not needed.

The bot registers `/rooms`, `/player id:`, `/status`, `/play [language]`, `/help`, `/top` and `/meta` at startup. The two old commands and match waiting / 04:00 monthly Top 10 posts keep their configured targets. Commands only respond in channels with `commands: true`. Replies use the Discord user's locale; `/play` can explicitly choose English, Japanese, Korean or Chinese. `/play` includes the published browser client at `https://ocg1103nexus.com/` with the selected `lang` parameter, plus the Windows KoishiPro game pack for new players and the desktop assistant ZIP for players with a compatible YGOPro/KoishiPro installation. The assistant goes beside `ygopro.exe` and installs the 1103 environment, but does not include or update the game client. The guide warns that the old ADS Gateball Server client is unsupported. `/status` uses `GET /api/public/rooms`, counting room occupants as `rooms.html` does. No game server modification is required.

The live `#bot-commands` (`1504412164038066388`) and `#replays-decklists` (`1554786521066905633`) are under
`COMMUNITY` (`1554786332298055720`), following the owner's choice to move both on 2026-10-11.
Their IDs, histories and permission overwrites are preserved, so command routing still uses the same configured ID.
`PLAY` holds matchmaking alerts, daily rankings, win streaks and monthly reports. Existing announcements, welcome,
four-language guides and the command pin were edited in place to reflect the browser launch and `/meta`;
the original message IDs and pins were retained. The public browser URL and official site's client entry were checked live.

`statusCard.enabled` is **false** in the default template. The local PC deployment enabled it after the owner approved and created `#server-status`. Once enabled, the bot maintains one message in that channel, records the message ID in `data/status-card.json`, and recovers its own recent card if that local state file is lost. A missing old message is recreated; permission or network errors do not create another card. The card shows a relative last check time because the bot cannot update it while offline. The bot needs View Channel, Send Messages and Read Message History there. It only edits its own message. The current live card is pinned.

Stop the old combined `community-bot` before starting this bot to avoid duplicate posts. Around 04:00 Asia/Shanghai, carry over its `data/schedule-state.json` into this service's `data/` before starting or wait until the next day. Run `npm test` here for platform behavior. This bot must not create, move or rename Discord channels as part of startup.

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
当前 PC 的 Discord 实例已重启，确认 `/meta` 注册成功和 Gateway 就绪；运行日志确认自动月报开启、月报目标数为 1。
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

The owner authorized the local PC deployment on 2026-10-09. `PLAY / #win-streaks` is channel `1557874652640976916`, readable by members with posting restricted to the bot and administrators. The private Discord config enables streaks and uses the public game API at `http://121.4.34.71:7922/`; the website proxy did not expose `/api/ladder/streaks` at setup time. The default template includes the channel ID but keeps the global streak switch disabled. Run this service with its own `config.json`; an inherited `BOT_CONFIG_PATH=../community-bot/config.json` uses the older combined bot settings and must be overridden for this deployment. Preserve `data/schedule-state.json`, `data/status-card.json` and `data/win-streak-state.json` when restarting.

The local deployment runs in the background. Its process ID and absolute entry path are recorded in `data/win-streak-runtime.json`; confirm and stop that Discord process before starting another instance. To start manually from this service directory with the correct private config:

```powershell
$env:BOT_CONFIG_PATH = '.\config.json'
npm start
```

Each post contains all four languages regardless of the target's `languages` list. It reports the current M streak, this month's rating, wins, win-loss difference and win rate. A result is eligible for only 60 seconds after settlement; only the player's latest winning result is eligible. At 5, 6, 7… the online bot attempts one post per newly observed result. Restarting after missing 5–7 may post a fresh 8, but never reconstructs the old posts. Losses invalidate older streaks. Attempts are persisted before sending; failures may be omitted. REST requests also expire at the deadline, and stable nonces reduce duplicates.

Keep `data/win-streak-state.json` during upgrades. All players start at zero when the game feature is first enabled; historical streaks are not restored. Wins accumulated after launch persist across restarts. The complete public response contract is maintained in [WEB_AND_ANALYTICS_SPEC.md](../../docs/WEB_AND_ANALYTICS_SPEC.md).
