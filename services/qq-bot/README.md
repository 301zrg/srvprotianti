# QQ bot

服务导航见 [services](../README.md)；正式部署见 [DEPLOYMENT](DEPLOYMENT.md)，
语言、月报命令、逐部分投递恢复及模块职责见 [LANGUAGE_AND_DELIVERY](LANGUAGE_AND_DELIVERY.md)。

This service runs independently from the Discord bot and the game server. Source code imports shared logic from `../bot-core`; a portable folder can be built with `node ../bot-tools/build-release.mjs`.

## Source setup

Install with `npm ci` here and in `../bot-core` (Node.js 20+), then run `npm start`. The optional `BOT_CONFIG_PATH` is resolved from this service folder; by default the bot reads its own private `config.json`. A deployment folder needs that private `config.json`, copied from `config.default.json` and filled with the QQ settings, game API URL and target group. Do not commit that file. Set `qq.enabled: true`; Discord settings are not needed. `apiBaseUrl` defaults to Tencent's public bot API. `groupOpenId` is the group OpenID, not the ordinary numeric QQ group number. `temp` still discovers the first group at runtime. Logs and daily schedule state are local to this process.

Commands in an enabled group require an actual mention: `@机器人 房间`, `@机器人 战绩 <玩家ID>`, `@机器人 状态`, `@机器人 玩法`, `@机器人 帮助`, `@机器人 排行`, `@机器人 月报 [YYYY-MM]`, `@机器人 卡组 [YYYY-MM]`, `@机器人 卡片 <怪兽|魔法|陷阱|额外|副卡> [YYYY-MM]`. Months also accept `YYYYMM`. QQ uses Chinese command words and positional arguments; slash commands and named arguments are unsupported. Ordinary group messages are ignored; a mention with an unknown command gets localized help. The [QQ command contract](LANGUAGE_AND_DELIVERY.md#查询命令) also applies when adding functionality from Discord. Proactive permission failure still disables later attempts in this process and leaves commands available.

The `玩法` guide includes the published desktop/mobile browser client, the Windows KoishiPro game pack for new players and the Windows desktop assistant ZIP for compatible YGOPro/KoishiPro installations. The assistant goes beside `ygopro.exe` and installs the 1103 environment, but does not include or update the game client. The guide warns that the old ADS Gateball Server client is unsupported. Download links and public connection details come from `config.default.json`; verify them after a server move. `状态` reports room occupancy using the same count as `rooms.html`, including spectators.

If a leftover instance of the removed combined `community-bot` is still running, stop it before starting this bot. Preserve all `data/` during upgrades. Daily rankings recover from 04:00 until midnight, retry explicit failures each minute and persist per-group receipts. Legacy attempts and uncertain sends are held to avoid duplicates. Automatic monthly reports require `monthlyReports.enabled`, group `monthlyReport` and `proactiveEnabled`; schedule is day 1 at 10:00 Asia/Shanghai, default recovery window 72 hours. Queries work with automatic reports disabled. `npm start` runs a supervisor (5–60-second crash backoff), and `data/qq-instance.lock` excludes duplicate workers. Run `npm test` here and in `../bot-core`.

## 群内连胜推送

新 QQ 独立服务已接入 [bot-core 的连胜监控](../bot-core/README.md#shared-win-streak-contract)。
开启顶层 `winStreaks.enabled`，并在所选原有群配置中同时设置 `winStreakAlerts: true` 和
`proactiveEnabled: true`。`matchAlerts`、`monthlyTop10`、`commands` 的值独立，连胜可以发到匹配提醒群或另一个群。
连胜文案按目标群 `languages` 输出，所有文字与图片也采用同一语言配置。
多语言图片同时显示配置的全部语言，并保持顺序；月报查询与自动投递使用同一渲染规则。

连胜沿用匹配提醒的群选择、就绪判断和主动权限拒绝处理，通过同一官方
`POST /v2/groups/{group_openid}/messages` 接口发送文本，复用 SDK 的 Access Token 管理。
SDK 的 `sendText` 不接收调用方截止时间，因此连胜发送使用带 AbortSignal 的 HTTP 请求，
取 Token 后再次检查窗口；定时榜单/月报使用独立回执状态机，查询与匹配提醒沿用 SDK。
发送前持久记录尝试，失败或过期不补发；详见共享契约。

2026-10-09 用户反馈：群主开通机器人主动消息的群中，匹配提醒正常工作。
本次按该实际权限条件接入连胜，未新增平台权限申请或群内查询指令。
[腾讯发送消息文档](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)
的通用说明记录主动推送已停用，因此新应用/其他群仍需按实际能力验收，不能仅配置开关就认定可发。
返回 `40034102` / `40034105` 后，该群本进程停止所有主动尝试并记录日志，群内被动查询仍可使用。
恢复权限后重启 QQ Bot，不补此前漏掉的连胜。

| 修改内容 | 源码入口 |
| --- | --- |
| QQ 消息、群发现、权限与连胜发送 | `src/qq.mjs` |
| 独立启动与配置加载 | `src/index.mjs` |
| 默认开关、目标群与日志文件 | `config.default.json` |
| 配置验证、轮询、去重与四语言格式 | [bot-core](../bot-core/README.md) |

`npm test` 覆盖群开关、主动权限拒绝后保留查询、`temp` 发现、配置语言、月报命令、回复预算、媒体回执、Token 获取期间过期和请求超时。
bot-core 测试另覆盖 QQ 定时恢复、逐图续发、结果不明暂停、语言数据校验、真实字体渲染、监督进程及单实例锁。
测试使用模拟群接口；正式服务器的真实群投递需由下一场达标连胜验收。
