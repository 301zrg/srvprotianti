# SRVPro 天梯插件化版

基于 [MoeCube SRVPro](https://github.com/moecube/srvpro)，提供可选 TT 天梯、账户计分、
排行榜、卡组分类与使用率统计、公开房间/录像页面和 PostgreSQL 部署支持。
主程序保留通用协议与插件扩展点，业务位于 `plugins/`；
QQ/Discord 机器人分别位于 `services/qq-bot/` 和 `services/discord-bot/`，共用 `services/bot-core/`，独立运行。

## 从哪里开始

| 任务 | 入口 |
| --- | --- |
| 修改某个功能 | [开发入口与模块路由](AGENTS.md)，再读对应模块 README |
| 接手整体项目、准备上线 | [当前交接](docs/PROJECT_HANDOFF.md) |
| 新 Linux 安装、数据库与录像恢复、换机 | [运维指南](ops/README.md) |
| 了解运行拓扑、插件依赖与结算数据流 | [当前架构图解](docs/ARCHITECTURE.md) |
| 查规范、配置、运维或历史设计 | [文档索引](docs/README.md) |
| 宿主、主服务与插件生命周期 | [宿主说明](plugins/README.md) |
| 运行或修改 QQ/Discord 机器人 | [独立服务入口](services/README.md) |

## 目录

```text
srvprotianti/
├─ AGENTS.md                   全局短规则与任务路由
├─ ygopro-server.coffee/.js    主服务与通用钩子
├─ plugin-system.js           通用插件宿主
├─ data-manager/              数据连接与仓储扩展
├─ plugins/<模块>/README.md   模块开发入口及按需专题
├─ services/                 独立服务；入口为 services/README.md
│  ├─ bot-core/              机器人共享逻辑
│  ├─ qq-bot/、discord-bot/   两个平台的独立服务
├─ migrations/               跨模块显式迁移
└─ docs/                     交接、跨模块契约、部署与历史背景
```

## 开发命令

在本目录执行；主仓 CI 使用 Node.js 24，安装与资源要求见 [开发流程](docs/DEVELOPMENT_WORKFLOW.md#测试分类与入口)。

```text
npm ci
npm run build
python ops/scripts/ops.py catalog-fetch --destination plugins/card-catalog/databases --versions ops/versions.json
npm test
```

卡库获取命令需要网络和全新的目标目录；已有卡库时按 [卡片目录配置](plugins/card-catalog/CARD_DATABASE_CONFIG.md)
先核对固定版本，不覆盖现存目录。`npm test` 不需要正式部署配置；`npm start` 才启动游戏服务，
需另行准备 YGOPro 引擎、游戏数据、本地配置和数据库结构，步骤见 [运维指南](ops/README.md)。

构建同步 CoffeeScript/TypeScript 的生成 JavaScript。按改动选择类型检查、针对性测试和
客户端验收的方法见 [开发流程](docs/DEVELOPMENT_WORKFLOW.md)；纯文档修改不需要构建。
机器人使用独立 package.json、依赖与测试，见其 README。

生产升级前核实交接中的迁移、回填与真实客户端验收状态；代码实现和历史本地测试通过
不等于已上线。部署配置、凭据、CDB、日志和运行数据不随代码提交。

## 上游与许可证

[上游旧 README](docs/archive/UPSTREAM_README.md) 仅保留历史背景。
版权归 MoeCube Team 及其贡献者所有，沿用 [GNU AGPL v3.0](LICENSE)。

### 706 天梯网页项目声明

本仓库的 706 天梯网页及配套桌面助手均为开源、非盈利项目。若相关版权方提出要求，相关内容可能随时下架，敬请理解。
