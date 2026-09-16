# 卡组模板更新后的数据库重分类

本工具按照当前 `deck_templates/*.ydk` 重新分类已有天梯 Match。模板文件可命名为
`<卡组类型ID>.ydk`、`<卡组类型ID>-<序号>.ydk` 或 `<卡组类型ID>_<序号>.ydk`；同一 ID 的任意模板完整命中时，
都识别为该 ID。每名玩家只使用该 Match 的 G1 起始牌组，G2/G3 换备后的牌组不会改变类别。工具同步更新以下业务字段：

- `ladder_match.playerADeckTypeId`、`playerBDeckTypeId`；
- 对应所有 `ladder_match_game.deckTypeId`、`opponentDeckTypeId`。
- 若使用率迁移已完整安装，还会更新 `ladder_usage_sample.deckTypeId`，并从全部样本重建
  `ladder_usage_daily_deck`、`ladder_usage_total_deck`。

`duel_log_player` 只保存原始牌组，不保存类别，因此不会修改。历史归档表
`ladder_match_game_legacy_202609` 是已停用的伪单局审计数据，也不会修改。

三张使用率相关表全部不存在时，工具兼容尚未安装使用率迁移的部署并跳过它们；若只存在其中一部分，工具会中止，要求先修复迁移，
不会在不完整的派生结构上继续写入。卡片事实和卡片汇总不含卡组类型，因此不需要随本次重分类修改。

多模板只表示同一类型的替代命中条件。若一个实战牌组同时完整包含不同类型的模板，分类器仍按模板文件名排序取首个命中；
因此新增变体后必须先查看 `audit` 的类别迁移分布，且模板设计应尽量避免不同 ID 之间的包含歧义。

无法唯一找到 G1 DuelLog、G1 双方牌组不完整、玩家不一致或牌组 buffer 损坏的 Match 会保持原值，并在报告的
`skippedByReason`/`skipped` 中列出。工具不会根据旧类别或 G2/G3 猜测。

## 推荐执行顺序

所有命令均从 `srvprotianti` 根目录执行。先停止游戏服务器和其他数据库写入任务，并制作 PostgreSQL 备份。

通过环境变量连接数据库：

```powershell
$env:SRVPRO_LADDER_PG_HOST = 'localhost'
$env:SRVPRO_LADDER_PG_PORT = '5432'
$env:SRVPRO_LADDER_PG_DATABASE = 'srvpro'
$env:SRVPRO_LADDER_PG_USERNAME = 'srvpro'
$env:SRVPRO_LADDER_PG_PASSWORD = Read-Host 'PostgreSQL password' -MaskInput
```

也可在明确需要使用本机主配置时给命令增加 `--use-host-config`。工具不会输出密码或修改配置文件。

先运行只读审计：

```powershell
npm run deck:reclassify -- audit --report .\deck-reclassify-audit.json
```

模板 SHA-256 会覆盖纯数字模板及 `-序号`/`_序号` 变体。检查 `count`（模板文件数）、`deckTypeCount`（有模板的类型数）、
`changedMatches`、`changedGameRows`、`changedUsageSampleRows`、类别迁移清单和跳过原因。然后运行会真实更新但最终回滚的模拟：

```powershell
npm run deck:reclassify -- simulate --report .\deck-reclassify-simulate.json
```

模拟成功且 `verification` 两项均为 0 后，再正式提交：

```powershell
npm run deck:reclassify -- apply --confirm APPLY-DECK-RECLASSIFICATION --report .\deck-reclassify-apply.json
```

`simulate` 和 `apply` 都会锁定天梯及 DuelLog 表；使用率表存在时也会锁定三张相关派生表。所有更新、汇总重建和校验均在
同一个事务内完成，任何错误都会整体回滚。正式执行后重启服务，再查看卡组统计和使用率页面。若服务未重启，已有进程内统计
缓存最多可能继续显示约 45～60 秒旧结果。
