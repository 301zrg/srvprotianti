# 公开 API 与统计语义契约

本文只维护跨插件 HTTP 接口、数据口径和访问边界。页面交互归
[ladder-web](../plugins/ladder-web/README.md)，实体与历史修复归
[数据模型规范](DATA_MODEL_AND_MIGRATION.md)。只在改动这些边界时阅读/更新本文。

## 1. 接口归属与兼容

原 `/api/getrooms`、`/api/replay...` 保持宿主原有鉴权和响应行为；既有监控继续使用原接口。
公开页面使用下表独立接口。房间/录像地址是对应插件的默认配置，改部署地址时需同步消费者。

| 接口 | 提供方与语义 |
| --- | --- |
| `GET /api/public/rooms` | `public-room-web`：脱敏的公开房间列表 |
| `GET /api/public/replays` | `public-replay-web`：文件列表、搜索、分页与通用对局信息；天梯字段由 `ladder-replay-enrichment` 补充 |
| `GET /api/public/replay/<filename>` | `public-replay-web`：下载固定录像目录中的 `.yrp` |
| `GET /api/ladder` | `ladder-web` → `ladderAnalytics.ranking`：总/月排行 |
| `GET /api/ladder-config` | `ladder-web` → `ladderAnalytics.rankingBasis`：当前默认排序 |
| `GET /api/ladder-deck-stats` | `ladder-web` → `ladderAnalytics.deckStats`：月份卡组胜率矩阵 |
| `POST /api/ladder/player` | `ladder-web` → `ladderAnalytics.profile`：玩家摘要、曲线和可见记录 |
| `POST /api/ladder/player/deck` | `ladder-web` → `ladderAnalytics.profileDeck`：可见 Match 的 G1 初始卡组 |
| `GET /api/ladder/usage/cards` | `ladder-web` → `ladderUsageAnalytics.cardUsage`：卡片使用率 |
| `GET /api/ladder/usage/decks` | `ladder-web` → `ladderUsageAnalytics.deckUsage`：细分类使用率 |
| `GET /api/ladder/deck-search` | `ladder-web` → `ladderUsageAnalytics.searchDecks`：至多 20 个四语言模糊候选 |
| `GET /api/ladder/deck-detail` | `ladder-web` → `ladderUsageAnalytics.deckDetail`：细分类使用率、胜率、对手和前 10 玩家 |
| `GET /api/ladder/deck-template` | `ladder-web` → `deckClassifier.getTemplate`：分类器已加载的模板 |
| `GET /api/example-decks` | `ladder-web`：请求时读取示例分组/四语言名称/文件名 |
| `GET /example_decks/<filename>` | `ladder-web`：示例 `.ydk` 下载 |

页面路由只归 `ladder-web/routes.json`，不得放回宿主业务分支。新增路由必须避免冲突、受保护
API 覆盖和目录越界；现有页面路由直接读取本地配置，不应把这些约束描述为宿主已完成的统一
验证能力。`/assets/<filename>` 已限制固定 `web/assets` 目录、单层 basename 和 `.css/.js`。

## 2. 排行与玩家访问范围

`/api/ladder` 接受 `type=total|month`、`month=YYYYMM`、`rankingBasis=points|wins|diff|winRate`、
`search/page/pageSize`。未传或非法排序回退至每次请求合并读取的 `ladder-analytics/config*.json`。
排行在完整榜单确定后再搜索和分页；历史月读取对应 `LadderMonthRecord`。返回的 `name` 是显示名
（无显示名时回退规范键），等级分字段为 `duelPoints`；玩家摘要中的等级分字段才是 `points`。
当前默认每页 50 条、上限 100；公开响应不回传认证密码。

`POST /api/ladder/player` 接受 JSON `player/password/month/page`，精确查找规范化玩家：

