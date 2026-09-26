# 文档索引与维护约定

日常开发从 [AGENTS.md](../AGENTS.md) 选一个模块入口。只有整体交接/上线才先读
[PROJECT_HANDOFF.md](PROJECT_HANDOFF.md)，不要求每次修改通读本目录。

## 文档分层

| 层级 | 内容 | 何时阅读/更新 |
| --- | --- | --- |
| 根 README | 项目定位、运行与一级导航 | 初次了解项目；入口变化时更新 |
| 根 AGENTS | 通用约束、任务到模块的路由 | 日常任务入口；全局规则/模块变化时更新 |
| 模块 README | 职责、源码入口、边界、不变量、验证 | 日常局部修改；对应契约变化时更新 |
| 模块专题 | 详细配置、页面契约、回填/迁移操作 | 任务涉及该主题时 |
| docs 跨模块规范 | 架构、开发流程、共享数据/API 定义 | 改动跨边界时 |
| 当前交接 | 整体状态、未解决问题、上线前置条件 | 接手整体项目、部署、状态变化时 |
| 历史设计/归档 | 当时背景、方案、诊断与测试证据 | 追溯原因时；不作为当前待办 |

这个划分按代码责任归属，不按 Markdown 长度机械拆文件。插件文档放在插件内；
独立服务文档放在服务内。跨模块协议留在 `docs/`，避免每个插件复制一份。

## 当前全局规范

| 文档 | 用途 |
| --- | --- |
| [当前交接](PROJECT_HANDOFF.md) | 项目状态、上线前仍需核实事项与延期决策 |
| [架构规范](REFACTORING_SPEC.md) | 宿主、插件、独立服务、生命周期和数据所有权 |
| [开发流程](DEVELOPMENT_WORKFLOW.md) | 按影响选择验证和交付要求 |
| [数据契约与迁移](DATA_MODEL_AND_MIGRATION.md) | 身份、Match/单局、事务、派生数据和历史修复边界 |
| [API 与统计契约](WEB_AND_ANALYTICS_SPEC.md) | 跨模块接口、统计分母和可见性 |

模块清单见 [开发入口](../AGENTS.md)，宿主机制见 [plugins/README.md](../plugins/README.md)。
不要沿模块文档中的每个链接递归阅读；跨模块修改只补读实际涉及的提供者与消费者契约。

## 配置、页面与操作专题

| 主题 | 入口/归属 |
| --- | --- |
| 页面路由、参数、交互和回归 | [ladder-web 页面规范](../plugins/ladder-web/WEB_PAGE_DEVELOPMENT_SPEC.md) |
| Web 配置 | [ladder-web 配置](../plugins/ladder-web/WEB_CONFIG.md) |
| 卡组分类元数据 | [分类 JSON](../plugins/deck_analysis/json_structure.md) |
| 展示分组 | [分类展示配置](../plugins/deck_analysis/DECK_DISPLAY_CONFIG.md) |
| 模板更新后历史重分类 | [重分类手册](../plugins/deck_analysis/RECLASSIFY_DATABASE.md) |
| 四语言 CDB | [卡片目录配置](../plugins/card-catalog/CARD_DATABASE_CONFIG.md) |
| 天梯历史修复 | [ladder-core 迁移](../plugins/ladder-core/migrations/202609-history-repair/README.md) |
| 使用率建表、权限与回退 | [根迁移目录](../migrations/202609-player-usage/README.md) |
| 使用率历史回填 | [usage 回填](../plugins/ladder-usage-analytics/BACKFILL.md) |
| QQ/Discord 开发、运行、排查 | [服务 README](../services/community-bot/README.md)；选型背景见 [DESIGN](../services/community-bot/DESIGN.md) |
| 其他单一卡池适配 | [卡池指南](CARD_POOL_PORTING_GUIDE.md) |
| HTTPS/Funnel/Caddy | [部署草案](CADDY_HTTPS_DEPLOYMENT.md)，实施前重新核实环境 |

原 `docs/WEB_PAGE_DEVELOPMENT_SPEC.md` 和 `docs/COMMUNITY_BOT_DESIGN.md` 仅保留跳转，
避免旧链接失效；新链接指向模块内原文。移动文档不代表移动插件或部署脚本。

## 历史设计与归档

| 文档 | 状态 |
| --- | --- |
| [整理前交接快照](archive/PROJECT_HANDOFF_2026-09-26.md) | 保留原始细节、部署批次与验证记录，不是当前规则 |
| [玩家/使用率设计](LADDER_PLAYER_AND_USAGE_SPEC.md) | 已实施功能的历史设计与安全讨论，不再维护第二份页面/API 现状 |
| [解耦实施计划](DECOUPLING_IMPLEMENTATION_PLAN.md) | 已执行的设计记录，不能重复当作待办 |
| [早期功能审计](FEATURE_INVENTORY.md) | 插件化前的耦合快照，部分描述已失效 |
| [桌面客户端调研](DESKTOP_CLIENT_RESEARCH.md) | 独立后续项目背景 |
| [srvpro2 调研](SRVPRO2_MIGRATION_RESEARCH.md) | 长期延期研究 |
| [上游 README](archive/UPSTREAM_README.md) | 上游背景，不代表当前安装步骤 |
| [旧验证记录](archive/VERIFY_LEGACY.md) | 历史证据，不代表当前版本通过 |

## 写作与维护规则

1. **一项详细规则一个维护位置。** 模块 README 可提炼关键不变量并链接依据；
   不复制完整字段表、迁移命令或页面说明。提供者负责契约，消费者记录依赖。
2. **先写当前行为，再写原因。** 概念、代码位置、默认配置与命令要能相互验证；
   设计建议明确标“待实现/历史”，不能写成当前能力。
3. **入口保持短。** 全局入口和普通模块 README 尽量约一百行以内；这是编辑目标而非硬性限制。
   模块较复杂时将长配置表/操作步骤放专题，并写明触发阅读的条件，不为凑目录造空文档。
4. **变更按职责同步。** 内部重构不改变契约时无需改交接；样式修改无需改数据规范。
   API、字段或统计变化才同步受影响的共享契约；新增/迁移文档时修复相关索引和相对链接。
5. **明确状态与证据。** 代码完成、本地测试、客户端/平台验收、生产部署分开记录。
   验证记录带日期/版本/范围，不保留“当前全部通过”这样的无条件断言。
6. **保留必要历史，停止持续抄写。** 普通修改由 Git diff/提交说明记录；
   值得长期保留的设计取舍写在所属模块或专门历史记录，交接不追加逐日流水账。
7. **冲突必须核实。** 明确需求、现行契约、代码与测试一起判断；历史记录不覆盖当前规则。
   不为了让文档显得一致而悄悄改变已确认的业务语义。

## 本次结构调整的原因

旧交接同时承担目录树、规范、功能清单、部署批次和变更日志，日期与后续追加内容容易矛盾；
全局页面规范、设计稿与 API 规范又多次描述同一功能。改为模块入口和按需专题后，
局部任务通常只需“全局短规则 + 一个模块 README”，涉及接口或数据时再补读契约。
保留原交接快照与旧路径跳转，避免精简时丢失诊断背景或打断已有引用。
