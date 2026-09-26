# 项目开发入口

适用范围：本目录及子目录。日常任务先读本文件，再读下表中对应的一个模块 README；
只在触及其他模块契约、迁移或部署时补读相关专题，不递归展开所有链接。
文档帮助定位约束，实施前仍需查看目标源码和相关测试。

## 全局约束

- 修改限于本项目；同级 `../srvpro/` 是只读行为基准。保留用户已有的未提交改动。
- 未明确授权时，不读取、修改或提交 `config/config.json`、`config/admin_user.json`、
  插件/服务的本地 `config.json`；示例与默认值不得含凭据。日志、录像、dump 和运行数据不提交。
- 宿主只承载通用协议、生命周期、插件机制；TT、计分、分类、统计和页面业务留在所属插件。
  外部平台机器人是独立服务，位于 `services/`。
- 运行时跨插件通过声明的依赖和 `api.provide` / `api.get` 协作，不能直接读取对方内部文件。
  插件缺失或禁用不能破坏无依赖功能；宿主改动要覆盖无插件场景。
- CoffeeScript/TypeScript 是对应生成 JS 的修改入口，修改后编译并检查产物 diff。
  原生 JS 插件直接修改 JS；机器人沿用其现有 ESM，不强制改成 CommonJS。
- 沿用目标文件的风格，避免整文件格式化。新增插件 JS 使用 CommonJS、`'use strict'`、
  两空格缩进；非显然的协议、并发、事务逻辑注释说明原因。
- 新配置提供安全默认值、字段说明和边界校验。已有不需要配置的插件无需为了目录齐全造配置。
- 插件自有业务表必须有对应 EntitySchema，在连接前注册；生产 `synchronize=false`，
  schema 变更配套显式迁移、验收和回退/恢复说明。没有授权不执行生产数据写入。
- 不从缺失或矛盾证据猜测历史值。接口不得泄露密码、IP 或未授权卡组；公开下载校验根目录与文件名。
- 按改动影响选验证：文档检查链接和 diff；逻辑改动跑针对性测试；跨模块/宿主改动跑主仓测试。
  协议结果、结算、统计公式或权限变化必须有能区分修改前后行为的回归样本。
- 只更新发生变化的契约归属文档。局部修复不向交接文档追加流水账；新增上线阻塞或解除阻塞才改交接。

## 按任务选择入口

| 任务/目录 | 先读 |
| --- | --- |
| 主服务、房间/重连、单局结束、插件宿主、通用 DataManager | [宿主与插件入口](plugins/README.md) |
| TT 认证、计分、Match/单局记录 | [ladder-core](plugins/ladder-core/README.md) |
| 卡组识别、模板、分类/展示元数据 | [deck_analysis](plugins/deck_analysis/README.md) |
| 排行榜、玩家查询、卡组胜率 | [ladder-analytics](plugins/ladder-analytics/README.md) |
| 使用率投影、卡组详情、回填 | [ladder-usage-analytics](plugins/ladder-usage-analytics/README.md) |
| 卡片名称、类型、异画、CDB | [card-catalog](plugins/card-catalog/README.md) |
| HTML/CSS/浏览器交互、页面路由、天梯 HTTP 接口 | [ladder-web](plugins/ladder-web/README.md) |
| 公开房间 API | [public-room-web](plugins/public-room-web/README.md) |
| 公开录像扫描/下载 API | [public-replay-web](plugins/public-replay-web/README.md) |
| 录像的天梯分类增强 | [ladder-replay-enrichment](plugins/ladder-replay-enrichment/README.md) |
| PostgreSQL 连接兼容 | [postgres-compat](plugins/postgres-compat/README.md) |
| QQ/Discord 机器人 | [community-bot](services/community-bot/README.md) |

表中未覆盖的任务先用路径/符号搜索定位，再读最近的模块说明；无需遍历全项目文档。
增加模块时补充 README 和这张路由表。不要把所有模块说明复制到本文件。

## 何时补读全局文档

- 新增插件、修改依赖/宿主生命周期：[架构规范](docs/REFACTORING_SPEC.md)。
- 不清楚如何选择验证或交付：[开发流程](docs/DEVELOPMENT_WORKFLOW.md)。
- 跨模块字段、schema 或历史数据处理：[数据契约与迁移](docs/DATA_MODEL_AND_MIGRATION.md)。
- 跨模块 HTTP 接口、统计公式或可见性：[API 与统计契约](docs/WEB_AND_ANALYTICS_SPEC.md)。
- 接手整体项目或准备部署：[当前交接](docs/PROJECT_HANDOFF.md)。
- 查找其他专题或历史背景：[文档索引](docs/README.md)。

发现文档和代码矛盾时，用源码、测试及明确需求核实，在本次范围内修正文档或实现；
不要把历史设计的“待实现”直接当作新任务，也不要仅凭现有实现推翻已确认的业务约束。

