# SRVPro 天梯插件化版

基于 [MoeCube SRVPro](https://github.com/moecube/srvpro)，提供可选 TT 天梯、账户计分、
排行榜、卡组分类与使用率统计、公开房间/录像页面和 PostgreSQL 部署支持。
主程序保留通用协议与插件扩展点，业务位于 `plugins/`；
QQ/Discord 机器人位于 `services/community-bot/`，独立运行。

## 从哪里开始

| 任务 | 入口 |
| --- | --- |
| 修改某个功能 | [开发入口与模块路由](AGENTS.md)，再读对应模块 README |
| 接手整体项目、准备上线 | [当前交接](docs/PROJECT_HANDOFF.md) |
| 查规范、配置、运维或历史设计 | [文档索引](docs/README.md) |
| 宿主、主服务与插件生命周期 | [宿主说明](plugins/README.md) |
| 运行或修改 QQ/Discord 机器人 | [机器人 README](services/community-bot/README.md) |

## 目录

```text
srvprotianti/
├─ AGENTS.md                   全局短规则与任务路由
├─ ygopro-server.coffee/.js    主服务与通用钩子
├─ plugin-system.js           通用插件宿主
├─ data-manager/              数据连接与仓储扩展
├─ plugins/<模块>/README.md   模块开发入口及按需专题
├─ services/community-bot/    独立机器人
├─ migrations/               跨模块显式迁移
└─ docs/                     交接、跨模块契约、部署与历史背景
```

## 开发命令

在本目录执行；需已准备 YGOPro 服务端、卡片数据和本地部署配置。

```text
npm install
npm run build
npm test
npm start
```

构建同步 CoffeeScript/TypeScript 的生成 JavaScript。按改动选择类型检查、针对性测试和
客户端验收的方法见 [开发流程](docs/DEVELOPMENT_WORKFLOW.md)；纯文档修改不需要构建。
机器人使用独立 package.json、依赖与测试，见其 README。

生产升级前核实交接中的迁移、回填与真实客户端验收状态；代码实现和历史本地测试通过
不等于已上线。部署配置、凭据、CDB、日志和运行数据不随代码提交。

## 上游与许可证

[上游旧 README](docs/archive/UPSTREAM_README.md) 仅保留历史背景。
版权归 MoeCube Team 及其贡献者所有，沿用 [GNU AGPL v3.0](LICENSE)。
