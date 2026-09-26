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
同 IP/受限制玩家匹配、等待期匿名、投降和计分参数。没有专用热读逻辑，修改后重启。
仍使用宿主的通用数据库开关和重连配置；检查开关时避免输出正式连接凭据。

## 验证

从 `srvprotianti` 根目录执行，按改动范围选择：

```text
node plugins/tests/plugin-tests.js
node plugins/tests/integration.test.js
node duel-finalization.test.js
node room-lifecycle.test.js
```

前两项验证计分、事务、镜像和缺录像；改协议终局/重连契约时加后两项，
并记录仍需双客户端验证的 G1～G3、弃权和双断线场景。集成测试使用 SQL.js，不验证生产库部署。

## 仅在对应任务补读

- 改字段、事件或持久化：[数据契约](../../docs/DATA_MODEL_AND_MIGRATION.md)。
- 修复历史数据：[迁移手册](migrations/202609-history-repair/README.md)。
- 改供统计消费的语义：[Web 与统计契约](../../docs/WEB_AND_ANALYTICS_SPEC.md)。
