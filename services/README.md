# 独立服务入口

QQ 与 Discord 机器人分别运行，只消费游戏服务的公开 HTTP API，不加载进游戏主进程，也不直接连接数据库。
日常修改先读对应服务 README；部署到另一台机器时读该服务的 DEPLOYMENT。

| 任务 | 文档入口 |
| --- | --- |
| QQ 功能、群权限、配置与排查 | [qq-bot](qq-bot/README.md) |
| QQ 正式部署、升级与启用连胜/月报 | [QQ 部署手册](qq-bot/DEPLOYMENT.md) |
| QQ 统一语言、月报查询与逐部分投递恢复 | [QQ 语言与投递](qq-bot/LANGUAGE_AND_DELIVERY.md) |
| Discord 功能、频道与本地运行 | [discord-bot](discord-bot/README.md) |
| Discord 正式部署与升级 | [Discord 部署手册](discord-bot/DEPLOYMENT.md) |
| 公共 API、轮询、定时、四语言文案 | [bot-core](bot-core/README.md) |
| 生成可独立复制的部署包 | [bot-tools](bot-tools/README.md) |

## 目录与文档归属

```text
services/
├─ README.md                    服务导航与职责
├─ bot-core/README.md            共享逻辑、数据边界与验证
├─ qq-bot/
│  ├─ README.md                  开发、源码运行与 QQ 平台行为
│  └─ DEPLOYMENT.md              正式部署；构建时成为包内 README
├─ discord-bot/
│  ├─ README.md                  开发、源码运行与 Discord 平台行为
│  └─ DEPLOYMENT.md              正式部署；构建时成为包内 README
├─ bot-tools/README.md           构建与产物约束
└─ releases/<平台>/README.md     生成的部署包说明，不在此手工维护
```

平台开关、凭据和排查归对应服务；共用连胜与定时规则归 bot-core；构建规则归 bot-tools。
游戏侧字段、事务、API 仍归插件与 [跨模块契约](../docs/README.md)，
[连胜调研](../docs/LADDER_WIN_STREAK_RESEARCH.md) 保留服务端、Bot 和频道选择之间的业务取舍。
原 RELEASE.md 保留跳转，旧 DESIGN 不作为新服务的功能清单。

## 运行边界

每个平台只运行一个实例。切换旧合并服务时先停对应平台，保留每日月榜及连胜去重状态，避免重复消息。
`config.json`、日志、`data/` 是部署机器的私有文件，不随源码或部署包提交。
对象配置递归合并，群/频道数组整体替换；升级时在原配置上添加开关，保留既有目标。
新增连胜/月报推送默认关闭，按各平台部署手册显式启用；连胜需要 `GET /api/ladder/streaks`。
QQ 与 Discord 均有独立 worker 锁；QQ 新增监督进程，日榜与月报各保存自己的回执状态。
