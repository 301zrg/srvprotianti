# PostgreSQL 首次建库与恢复验收

本目录解决“全新空库没有基础表，增量迁移无法直接运行”的部署缺口。生产仍保持
`synchronize=false`。所有命令只读取已提交的实体、锁定依赖和本目录的显式 DDL，
不会读取 `config/config.json`、插件本地 `config.json` 或管理员密码文件。

完整服务器、资源、录像联合备份和迁址步骤见
[运维指南](../../../ops/README.md)；本目录负责数据库结构与权限。

## 选择正确入口

| 场景 | 命令 | 会写什么 |
| --- | --- | --- |
| 部署前核对代码契约 | `check-contract` | 不连接数据库 |
| 新建、没有任何用户对象的专用数据库 | `init` | 一次事务创建完整结构、授权并验收 |
| 从完整 dump 恢复的新数据库 | `grant` 后 `verify` | `grant` 只改权限，`verify` 使用只读事务 |
| 已有数据库检查 | `verify` | 不改表、不改历史、不重置积分或连胜 |
| 旧库缺表、缺字段、错误历史 | 对应业务迁移 | 此工具拒绝代替增量迁移或猜测历史 |

`init` 对已有表、视图、序列、自定义函数或类型直接失败，事务回滚。
即使已有表是空的，也不能再次初始化。恢复录像与数据库时 **不得运行 `init`**，
也不得重跑连胜 `apply.sql`；后者会违背保留已累计连胜的要求。

## 初次部署

先在完整服务器代码根目录执行 `npm ci` 和 `npm run build`，准备 Linux 运行依赖。
数据库使用专用运行账户；管理员/结构所有者与运行账户分开。
当前部署目标是 PostgreSQL 17；以下工具也在隔离的 PostgreSQL 18.4 实例通过真实测试。

管理员通过 `psql` 创建专用账户与空库，例如：

```sql
CREATE ROLE srvpro_schema NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE srvpro_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- 使用 psql 的 \password srvpro_runtime 交互设置密码，不把密码写进 SQL 或 shell 历史。
CREATE DATABASE srvpro OWNER srvpro_schema TEMPLATE template0 ENCODING 'UTF8';
```

创建操作本身遇到同名账户或数据库应停止并核对，不删除或覆盖原对象。
`srvpro_schema` 只拥有数据库与结构，不允许登录。运行账户不能成为该所有者或其成员。

在代码根目录，设置管理员连接的标准 PostgreSQL 客户端环境变量：

```bash
export PGHOST=127.0.0.1
export PGPORT=5432
export PGUSER=postgres
export PGOPTIONS='-c role=srvpro_schema'
export PGPASSFILE=/secure/path/schema-admin.pgpass
# pgpass 内容由部署者私下设置；Linux 文件权限为 0600，不提交 Git。

node plugins/postgres-compat/deployment/schema.js check-contract
node plugins/postgres-compat/deployment/schema.js init \
  --database srvpro --runtime-role srvpro_runtime --confirm-empty srvpro \
  --report /secure/path/schema-init.json
```

`--database` 必须显式提供，连接后再次核对实际库名；`--confirm-empty` 必须与其一致。
`PGPASSWORD` 可供隔离测试或短期自动化使用；正式部署优先用私密 `PGPASSFILE` 或
Unix socket 认证。工具不接受带凭据的连接 URL，也不输出环境变量或连接选项。
管理员环境仅用于维护，不放进游戏服务的 systemd EnvironmentFile。
`PGUSER` 用管理员身份认证，`PGOPTIONS` 在本次连接切换到 NOLOGIN 结构所有者，
使新对象与后续 `--no-owner` 恢复的对象归 `srvpro_schema`。
管理员须有权切换该角色；本工具使用的 Node pg 已在真实实例验证支持此环境变量。

随后启用 `postgres-compat`，设 `synchronize:false`，让游戏服务使用
`SRVPRO_LADDER_PG_HOST/PORT/DATABASE/USERNAME/PASSWORD`，其中 USERNAME 为运行账户。
插件本地配置只需覆盖启用开关等非秘密参数；完整安全配置示例见运维指南。
使用本批宿主的 `maintenance-state.js` 与编译后的 `ygopro-server.js`：
宿主环境覆盖已排除这五个 `SRVPRO_LADDER_PG_*` 变量，防止它们被写回主配置或记录到日志。
自定义环境变量映射应避免与宿主通用 `SRVPRO_*` 映射重名。

## 完整结构与历史兼容

[bootstrap.sql](bootstrap.sql) 是可审查的完整 DDL，共 20 张当前运行表：
宿主 8 张、天梯 4 张、使用率 8 张。它已包含当前连胜字段与索引，
新环境无须先走历史修复、使用率增量建表和连胜增量迁移。
DDL 由工具放在有空库检查、事务和 PostgreSQL advisory lock 的流程中执行；
不要将文件单独当作普通升级 SQL 执行。

[entity-contract.json](entity-contract.json) 固定当前 TypeORM 映射。
`check-contract` 会比较实际已编译实体与快照，再比较完整 DDL。
实体以后改变时工具会拒绝部署，维护者须同时审查并更新对应显式迁移与此部署契约。
它覆盖当前两个拥有实体的插件，未来新增业务插件的实体必须补入本契约，不能假定自动兼容。

