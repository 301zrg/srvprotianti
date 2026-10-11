# TT 天梯核心

本目录负责 TT 账户、匹配策略、逐局捕获和 Match 结算。日常修改先定位 `index.js`，
不要把天梯业务重新写回宿主游戏流程。
通用约束见 [AGENTS.md](../../AGENTS.md)；只在跨边界时补读文末契约。

## 职责与边界

- `index.js`：`authenticate` / `verifyExisting`、`captureGame`、`captureRpsWinner`、
  `linkDuelLog`、`settle`，以及 TT 的通用房间策略注册。
- `entities.js`：`LadderUser`、`LadderMonthRecord`、`LadderMatch`、`LadderMatchGame` 四个实体。
- `i18n.json`：插件翻译，在 `register` 阶段注册；不覆盖宿主或其他插件的同语言同键。
- `diagnose-match.js` 与 `migrations/202609-history-repair/`：显式诊断和历史修复工具。
- manifest 依赖 `deck-classifier`。向其他插件提供 `ladderCore`，实体访问统一使用
  `ladderCore.entities` / `ladderCore.getRepository(name)`，不穿透目录加载实体。
- 宿主负责协议解码、终局证据与重连计时；本插件校验模式/双人席位后消费事件。
  排行榜、使用率、HTTP 展示由各自插件负责。

## 必须保持的行为

- 账户关联用去空白的小写 `name`，显示用 `displayName`；按 `Asia/Shanghai` 生成 `YYYYMM`。
  查询认证只验证已有账户，不能通过查询创建账户；密码不进入 URL、响应或日志。
- 事件顺序为 `rps_winner` → `duel_result` → 可选 `duel_log_saved` → `room_deleted`，
  事务提交成功后才发 `ladder_match_committed`。单局捕获立即复制数组和标量。
- 只有完整 `DUEL_END` 或明确弃权才可结算；异常进程退出、普通房间删除不能把领先方当胜者。
  正常比分还须与逐局 WIN 捕获结果一致，不一致则拒绝积分和比赛记录写入。
- 用户总/月积分、胜负、Match 和单局必须在一个事务内提交；`matchKey` 防止重复结算，
  并发更新同一账户需保留锁定保护。统计通知不能提前于提交。
- `LadderUser.currentWinStreak` 以整场 M 计数，胜者加一、败者归 0，跨月保持；
  首次启用时所有玩家从 0 开始，不恢复历史连胜；启用后累计的次数跨重启保留。
  `lastMatchId` 与连胜在同一结算事务保存，用于最近连胜播报。重复清理同一房间不能重复计数。
  进房和切换语言的战绩提示追加当前连胜；0 连胜显示“当前暂无连胜”。
- 每个物理单局保存双方各一条镜像；单局胜者不能用 Match 胜者代替。
  `duelCount` 从 1 开始，`isMain` 仅 G1 为 1，不恢复 `gNumber` / `isSide`。
- Match 与所有单局的双方类型固定为 G1 未换备分类；猜拳胜者 `coinWinner`、G1 先攻者、
  单局胜者、Match 胜者是四个概念。未知历史值保留空，不猜测。
- 录像缺失不阻止结算，`duelLogId` 可空；不能用“房间最新录像”无条件补关联。
- TT 启用双方并发重连窗口；一方返回、另一方超时仍按明确弃权处理。
  双方均超时且无人返回的 `all_players_reconnect_timeout` 不写积分、Match 或单局。
  普通房和其他随机模式不启用这组 TT 策略。
- 插件表在连接数据库前注册 EntitySchema；正式结构变更需要显式迁移及回退。

## 配置

默认项在 `config.default.json`，本地 `config.json` 只写覆盖项：TT 模式、认证、
同 IP/受限制玩家匹配、等待期匿名、投降、回合时长和计分参数。
`rating` 的计分参数在每场结算时合并读取默认文件和本地覆盖，热更作用于下一场结算，
双方使用同一份配置快照。`initialPoints` 沿用启动时的基线；除下述回合时长和挂机/强退处罚开关外，修改它或其他非计分配置需要重启。
运行中 JSON 或参数校验失败时记录不含配置内容的告警，并保留上一份有效计分配置；
初始化参数校验失败时使用内置默认值。删除覆盖项会恢复默认值，不保留启动时的旧覆盖。
仍使用宿主的通用数据库开关和重连配置；检查开关时避免输出正式连接凭据。

`turnTimeLimitSeconds` 默认为 `300` 秒（5 分钟），只接受 `1..65535` 范围内的 JSON 整数，
不接受字符串、零、负数或小数。TT 匹配时异步读取 `config.default.json` 和本地 `config.json`，
新建房间在启动决斗进程前使用该值，无需为配置修改重启服务。已有等待房、正在进行的房间及其后续 G2/G3
保留建房时的时长；普通房和其他随机模式沿用原设置。删除本地覆盖项恢复默认值；JSON、类型或范围错误时
只记录错误类型并保留上一次有效值，无有效值则使用内置 `300`。无需文件监听或定时轮询，仅读取两个小配置文件。
此项不修改独立的 `modules.random_duel.hang_timeout` 无操作踢人规则，也不修改重连时限或网络延迟补偿。
首次部署功能代码需重启服务，之后修改这个配置项即可热更。

