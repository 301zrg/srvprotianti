# ladder-replay-enrichment：录像天梯增强

本文件是录像卡组类型与筛选的开发入口；通用约束见 [AGENTS.md](../../AGENTS.md)。
本插件为基础录像接口追加能力，不拥有独立 HTTP 路由或数据库表。

## 职责与入口

- [index.js](./index.js)：注册列表筛选、类型清单、玩家分类和筛选缓存失效。
- [plugin.json](./plugin.json)：依赖 `public-replay-web`、`ladder-core`、`ladder-usage-analytics`、`deck-classifier`。
- `api.dataManager` 不可用时不注册增强能力。

## 服务契约

| 服务 | 使用方式 |
| --- | --- |
| `publicReplayWeb` | `registerEnrichment()` 扩展列表和玩家字段 |
| `ladderCore` | `getRepository('LadderMatchGame')` 读取已存单局分类 |
| `deckClassifier` | `classify()` 识别录像玩家初始牌组 |
| `ladderUsageAnalytics` | `getDeckMetadata()` / `listDeckMetadata()` 提供名称和类型清单 |

列表接受正整数 `deckTypeId`；其他值视为无筛选，响应追加 `deckTypeId` 和 `deckTypes`。
筛选查询 `LadderMatchGame.deckTypeId`，经可空 `duelLogId` 关联到 `DuelLog`，
将匹配文件名集合交给基础录像插件。这里复用天梯保存的 G1 分类。

玩家展示字段 `deckTypeId/deckNames` 当前由 `DuelLogPlayer.startDeckBuffer` 解码后识别，
只使用主卡组与额外卡组；缺失或解码失败时不追加字段。
展示分类与已存 G1 筛选来源不同，修改口径时必须核对两条路径。

## 关键不变量

- 通过服务获取其他插件能力，不直接引用其他插件的实体或配置文件。
- 筛选不逐份解析全部历史录像，也不新增录像索引表。
- 筛选缓存有效期 60 秒；收到 `ladder_match_committed` 时清空。
- 缺少 `duelLogId` 的单局不能命中此筛选；基础无筛选列表仍以文件为准。
- 调整卡组分类、元数据或提交事件时，检查名称、筛选结果与缓存是否同步。

## 配置与验证

当前没有独立 `config.default.json`；查询参数来自基础录像 API，类型元数据由服务提供。

从仓库根目录运行：

```text
node plugins/tests/integration.test.js
```

该测试加载完整插件组合，检查 G1 类型筛选、玩家增强字段和类型清单；
新增筛选分支或缺失关联处理时补充对应的回归样本。

## 按需补读

- 改增强协议：[public-replay-web/README.md](../public-replay-web/README.md)。
- 改已存分类或结算事件：[ladder-core/README.md](../ladder-core/README.md)。
- 改类型名称与清单：[ladder-usage-analytics/README.md](../ladder-usage-analytics/README.md)。
- 改分类算法：[deck_analysis/README.md](../deck_analysis/README.md)。
