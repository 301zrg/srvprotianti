# 玩家战绩与使用率迁移

正式 PostgreSQL 的 `synchronize` 必须保持 `false`。停止 Node 服务并备份数据库后执行：

```powershell
psql -v ON_ERROR_STOP=1 -d <数据库名> -f .\migrations\202609-player-usage\001-create-usage-projections.sql
```

如果迁移使用 `postgres` 等管理员账号，而 Node 使用权限较低的独立账号，还必须由管理员显式
授予本批表和序列权限。`<Node数据库用户名>` 应填写 Node 实际连接 PostgreSQL 时使用的
`username`，不是数据库名：

```powershell
psql -v ON_ERROR_STOP=1 -d <数据库名> -v app_role=<Node数据库用户名> -f .\migrations\202609-player-usage\grant-runtime-role.psql
```

脚本只授权本批八张可重建统计表、五个自增序列及 `public` schema 的使用权，不会把其他表
或管理员权限一并开放。末尾三列都应显示 `t`。如果建表账号和 Node 账号相同，则本来已经是
表 owner，一般无需执行授权脚本。

建表并确认运行账号权限后再启动服务；此后新结算的 Match 会自动写入增量统计。旧 Match 不会在普通启动时自动
回填，须按 `plugins/ladder-usage-analytics/BACKFILL.md` 显式执行回填工具。迁移 SQL 使用
`IF NOT EXISTS`，但仍建议先在数据库副本验证。

如需回退，先停服并恢复升级前备份（首选）；若只需删除本批可重建统计表，可执行
`rollback.sql`。它不会删除 `ladder_match`、玩家积分或 DuelLog，但会永久移除已经生成的使用率
投影，之后重新上线必须再次回填。
