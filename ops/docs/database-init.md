# PostgreSQL 空库初始化与已有库分支

生产正常启动保持 `synchronize:false`。本批显式初始化工具位于服务端
`plugins/postgres-compat/deployment/`，从当前实体导出审阅契约后，用固定 SQL 创建全部 20 张表。
它不读取本地私密 config.json，不自动扫描后执行历史迁移，不修改既有积分或连胜。

## 选择正确的路线

| 现状 | 操作 |
| --- | --- |
| 全新环境，无账号和录像 | 新建角色/空数据库 → check-contract → init → verify →游戏验收 |
| 完整旧库和录像迁机 | 新空目标数据库 → 联合 restore → grant/verify；不先 init |
| 正在运行的旧库缺字段或约束 | 先备份、只读 verify 收集差异 → 审查对应增量迁移 →停写后执行明确变更 |
| 只缺派生统计 | 对照使用率/统计契约审查回填，不能用初始化或历史修复代替 |

新库 bootstrap 包括宿主账号/禁用/随机比分/云录像/单局日志，天梯用户/月记录/Match/单局，
以及八张使用率表、序列、外键、索引和约定 CHECK。历史修复脚本曾使用 bigint 引用、
更强 NOT NULL 和额外索引，验证器明确识别兼容差异，不自动缩窄数据类型。

## 角色与空库

本例 database=`srvpro_1103`，schema owner=`srvpro_schema`（不允许 LOGIN），
runtime=`srvpro_runtime`（LOGIN，无管理员能力）。更换名字时同步 private 配置和备份计划。
在新机本地 PostgreSQL 管理身份下执行；这些命令不用于接管正在使用的库。

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1
```

```sql
CREATE ROLE srvpro_schema NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE srvpro_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE srvpro_operator LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT srvpro_schema TO srvpro_operator;
\password srvpro_runtime
\password srvpro_operator
CREATE DATABASE srvpro_1103 OWNER srvpro_schema TEMPLATE template0 ENCODING 'UTF8';
\connect srvpro_1103
ALTER SCHEMA public OWNER TO srvpro_schema;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE srvpro_1103 TO srvpro_runtime;
GRANT CONNECT ON DATABASE srvpro_1103 TO srvpro_operator;
\q
```

交互式 `\password` 避免密码进入 shell 命令历史。
operator 是独立运维身份，继承 schema owner 权限，供完整读取、恢复与 grant 使用；
不能给 runtime 此成员关系，也不能把 operator 凭据交给游戏进程。
恢复目标库由管理员事先创建；operator 的 NOCREATEDB 不阻碍对已创建目标进行恢复。
现场另有不同 owner、归档对象或全局扩展时需单独授予足够权限并验收，不能假定此例覆盖任意库。
恢复时数据库 encoding/collation/ctype 优先匹配 manifest 的源环境；
源库 Windows locale 与 Linux不相同不能直接复制字符串名称，需在新库选可用 locale 并核对排序/唯一性。
不要把源库 PG data 目录从 Windows 拷到 Linux；使用逻辑 dump。

## 空库工具

`schema.js` 用标准 PGHOST、PGPORT、PGUSER、PGPASSWORD/PGPASSFILE，
这些是操作者连接变量，与游戏服务的 `SRVPRO_LADDER_PG_*` 分开。
只在源码对应 application 中运行；实体变了但 SQL/契约没同步时 check-contract 会失败。

```bash
cd /srv/srvprotianti/releases/server-1103-20261011/application
node plugins/postgres-compat/deployment/schema.js check-contract
sudo install -d -m 0700 -o postgres -g postgres /var/lib/postgresql/srvprotianti-reports
sudo -u postgres env PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres PGOPTIONS='-c role=srvpro_schema' \
  /opt/node24/bin/node plugins/postgres-compat/deployment/schema.js init \
  --database srvpro_1103 --runtime-role srvpro_runtime --confirm-empty srvpro_1103 \
  --report /var/lib/postgresql/srvprotianti-reports/schema-init.json
```

`PGOPTIONS` 在管理员连接后切换 schema owner，因此对象归属 `srvpro_schema`，
而不是 runtime 或 postgres。报告目录只给本次执行身份可写。
不得为省事将私有备份目录改为全员可读写。
`--confirm-empty` 必须与 database 完全一致；SQL 会在事务中拒绝任何用户对象。
再次对已建好的库 init 必须失败，工具没有覆盖、DROP 或清空分支。

授权只授予所需表 CRUD、schema USAGE、生成序列 USAGE/SELECT。
runtime 不能是表/序列 owner，不能通过成员关系取得 owner 权限，不能建永久对象。
若发现 runtime 属于旧超级用户/owner，改用独立 runtime 角色；不临时关闭检查。

## 验证连接和运行权限

```bash
REPORT_DIR=$(mktemp -d)
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_runtime \
  /opt/node24/bin/node plugins/postgres-compat/deployment/schema.js verify \
  --database srvpro_1103 --runtime-role srvpro_runtime \
  --report "$REPORT_DIR/schema-runtime.json"
```

使用该执行身份可写的私有报告目录，密码只通过 .pgpass/PGPASSFILE 或临时环境传入。
verify 是只读检查，退出 0 且 `ok:true` 才通过。它检查字段、类型、默认值、主键、
唯一/外键/索引/CHECK、序列和运行角色权限。警告要按内容审阅，不能只数 20 张表。
接着用游戏服务真实注册测试账号并完成一场 TT Match，检查账号、积分、连胜、Match/单局与使用率。

## 已有库缺口

只先运行 verify，不执行 init、同步 DDL 或 `202610-win-streaks/apply.sql`。
恢复完整旧库后，连胜、总/月积分和事实来自备份，不从零重新开始。
verify 报缺列/索引时，查服务端对应模块 README 和 migration，列出准确差异及升级顺序；
没有足够原始事实时保留“未知”，不要猜补胜者、Match 或录像关联。

`grant` 可在结构符合当前契约后重新授予目标 runtime：

```bash
node plugins/postgres-compat/deployment/schema.js grant \
  --database srvpro_1103 --runtime-role srvpro_runtime --report /private-staging/schema-grant.json
```

grant 不创建表，不重置数据；由单独 owner/管理员运行，并在同一事务内验证，不符合时回滚授权操作。
外键依赖其他 schema、扩展或额外归档表时同时移交其 DDL/权限；本工具的 20 表契约不等于
任意现场扩展都会自动兼容。

## 错误定位

| 现象 | 优先检查 |
| --- | --- |
| contract mismatch | 是否漏传新 EntitySchema/生成实体 JS；实体和 reviewed SQL 是否配套 |
| init requires empty | 是否误把已有/已恢复库当新库；不要删除对象强行通过 |
| runtime owns table/can CREATE | owner/runtime 是否混用、角色成员关系或 PUBLIC CREATE |
| missing sequence/permissions | 是否完整恢复 schema/序列，是否执行目标角色 grant |
| bigint/default/NOT NULL warning | 是否已识别历史迁移的增强结构；结合模块契约审阅，不自动改写 |
| 中文卡名/使用率缺失 | 查 card-catalog 的四语 CDB 和 metadataAvailable，非建表工具能解决 |

SQL 或结构/权限验收失败会回滚初始化事务。报告在提交后写入，若只是报告路径/写入失败，
数据库可能已成功初始化；先用 verify 核对，不得清库或重新 init。
恢复分支失败保留新库供诊断，换另一个全新库重试。
正式 PostgreSQL 17 验收与本机 PostgreSQL 18 实测分开记录，见 [validation](validation.md)。
