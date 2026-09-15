# SRVPro 天梯插件化版文档索引

> 状态基准：2026-09-16。
>
> 新维护者先阅读 `PROJECT_HANDOFF.md`；根 `README.md` 只负责项目入口，不替代交接、迁移
> 或部署文档。

## 首要文档

| 文档 | 用途 | 当前状态 |
| --- | --- | --- |
| [PROJECT_HANDOFF.md](./PROJECT_HANDOFF.md) | 当前实现、重要决策、部署前置条件、已知问题和延期事项 | 当前权威入口，持续更新 |
| [DEVELOPMENT_WORKFLOW.md](./DEVELOPMENT_WORKFLOW.md) | 插件化改动顺序、测试和提交检查 | 当前开发约定 |
| [REFACTORING_SPEC.md](./REFACTORING_SPEC.md) | 插件化目标、不可违反的边界、宿主与插件职责 | 当前架构约束 |
| [DECOUPLING_IMPLEMENTATION_PLAN.md](./DECOUPLING_IMPLEMENTATION_PLAN.md) | 本轮本体/插件解耦范围、不变量和验收设计 | 2026-09-16 已执行的设计记录 |

## 数据、Web 与功能规范

| 文档 | 用途 | 当前状态 |
| --- | --- | --- |
| [DATA_MODEL_AND_MIGRATION.md](./DATA_MODEL_AND_MIGRATION.md) | 天梯数据模型、生产迁移、审计和回退原则 | 当前迁移规范 |
| [WEB_AND_ANALYTICS_SPEC.md](./WEB_AND_ANALYTICS_SPEC.md) | 公开 API、排行榜和卡组统计口径 | 已实现部分的权威口径 |
| [WEB_PAGE_DEVELOPMENT_SPEC.md](./WEB_PAGE_DEVELOPMENT_SPEC.md) | 八个公开页面的路由、参数、字段、交互和回归要求 | 当前页面契约 |
| [LADDER_PLAYER_AND_USAGE_SPEC.md](./LADDER_PLAYER_AND_USAGE_SPEC.md) | 玩家查询、卡片/卡组使用率、详情页和性能设计 | 已实现，待生产迁移与历史回填 |
| [CARD_POOL_PORTING_GUIDE.md](./CARD_POOL_PORTING_GUIDE.md) | 将本项目适配为其他单一卡池实例时的修改点和环境隔离原则 | 当前部署指南 |

## 部署与安全

| 文档 | 用途 | 当前状态 |
| --- | --- | --- |
| [CADDY_HTTPS_DEPLOYMENT.md](./CADDY_HTTPS_DEPLOYMENT.md) | Windows、Caddy、HTTPS/Funnel、防火墙和回退方案 | 未来部署草案，尚未执行 |
| [DESKTOP_CLIENT_RESEARCH.md](./DESKTOP_CLIENT_RESEARCH.md) | 本地 PC 客户端的仓库边界、技术选型、YGOPro 启动与脚本更新方案 | 延期调研归档 |
| [SRVPRO2_MIGRATION_RESEARCH.md](./SRVPRO2_MIGRATION_RESEARCH.md) | srvpro2 优劣、兼容性闸门与迁移难度 | 长期延期调研归档 |

生产数据库的具体迁移入口还包括：

- [天梯历史修复](../plugins/ladder-core/migrations/202609-history-repair/README.md)
- [玩家与使用率表迁移](../migrations/202609-player-usage/README.md)
- [使用率历史回填](../plugins/ladder-usage-analytics/BACKFILL.md)

## 插件与配置说明

- [插件总览](../plugins/README.md)：插件加载、配置覆盖、职责和事件时序。
- [卡组分类 JSON 结构](../plugins/deck_analysis/json_structure.md)：卡组规则文件的字段结构。
- [卡组展示配置](../plugins/deck_analysis/DECK_DISPLAY_CONFIG.md)：大类展示分组和热更新。
- [卡组数据库配置](../plugins/card-catalog/CARD_DATABASE_CONFIG.md)：四语言 CDB 的部署位置和读取方式。
- [Web 插件配置](../plugins/ladder-web/WEB_CONFIG.md)：页面路由及 Web 配置。
- [历史卡组重新分类](../plugins/deck_analysis/RECLASSIFY_DATABASE.md)：模板变化后的显式数据处理。

## 历史与归档

| 文档 | 说明 |
| --- | --- |
| [archive/UPSTREAM_README.md](./archive/UPSTREAM_README.md) | 重构前的上游 SRVPro 根 README；不作为当前部署说明 |
| [FEATURE_INVENTORY.md](./FEATURE_INVENTORY.md) | 插件化初期的功能和耦合审计；部分内容已经过期 |
| [archive/VERIFY_LEGACY.md](./archive/VERIFY_LEGACY.md) | 早期验证记录；当前结论以交接文档第 7 节为准 |

## 文档维护规则

- 完成功能、改变当前状态、发现生产风险或确认延期事项时，更新 `PROJECT_HANDOFF.md`。
- 修改公开页面的路由、参数、接口字段、按钮、显示内容或隐私规则时，同步更新
  `WEB_PAGE_DEVELOPMENT_SPEC.md`；改变公开 API 或统计定义时还要更新
  `WEB_AND_ANALYTICS_SPEC.md`。
- 修改 schema 或历史数据处理方式时，同步更新 `DATA_MODEL_AND_MIGRATION.md`、对应迁移
  README、审计和回退步骤。
- 增删或改名文档时同步更新本索引；根 `README.md` 只保留稳定的一级入口。
- 当前阶段不移动现有规范文件。以后如按 `architecture/`、`features/`、`operations/` 分类，
  应在一次独立文档提交中完成移动并统一修复全部链接。