`countAfkPenalty` 默认为 `false`，只接受 JSON 布尔值。关闭时 TT 挂机超时仍会踢人、主动强退仍按
原规则结算，但两者都不增加随机对战处罚次数；开启时各计一次，不附加系统踢人引起的强退次数。
该开关由插件通过宿主的通用处罚钩子提供，在挂机超时、强退和重新匹配时重新读取
`config.default.json` 和本地 `config.json`，对已开局房间生效，无需重启。删除覆盖项恢复默认值；
JSON 或类型错误时只记录错误类型并保留上一次有效开关，启动时无有效值则使用 `false`。
关闭时重新进入 TT 不检查仅含挂机/强退的旧处罚记录，不显示这些原因的警告或封禁提示，也不进入
违规匹配池。历史记录不删除，其他随机模式仍检查原记录；重新开启开关后原记录重新参与检查。
混合记录仍保留其他违规原因（例如违规发言）的处罚，提示只显示未豁免的原因；旧表只有共同总次数，
不能推算各原因次数，因此混合记录沿用原总次数，不能据此清除其他违规。未知或空原因记录保持原处理。
TT 允许离开提示通过通用房间策略使用本插件翻译，明确说明“不视为强退，但仍可能扣除天梯积分”。
默认欢迎词、昵称/密码不匹配、重复账号占席、认证服务不可用和直接加入天梯房的拒绝提示，均将
中、英、日、韩四语合并为同一行，无需先切换语言。`welcome` 默认使用 `${ladder_welcome}`；
旧配置中的“天梯比赛”也会转换为四语欢迎词，其他自定义文字或空字符串保留原行为。
随机对战的处罚警告、受限匹配和封禁提示由宿主统一返回四语，剩余时间按每一语种分别格式化。

```json
{
  "countAfkPenalty": false,
  "turnTimeLimitSeconds": 300
}
```

| `rating` 字段 | 默认值 | 含义与边界 |
| --- | --- | --- |
| `totalWeight` | `0.6` | 总等级分权重，有限数字，范围 `[0, 1]` |
| `monthWeight` | `0.4` | 当月等级分权重，有限数字，范围 `[0, 1]` |
| `useDynamic` | `true` | 布尔值；关闭后使用固定加减分，权重不参与计分 |
| `kFactor` | `20` | 动态计分系数，有限正数 |
| `minDelta` / `maxDelta` | `8` / `15` | 动态加减分绝对值上下限，非负安全整数，且下限不大于上限 |
| `fixedDelta` | `12` | 固定加减分绝对值，非负安全整数；沿用固定模式不受动态上下限限制的行为 |
| `initialPoints` | `1000` | 用户/新月份初始积分，正安全整数；启动时固定 |

未提供的字段采用默认值，包括旧配置未写权重时的 `0.6/0.4`。两项权重按和归一化，不能
同时为 `0`；例如 `0.3/0.2` 等价于 `0.6/0.4`。只设置 `monthWeight: 0` 时，总分权重归一化
为 `1`，恢复原来的总分计分算法。

```json
{
  "rating": {
    "totalWeight": 0.6,
    "monthWeight": 0.4
  }
}
```

动态计分使用结算前的 `总分 × totalWeight + 当月分 × monthWeight` 计算双方预期胜率，
仍按 `round(K × (胜负结果 − 预期胜率))` 取变化量，再限制绝对值到 `minDelta/maxDelta`。
当月分只取当前 `YYYYMM` 的月记录；无记录时用启动初始分，不使用用户表旧月份兼容快照。
同一变化量更新总/月分，余额仍保留 `0` 下限；Match 的前后积分仍是总分，综合分不写入数据库。
无需改表或重算历史积分；配置生效时间和权重调整应由部署记录留存。

## 验证

从 `srvprotianti` 根目录执行，按改动范围选择：

```text
node plugins/tests/plugin-tests.js
node plugins/tests/integration.test.js
node plugins/ladder-core/win-streak.test.js
node duel-finalization.test.js
node room-lifecycle.test.js
node random-duel-afk.test.js
node ladder-turn-time.test.js
node ladder-messages.test.js
```

前两项验证计分、事务、镜像和缺录像；改协议终局/重连契约时加终局与房间测试，
挂机处罚和离开提示的回归由 `random-duel-afk.test.js` 覆盖。
回合时长及热更由 `ladder-turn-time.test.js` 覆盖默认值、覆盖/删除、无效配置、已有房间冻结、
新房进程参数、并发匹配与无插件/禁用插件场景。
`ladder-messages.test.js` 运行进房、语言切换和警告路径，验证真实翻译与 CHAT 编解码后的四语登录失败
和扣分提示，以及四语欢迎/拒绝进房/处罚消息、词典完整性和较长消息不截断；不能代替真实客户端 UI 验收。
协议修改仍记录待验收的 G1～G3、弃权和双断线场景。
集成测试使用 SQL.js，不验证生产库部署。

更新正式服务时同步运行文件 `../../ygopro-server.js`、`../../data/i18n.json`、本插件 `index.js`、`i18n.json`、
`afk-policy.js`、`turn-time.js` 和 `config.default.json`，保留本地 `config.json`。修改 CoffeeScript 源码后必须编译，
仅复制 `.coffee` 不会更新 `npm start` 实际运行的 JS。扣分提示依赖宿主策略、插件进房策略和翻译三者同时更新。
累计复制清单见 [部署文件清单](DEPLOY_FILES.md)，已修复与保留问题见 [语言消息核查](LANGUAGE_AUDIT.md)。

## 仅在对应任务补读

- 改字段、事件或持久化：[数据契约](../../docs/DATA_MODEL_AND_MIGRATION.md)。
- 上线 M 连胜、从 0 初始化与回退：[连胜迁移](migrations/202610-win-streaks/README.md)。
- 修复历史数据：[迁移手册](migrations/202609-history-repair/README.md)。
- 改供统计消费的语义：[Web 与统计契约](../../docs/WEB_AND_ANALYTICS_SPEC.md)。
