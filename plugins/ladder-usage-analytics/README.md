# 使用率投影与细分类详情

本模块负责已结算 Match 的 G1 卡组样本、卡片事实、日/全量汇总和细分类详情，
向 Web 插件提供 `ladderUsageAnalytics`，普通启动只增量处理新提交的 Match。
通用约束见 [AGENTS.md](../../AGENTS.md)；回填操作另按文末手册执行。

## 职责与边界

- `index.js`：`projectOneMatch` / `enqueue` 投影，`cardUsage` / `deckUsage` 使用率，
  `deckDetail` / `deckTopPlayers` 详情，以及分类搜索服务。
- `entities.js`：八张自有表的 EntitySchema，必须与迁移一一对应并在数据库连接前注册。
- `backfill.js`：显式历史回填；建表/授权/回退位于根目录 `migrations/202609-player-usage/`。
- manifest 依赖 `ladder-core`、`deck-classifier`、`card-catalog`，不依赖 `ladder-analytics`。
  天梯实体、分类元数据和卡片目录分别通过这三个插件的服务取得。
- 监听提交后的 `ladder_match_committed`，失败记录告警并由维护工具补齐；
  本模块不决定比赛胜负、不重算积分，也不提供页面或 HTTP 路由。

## 必须保持的行为

- 每个 Match 的双方各一个样本，以 `(matchId, playerName)` 唯一约束保持幂等。
  每个样本的事实与各层汇总在同一事务写入，避免重试重复累计。
- 分类取 Match 已保存的 G1 类型，卡片取可唯一识别双方的 G1 `DuelLogPlayer.startDeckBuffer`。
  不从 G2/G3、最新录像或旧分类猜测初始牌组。
- 中文卡片目录不可用时整场跳过投影。目录可用但 G1 快照缺失/无效时仍计卡组样本，
  `cardValid=0`，不进入卡片分母；接口返回 `allDecks` 与 `validCardDecks` 说明覆盖率。
- 异画先归并原卡；主卡怪兽/魔法/陷阱、额外和副卡分区域统计，
  每个有效样本对同一区域卡片只贡献一次使用计数，同时保留投入 1/2/3 张分布。
  未知卡、损坏快照或归并后全卡组同卡超过三张应视为无效快照。
- 使用率查询读汇总，不扫描历史 deckbuffer。卡片分母是有效卡片样本，
  卡组分母是全部卡组样本；不能混用或静默丢掉缺快照样本。
- 时期按 `Asia/Shanghai`：本日为自然日、本周周一开始、月份 `YYYYMM`；
  全部时期读全量汇总。查询值参数绑定，指标/语言/时期使用白名单。
- 细分类列表和详情的对手列表将 4095“其他”放最后；它不作为可选详情类型。
- 详情胜率按双玩家视角 SQL 聚合；`g1FirstPlayer` 不属于双方的 Match 全部排除，
  单局必须有反向镜像且 `isFirst` 相加为 1。同卡组总体 50%，先后攻不强制 50%。
- 详情胜率前十玩家须达到配置的最低 Match 场数；与大类胜率修改同一统计定义时，
  同时检查 `ladder-analytics`，避免两个独立聚合实现口径分叉。

## 配置与缓存

- 默认项在 `config.default.json`，本地 `config.json` 只写覆盖项；卡片默认前 200、每页 50。
- 详情的 `minPlayerMatches` 默认 25、`cacheTtlSeconds` 默认 60，按文件变化热读；
  最低场数纳入详情缓存键，新投影成功后清缓存。其他启动配置不要假设自动热更新。
- 样本保存算法版本和卡库指纹。更新模板/CDB 不自动回写旧样本；
  重分类需同步卡组汇总，补缺口与重建既有卡片事实是不同的维护任务。

## 验证

从 `srvprotianti` 根目录执行：

```text
node plugins/tests/plugin-tests.js
node plugins/tests/integration.test.js
```

检查实体/迁移一致、双侧样本幂等、缺快照分母、异画与副卡分布、
时期边界及详情筛选。集成测试使用 SQL.js；生产建表和回填不能由测试结果替代。

## 仅在对应任务补读

- 首次部署或补历史缺口：[BACKFILL.md](BACKFILL.md)。
- 改字段/表/迁移：[数据契约](../../docs/DATA_MODEL_AND_MIGRATION.md)。
- 改公开响应或统计定义：[Web 与统计契约](../../docs/WEB_AND_ANALYTICS_SPEC.md)。
- 模板变更后的历史重分类：[RECLASSIFY_DATABASE.md](../deck_analysis/RECLASSIFY_DATABASE.md)。
