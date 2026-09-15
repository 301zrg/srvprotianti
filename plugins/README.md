# SRVPro 可选插件

插件宿主只加载含 `plugin.json` 的一级子目录。删除本目录中的插件后，主程序不会注册 TT 模式、天梯数据表、公开页面或公开 API。

## 配置

每个插件的安全默认配置在自身的 `config.default.json`。部署时如需覆盖：

1. 在同一插件目录创建 `config.json`。
2. 只写需要覆盖的字段；宿主会与默认配置深度合并。
3. `plugins/*/config.json` 已加入 `.gitignore`，不得提交账户或密码。

PostgreSQL 部署应启用 `postgres-compat/config.json`，连接字段也可以通过该插件默认配置中声明的环境变量传入。现有 `config/config.json` 只作为旧部署兼容输入，本次重构未修改该敏感文件。该插件默认设置 `synchronize: false`，普通启动不会自动修改数据库结构；正式结构变更使用经过确认的迁移 SQL。

## 插件职责

- `deck_analysis`（manifest ID `deck-classifier`）：YDK 模板解析、卡组类型识别，以及卡组元数据/展示分组的统一读取服务。
- `ladder-core`：TT 匹配、账户认证、单局捕获、事务结算、天梯翻译和天梯实体服务契约。
- `ladder-analytics`：排行榜、按玩家视角的卡组统计和短时进程缓存。
- `card-catalog`：逐份读取四语言 CDB，提供卡片类型、异画归并和本地化名称。
- `ladder-usage-analytics`：G1 卡组增量投影、卡片/卡组使用率汇总和细分类详情统计。
- `public-room-web`：无管理员密码的房间列表 API 与页面文件。
- `public-replay-web`：与天梯无关的公开录像文件列表、DuelLog 基础信息和下载 API。
- `ladder-replay-enrichment`：为公开录像注册天梯 G1 卡组类型、类型清单和筛选能力。
- `ladder-web`：JSON 页面路由、排行榜及统计 API。
- `postgres-compat`：数据库创建前应用可选 PostgreSQL 连接配置。

运行时插件不得直接 `require` 其他插件的实体或数据文件。天梯实体通过 `ladderCore.entities` /
`ladderCore.getRepository()` 取得；卡组元数据通过 `deckClassifier` 服务取得。公开录像基础插件不
依赖天梯，增强插件通过 `publicReplayWeb.registerEnrichment()` 组合能力。插件宿主只扫描一级
目录，因此这些插件保持平级，由 `plugin.json` 依赖表达初始化顺序。

## 事件时序

```text
G1 猜拳结束，胜者收到 SELECT_TP
  -> rps_winner（记录可空的 coinWinner）
YGOPro 判定 WIN
  -> duel_result（宿主复制所有有效对局席位；具体插件自行校验模式和人数）
  -> 尝试保存录像和 DuelLog
  -> duel_log_saved（成功时补充可空关联）
YGOPro 发送 DUEL_END 或宿主明确判定弃权
  -> room_deleted(room, scores, terminalOutcome)
  -> ladder-core 验证终局后在一个事务内提交积分、月份、Match 和镜像单局
  -> ladder_match_committed(matchId, monthKey)
  -> ladder-usage-analytics 为双方写入幂等样本、卡片事实和日/总汇总
```

录像缺失不会取消已经捕获的单局，也不会阻止 Match 结算。`gNumber` 和 `isSide` 不再由新代码读写。历史库使用 [202609-history-repair](./ladder-core/migrations/202609-history-repair/README.md) 在维护窗口中归档旧伪单局、从 DuelLog 恢复可靠单局并删除新表中的废弃字段。

正常完成的 Match 在入库前还会核对房间最终比分与逐局 WIN 事件；两者不一致时拒绝发放积分，避免错误结果扩散到用户、月份、Match 和统计表。没有 `DUEL_END` 或明确弃权证据的进程异常退出同样拒绝结算，不能把当前领先比分当成完整 Match。单局卡组类型始终沿用 G1 的未换备卡组类型。

## 验证

```text
npm test
npx tsc --noEmit
npm run build
```

`plugins/tests/integration.test.js` 使用内存数据库验证事务、镜像记录、同卡组胜率、玩家查询和
使用率投影，不连接正式数据库。生产 `synchronize=false` 时须先执行
`migrations/202609-player-usage/001-create-usage-projections.sql`，历史回填见
`ladder-usage-analytics/BACKFILL.md`。
