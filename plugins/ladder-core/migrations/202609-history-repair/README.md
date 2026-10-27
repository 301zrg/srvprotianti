# 天梯历史数据修复（202609）

这套迁移只处理能够由 `DuelLog` 唯一、可靠恢复的天梯单局。旧的
`ladder_match_game` 是按 Match 结果伪造的 G1 记录，迁移后会原样归档为
`ladder_match_game_legacy_202609`，不再参与业务查询，也不会被删除。

迁移不会重算或清空 `ladder_user`、`ladder_month_record` 的历史胜负和积分。
执行器会在事务内对这些字段逐行计算 SHA-256 摘要，迁移前后不一致就自动回滚。

## 恢复规则

只有同时满足以下条件的 DuelLog 会生成单局记录：

- 按房间名及 `duelCount` 从 1 重置的位置组成连续的 1～3 局比赛；
- 两名玩家、唯一胜者和唯一先攻者均完整，G1 有双方起始卡组 buffer；
- 玩家组合与 `LadderMatch` 完全相同；
- 最后一局胜者与 Match 胜者相同；
- 最后一局时间与 Match 入库时间相差不超过 30 秒；
- Match 与 DuelLog 比赛段是一对一的唯一匹配。

每个物理单局生成两条玩家视角记录。`isMain=1` 仅表示 G1；G2/G3 为 0。
已删除的 `gNumber`、`isSide` 不会进入新表。每名玩家只从 G1 的起始卡组
buffer 解析一次类型，并让 G2/G3 沿用该类型；主卡组与额外卡组一起匹配模板，副卡组不参与；
无法完整匹配模板时写入“其他卡组”ID 4095。

本地备份中先前审计结果应约为：1578 个可靠 Match、4043 个物理单局、
8086 条玩家视角记录。迁移后有 746 个仅保留 Match 的记录：其中 681 个 Match
对应现在的 1362 条伪单局，另外 65 个没有可恢复单局。线上仍在产生数据，因此正式
停机后的数字可能变化；应以停机后 `audit` 的结果为准，而不是以这些数字为硬条件。

## 文件说明

- `migrate.js`：唯一推荐入口；支持审计、事务模拟、正式执行和验收。
- `display-name-overrides.json`：无法从日志唯一判断大小写时的人工决定。
- `00-audit.sql`～`04-verify.sql`：执行器使用的分阶段 SQL。
- `rollback.sql`：只用于紧急交换新旧单局表，不能代替完整数据库恢复。
- `05-align-game-decks.sql`：已迁移数据库将所有 G2/G3 卡组类型校正为 Match 的 G1 类型。

所有命令均在 `srvprotianti` 根目录执行。执行器不会打印数据库密码，也不会修改
`config/config.json` 或 `config/admin_user.json`。

## 一、本地完整演练

### 1. 停服并制作可恢复备份

先停止 `node ygopro-server.js`。使用 PostgreSQL 管理员账号创建 custom-format 备份：

```powershell
$stamp = Get-Date -Format yyyyMMdd-HHmmss
pg_dump -h localhost -p 5432 -U postgres -W -Fc -f ".\srvpro-before-ladder-$stamp.dump" srvpro
```

`-W` 会由 `pg_dump` 自己提示密码，密码不会写进命令或仓库。确认命令退出码为 0，
并检查 dump 文件大小不是 0。

### 2. 只读审计

本地应用账号可以直接使用现有主配置做只读审计：

```powershell
node .\plugins\ladder-core\migrations\202609-history-repair\migrate.js audit --use-host-config --report .\ladder-audit-local.json
```

重点检查：

- `duplicate_normalized_users`、`duplicate_month_rows` 和 `duplicate_match_keys` 必须为 0；
- `displayNamesRequiringDecision` 应只包含已在 overrides 文件中确认的名字；
- `unresolvedDisplayNames` 必须为空；
- `rebuilt_game_rows` 应等于 `recoverable_duels * 2`；
- `match_only_rows` 可以大于 0，这些 Match 不会被伪造出单局。

应用账号的 `permissions.can_create_in_public` 可能为 `false`，这不影响只读审计；
`simulate/apply` 必须改用满足该权限检查的管理员连接。

全库的 `invalid_duel_logs` 可以大于 0；可靠筛选会排除它们。

### 3. 配置有 DDL 权限的连接

迁移需要 `ALTER TABLE`、`CREATE TABLE` 和 public schema 的 CREATE 权限。推荐使用
PostgreSQL 管理员执行，不要为了迁移长期扩大应用账号权限：

