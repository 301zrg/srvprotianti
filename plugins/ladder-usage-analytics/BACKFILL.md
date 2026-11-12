# 使用率历史回填

普通启动只增量处理新结算 Match，绝不扫描历史表。本工具用于已存在 Match 的库补齐派生样本，
不会重建已有样本的卡片事实，也不会重算积分。它会读取目标环境私有宿主/插件配置并连接其数据库；
以下命令须由部署者在核对目标、备份和停写条件后执行，不属于普通离线测试。

全新空库按 [PostgreSQL 部署工具](../postgres-compat/deployment/README.md) 创建完整结构，
没有历史 Match 时不需要回填；完整 dump 恢复后先授权并验收，不重复执行建表 SQL。
已有库首次增加使用率功能时按以下顺序操作：

1. 停服并备份 PostgreSQL。
2. 若尚未安装使用率结构，执行 `migrations/202609-player-usage/001-create-usage-projections.sql`；
   已有完整结构则跳过建表，先验收结构/权限。如果建表管理员与 Node
   数据库账号不同，再用同目录 `grant-runtime-role.psql` 授权；否则 audit 会报“对表
   `ladder_usage_sample` 权限不够”。
3. 先审计：`npm run ladder:usage-backfill -- audit --use-host-config`。
4. 模拟模式只报告预计缺口，不写数据库：
   `npm run ladder:usage-backfill -- simulate --use-host-config`。
5. 正式回填：
   `npm run ladder:usage-backfill -- apply --use-host-config --confirm APPLY-LADDER-USAGE-BACKFILL`。

工具每批读取 100 个 Match，并逐个提交；中断后可以安全重跑，
`(matchId, playerName)` 唯一约束会跳过已完成样本。回填期间建议保持 Node 服务停止，避免与实时增量
投影竞争。输出的 `after.samples` 正常应等于 `matches * 2`；缺少 G1 卡组只会令该样本
`cardValid=0`，不会阻止卡组种类使用率计数。
