# 天梯密码批量转换（2027xx，未执行）

把 `ladder_user.pass` 里的旧明文逐行转换成 scrypt 哈希。只写好、测过，**没有在任何真实数据上执行**。

## 上线顺序（设计 6.2）

1. **兼容版首次发布**：部署新代码，`passwordHash.mode = "legacy"`（默认）。新账号仍存明文，
   改密码接口关闭，重置和转换脚本拒绝运行，登录两种格式都认。`realName` 新记录不带密码、
   全角 `＄` 建号拒绝、席位绑定结算、日志过滤、准入限流随这一版上线。
2. 上线前在实验机验证回退包“兼容版 + `frozen`”：B3 副本，覆盖哈希与明文混合账号、清洗前后的
   `realName`、recover 拒绝、后台按昵称筛选。
3. 兼容版稳定几天后，在发布监控等到房间空的时候：
   - 停服；**单独导出 `ladder_user` 表**（含明文，到期日：本步完成后 7 天删除；只用于数据损坏时人工核对）；
   - 把 `passwordHash.mode` 改成 `"hashed"`，启动；`plugins/ladder-core/config.json` 必须让服务账户可读
     （实验机曾因 root 独占权限读取失败，服务按失败保护沿用旧设置，日志只有一条 `ladder_security_config_invalid`）；
   - `node migrate.js --dry-run`，核对计数；
   - `node migrate.js --apply --confirm HASH-LADDER-PASSWORDS`；
   - 结果里 `remaining non-empty legacy plaintext` 必须为 0；`damaged` 非 0 时逐个人工处理。
4. 维护窗口里分批清洗历史 `realName`（`../2027xx-scrub-realname`）。
5. HTTPS 确认生效后把 `passwordChange.enabled` 改成 `true`。

## 行为

- 只处理按严格解析判定为旧明文的非空值；已有哈希和空值跳过；前缀像哈希但格式不对的行列为“损坏”，
  让运行失败，不跳过。
- 每行用条件更新 `WHERE name = ? AND pass = 旧值`；被改密码或重置抢先时重读重试，不覆盖新凭据。
- 每次写入前重读配置：模式离开 `hashed`（例如切到 `frozen`）立即停止。
- 可重复执行；第二次 `--apply` 不会写任何行。
- 输出只有计数和损坏/冲突账号的规范化昵称，不输出密码或哈希。

## 回退（设计 6.2）

- 从 `hashed` 只能进 `frozen`，不能回 `legacy`（库里有哈希时配置写 `legacy` 也按 `frozen` 处理）。
- `frozen`：双格式认证照常，暂停建号和一切凭据变更，改密码接口返回 503，脚本拒绝运行。
  日志出现 `ladder_password_frozen_quiesced` 且确认转换/重置脚本已退出，才算回退完成。
- **不再用导出整列恢复 `pass`**，也不再退回兼容版之前的代码。
- 数据库连接：`SRVPRO_LADDER_DATABASE_URL`，或 `SRVPRO_LADDER_PG_HOST / _PORT / _DATABASE / _USERNAME / _PASSWORD`。