当前 PostgreSQL 显式迁移比 EntitySchema 更严格的差异已明确保留：

- `DuelLog` 主键是 `bigint`，天梯对应日志引用使用 `bigint`；历史单局主键、Match 引用和
  使用率样本/事实主键及引用沿用显式迁移的 `bigint`，不缩窄回 `integer`。
- 使用率卡片事实到样本的删除级联外键、天梯玩家/时间查询索引、单局日志索引及
  `duelCount/isFirst/isMain` CHECK 都纳入完整 DDL 与验证。
- 当前运行实体允许单局 `winnerName=NULL`，新库保留这一映射。
  已做历史修复的旧库 `winnerName NOT NULL`、三个单局标志缺省值缺失均可通过验证，
  并列为警告；当前结算写入明确提供这些字段。工具不会放松原库约束。
- `integer` 字段在历史库已扩为 `bigint`、字符串列比实体更长时允许保留；
  要求 `bigint` 的列仍是 `integer`、时间列类型改变、必需列/索引/外键/CHECK 缺失会失败。
  历史归档表可以保留，工具不会删除或自动注册它们。

## 恢复与权限

先用与来源匹配的 PostgreSQL 工具，将完整逻辑 dump 恢复到另一个空数据库，
使用 `pg_restore --exit-on-error --no-owner --no-privileges`，检查退出码。
不要覆盖原库，不把 PostgreSQL 18 的 dump 向 PostgreSQL 17 反向恢复。
重新设置结构所有者，再由管理员执行：

```bash
node plugins/postgres-compat/deployment/schema.js grant \
  --database srvpro_restored --runtime-role srvpro_runtime
node plugins/postgres-compat/deployment/schema.js verify \
  --database srvpro_restored --runtime-role srvpro_runtime \
  --report /secure/path/schema-restored.json
```

`grant` 在一个事务中对这 20 张表授予 SELECT/INSERT/UPDATE/DELETE，
对其自增序列授予 USAGE/SELECT，对 public schema 授予 USAGE。
它会撤销本专用数据库 public schema 上 PUBLIC 与运行账户的 CREATE，
不创建/改密码、不改变全局账户属性、不修改默认权限或历史行。
这会影响该数据库其他账户通过 PUBLIC 继承的 CREATE，因此只应用于专用游戏数据库。
归档表无需游戏运行账户访问；完整备份由有权限读取所有对象的维护者完成。

验收还检查：运行角色可 LOGIN/CONNECT、没有管理权限、没有表所有权或结构 CREATE，
必需列类型/空值/缺省值、完整有效的索引与唯一键、外键/已验证 CHECK、RLS、全部表的
CRUD 权限，以及每个生成 ID 的序列权限和下一值是否大于该列最大已有 ID。
结果含各表行数、错误、历史兼容警告和 PostgreSQL 版本，不含玩家行或凭据。
错误返回非零退出码；`init/grant` 的验收失败会回滚其本次事务。
输出报告的父目录须预先存在且当前维护账户可写；生成的 JSON 不作为公开仓库资料提交。
报告在事务提交后写入；如果只有报告写入失败，DDL/授权可能已经完成，先用 verify 核对，
不要清库重试 init。SQL 与结构/权限验收失败仍会回滚其事务。

若发现原运行账户拥有表或有管理员能力，应另建专用运行账户，保留原库并显式授权；
工具不自动剥夺全局权限或转移所有权。若序列错误，停服审计后由维护者显式修复，
不能让普通启动随意 `setval`。结构缺失按所属模块迁移解决，禁止临时打开 synchronize。

## 验证与可复现演练

不连接数据库的检查：

```text
node plugins/postgres-compat/deployment/schema.test.js
```

真实隔离 PostgreSQL 演练需要单独的测试实例，绑定 `127.0.0.1`，使用非 5432 端口，
不能指向正式实例。管理员允许创建测试角色和新数据库：

```bash
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=stage2_owner
unset PGOPTIONS
export SRVPRO_SCHEMA_TEST_CONFIRM=isolated
node plugins/postgres-compat/deployment/isolated-postgres.test.js \
  --pg-bin /usr/lib/postgresql/17/bin --report-dir /secure/path/pg-drill
```

演练创建带唯一前缀的合成数据源库、恢复库与运行角色，并保留它们供审查，
不会删除原库或调用正式服务器配置。维护者验收后停掉整个临时实例即可。
覆盖完整初始化、拒绝重复初始化、真实 TypeORM 在 synchronize=false 下向 20 张表写入、
运行角色无建表权限、CHECK/唯一约束/使用率级联、只读验证不重置积分与连胜、
历史结构兼容、缺索引/权限/错误序列拒绝、真实 pg_dump/pg_restore 和恢复后验收。

本机 Windows PostgreSQL 18 的演练不能替代目标 Linux/PostgreSQL 17 的首次演练，
也不证明 YGOPro 引擎、WSS、真人对局或公开录像回放已通过；这些在运维验收中分别记录。