```powershell
$env:SRVPRO_LADDER_PG_HOST = 'localhost'
$env:SRVPRO_LADDER_PG_PORT = '5432'
$env:SRVPRO_LADDER_PG_DATABASE = 'srvpro'
$env:SRVPRO_LADDER_PG_USERNAME = 'postgres'
$env:SRVPRO_LADDER_PG_PASSWORD = Read-Host 'PostgreSQL password' -MaskInput
```

如使用受信任证书的 TLS 连接，可另设：

```powershell
$env:SRVPRO_LADDER_PG_SSL = 'true'
```

### 4. 事务模拟（必做）

```powershell
node .\plugins\ladder-core\migrations\202609-history-repair\migrate.js simulate --report .\ladder-simulate-local.json
```

模拟会真正执行建表、卡组解析、8086 类似规模的数据插入和全部验证，最后执行
`ROLLBACK`。输出中 `committed` 必须为 `false`；模拟结束后不会留下归档表或新数据。

### 5. 正式执行

确认模拟成功后执行：

```powershell
node .\plugins\ladder-core\migrations\202609-history-repair\migrate.js apply --confirm APPLY-LADDER-HISTORY-202609 --report .\ladder-apply-local.json
```

确认字符串用于避免误操作。所有 DDL 和数据写入都在同一个事务中；任何解析、数量、
约束、孤儿记录或历史积分摘要校验失败都会整体回滚。

### 6. 用应用账号独立验收

```powershell
node .\plugins\ladder-core\migrations\202609-history-repair\migrate.js verify --use-host-config --report .\ladder-verify-local.json
```

下列字段必须全部为 0：`missing_display_names`、`missing_match_keys`、
`invalid_duels`、`orphan_games`、`orphan_logs`。同时 `rebuilt_rows` 必须是
`physical_duels` 的两倍，`required_unique_indexes=3`、`required_game_columns=4`、
`retired_game_columns=0`、`deck_type_mismatches=0`、`match_key_nullable=NO`。

如果数据库已用旧版迁移器完成迁移，需要先执行一次 G1 卡组类型校正：

```powershell
& 'D:\software\PostgreSQL\18\bin\psql.exe' -h localhost -p 5432 -U srvpro -W -d srvpro -v ON_ERROR_STOP=1 -f '.\plugins\ladder-core\migrations\202609-history-repair\05-align-game-decks.sql'
```

该脚本只以 LadderMatch 已保存的 G1 类型校正对应单局，不修改胜负或积分；校验失败会回滚。

随后启动服务器并人工检查：

```powershell
node .\ygopro-server.js
```

检查天梯总榜/月榜、录像列表和下载、月份切换、Match/单局胜率，以及新 TT 比赛能否
继续写入两视角单局。完成后清除当前 PowerShell 会话中的密码：

```powershell
Remove-Item Env:SRVPRO_LADDER_PG_PASSWORD -ErrorAction SilentlyContinue
```

## 二、线上执行顺序

1. 提前部署代码但不要启动新版本。
2. 进入维护，停止游戏服务器和所有会写入上述六张表的任务。
3. 制作并校验一份新的 `pg_dump -Fc` 备份。
4. 对停机后的数据库重新运行 `audit`；不要照搬本地的行数。
5. 若出现新的大小写歧义，暂停迁移，人工确认后只修改
   `display-name-overrides.json`，再重新审计。
6. 以管理员连接运行 `simulate`。
7. 模拟成功后运行 `apply`，再以应用账号运行 `verify`。
8. 启动新版本并完成页面及一场 TT 实战冒烟测试。
9. 保留 dump 和 `ladder_match_game_legacy_202609`，不要立即清理。

执行期间会取得相关表的 ACCESS EXCLUSIVE 锁。停服能够避免锁等待，也能保证审计结果
与正式迁移使用同一批数据。

## 三、回退

`apply` 报错时执行器已经自动 `ROLLBACK`，无需人工清理。

若提交后才发现业务问题，首选：停止服务，并从迁移前的 custom-format dump 完整恢复。
可先恢复到一个新的数据库中验证：

```powershell
createdb -h localhost -p 5432 -U postgres -W srvpro_restore_check
pg_restore -h localhost -p 5432 -U postgres -W -d srvpro_restore_check .\srvpro-before-ladder-时间.dump
```

仓库中的 `rollback.sql` 只交换新旧 `ladder_match_game` 表，保留修复表供检查；旧表结构
与当前代码不完全兼容，所以只有在同时回退应用代码、且明确理解影响时才可以使用。

## 四、不会在本迁移中处理的内容

- 不根据 `LadderMatch` 重算 LadderUser 或月度胜负、积分；
- 不为无法可靠关联的 Match 猜测单局；
- 不删除旧伪单局归档；
- 不修复其它已登记的历史遗留问题；
- 不自动决定今后新出现的用户名大小写歧义。