- 密码正确时返回所选月全部记录，20 条分页；未认证时仅当前月最近 `recentMatchLimit` 条，其他月份无记录。
- 总/月摘要含完整榜单中的名次，按当前 `rankingBasis` 排序；缺少月榜记录时月名次为 `null`。
  总/月摘要和全时期最近 `recentMatchLimit` 场积分曲线公开，不随历史月份记录权限隐藏。
  `recentMatchLimit` 由 `ladder-analytics` JSON 热更新，默认 10，限制在 10–20，响应返回生效值。
- 记录含双方积分变化、赛后积分、细分类、G1 先攻及可空的猜拳胜者；猜拳胜者不能由先攻推断。
- 时间使用 `LadderMatch.createTime` 结算时间；比分来自单局结果，无法可靠确定时不猜测。
- 摘要的卡组胜负只覆盖可追溯的 Match，不能把更早的用户累计胜负猜测分配到卡组。

`POST /api/ladder/player/deck` 接受 `player/password/matchId/side=player|opponent`，每次重新检查
Match 归属和公开/认证可见范围。只取 G1 `DuelLogPlayer.startDeckBuffer`；缺失返回 404。
当前下载名为 `<清理后的规范玩家名>-<matchId>.ydk`。两个玩家端点的成功响应均设置
`Cache-Control: no-store`；密码不回传、不放 URL、业务日志或持久化浏览器存储。

## 3. 录像与下载边界

录像目录是列表和下载的权威来源，DuelLog 只补充元数据；没有数据库关联的历史文件仍可见。
列表接受 `search/page/pageSize`，默认每页 20、上限 100。基础响应提供文件名/大小/时间、局号、
可空胜者和玩家当前卡组 buffer；缺失元数据不能阻塞文件下载。

启用 `ladder-replay-enrichment` 后：

- `deckTypeId` 筛选复用 `LadderMatchGame` 保存的 G1 分类，60 秒缓存，新 Match 提交时清除。
- 当前页的分类名称由各 DuelLogPlayer 的 `startDeckBuffer` 按当前模板识别。它与筛选所依据的
  Match G1 分类不是同一数据来源，不能声称全部展示结果都固定为 G1；后续改变需显式统一契约。
- 普通列表只分类当前页，不扫描全部历史卡组 buffer；不为此新增统计表。

录像下载仅接受单层 `.yrp` 文件名，拒绝路径穿越，提供附件响应头和 Unicode 文件名编码。
录像页生成卡组下载名 `<录像名>-g<duelCount>-<玩家原始名称>.ydk`；不同于玩家战绩的 G1 下载。
用户名进入文件名时必须清理非法字符并限制长度。公开接口不暴露真实 IP、账号密码或房间密码；
房间名 `$` 后部分应在服务端/页面双重隐藏。

`/api/ladder/deck-template?deckTypeId=<ID>[&filename=<文件名>]` 只接受该类型已加载的精确
模板文件名，不接受路径或其他类型的模板。省略文件名时优先 `<ID>.ydk`，否则最小编号变体，
缺失返回 404。详情的 `selected.templateFiles` 是可下载文件的权威列表。

## 4. 胜率统计口径

一个参赛玩家/卡组视角是一个样本。A 对 B 产生两个视角；A 对 A 同时贡献一胜一负，因此
同卡组总体胜率为 50%。先后攻各自只统计相应视角，不强制各自为 50%。

| 来源 | 处理规则 |
| --- | --- |
| `LadderMatch` | 双方展开为两个视角；Match 先后攻以 G1 为准 |
| `LadderMatchGame` | 直接使用双镜像视角；`isFirst=1/0` 表示先/后攻，`isMain=1/0` 表示主/备牌局 |
| 指定对阵 | 按 `deckTypeId -> opponentDeckTypeId` 统计 |
| 无有效 G1 先攻者的 Match | 整场及其单局均不进入胜率统计 |
| 单局先后攻不可靠 | 必须有两条相反视角且 `isFirst` 恰好一方为 1，否则不进任何单局胜率统计 |

