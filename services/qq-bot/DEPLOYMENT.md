# QQ 机器人部署

部署包包含 QQ 适配器和共享核心，可独立复制到正式服务器。支持月报/卡组/卡片查询、
每月定时四图月报、每日榜恢复、崩溃重启与单实例锁；语言及投递规则见 [LANGUAGE_AND_DELIVERY](LANGUAGE_AND_DELIVERY.md)。
连胜支持从 5 连胜起，
此后每次观察到的新胜利推送；只发送结算后 60 秒内的最新结果，不补旧消息。
连胜包含配置语言的文案及本月等级分、胜场、胜负差、胜率；所有图片也显示群配置的全部语言。

`services/releases/qq-bot` 是构建产物。复制整个目录到独立运行位置后再添加私有配置；
升级只更新代码与依赖，保留正式目录的 `config.json`、`data/` 和日志。

## 安装或升级

1. 目标机器安装 Node.js 20 或更高版本，在部署目录执行 `npm ci`。
   跨操作系统重新安装依赖，`sharp` 含原生文件，不复制其他系统的 node_modules。
2. 首次部署将 `config.default.json` 复制为 `config.json`，填写 `gameApi.baseUrl`、
   `qq.appId`、`qq.appSecret`、`qq.groups`，设置 `qq.enabled: true`。
   升级已有 QQ Bot 时在原私有配置上加开关，不用默认文件覆盖凭据和现有群。
3. 切换前停止旧 QQ 实例或合并 `community-bot` 的 QQ 平台，避免重复消息。
   搬迁时带上 `data/schedule-state.json`；已有连胜功能还需保留 `data/win-streak-state.json`。
   月报素材与 `data/monthly-report-state.json` 也需保留。每日榜从 04:00 恢复至当日午夜，
   明确失败一分钟后重试；旧 `lastAttempt` 与结果不明发送暂停，不能用删除状态强制重发。
4. 在部署目录执行 `npm test`，再由原进程管理器执行 `npm start`。
   `npm start` 启动监督进程，worker 崩溃后按 5–60 秒重启，`data/qq-instance.lock` 阻止重复 worker。
   手动停止时先停监督进程，再停 worker；不要让进程管理器和手动命令各启动一套实例。
   确保 `BOT_CONFIG_PATH` 指向本目录 `config.json`，没有继承旧合并服务路径。
   日志为 `logs/qq-bot.log`，运行状态位于 `data/`。

`groupOpenId` 是机器人收到的群 OpenID，不是普通 QQ 群号。
只有一个待发现群时可先用 `temp`，在该群 @机器人 后查看 `qq_group_discovered`，再填入真实 OpenID；
发现前不会消费连胜结果。对象配置递归合并，群数组整体替换，修改时保留已有所有群与开关。
私有配置、Access Token、日志和运行状态不提交到 Git。

## 语言与月报

在每个原群对象中设置有序语言，例如：

```json
"languages": ["zh-cn", "en-us"]
```

查询、帮助、玩法、匹配提醒、每日榜、连胜和月报均使用这些语言。
每张图片同时显示这两种语言；只配置中文时标题、图注和卡名不额外带英日文。
群数组整体替换，修改时保留其他群与已有开关。修改配置后重启。

新增被动查询无需打开主动权限：

```text
@机器人 月报
@机器人 月报 2026-09
@机器人 卡组 202609
@机器人 卡片 副卡 202609
/meta month:202609 view:monster
```

启用定时月报时，在现有配置顶层加入以下片段：

```json
"monthlyReports": {
  "enabled": true,
  "timezone": "Asia/Shanghai",
  "day": 1,
  "hour": 10,
  "minute": 0,
  "catchUpHours": 72,
  "webBaseUrl": "",
  "stateFile": "data/monthly-report-state.json",
  "artifactDir": "data/monthly-reports"
}
```

在已配置且有主动权限的目标群对象中设置 `monthlyReport: true`、`proactiveEnabled: true`。
顶层开关与群开关默认关闭。月报每月 1 日北京时间 10:00 发布上月，默认 72 小时内恢复；
明确失败五分钟后重试，已确认图片不重发，发送结果不明则暂停该期剩余内容。
`webBaseUrl` 留空时使用 `guide.introUrl` 所在目录；新状态文件和素材目录须位于服务目录内，
月报状态与每日榜状态文件必须不同。查询不开放管理员预览、手动补发或 X 导出。

月报查询和投递需 `/api/ladder/usage/decks`、`/api/ladder/deck-detail`、`/api/ladder/usage/cards`；
发送图片复用 SDK 的二进制上传。QQ 后台应允许正文中实际使用的官网 URL。
本地测试验证协议与恢复逻辑，正式群仍需检查四张图片完整、语言顺序正确且无重复。

## 启用连胜

服务端已部署连胜字段和游戏代码后，确认 `gameApi.baseUrl` 下
`GET /api/ladder/streaks` 可用，返回 `serverTime`、`windowSeconds: 60` 和 `streaks`。
仅加数据库字段而未部署结算/API 代码还不能推送。

在现有 `config.json` 顶层添加：

```json
"winStreaks": {
  "enabled": true,
  "pollSeconds": 5,
  "stateFile": "data/win-streak-state.json"
}
```

在希望接收连胜的原 `qq.groups[]` 对象中添加/确认：

```json
"winStreakAlerts": true,
"proactiveEnabled": true
```

以上是合入现有 JSON 的片段；群 OpenID、语言、命令、匹配提醒、月榜开关继续使用原配置。
两项群开关都需要显式开启；全局开关默认关闭，`pollSeconds` 范围 1–60。
开到当前匹配提醒群即可在那里播报，也可只对另一个已配置且有主动权限的群开启。
每个平台只运行一个实例，保留去重状态后重启。旧 5～7 胜漏报后只播新鲜的第 8 胜，超时不补。

## 群权限与验收

连胜沿用匹配提醒的主动群消息接口和权限处理。用户已确认群主开通主动消息的群中匹配提醒可发；
部署时优先对该群启用连胜。[腾讯通用文档](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)
仍记录主动推送停用，其他群/应用的实际权限需单独验收，配置本身不会申请权限。

日志 `qq_ready` 表示连接就绪；`qq_proactive_sent` 且 `kind: win_streak` 表示接口接受连胜消息。
`qq_proactive_failed` 带平台错误码；`40034102` / `40034105` 会停止该群本进程主动尝试，
查询命令不受影响。确认权限后重启，仍不补失败消息。
没有符合窗口的比赛时没有播报是正常行为，真实达标比赛后检查配置的语言段落和月份战绩。
机器人端测试使用模拟接口，不能替代正式群投递验收。

原有命令：`@机器人 房间`、`@机器人 战绩 <玩家ID>`、`@机器人 状态`、
`@机器人 玩法`、`@机器人 帮助`、`@机器人 排行`；另有上述月报/卡组/卡片命令。
`玩法` 提供 KoishiPro 整合包、兼容客户端使用的桌面助手 ZIP 及连接说明；
旧 ADS Gateball Server 客户端不兼容，服务器或下载地址变化后核实 `guide` 配置。
`qq_scheduled_part_sent` 记录每日榜/月报每部分的消息 ID；`qq_scheduled_delivery_failed` 记录失败与状态。
`uncertain` 表示需要人工核对群消息，重启不会自动重发该条。
