# 历史 `realName` 清洗（2027xx，未执行）

旧宿主在 `duel_log_player."realName"` 里写的是 `昵称$密码`。新代码只写昵称；这个脚本把历史记录里
`$` 及之后的部分去掉。已在隔离副本演练，**生产库待执行**。

- 先决条件：新代码已上线（recover 入口在代码里停用，后台 `playername` 按昵称匹配）。
- `node scrub.js --dry-run`：只统计含 `$` 的行数。
- `node scrub.js --apply --confirm SCRUB-REALNAME [--batch-size 10000]`：按 id 分批
  `split_part("realName", '$', 1)`，每批一个短事务，避免长时间锁表；结束后含 `$` 的行数应为 0。
- 可重复执行。只输出计数，不输出任何 `realName`。
- **有意不可逆**：清洗后没有地方再需要密码部分。执行前确认已按 `_docs` 的约定保留所需备份，
  并在维护窗口内进行。
- 数据库连接同 `../2027xx-hash-passwords/README.md`。
