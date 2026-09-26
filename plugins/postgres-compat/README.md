# postgres-compat：PostgreSQL 连接适配

本文件是 PostgreSQL 启动配置的开发入口；通用约束见 [AGENTS.md](../../AGENTS.md)。
插件负责数据库创建前的连接配置，不拥有业务实体，也不执行迁移。

## 职责与入口

- [index.js](./index.js) 的 `configure(api)` 在宿主建立数据库连接前修改 `api.runtime.databaseConfig`。
- [plugin.json](./plugin.json)：无插件依赖。
- [config.default.json](./config.default.json)：可提交的默认连接字段与环境变量名。

## 配置契约

| 情况 | 行为 |
| --- | --- |
| 插件 `enabled: true` | 使用插件 `connection`，再应用已配置且非空的环境变量覆盖 |
| 插件关闭、宿主已有 PostgreSQL 连接 | 保留原连接字段，仍应用本插件的 `synchronize` 策略 |
| 插件关闭、宿主非 PostgreSQL | 不修改连接 |

适配时强制 `type: 'postgres'`；端口转为数值，缺省回退 5432。
必须有 `database` 和 `username`。宿主历史开关 `settings.modules.mysql.enabled`
也会置为 `true`；该开关名称不代表适配后的实际数据库驱动。

## 关键不变量

- 默认 `enabled: false`、`synchronize: false`；普通 PostgreSQL 启动不自动改表。
- 只有插件配置明确写 `synchronize: true` 才允许自动同步；不要以此替代生产迁移。
- 实体属于各自业务插件，须在建连接前注册；结构变更提供迁移与回退 SQL。
- 保持旧连接配置兼容，不把旧部署的凭据复制进文档或可提交文件。
- 环境变量覆盖仅在插件 `enabled: true` 时生效，不能误写成覆盖所有旧部署。

## 配置与验证

部署覆盖写同目录 `config.json`。默认环境变量映射为
`SRVPRO_LADDER_PG_HOST/PORT/DATABASE/USERNAME/PASSWORD`（完整名称见默认 JSON）。
诊断优先核对字段、配置来源和启用条件，不输出真实连接串或密码。

从仓库根目录运行：

```text
node plugins/tests/plugin-tests.js
```

现有断言检查旧 PostgreSQL 的安全默认值，以及启用插件后的驱动和宿主开关；
这些是配置逻辑测试，不证明真实 PostgreSQL 连通性或迁移成功。

## 按需补读

- 改宿主加载时序：`plugin-system.js`、`ygopro-server.coffee` 的数据库初始化。
- 改表结构或生产迁移：[DATA_MODEL_AND_MIGRATION.md](../../docs/DATA_MODEL_AND_MIGRATION.md)。
- 改某业务表：对应插件的 README、实体与迁移文件。