所有胜率返回胜场分子和参与分母，不能只返回百分比。零分母保留无样本语义。
12 项指标为 Match/全部单局/主牌局/备牌局分别乘以综合/先攻/后攻。
矩阵行表示己方、列表示对手；`::all` 统计全部对手，含展示分组之外的类型，不能只合计可见列。
比赛中的双方分类固定为 G1 未换备类型，分类与权威数据写入规则见数据模型规范。

## 5. 使用率与细分类详情

所有时期按 `Asia/Shanghai`：`today` 是中国自然日，`week` 从周一开始，`month` 为 `YYYYMM`，
`all` 读取全量汇总。使用率按每场 Match 双方各一个初始卡组样本计数，不按单局重复计数。

- 卡片参数为 `metric=monster|spell|trap|extra|side`、`period/month/page/lang`；只返回前 200 项，
  默认 50 项分页（配置只可降低这两个上限）。主卡类型与额外/副卡分区分别统计。
- 卡片按 alias 归并；未知卡、解码失败或归并后全卡组同卡超过 3 张的快照不进卡片统计。
  `usageRate = deckCount / validCardDecks`，同时返回 1/2/3 张投入数量。
- 卡组类型使用率的分母为 `allDecks`；G1 快照缺失仍可贡献类型样本。响应同时返回
  `coverage.validCardDecks/allDecks`，不能让缺失快照默默缩小卡组使用率分母。
- 四语言卡名来自 `card-catalog`，中文负责卡片类型和 alias，其他语言缺名回退中文。
  卡片资料不可用时投影会跳过，需依照模块回填手册补齐，不能声称覆盖全部原始 Match。
- `deckTypeId=4095` 为“其他”，列表固定末尾，不提供详情页。
- 详情接受 `deckTypeId/q/period/month`，返回所选细分类的使用率、12 项胜率、对手和玩家榜。
  “胜率前 10 玩家”须满足 `minPlayerMatches`（默认 25）；该配置按文件修改时间热更新并进入
  详情缓存身份。对手列表“其他”也固定末尾。

日/全量使用率表属于可重建派生数据，普通启动只处理新 Match，不自动回填历史。
建表/回填操作见 [BACKFILL.md](../plugins/ladder-usage-analytics/BACKFILL.md)，不能由页面请求触发。

## 6. 元数据、性能与查询约束

`deckClassifier` 唯一读取卡组元数据、展示分组和模板。元数据/展示分组按文件修改时间热更新；
模板仍是分类器启动时加载的文件。统计、使用率、录像增强消费服务，不各自重复读取 JSON。
介绍页 `example-decks.json` 按请求读取；已打开页面要刷新/重新请求才取得新值。

- 胜率使用数据库过滤和 SQL 聚合；禁止读整张 `LadderMatchGame` 再在 Node.js 中筛选。
- `ladder-analytics` 当前对所有月份均用可配置 TTL（默认 45 秒），缓存包含展示分组身份；
  新 Match 使对应月份失效，启动后异步预热当月，不阻塞游戏服务。历史月份没有永久缓存。
- 使用率查询读日/全量汇总；卡组详情在限定时期内对 Match/单局 SQL 聚合，默认缓存 60 秒，
  最多 64 个键。进程缓存丢失不影响权威比赛数据，可从数据库重建。
- 玩家 ID、搜索值、月份等用参数绑定；指标、时期、语言、排序字段通过服务端白名单映射，
  不直接拼接用户输入为 SQL。保留分页上限、稳定次序，新增查询应考虑缓存容量和并发成本。
- 不把旧设计中的未来性能目标当成已完成能力。扩大索引或给胜率新增持久化快照前，先取得
  真实数据规模、慢查询和 `EXPLAIN ANALYZE`；快照设计需算法版本、水位和失效/重建机制。

HTTP 只是当前部署选择，POST 不提供链路加密。HTTPS、密码存储升级等部署债务的当前状态见
[交接入口](PROJECT_HANDOFF.md)，不因日常页面任务重复实施历史备选方案。
