# 宿主与插件开发入口

> 全局规则见 [AGENTS.md](../AGENTS.md)。这里只覆盖通用宿主、主服务与插件机制；
> 修改具体业务时从 [模块导航](../AGENTS.md) 直接进入对应 README。

## 源码定位

| 内容 | 修改入口 |
| --- | --- |
| 插件发现、依赖、配置、生命周期、事件/服务/翻译注册 | [plugin-system.js](../plugin-system.js) |
| 协议处理、房间/重连、通用钩子和 HTTP 主入口 | [ygopro-server.coffee](../ygopro-server.coffee) |
| 单局结束与胜者坐标、录像捕获 | [duel-finalization.coffee](../duel-finalization.coffee) |
| 空随机等待房回收、重连超时策略辅助 | [room-lifecycle.js](../room-lifecycle.js) |
| 维护排空计数、管理请求鉴权辅助与代理头兼容 | [maintenance-state.js](../maintenance-state.js) |
| 房间列表与有效玩家过滤 | [roomlist.coffee](../roomlist.coffee) |
| 数据库连接、实体注册、插件事务 | [DataManager.ts](../data-manager/DataManager.ts) |

有 CoffeeScript/TypeScript 源文件的生成 JS 不单独编辑。纯 JS 宿主辅助文件按原文件修改。

## 加载与配置契约

- 只发现一级目录中的 `plugin.json`。manifest 的 `name` 是稳定 ID；
  `deck_analysis/` 的 ID 为 `deck-classifier`，不能只改一处。
- 依赖声明以实际服务调用为准。发现/依赖排序后加载模块，连接前执行 `configure`、
  `register`，数据库就绪后执行 `init`。
- 运行目录准备与插件 `init` 完成后才开放 TCP/HTTP/HTTPS/Neos 监听。
  生命周期失败会撤下该插件及传递依赖者的钩子、服务和翻译，独立插件继续运行；
  失败后的迟到任务不能重新登记注册项。实体在创建连接前锁定，连接后的失败不删除 metadata 或表。
  共享配置写入、插件自建资源和已取得的对象引用不由宿主回滚，插件必须自行负责。
- 宿主将插件 `config.default.json` 与本地 `config.json` 深度合并；后者不提交。
  不保证所有插件都热加载配置，是否重启由模块文档说明。
- `api.hook` 注册事件，`api.emit` 触发；`api.provide/get` 传递服务，
  `api.registerEntity` 在连接前登记实体，`api.registerTranslations` 登记插件文案。
- 钩子按优先级执行并隔离异常。修改调用链前确认是否必须等待完成；异常被隔离不能使认证意外放行。
- 翻译的同语言同键冲突必须报错；宿主负责统一合并和重建翻译规则，核心不存天梯文案。
- 运行时通过服务取得其他插件数据；不跨插件目录读取实体或 JSON。
  新增插件/扩展宿主时补读 [架构规范](../docs/REFACTORING_SPEC.md)。

## 通用事件与房间不变量

```text
SELECT_TP -> rps_winner
WIN -> duel_result -> 尝试保存录像/DuelLog -> duel_log_saved（日志路径启用时，ID 可空）
DUEL_END / 明确弃权 / 其他关闭原因 -> room_deleted(..., terminalOutcome)
```

- `duel_result` 复制全部有效对局席位；通用钩子不能硬编码双人或 TT，业务插件验证自己的模式/人数。
- WIN 胜者基于共享先后攻坐标归一化，不取决于哪侧连接先上报。
- 原生 `HINT_OPSELECTED` 系统提示 `1161`（效果处理）与 `1162`（效果重置）补发给原分发遗漏的本方操作者，
  只接受完整 7 字节消息；其他选项与暗牌消息沿用原分发。Single／Match 依据当前先后攻坐标，
  Tag 依据源连接自身 START／NEW_TURN 流重建的当前席位，只由唯一对方操作者的原始消息触发一次；队友、观战与录像仍走原链路。
  相同提示连续出现仍逐条发送，不修改选择缓存或响应；断线、重连恢复和房间恢复期间不补发或重播旧提示。
  重连前缀仍可恢复独立席位计数；未取得完整映射时不猜测。补发异步复制发送并捕获失败，不因收件端背压阻塞原对手队列。
- 后端 socket 关闭在超时范围内等待该连接 STOC 队列排空；子进程退出再限时等待房间内连接收尾并记录结果。
  进程退出/房间删除本身不是完整 Match 的证据，不能用暂存领先比分替代终局。
- 当前持久化流程等待 `saveDuelLog` 返回，`duel_log_saved.duelLogId` 可空；
  录像文件由异步回调写入，该事件不证明文件已经成功落盘。保存失败不取消捕获的结果。
  改为后台持久队列是独立设计任务，不能直接去掉现有 `await`。
