# M 局连胜迁移与启用

用户口径：所有玩家从功能上线后的 0 连胜开始计数，不读取或恢复历史连胜。
只播上线后新结算的比赛，历史比赛不补播。
该迁移不修改总/月积分、胜负或 Match。生产继续使用 `synchronize=false`，普通启动不迁移。

## 初始化规则

迁移只给用户表新增 `currentWinStreak`（非空，默认 0）、`lastMatchId`（初始为空）和连胜索引。
现有账户和新账户都从 0 开始，第一场获胜变为 1，第一场失败仍为 0；整场 M 获胜加一，失败归 0。
上线后累计的次数持久保存，跨月或重启不会清零。

上线后首次连赢 5 场才进入 60 秒播报窗口；之后每次观察到新的获胜结果继续播报。
迁移不扫描 Match，不回填历史连胜，不修改原总/月积分、胜场或负场。

## 执行顺序

先在隔离 PostgreSQL 数据副本演练，生产执行应指定目标库并取得部署授权。
以下命令从项目根目录执行。Windows 示例使用本机 PostgreSQL 18、`postgres` 角色和 `srvpro` 数据库；
隔离演练或实际数据库名不同时，替换 `-d srvpro`，并按部署环境调整连接参数，不在脚本内保存凭据。
必须显式指定 `-d`：未指定数据库且没有环境变量覆盖时，`psql` 默认连接与用户名同名的库，
因此 `-U postgres` 通常会连到 `postgres` 库，导致脚本找不到 `ladder_user` / `ladder_match`。

无需先审计历史数据。停止游戏服务，备份数据库，再执行加字段迁移和验收：

```powershell
 psql -X -h localhost -p 5432 -U postgres -d srvpro -v ON_ERROR_STOP=1 -f '.\plugins\ladder-core\migrations\202610-win-streaks\apply.sql'
 psql -X -h localhost -p 5432 -U postgres -d srvpro -v ON_ERROR_STOP=1 -f '.\plugins\ladder-core\migrations\202610-win-streaks\verify.sql'
```

`audit.sql` 保留为可选的连接和字段预检，只查看元数据，不扫描历史 Match：

```powershell
 psql -X -h localhost -p 5432 -U postgres -d srvpro -v ON_ERROR_STOP=1 -f '.\plugins\ladder-core\migrations\202610-win-streaks\audit.sql'
```

如果指定数据库后仍提示表不存在，先执行只读检查：

```powershell
 psql -X -h localhost -p 5432 -U postgres -d srvpro -v ON_ERROR_STOP=1 -c "SELECT current_database(), current_schema(), current_setting('search_path') AS search_path, to_regclass('ladder_match') AS match_table, to_regclass('ladder_user') AS user_table;"
```

`match_table` 和 `user_table` 都应非空。若为空，确认目标库和表所在 schema；
脚本使用未限定 schema 的表名，连接的 `search_path` 必须包含实际业务 schema。

迁移只有两个新列和一个索引，全部在事务内；重复执行会报错并回滚，不会覆盖已经开始累计的连胜。
验收 `invalidStreaks=0`、`invalidLatestMatches=0`；游戏服务重启前 `deliveryMarkers=0`。
游戏服务首次启动前还应有 `nonzeroStreaks=0`，即所有账户从 0 开始；开始结算后该值可以大于 0。
上线期间检查已有总/月胜负和积分没有变化，进房显示从上线后累计的次数。
部署新游戏代码后，再部署新 QQ/Discord Bot，按 [服务入口](../../../../services/README.md) 中对应部署手册启用群/频道。
只读 `GET /api/ladder/streaks` 只返回最近 60 秒内仍处于连胜的最新结果。

## 权限与回退

迁移角色需对 `ladder_user` 具有 ALTER/建索引权限；验收需对 `ladder_user` 和 `ladder_match` 具有 SELECT 权限。
未新建业务表，运行账户沿用原表 SELECT/INSERT/UPDATE 权限；仍应在隔离库验证实际运行角色。

先关闭 Bot 连胜开关并停止新游戏服务，部署旧版本，再执行 `rollback.sql` 删除新增字段和索引。
回退只删除连胜数据，保留已有 Match、总/月胜负和积分；重新加字段上线后连胜重新从 0 开始。
如果需要恢复迁移时的完整数据库状态，使用停服前备份，不把结构回退当成整库恢复。
