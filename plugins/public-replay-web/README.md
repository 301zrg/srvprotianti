# public-replay-web：公开录像基础接口

本文件是录像列表和下载的开发入口；通用约束见 [AGENTS.md](../../AGENTS.md)。
基础录像能力不依赖天梯插件；页面属于 `ladder-web`。

## 职责与入口

- [index.js](./index.js)：扫描录像文件、补充 `DuelLog` 元数据、处理下载与增强服务。
- [plugin.json](./plugin.json)：无插件依赖；`api.dataManager` 不可用时不注册接口或服务。
- 录像目录来自宿主 `settings.modules.tournament_mode.replay_path`，相对进程工作目录解析。

## HTTP 与服务契约

| 默认接口 | 行为 |
| --- | --- |
| `GET /api/public/replays` | 接受 `page`、`pageSize`、文件名 `search`；返回 `replays/total/page/pageSize` |
| `GET /api/public/replay/:filename` | 下载目录中的 `.yrp` 文件 |

列表按文件名倒序排列；每项有名称、大小、修改时间、局数、胜者和玩家。
`DuelLog` 只补充元数据；没有关联记录的历史文件仍可列出和下载。
玩家基础字段为 `id` 与 `deckbuffer`，增强插件可以补充字段。

通过 `api.provide('publicReplayWeb', ...)` 提供 `registerEnrichment(provider)`：

- `prepareList(query)` 可返回 `matchingReplayNames: Set` 与顶层 `response`；多个集合取交集。
- `enrichPlayer(player)` 返回要合并到公开玩家对象的字段。
- 提供者至少实现一个方法；不得覆盖基础字段来改变既有语义。

## 关键不变量

- 文件目录是录像可下载性的依据；缺少数据库关联不能隐藏现存文件。
- 按元数据名 `DuelLog` 获取仓库，避免顶层加载实体早于数据库类型初始化。
- 下载只接受单个 `.yrp` 文件名；保持路径穿越检查和错误状态码。
- 中文文件名使用 ASCII 安全的 `filename` 与 UTF-8 `filename*` 响应头。
- 天梯分类与筛选通过增强服务组合，不能反向依赖天梯实体或私有文件。

## 配置与验证

[config.default.json](./config.default.json) 定义列表/下载路径及分页，默认每页 20、上限 100；
部署覆盖写同目录 `config.json`，更改路径时同步消费方。

从仓库根目录运行：

```text
node plugins/tests/plugin-host.test.js
node plugins/tests/integration.test.js
```

检查包括无天梯服务时基础插件可用、孤立录像文件可见及中文文件名下载。

## 按需补读

- 改卡组筛选或增强字段：[ladder-replay-enrichment/README.md](../ladder-replay-enrichment/README.md)。
- 改录像页面：[ladder-web/README.md](../ladder-web/README.md)。
- 改宿主录像记录：`data-manager/DataManager.ts` 的 `saveDuelLog()` 与相关实体。
