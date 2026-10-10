# QQ bot

服务导航见 [services](../README.md)；正式部署与连胜启用步骤见 [DEPLOYMENT](DEPLOYMENT.md)。

This service runs independently from the Discord bot and the game server. Source code imports shared logic from `../bot-core`; a portable folder can be built with `node ../bot-tools/build-release.mjs`.

## Source setup

Install with `npm ci` here and in `../bot-core` (Node.js 20+). For the first local cutover, the existing private config can be reused without copying credentials:

```powershell
$env:BOT_CONFIG_PATH = '..\community-bot\config.json'
npm start
```

`BOT_CONFIG_PATH` is resolved from this service folder. A deployment folder instead needs its own private `config.json`, copied from `config.default.json` and filled with the QQ settings, game API URL and target group. Do not commit that file. Set `qq.enabled: true`; Discord settings are not needed. `apiBaseUrl` defaults to Tencent's public bot API. `groupOpenId` is the group OpenID, not the ordinary numeric QQ group number. `temp` still discovers the first group at runtime. Logs and daily schedule state are local to this process.

Commands in an enabled group: `@机器人 房间`, `@机器人 战绩 <玩家ID>`, `@机器人 状态`, `@机器人 玩法`, `@机器人 帮助`, `@机器人 排行`. `/rooms`, `/player`, `/status`, `/play`, `/help`, `/top` aliases are also accepted in QQ. A plain group message without @ is answered only if it contains an exact command; an unknown @ gets help. Proactive permission failure still disables later attempts in this process and leaves commands available.

The `玩法` guide offers the Windows KoishiPro game pack to new players and the Windows desktop assistant ZIP to players with a compatible YGOPro/KoishiPro installation. The assistant goes beside `ygopro.exe` and installs the 1103 environment, but does not include or update the game client. The guide warns that the old ADS Gateball Server client is unsupported. Download links and public connection details come from `config.default.json`; verify them after a server move. `状态` reports room occupancy using the same count as `rooms.html`, including spectators.

Stop the old combined `community-bot` before starting this bot to avoid duplicate waiting alerts and daily leaderboard posts. Around 04:00 Asia/Shanghai, copy its `data/schedule-state.json` into this service's `data/` before starting or wait until the next day; the scheduler deliberately does not replay missed posts. Run `npm test` here for platform behavior.

## 群内连胜推送

新 QQ 独立服务已接入 [bot-core 的连胜监控](../bot-core/README.md#shared-win-streak-contract)。
开启顶层 `winStreaks.enabled`，并在所选原有群配置中同时设置 `winStreakAlerts: true` 和
`proactiveEnabled: true`。`matchAlerts`、`monthlyTop10`、`commands` 的值独立，连胜可以发到匹配提醒群或另一个群。
群语言配置不限制连胜文案，每条始终含中、英、日、韩四个完整段落。

连胜沿用匹配提醒的群选择、就绪判断和主动权限拒绝处理，通过同一官方
`POST /v2/groups/{group_openid}/messages` 接口发送文本，复用 SDK 的 Access Token 管理。
SDK 的 `sendText` 不接收调用方截止时间，因此连胜发送使用带 AbortSignal 的 HTTP 请求，
取 Token 后再次检查窗口；原匹配提醒、月榜和查询发送方式保持原行为。
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

`npm test` 覆盖群开关、主动权限拒绝后保留查询、`temp` 发现、四语言发送、Token 获取期间过期和请求超时。
测试使用模拟群接口；正式服务器的真实群投递需由下一场达标连胜验收。
