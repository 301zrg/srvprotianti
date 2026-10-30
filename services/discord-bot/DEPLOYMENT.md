# Discord bot deployment package

This folder contains the Discord adapter and a copy of the shared bot core. It can be copied to a PC or VPS without the QQ bot source.

Treat `services/releases/discord-bot` as a build artifact. Copy it to a separate deployment directory before adding private config or runtime data. During upgrades, keep the deployment directory's `config.json` and `data/`, especially `data/status-card.json`.

1. Install Node.js 20 or later, then run `npm ci` in this folder on the target machine. Install again after copying to a different operating system; `sharp` includes native binaries.
2. Copy `config.default.json` to `config.json`. Set `gameApi.baseUrl`, `discord.applicationId`, `discord.botToken` and `discord.enabled: true`. The default Guild and channel IDs reflect the 2026-09-30 guild construction; review them before starting. Keep `config.json` private. The Bot Token comes from Developer Portal → Bot, not the 64-character Public Key.
3. Stop the old combined `community-bot` Discord instance before starting this package. Preserve the existing `data/`; legacy daily attempt records are reconciled against this deployment's channel history.
4. Run `npm start`. Discord always reads this folder's `config.json`, ignoring inherited `BOT_CONFIG_PATH` overrides. The supervisor restarts a crashed worker after 5–60 seconds; `data/discord-instance.lock` prevents duplicate workers. The process must be able to reach Discord REST and Gateway and the public game API. Logs go to `logs/discord-bot.log`.

Slash commands: `/rooms`, `/player id:`, `/status`, `/play [language]`, `/help`, `/top`, `/meta`, `/resend`. Startup registers them in the configured Guild. Matchmaking alerts and the daily 04:00 monthly Top 10 use separate configured channels. The daily Top 10 retries failures every minute and catches up until midnight that day; its channel needs View Channel, Send Messages and Read Message History. `statusCard.enabled` is **false** in the template; set it to `true` when deploying the live guild's status card. Neither startup nor this package changes Discord channels, roles or messages outside configured bot posts.

`/resend` is visible by default only to administrators, and invocation/button clicks recheck Administrator or server-owner
permission. Its private buttons post the Top 10 only in a `monthlyTop10: true` channel, or last month's four-image report
only in a `monthlyReport: true` channel. Existing formal messages are returned without duplicate posts; confirmed deletions
can be recreated. Buttons expire after 15 minutes and are bound to the requester, guild and channel.
To test in an administrator-only channel, add `adminResendTest: true` on that channel. Both buttons then post only in that
test channel and leave formal delivery state untouched. The template enables this for `#moderator-only`
(`1504793818916982810`); review that ID and the channel privacy when deploying elsewhere.
Failed manual monthly requests retry every five minutes even beyond the 72-hour automatic window.

Win streak posts are disabled by default. After deploying the game-side streak migration and `/api/ladder/streaks`, set `winStreaks.enabled: true` and `winStreakAlerts: true` on the chosen channel. The default template includes the owner-approved `PLAY / #win-streaks` channel `1557874652640976916` created on 2026-10-09; review that ID for other guilds. Each post contains Chinese, English, Japanese and Korean and reports the current M streak plus monthly rating, wins, win-loss difference and win rate. Only the player's latest victory within 60 seconds can post; missed results are not backfilled. Keep `data/win-streak-state.json` during upgrades. `pollSeconds` defaults to 5 (1–60). The bot does not create the channel.

The `/play` reply links to the published desktop/mobile browser client at `https://ocg1103nexus.com/`, selecting
`lang=zh|en|ja|ko` to match the reply language. It also gives new Windows players the KoishiPro game pack and
players with a compatible game client the desktop assistant ZIP. The assistant is extracted beside `ygopro.exe`;
it installs the 1103 environment but does not include or update the game client. The old ADS Gateball Server client
is unsupported. Review the `guide` links in `config.default.json` after a new release or server move.

The live guild keeps `#bot-commands` (`1504412164038066388`) and `#replays-decklists` (`1554786521066905633`)
under `COMMUNITY` (`1554786332298055720`). Moving them preserved IDs, histories and existing permissions;
there is no need to change the configured command channel ID. `PLAY` contains the bot's alerts and statistics.

## Monthly report verification and enabling publication

