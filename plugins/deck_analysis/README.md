# 卡组分类与元数据

本目录是卡组分类、模板和展示分组的开发入口。目录名为 `deck_analysis`，
manifest ID 为 `deck-classifier`，对外服务名为 `deckClassifier`；三者不要混用。
通用约束见 [AGENTS.md](../../AGENTS.md)；普通局部任务无需先读全部专题。

## 职责与边界

- `index.js`：解析 YDK、加载模板、分类，以及读取/搜索卡组元数据和展示分组。
- `deck_templates/*.ydk`：分类所需的模板；`deck_analysis.json`：细分类与四语言名称。
- `deck_display.json`：胜率矩阵的展示分组，不决定比赛中保存的细分类。
- `reclassify-database.js`：显式维护工具；普通插件启动不重写历史分类。
- manifest 显式依赖 `card-catalog`，在 `init` 阶段取得已就绪的 `cardCatalog` 服务。其他运行时插件通过 `deckClassifier` 访问本模块，
  不直接读取这里的 JSON、模板或内部函数。
- 本模块不写比赛结果、不提供 HTTP 路由，也不负责 CDB 卡片名称；卡片目录由 `cardCatalog` 提供。

## 必须保持的行为

- 分类条件是模板 `main + extra` 被实战 `client.main` 完整包含；宿主已将主卡与额外卡合并。
  模板和实战卡号都先通过 `cardCatalog.canonicalize` 归并异画，再比较重复张数；原画、不同异画的数量合计。
  模板两张同卡就要求至少两张；副卡不参与。本模块不直接读取 CDB。
- 中文卡片元数据不可用时初始化失败，不提供可能误判的分类服务；依赖分类器的天梯插件由宿主停用，独立插件仍可运行。
- 禁止把完整包含改成集合包含、相似度或 65% 重合。无命中返回配置的兜底 ID，当前为 4095。
- 文件名接受 `<ID>.ydk`、`<ID>-<序号>.ydk`、`<ID>_<序号>.ydk`；同 ID 多模板为“任一命中”。
  不同 ID 同时命中时仍按文件名排序取首个，新增模板须检查分类歧义。
- 模板下载只接受指定 ID 下已加载的精确文件名，不能接受路径或其他 ID 的文件。
  省略文件名时优先基础模板，否则返回序号最小的变体。
- `deck_analysis.json` 的显式 ID 是运行时依据，不从 ID 位段反推出业务含义。
  ID 会保存在数据库中；改名可更新四语言文案，改 ID 则涉及历史数据迁移。
- 整场 Match 采用双方 G1 未换备分类，G2/G3 不改变类型；冻结和落库由 `ladder-core` 负责。
- 分组成员优先使用 `archetypeIds`；旧 family/custom 推导仅作兼容。
  `行分组::all` 包含隐藏对手，不能以可见矩阵列之和替代。

## 配置与生效时机

- `config.default.json` 声明模板目录、元数据文件、展示文件和兜底 ID；本地 `config.json` 只写覆盖项。
- `deck_analysis.json`、`deck_display.json` 按文件修改时间热读；调用方应让变更进入缓存身份。
- 模板匹配计数和文件清单在初始化时加载；每次识别只为实战卡片增加一次内存归并查询。
  修改模板或归并规则后重启服务使分类和下载清单保持一致；原始 YDK 下载和对局快照保留原卡号。
- 改展示分组或名称不自动改历史分类。重跑历史分类需要可靠 G1 快照及独立维护流程；
  同步 Match、活动单局和已安装的使用率卡组汇总，不修改历史伪单局归档。

## 验证

从 `srvprotianti` 根目录执行，按改动范围选择：

```text
node plugins/tests/plugin-tests.js
node plugins/deck_analysis/classifier.test.js
node plugins/deck_analysis/reclassify-database.test.js
node plugins/tests/integration.test.js
```

前两项覆盖重复张数、多模板、元数据、异画归并、生命周期和下载边界；维护工具改动加重分类测试；
跨统计/录像契约改动加集成测试。维护工具的 `audit/simulate/apply` 不是普通测试命令。

## 仅在对应任务补读

- 调整元数据字段或卡组 ID：[json_structure.md](json_structure.md)。
- 调整展示分组：[DECK_DISPLAY_CONFIG.md](DECK_DISPLAY_CONFIG.md)。
- 更新历史分类：[RECLASSIFY_DATABASE.md](RECLASSIFY_DATABASE.md)。
- 改 G1 数据来源或保存字段：[数据契约](../../docs/DATA_MODEL_AND_MIGRATION.md)。
- 改统计 API 的分组口径：[Web 与统计契约](../../docs/WEB_AND_ANALYTICS_SPEC.md)。
