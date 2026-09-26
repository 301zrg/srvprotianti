# public-room-web：公开房间 API

本文件是房间公开接口的开发入口；通用约束见 [AGENTS.md](../../AGENTS.md)。
本插件只注册 API；房间页面及静态路由属于 `ladder-web`。

## 职责与入口

- [index.js](./index.js)：在 `init()` 中注册 `http_request`，读取宿主房间快照。
- [plugin.json](./plugin.json)：无插件依赖，不依赖天梯数据库。
- [room-lifecycle.js](../../room-lifecycle.js)：共用的有效等待席位判定。

## 接口契约

默认 `GET /api/public/rooms` 返回 `{rooms}`，不使用管理员密码。

| 字段 | 口径 |
| --- | --- |
| `roomid` | 房间进程号的字符串形式，用于识别房间 |
| `roomname` | 去掉 `$` 后密码部分的进房名称 |
| `roommode` / `needpass` | 宿主模式值 / 字符串形式的密码标记 |
| `users` | 按 `pos` 排序的已取得席位玩家；不是有效对战人数 |
| `istart` | `wait`、`Duel:N Siding` 或 `Duel:N Turn:T` |

`users` 可含观战席位；消费方应自行按有效对战席位统计人数。
`roommode` 不是 TT 等随机模式的标识，现有机器人仍按 `roomname` 识别 TT。

## 关键不变量

- 不暴露房间密码或玩家 IP；玩家 `id` 固定为 `-1`，`ip` 固定为 `null`。
- 名称通过宿主 `getMaskedPlayerName()` 取得，不能绕过等待期匿名策略。
- 未建立、正在删除或已删除的房间不返回；随机等待房没有有效对战席位时不返回。
- `showPlayerStatus` 默认关闭；即使开启，等待阶段及 `pos === 7` 仍不返回状态。
- 修改字段、可见性或状态文字时，核对房间页面和机器人两类消费方。

## 配置与验证

[config.default.json](./config.default.json) 定义 `endpoint` 和 `showPlayerStatus`；
部署覆盖写同目录 `config.json`，不要提交真实部署配置。

从仓库根目录运行与改动相关的检查：

```text
node room-lifecycle.test.js
node plugins/tests/integration.test.js
```

前者检查席位与房间生命周期，后者检查公开列表、空房过滤和状态格式。

## 按需补读

- 改页面：[ladder-web/README.md](../ladder-web/README.md)。
- 改 TT 判定、提醒或房间字段：[community-bot/README.md](../../services/community-bot/README.md)。
- 改宿主房间策略：`ygopro-server.coffee` 与 `room-lifecycle.js` 的相关实现。