- Room 使用通用 `policy_overrides`：`hideNamesBeforeStart`、`allowEarlySurrender`、
  `allowConcurrentReconnects`、`neutralOnAllReconnectTimeout`、`opponentLeaveTipSuffix`。
  `opponentLeaveTipSuffix` 可替换允许对手离开提示的后半句，使用所属插件的翻译键；未提供时沿用宿主文案。
  并发重连与全员超时中止仅由 TT 插件启用，默认普通房行为保持。
- 随机匹配通过 `random_room_time_limit(type)` 取得回合时长（秒），传入实际匹配类型，空类型使用默认类型。
  宿主采用首个 `1..65535` 范围内的整数，仅在新建房间时复制到 `hostinfo.time_limit`，并在启动决斗进程前生效。
  配置读取先于查找等待房，避免异步读取期间并发进房重复建房；加入已有房间不改其时长。
  无处理器、无有效返回值或处理器异常时沿用宿主默认值；具体模式和热更策略由插件提供。
- 随机对战挂机超时先等待 `random_duel_afk_penalty(room, player)` 钩子，再决定是否计次。
  主动强退同样等待 `random_duel_flee_penalty(room, player)`；挂房间倒计时和连续踢人路径的
  Zombie 计次等待 `random_duel_zombie_penalty(room, player)`。
  任一处理器返回严格的 `false` 即免除对应的本次违规计次；无处理器、返回其他值或处理器异常时仍计次。
  钩子不改变超时踢人、弃权或结算。系统踢人使用 `system_kicked` 标记，断开时不再追加强退处罚。
- 匹配时 `random_duel_penalty_history(type, record)` 可返回 `{ignore: true}` 忽略本次匹配的旧处罚；
  任一处理器要求忽略即生效。否则首个含 `reasons` 数组的结果只替换提示原因，不改变保存的实体。
  类型为空时传入默认随机类型；无插件或钩子异常时沿用原检查。历史记录不被删除或改写。
  进房前的处罚警告、受限匹配和封禁消息统一包含中、英、日、韩四语，原因和剩余时间分别按该语言生成；
  文案使用紧凑格式以适配单条 CHAT 长度，不更改处罚阈值或匹配规则。
- 异步进房校验后再检查客户端是否已关闭；空随机等待房按 `modules.random_duel.empty_room_timeout`
  回收，不影响已开局房间。列表不发布无有效席位的随机等待房。
- 宿主移除插件后不注册 TT/天梯实体/新增公开 API；原 `/api/getrooms` 与 `/api/replay`
  的管理鉴权保留。独立服务不通过宿主加载。

## 钩子目录

宿主通过 `plugin_call` 调用全部钩子。它按优先级依次 `await` 每个处理器，单个处理器的异常会被隔离并记录，然后返回结果数组；所以下表的每个钩子都会等待完成。"返回值"一列说明宿主如何使用结果数组。核对日期 2026-10-30，以 `ygopro-server.coffee` 的调用点为准。

| 钩子 | 参数 | 返回值的用法 | 当前消费者 |
| --- | --- | --- | --- |
| `before_join_room` | `client, room` | 取第一个带 `error` 的结果，拒绝进房 | ladder-core |
| `after_join_room` | `client, room` | 忽略 | 无 |
| `resolve_room_join` | `client, room, pass` | 任一结果为 `true` 时，视为由插件接管进房 | ladder-core |
| `client_joined_game` | `client, room` | 忽略 | ladder-core |
| `client_language_changed` | `client, room` | 忽略 | ladder-core |
| `random_mode` | `uname, playerIp` | 取第一个 `type === uname` 的结果作为匹配模式 | ladder-core |
| `random_room_time_limit` | `type` | 取第一个 `1..65535` 的整数（秒） | ladder-core |
| `random_duel_penalty_history` | `type, record` | 有 `{ignore: true}` 即忽略旧处罚；否则用第一个 `reasons` 数组替换提示原因 | ladder-core |
| `random_duel_afk_penalty` | `room, player` | 有严格的 `false` 即免除本次计次 | ladder-core |
| `random_duel_flee_penalty` | `room, client` | 同上 | ladder-core |
| `random_duel_zombie_penalty` | `room, player`（两处调用） | 同上 | ladder-core |
| `room_started` | `room, playingPlayers` | 忽略 | ladder-core |
| `rps_winner` | `{roomId, roomName, randomType, playerName, playerPosition}` | 忽略 | ladder-core |
| `duel_result` | `{roomId, roomName, randomType, duelCount, winnerPosition, winnerName, winType, players, capturedAt}` | 忽略 | ladder-core |
| `duel_log_saved` | `{roomId, roomName, randomType, duelCount, duelLogId, replayFilename}`，`duelLogId` 可空 | 忽略 | ladder-core |
| `room_deleted` | `room, scoreArray, terminalOutcome` | 忽略 | ladder-core |
| `http_request` | `request, response, url` | 任一结果为 `true` 时，视为已处理 | ladder-web、public-replay-web、public-room-web |

