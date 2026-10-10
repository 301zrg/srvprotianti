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
| `roomtype` | 根据宿主房间属性判定的类型键；见下表 |
| `randommode` | 仅 `roomtype=random_other` 时返回扩展随机模式代号，其余为 `null` |
| `users` | 按 `pos` 排序的已取得席位玩家；不是有效对战人数 |
| `istart` | `wait`、`Duel:N Siding` 或 `Duel:N Turn:T` |

`users` 可含观战席位；消费方应自行按有效对战席位统计人数。
`roommode` 是单局、比赛、双打的对战模式，不是 TT 等随机模式的标识；现有机器人仍按 `roomname` 识别 TT。

| `roomtype` | 判定来源 |
| --- | --- |
| `ladder_match` / `random_single` / `random_match` / `random_tag` | 宿主 `random_type` 分别为 `TT` / `S` / `M` / `T` |
| `random_other` | 其他非空 `random_type`；代号见 `randommode` |
| `ai_battle` / `arena_room` / `tournament_room` | 宿主 `windbot` / `arena` / `challonge_info` 标记 |
| `single_room` / `match_room` / `tag_room` | 以上均不属于，且 `roommode` 分别为 `0` / `1` / `2` |
| `unknown_room` | 宿主模式缺失或超出上述范围 |

这些类型按表中顺序判定，不靠房名前缀猜测。密码、等待和开局状态不属于房间类型。

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
- 改 TT 判定、提醒或房间字段：[独立服务入口](../../services/README.md)，再选对应平台或 bot-core。
- 改宿主房间策略：`ygopro-server.coffee` 与 `room-lifecycle.js` 的相关实现。
