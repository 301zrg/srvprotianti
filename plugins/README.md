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
  主动强退同样等待 `random_duel_flee_penalty(room, player)`。
  任一处理器返回严格的 `false` 即免除该次挂机处罚；无处理器、返回其他值或处理器异常时仍计次。
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
