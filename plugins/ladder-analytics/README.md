# 排行榜、玩家战绩与卡组胜率

本模块提供 `ladderAnalytics` 数据服务。改排行榜、玩家可见范围或大类胜率时从这里开始；
页面和 HTTP 参数解析在 `ladder-web`，卡片/细分类使用率在 `ladder-usage-analytics`。
通用约束见 [AGENTS.md](../../AGENTS.md)；局部任务从本文和目标源码开始。

## 职责与边界

- `index.js` 的 `ranking`：总榜/月榜；`aggregateDeckStats` / `deckStats`：大类胜率矩阵。
- `profile` / `profileDeck`：玩家摘要、记录、积分曲线和受可见范围保护的 G1 卡组下载。
- manifest 依赖 `ladder-core`、`deck-classifier`、`card-catalog`。
  它与 `ladder-usage-analytics` 是并列插件，没有相互依赖。
- 通过 `ladderCore.entities` 读取天梯数据、`verifyExisting` 验证已有账户，
  通过 `deckClassifier` 取得分类/分组，通过 `cardCatalog` 区分下载 YDK 的主卡和额外卡。
- 不注册新表，不写计分，不直接读取其他插件的实体、JSON 或 CDB 文件。

## 必须保持的行为

- 排序支持 `points|wins|diff|winRate`；省略/非法值回退到当前配置。
  先对完整榜单编号再搜索/分页，搜索不能让玩家变成搜索结果中的“第一名”。
- 对外显示 `displayName`，关联用规范化账户名；月榜分数来自所选月份记录，
  总榜来自总记录，不能混用。月份按 `Asia/Shanghai` 解释。
- 一场 A 对 B 展开为 A、B 两个玩家视角；同卡组总体胜率为 50%，
  先攻/后攻子集不能强制为 50%。返回胜数和样本数，供前端计算并说明分母。
- `g1FirstPlayer` 缺失或不属于双方的 Match 及其单局全部排除。
  单局须有反向镜像，且两行 `isFirst` 合法并相加为 1。
- 使用 SQL 聚合单局，不能整表加载到 Node.js 后过滤。
  `rowGroup::all` 的总 M 局包含所有对手，即使该类别未展示，不能改成可见矩阵列之和。
- 旧 `includeBranches` / family 推导与预期分组不符时，优先修正显式 `archetypeIds`；
  改统计或展示语义应有明确需求依据，不能为消除总数差额而缩小分母。
- 查询玩家只精确匹配，不创建账户。空/错误密码使用公开范围：当前月最近 `recentMatchLimit` 条记录；
  正确密码可查看所选月全部记录，每页 20 条。总/月摘要含按当前默认排序依据计算的完整榜单名次，
  缺少月榜记录时月排名为 `null`；摘要与全时期最近 `recentMatchLimit` 场积分曲线保留公开。
- 下载每次重新验证 Match 归属和可见范围，双方卡组只取 G1 `startDeckBuffer`；
  无快照返回不可用，不能改取后续换备牌组。比分从物理单局结果计算，不从积分猜测。
- HTTP 层必须以 POST 请求体传密码并使用 `Cache-Control: no-store`；
  服务返回值不含密码，权限判断不能只放在页面按钮上。

## 配置与缓存

- `config.default.json` / 本地 `config.json` 提供 `rankingBasis`、`cacheTtlSeconds`、`maxPageSize`、
  `recentMatchLimit`。后者默认 10，有效整数范围 10–20；越界按边界值处理，非法值使用 10。
  排行榜、统计、玩家查询和公开卡组下载权限检查均重新读取配置；无效 JSON 记录告警并沿用上次可用配置。
- 胜率默认缓存 45 秒；月份与实际展示分组决定复用，新 Match 提交后使对应月份失效。
  异步预热不能阻塞启动，维护 CLI 不预热，重启仅清空缓存。
- 卡组名称和分组热更新由 `deckClassifier` 管理，不能另做一份跨目录文件缓存。

## 验证

从 `srvprotianti` 根目录执行：

```text
node plugins/tests/plugin-tests.js
node plugins/tests/integration.test.js
```

按改动重点核对真实排名、月份边界、同卡组/先后攻分母、坏镜像排除、
公开/认证记录范围、他人 Match 下载拒绝及缺失 G1 快照。集成测试使用 SQL.js；
SQL 性能改动另需在合适的 PostgreSQL 数据上验证执行计划。

## 仅在对应任务补读

- 改公开 API 或统计定义：[Web 与统计契约](../../docs/WEB_AND_ANALYTICS_SPEC.md)。
- 改来源字段或镜像模型：[数据契约](../../docs/DATA_MODEL_AND_MIGRATION.md)。
- 改页面：[ladder-web 开发入口](../ladder-web/README.md)。
- 改展示分组：[DECK_DISPLAY_CONFIG.md](../deck_analysis/DECK_DISPLAY_CONFIG.md)。