插件之间的事件不经过宿主：

| 事件 | 发出方 | 参数 | 消费者 |
| --- | --- | --- | --- |
| `ladder_match_committed` | ladder-core，在结算事务提交后通过 `api.emit` 发出 | `{matchId, monthKey}` | ladder-analytics（失效统计缓存）、ladder-usage-analytics（排队投影）、ladder-replay-enrichment（清除筛选缓存） |

新增或修改钩子时，同步更新上表，并写明宿主是否依赖它的返回值。

## 宿主依赖（`api` 以外）

下面这些依赖目前不经过 `api`，迁移宿主或复用到其他环境时必须一起保留，或者另行适配：

- `global.ygopro`：ladder-core 用它发送聊天、断开连接，并读取 `constants.DUEL_STAGE` / `COLORS`；public-room-web 读取 `constants.DUEL_STAGE`。
- `global.ROOM_all`：public-room-web 用它生成房间快照。拿到的是宿主的可变房间对象，插件只能读取，不能修改。
- 按相对路径 require 的宿主模块：`data-manager/DeckEncoder`（deck_analysis 的重分类脚本、ladder-analytics、ladder-usage-analytics、ladder-replay-enrichment）和 `room-lifecycle`（public-room-web）。
- 可选服务：ladder-analytics 通过 `api.get('publicReplayWeb')` 取录像服务（`index.js` 中查询录像的部分），但 `plugin.json` 没有声明 `public-replay-web`。服务缺失时只会少了录像链接，插件本身仍然加载。ladder-replay-enrichment 已经把它声明为必需依赖。可选依赖约定为：不写进 `dependencies`，代码必须能处理 `undefined`，并在模块 README 中说明。
- 离线、部署工具（如 `ladder-usage-analytics/backfill.js`、`postgres-compat/deployment/contract.js`、`ladder-core` 的迁移脚本）会直接 require 宿主或其他插件的文件。这只限于这些工具，运行时的插件代码不能这样做。

真正需要复用到第二个环境、并且暴露出实际边界问题时，再评估是否为这些依赖设计插件 API。

结算事务及提交后投影属于 [ladder-core](ladder-core/README.md) 和
[ladder-usage-analytics](ladder-usage-analytics/README.md)，不在宿主实现业务分支。

## 部署与维护边界

- `GET /api/maintenance/status` 在插件 HTTP 钩子之前处理，仅接受 GET 和 HTTP Basic，
  沿用管理员 `stop` 权限。响应只含维护开关、房间数与待完成任务计数，不含玩家身份。
- 计数覆盖未 established/正在删除的房间、现有客户端/后端协议任务、yrp 写回调、
  DuelLog 与其 `duel_log_saved` 钩子、云录像压缩/保存。这里只观察已有任务，未加队列上限或改变顺序。
  `readyToStop` 要求 stop 已启用、房间与待完成任务均为零；随后仍须停止所有写入进程再做联合备份。
  SIGTERM 本身不是整服自然排空，第三方插件/后台 writer 须另外纳入停写计划。
- Neos 先读取 `modules.neos.trusted_proxy_header`，字段缺失时兼容旧 `ip_header`；
  显式空字符串关闭转发头。头名统一大小写，仍只信任匹配 `trusted_proxies` 的直接连接来源。
- 宿主通用 `SRVPRO_*` 配置迁移排除默认 PostgreSQL 适配器的 `SRVPRO_LADDER_PG_*`，
  防止连接密码进入主配置和变更日志。自定义适配器变量名必须避免与宿主通用映射重名。
- 空库初始化使用 [PostgreSQL deployment 工具](postgres-compat/deployment/README.md)，
  保持生产 synchronize=false。已有库恢复不重新 init，不重置连胜/积分或重跑历史修复。

完整安装、账号、排空、停写和恢复步骤见 [运维入口](../ops/README.md)。

## 验证命令

从项目根目录执行，按实际修改范围选择：

```text
node plugins/tests/plugin-host.test.js
node duel-finalization.test.js
node room-lifecycle.test.js
node maintenance-state.test.js
```

修改 CoffeeScript/TypeScript 后先 `npm run build`（已含 TypeScript 类型检查），并检查生成 diff。
宿主/共享契约改动运行 `npm test`；涉及真实协议时再做两个客户端验收。
无插件验证使用临时目录/隔离副本，不删除工作区插件。

仅维护业务模块时按模块 README 的验证执行；仅修改本说明无需构建。