Upgrade the source/package and restart the bot to register `/meta`. First use this in the already allowed
`moderator-only` command channel as server owner or a member with Administrator permission:

```text
/meta month:2026-09 view:preview
```

Check the four-language introduction, explicit five card zones, selected-month English link and four complete images.
The first image contains Top 15 usage, overall Match win rates against all opponents and a directional 15×15 matrix.
Open its original size to read the sample counts. An asterisk denotes fewer than 20 samples; a dash denotes no samples.
This preview posts publicly in the selected command channel and does not change automatic delivery state.
Use `/meta view:export month:2026-09` to download the X bundle privately. It includes four PNGs, an English caption with
Japanese supplement, alt text, numerical JSON/text and a hash manifest. Post on X manually; no X token is needed.

Both `export` and `preview` are administrator tools. The `view` suggestions show them only to the server owner
or members with Administrator permission; ordinary members see only public query views. Manage Server alone
does not grant access. Submitted values are checked again, including manually typed values or stale client choices.
Export remains private; preview posts in the selected command channel. Reopen the command input after an upgrade
to obtain the current suggestions.

After accepting the preview, create a dedicated `#monthly-meta` channel manually. Give the bot View Channel,
Send Messages, Attach Files and Read Message History; allow members to view, and restrict posting as desired.
Merge this object into the existing guild's channel array without removing existing channels:

```json
{
  "channelId": "REPLACE_WITH_MONTHLY_REPORT_CHANNEL_ID",
  "languages": ["en-us", "ja-jp", "ko-kr", "zh-cn"],
  "commands": false,
  "matchAlerts": false,
  "monthlyTop10": false,
  "monthlyReport": true
}
```

Then set `monthlyReports.enabled: true` and restart. It only enables automatic publication; `/meta` works while it is false.
The fixed schedule is day 1 at 10:00 Asia/Shanghai and always reports last month. `catchUpHours` defaults to 72 (0–168);
0 allows only the scheduled first minute. Beyond the window, missed reports are available through manual commands.
`webBaseUrl` defaults to the directory of `guide.introUrl`, and can be overridden with the public website root.
It does not inherit the potentially private `gameApi.baseUrl`. Links always use `period=month`, `month=YYYYMM`,
`metric=deck` and `L=en`.

Delivery state defaults to `data/monthly-report-state.json`; artifacts are under `data/monthly-reports/YYYYMM/<batch>/`.
Both paths must stay inside the service directory. Do not discard them to resolve a delivery error: the bot persists
attempts before sending, checks its own messages/attachments before retrying, and requires sufficient history permissions.
A damaged state or mismatched edition requires operator review. Automatic sends use the archived batch until that
month's targets are acknowledged. Private export prefers the published batch even if the API is later corrected.

For offline preparation without private configuration:

```text
npm run report:prepare -- --month 2026-09 --api-url http://121.4.34.71:7922/ --web-url http://121.4.34.71:7922/
```

## Separate machine and optional proxy

The bot does not need to run on the game server. It only calls the public game API, so it can run on any
machine that reaches both that API and Discord. Build only this platform into a new public output directory:

```text
node services/bot-tools/build-release.mjs --platform discord --output <new-output-directory>
```

Use a standalone runtime directory outside the Git checkout (for example `C:\srvpro-runtime\discord-bot`),
restricted to the deployment account, Administrators and SYSTEM. Never publish `config.json`, runtime data or
proxy credentials. On another machine set `gameApi.baseUrl` to the game server's public API; on the game host
prefer `http://127.0.0.1:7922/`.

