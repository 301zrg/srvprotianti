# SRVPro 天梯插件化版

> 当前开发分支：`restructure2`。状态基准：2026-09-15。
>
> 本仓库仍处于上线前整理和验收阶段。接手、部署或修改代码前，请先阅读
> [项目交接文档](./docs/PROJECT_HANDOFF.md)。

## 项目定位

本项目基于 [MoeCube SRVPro](https://github.com/moecube/srvpro)，在保留原 YGOPro
服务器行为的基础上增加可选的 TT 天梯、账户与计分、排行榜、卡组分类、使用率统计、
公开房间/录像页面和 PostgreSQL 部署支持。

这些业务能力通过 `plugins/` 提供。删除可选插件后，主程序应退化为原 SRVPro 的功能和
安全行为；主流程只保留通用插件宿主、协议钩子和数据库扩展点。

## 文档导航

| 想了解的内容 | 入口 |
| --- | --- |
| 当前状态、部署前置条件、已知问题与延期事项 | [项目交接文档](./docs/PROJECT_HANDOFF.md) |
| 全部文档的用途和维护状态 | [文档索引](./docs/README.md) |
| 插件职责、配置覆盖和事件时序 | [插件说明](./plugins/README.md) |
| 插件化目标、边界和架构要求 | [重构规范](./docs/REFACTORING_SPEC.md) |
| 开发步骤与回归验收 | [开发流程](./docs/DEVELOPMENT_WORKFLOW.md) |
| 数据模型、正式迁移与回退原则 | [数据迁移规范](./docs/DATA_MODEL_AND_MIGRATION.md) |
| Web/API/统计口径与页面契约 | [Web 与统计规范](./docs/WEB_AND_ANALYTICS_SPEC.md)、[页面开发规范](./docs/WEB_PAGE_DEVELOPMENT_SPEC.md) |

原项目根 README 已归档到
[docs/archive/UPSTREAM_README.md](./docs/archive/UPSTREAM_README.md)，仅用于保留上游背景，
不代表当前分支的安装或部署方式。

## 目录概览

```text
srvprotianti/
├─ ygopro-server.coffee/.js     YGOPro 服务主流程与通用插件钩子
├─ plugin-system.js             插件发现、依赖和生命周期
├─ data-manager/                数据实体、仓储和连接
├─ plugins/                     可选业务插件及插件测试
├─ migrations/                  当前新增功能的显式数据库迁移
└─ docs/                        规范、交接、部署草案和历史资料
```

未来的 QQ/Discord 群机器人计划放在 `services/community-bot/`，作为同仓库、独立依赖、
可单独部署的服务，不放入会随游戏主进程加载的 `plugins/`。

## 开发与验证

当前代码已在 Node.js 24.15.0 下验证。还需要可用的 YGOPro 服务端、对应卡片数据和本地部署
配置，不能把示例配置直接用于生产。

```text
npm install
npm test
npx tsc --noEmit --pretty false
npm run build
```

`npm run build` 会同步生成 CoffeeScript/TypeScript 对应的 JavaScript；提交前应检查生成的
diff。开发环境启动入口为 `npm start`，但正式部署前还必须完成交接文档所列的数据库迁移、
历史回填、真实客户端冒烟测试和敏感配置检查。

## 当前边界

- HTTPS、云录像和 Challonge API 2.1 迁移均为延期事项，当前不应直接开启。
- QQ/Discord 群机器人尚未实现，设计为只消费公开 API 的独立服务。
- `config/config.json`、`config/admin_user.json` 和插件本地 `config.json` 可能包含部署信息，
  不得提交或复制到文档、日志和示例中。
- 根 `VERIFY.md` 与 `docs/FEATURE_INVENTORY.md` 含早期审计内容，判断当前状态应以交接文档为准。

## 上游与许可证

SRVPro 原项目版权归 MoeCube Team 及其贡献者所有。本项目沿用
[GNU Affero General Public License v3.0](./LICENSE)。
