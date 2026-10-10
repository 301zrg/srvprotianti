# QQ 机器人部署

部署包包含 QQ 适配器和共享核心，可独立复制到正式服务器。连胜支持从 5 连胜起，
此后每次观察到的新胜利推送；只发送结算后 60 秒内的最新结果，不补旧消息。
每条同时包含中文、英文、日文、韩文及本月等级分、胜场、胜负差、胜率。

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
   凌晨 04:00 切换尤其需要保留月榜状态，漏掉的榜单不补发。
4. 在部署目录执行 `npm test`，再由原进程管理器执行 `npm start`。
   确保 `BOT_CONFIG_PATH` 指向本目录 `config.json`，没有继承旧合并服务路径。
   日志为 `logs/qq-bot.log`，运行状态位于 `data/`。

`groupOpenId` 是机器人收到的群 OpenID，不是普通 QQ 群号。
只有一个待发现群时可先用 `temp`，在该群 @机器人 后查看 `qq_group_discovered`，再填入真实 OpenID；
发现前不会消费连胜结果。对象配置递归合并，群数组整体替换，修改时保留已有所有群与开关。
私有配置、Access Token、日志和运行状态不提交到 Git。

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
没有符合窗口的比赛时没有播报是正常行为，真实达标比赛后检查四个语言段落和月份战绩。
机器人端测试使用模拟接口，不能替代正式群投递验收。

原有命令：`@机器人 房间`、`@机器人 战绩 <玩家ID>`、`@机器人 状态`、
`@机器人 玩法`、`@机器人 帮助`、`@机器人 排行`；本次没有新增连胜查询命令。
`玩法` 提供 KoishiPro 整合包、兼容客户端使用的桌面助手 ZIP 及连接说明；
旧 ADS Gateball Server 客户端不兼容，服务器或下载地址变化后核实 `guide` 配置。