**The connection to Discord is direct by default.** A proxy is only needed when the bot's own machine cannot
reach Discord; that depends on where the bot runs, not on where the game server is. When needed, set
`DISCORD_PROXY_URL` (a loopback HTTP(S) proxy URL, credentials allowed) only in this bot worker's supervisor
environment. Which proxy provides it, and its nodes, are a deployment choice kept out of this repository.
`src/proxy.mjs` supplies an undici ProxyAgent to both client REST and command registration, and uses
global-agent inside this worker for Gateway. Global-agent is needed because ws's custom connection function
can bypass Node's default HTTPS agent. The wrapper supplies `secureEndpoint:true` to its HTTPS agent so
global-agent 4.x forwards the original Gateway SNI and certificate verification options. TLS and hostname
verification remain enabled. The fetch-based game API stays direct. Do not set Windows system proxy, WinHTTP
proxy, machine-wide environment variables or a default VPN route; QQ and SRVPro keep their existing networking.
Both REST and WebSocket setup follow the [Discord proxy guide](https://discordjs.guide/legacy/additional-info/proxy).
To drop a proxy later, remove the variable from the supervisor environment and restart only this worker.

To move an existing deployment: keep the old bot running during preparation, then stop its supervisor and
worker, copy the latest private configuration, the durable state files under `data/` and the complete monthly
artifact directory, verify their SHA, and start exactly one new worker. Do not transfer the old instance lock,
PID metadata or obsolete private configuration backups as runtime state. Preserve configured guild/channel IDs,
automatic publication flags, ranking acknowledgements, monthly editions and status message ID. If cutover fails,
disable the new startup mechanism and stop the new worker before restoring the old single instance; reconcile
unknown acknowledgements from history. Preserve the new instance's state before rollback rather than overwriting it.

PM2 can supervise the core and standalone `src/index.mjs` worker separately with watch disabled and restart backoff.
Use an ecosystem filename ending in `.config.js`; a plain `.cjs` filename may be treated as an application script.
Do not also run `npm start` when PM2 owns the standalone worker. If the ecosystem defines a `discord-proxy` app,
start and verify it before the worker. Save the reviewed PM2 process list for the existing boot mechanism and
record actual reboot validation separately. Moving the bot restarts only the Discord deployment, never SRVPro/QQ/Nginx.

On Windows without another boot mechanism, register a separate startup task for [ops/start-pm2.ps1](ops/start-pm2.ps1),
passing the deployment account's `-Pm2Command` and `-Pm2Home` paths. Use that same account, S4U, highest privileges,
a 45-second boot delay and retries; no password is stored in the task. The script reads the deployment's
`ecosystem.discord.config.js`; it starts `discord-proxy` only when that file defines it, then `discord-bot`.
It rejects names owned by another deployment and skips online workers. Test the task manually and compare all
PM2 PID/start/restart metadata before and after; this does not replace a reboot test.
[ops/register-startup-task.ps1](ops/register-startup-task.ps1) does exactly this from the deployed
`<root>\discord-bot\ops` directory: it refuses a different account profile (`-ExpectedProfile`, default
`C:\Users\Administrator`) or an unrecognized task with the same name, registers `SRVPro-Discord` only when
absent, runs it once and compares [ops/pm2-safe-snapshot.cjs](ops/pm2-safe-snapshot.cjs) projections, and
writes `data\boot-task-report.json` with `rebootTested: false`. The release build copies `ops/` into the package.
Run `npm ci` and `npm test` in the portable package on the target OS. Tests include authenticated REST/WSS CONNECT,
game API bypass and private URL error redaction.

The current production deployment's proxy choice and migration record are kept outside this repository with the
server handoff; they are not requirements of this bot.

## Moving to a Mac mini

The source PC deployment had automatic monthly reports enabled in `PLAY / #monthly-meta`;
the 2026-10-13 server migration preserved these settings. A future Mac migration must first stop the server instance.
(guild `1504410444876484658`, channel `1558588099616055466`). Members can read; posting is restricted to
the bot and administrators. The September 2026 report was backfilled as message `1558588166204563547`,
with batch `2384fffe8326ac80214cd375` marked published and its delivery acknowledged in `monthly-report-state.json`.
The next scheduled report covers October 2026 at 2026-11-01 10:00 Asia/Shanghai.
Templates still keep automatic publication disabled; preserve the live private configuration when migrating.

Stop the old bot first, back up its private `config.json` and the entire `data/`, and copy the new deployment package
to the Mac. Restore those files into the new service root, then run `npm ci` there. Do not copy Windows `node_modules`.
Artifacts and delivery state use relative paths, and the licensed Noto font travels with `src/core/assets/fonts/` in the package.
Source deployments use `src/assets/fonts/` in bot-core. Check public API connectivity, Discord Gateway/REST,
font rendering and `/meta view:export` on the target host before keeping its single instance running.
Windows rendering and package checks were completed on 2026-10-11; a real macOS rendering/network check remains part of migration.
