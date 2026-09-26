# SRVPro 社群机器人

独立运行的 QQ 群与 Discord 机器人。它只调用游戏服务现有的公开 API，不加载进游戏主进程。

## 开发入口

通用约束见 [AGENTS.md](../../AGENTS.md)；本服务拥有独立依赖、测试与启动命令。
不直接连接天梯数据库，不接收玩家密码或管理员凭据，不把平台 SDK 加载进游戏主进程。

| 要改的功能 | 源码入口 |
| --- | --- |
| 启动、配置与日志 | `src/index.mjs`、`src/config.mjs`、`src/logger.mjs` |
| 公开 API 与查询 | `src/api.mjs`、`src/service.mjs` |
| TT 等待提醒、04:00 月榜 | `src/monitor.mjs`、`src/scheduler.mjs` |
| QQ / Discord 适配 | `src/qq.mjs`、`src/discord.mjs` |
| 多语言与积分图 | `src/i18n.mjs`、`src/chart.mjs` |

必须保持：首次轮询及故障恢复先建快照；TT 等待提醒按有效席位判断并去重；
北京时间 04:00 月榜按 API 排序且错过不补发；战绩请求密码始终为空；
QQ 无主动权限时记日志并保留被动查询能力；多语言合成一条自动消息。

在本目录运行 `npm test`（`node --test`），或从仓库根目录运行
`npm --prefix services/community-bot test`。主仓库 `npm test` **不包含**本服务测试。
核心测试在 `test/core.test.mjs`，覆盖轮询、调度、公开 API、图像及 QQ 权限降级；
它们不证明真实平台发送成功。修改 API 字段时按需读相应插件 README；
修改功能口径、调度或平台权限时再读 [DESIGN.md](./DESIGN.md)。

已有 2026-09-23 QQ 群联调及主动消息无权限码 `40034105` 的记录；
QQ 主动推送与 Discord 的完整部署验收仍需在目标群/频道确认。

## 部署

1. 在本目录运行 `npm ci`（Node.js 20 或更新版本）。
2. 复制 `config.default.json` 为 `config.json`，填写游戏服务 `gameApi.baseUrl`、平台凭据与目标群/频道；把需要运行的平台设为 `enabled: true`。正式 `config.json` 已加入 `.gitignore`。
3. 运行 `npm start`，保持进程与网络在线。机器人日志写入 `logs/community-bot.log`，凌晨榜单运行记录写入 `data/schedule-state.json`；这些运行文件不会提交 Git。

QQ 的 `groupOpenId` 是群的 OpenID，和普通数字群号不同。首次测试可将唯一一项目标写成 `"groupOpenId": "temp"`；服务收到首个群事件时会在本次进程中自动绑定并处理该消息，同时把真实 OpenID 记录为 `qq_group_discovered`。随后把日志中的值写回 `config.json` 并重启。`qq.apiBaseUrl` 默认使用官方当前统一地址 `https://api.bot.qq.com`。每个 QQ 群和 Discord 频道可设置 `languages`，支持 `zh-cn`、`ja-jp`、`en-us`、`ko-kr` 中一种或多种。自动文案按配置顺序合为一条消息。QQ 目标群没有主动发消息权限时，设置 `proactiveEnabled: false`；匹配和月榜改写日志，被动查询继续可用。若平台返回主动消息无权限码 `40034102` 或 `40034105`，服务会在本进程内停止继续尝试该群并记录后续待推送内容。

群内指令为 `@机器人 房间`、`@机器人 战绩 <玩家ID>`；Discord 为 `/rooms`、`/player id:<玩家ID>`。QQ 群内 @机器人但没有给出这两个有效指令时，会按该群配置的全部语言回复指令帮助。房间查询逐行返回可用于进房的 `roomname`；战绩只使用空密码的公开模式，文字结果按目标配置的每种语言分别生成完整区块。每天北京时间 04:00 播报当月榜前十，排序由游戏服务 `ladder-analytics` 的 JSON 决定；错过时间不补发。

首次启动和游戏 API 从故障恢复时，房间轮询先建立快照，因此已有的等待房不会被误当成新匹配。短于轮询间隔的等待状态可能漏报。玩家查询显示总/月战绩及排名；折线图使用玩家公开接口按 `ladder-analytics` 的 `recentMatchLimit` 返回的积分记录，生成 PNG 发送。

QQ/Discord 的平台凭据与主动群消息权限需要在真实目标群/频道完成联调。不要把真实凭据或 `config.json` 上传到版本库。

Discord 的 `applicationId` 取 Developer Portal 的 General Information → Application ID；`botToken` 必须取 Bot → Token，不能填写 General Information 中的 64 位 Public Key。Discord 在无法直连的网络中还需要确保运行 Node.js 的进程及 Gateway WebSocket 实际经过 TUN 或代理。
