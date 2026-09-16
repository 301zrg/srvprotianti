# 本体与插件解耦实施方案

> 状态：2026-09-16 已确认执行。本文件记录本轮重构边界；实际完成状态以 `PROJECT_HANDOFF.md` 为准。

## 1. 目标与不变量

本轮只处理已经确认的结构问题，不改变天梯计分、录像内容或公开页面的对外行为。必须保持：

- TT 仍为双人匹配，但双人限制属于 `ladder-core`，不写入通用 `duel_result` 钩子。
- 天梯房间开局前隐藏姓名、允许提前投降的效果不变。
- 天梯提示的五个现有语言版本与语言切换行为不变。
- `/api/replays` 在完整插件集下继续返回卡组类型，并支持按卡组类型筛选。
- 录像文件仍是录像列表和下载的权威来源；数据库只负责补充元数据。
- 录像保存和 `duel_log_saved` 关联仍留在现有同步等待链中。本轮不异步化、不重排，避免产生录像与对局关联不准确的风险。

## 2. 本体改动设计

### 2.1 插件翻译注册

`PluginHost` 增加通用 `registerTranslations()` 注册能力。插件在 `register` 阶段提交按语言组织的键值；宿主统一合并到 `ygopro.i18ns` 并重建翻译正则。

约束：

- 翻译键由插件拥有，`data/i18n.json` 只保留 SRVPro 通用文案。
- 禁止插件覆盖已有翻译键，避免加载顺序静默改变文案。
- `ladder-core/i18n.json` 承接现有 `ladder_*` 文案。

### 2.2 通用房间策略

`Room` 增加 `policy_overrides` 对象。宿主只识别行为含义，不识别天梯：

- `hideNamesBeforeStart`：开局前隐藏玩家名。
- `allowEarlySurrender`：允许随机模式在默认限制回合前投降。
- `allowConcurrentReconnects`：允许同一房间为多名断线玩家同时保留重连记录。
- `neutralOnAllReconnectTimeout`：所有对局玩家均断线且各自窗口耗尽时以无结算结果终止房间。

`ladder-core` 根据自身配置设置这两个策略。删除天梯导向的 `plugin_hide_names` 和语义相反的 `plugin_no_early_surrender`。

### 2.3 通用对局结果

宿主 `duel_result.players` 收集 `room.dueling_players` 中所有有效玩家，不再写死 `pos < 2`。插件按自身模式校验人数；`ladder-core` 仍要求恰好两人，因此天梯数据口径不变。

## 3. 插件边界设计

### 3.1 回放插件拆分

- `public-replay-web` 只负责扫描、分页、搜索、下载录像，并以 `DuelLog` 补充通用对局信息。
- 新增 `ladder-replay-enrichment`，通过 `publicReplayWeb.registerEnrichment()` 注册天梯卡组分类、卡组名称和筛选能力。
- `public-replay-web` 不再依赖天梯插件；未启用增强插件时，录像基础列表仍可使用。
- `ladder-web` 只依赖它实际调用的统计服务，不以依赖关系强制捆绑公开房间和公开录像插件。

当前插件加载器仅发现 `plugins/` 的一级子目录，因此不通过物理嵌套表达关系；使用清晰的平级名称和 manifest 依赖表达边界。

### 3.2 天梯实体契约

`ladder-core` 服务公开只读的 `entities` 映射和 `getRepository(name)`。运行时插件通过服务取得实体/仓储，不再 `require('../ladder-core/entities')`。

实体定义仍由 `ladder-core` 唯一拥有；迁移脚本和该插件自身测试可直接引用实体文件，跨插件运行时代码不可直接引用。

### 3.3 卡组元数据单一读取者

`deck-classifier` 负责读取并规范化：

- `deck_analysis.json`：卡组 ID、代码和多语言名称。
- `deck_display.json`：页面展示分组。
- `deck_templates/`：模板与分类规则。

它通过服务提供查询、列表、搜索和展示分组接口。分析、使用率和录像增强插件只消费服务，不各自读取同一 JSON。这样更换卡池时只有一个元数据加载边界。

## 4. 文件整理

- 删除已无调用且路径/API 已过时的 `SimpleMonitor.ps1`。
- 将根目录早期验证记录 `VERIFY.md` 移到 `docs/archive/VERIFY_LEGACY.md`，并注明它不是当前验收依据。
- 删除未承载文件的 `plugins/public-room-api/`、`plugins/public-replay-api/`。

## 5. 验收

- 单元/集成测试覆盖翻译冲突、通用多人 `duel_result`、房间策略、无天梯增强的公开录像与完整增强结果。
- 执行 `npm test`、`npx tsc --noEmit --pretty false`、`npm run build`。
- 构建后检查生成 JavaScript，确认 CoffeeScript 源码与运行文件一致。
- 最后更新 `plugins/README.md`、文档索引和 `PROJECT_HANDOFF.md`。
