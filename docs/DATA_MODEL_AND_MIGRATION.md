# 天梯数据模型与正式数据迁移规范

## 1. 基本原则

- 代码迁移和历史数据修复分为两个阶段。
- 插件化完成前不修改正式数据，也不根据猜测回填缺失字段。
- 正式服务器仍在产生新数据，因此迁移工具必须支持明确截止水位并可重复执行。
- Codex 只生成 SQL 或维护脚本及验证命令，由维护者在正式服务器执行。
- 所有脚本必须提供 dry-run 或只读预检模式、事务边界、影响行数和执行后校验。
- 不在应用启动时隐式执行破坏性 schema 或历史数据迁移。

## 2. 用户身份

`LadderUser` 保留两个名称字段：

- `name`：小写规范化键，用于唯一性、认证和不区分大小写查询。
- `displayName`：玩家注册时原始大小写，用于页面和对局展示。

`displayName` 的历史回填以 DuelLog 中唯一出现的原始写法为自动来源。没有来源或存在
多种写法时必须由维护者在迁移配置中明确决定，不能按出现频率猜测。本次已确认的四项
人工覆盖记录在 `plugins/ladder-core/migrations/202609-history-repair/display-name-overrides.json`。

## 3. 月记录

`LadderMonthRecord` 必须对 `(name, monthKey)` 建立唯一约束。

月份统一为 `YYYYMM`。历史月份榜单只读取对应的月记录，不能依赖 `LadderUser` 当前月快照。

## 4. Match 记录

`LadderMatch` 一行表示一场完整 Match，至少包含：

- 月份。
- 双方规范化名称和展示名称。
- Match 胜者和败者。
- 双方卡组类型。
- 双方结算前、结算后等级分和变化值。
- 第一局先攻者。
- 可选的猜拳或硬币结果。
- 可为空的录像/日志关联。
- 创建时间和用于幂等结算的唯一业务标识。

Match 记录、双方用户积分和月记录必须在同一个数据库事务中提交。

## 5. 单局记录

`LadderMatchGame` 使用玩家视角模型。每个实际单局保存两条镜像记录：

```text
玩家 A -> 玩家 B
玩家 B -> 玩家 A
```

建议字段：

- `matchId`
- `duelLogId`，允许为空
- `playerName`
- `playerDisplayName`
- `opponentName`
- `opponentDisplayName`
- `deckTypeId`
- `opponentDeckTypeId`
- `winnerName`
- `duelCount`
- `isFirst`
- `isMain`
- `createTime`

字段处理：

- 删除 `gNumber`，因为它与 `duelCount` 重复。
- 删除 `isSide`，使用 `isMain = 0` 表示换备后的第二或第三局。
- `isMain` 只能由 `duelCount === 1` 生成，禁止调用方传入矛盾值。
- `isFirst` 表示该行的 `playerName` 是否为本单局先攻者。
- `winnerName` 必须是该单局胜者，不能使用整场 Match 胜者代替。

建议增加防重复约束，例如 `(matchId, duelCount, playerName)` 唯一；最终形式需结合正式库主键类型确认。

## 6. 单局结果捕获

单局结果必须在基准项目完成胜负判定后、录像保存前，通过通用事件发送给插件。

事件发生时内存中已经存在：

- `room.duel_count`
- 计算完成的胜者位置
- `room.dueling_players`
- 玩家规范化名称和原始展示名称
- 每名玩家的 `is_first`
- 当前 `main` 数组，即主卡组与额外卡组的合并区
- 当前 `side` 数组
- 当前 Match 比分

天梯插件收到事件后必须立即深拷贝数组和标量，防止下一次换备或房间清理修改原对象。

## 7. 与录像解耦

- 天梯结算不得等待录像成功后才开始。
- `LadderMatch` 和 `LadderMatchGame` 即使没有录像也必须保存。
- `duelLogId` 是可选关联，不是比赛记录存在的前提。
- 录像保存成功时可以关联其 ID；失败时保留空值并记录日志。
- 不允许使用“该房间最新 DuelLog”作为无条件回退，因为并发和重复保存时可能关联错误记录。

## 8. 卡组数据来源

YGOPro 的 `UPDATE_DECK` 数据由两段构成：

- 前 `mainc` 张：主卡组和额外卡组合并区。
- 后 `sidec` 张：副卡组。

现有服务器的 `client.main` 已经保存前一段，`client.side` 保存后一段。模板 YDK 则可直接解析为 `main`、`extra`、`side`。

匹配时使用：

```text
模板 main + 模板 extra  ⊆  实战 client.main
```

副卡组不参与。不需要查询 `cards.cdb`，也不需要在运行时区分实战卡组中的主卡和额外卡，因此不会引入 SQLite 查询开销。

没有模板被完整包含时返回“其他卡组”。不启用最大重合模糊匹配。

## 9. 历史数据迁移实施方案

已确定采用维护窗口停服后的一次性事务迁移，执行入口和完整演练步骤见
`plugins/ladder-core/migrations/202609-history-repair/README.md`。

- 旧 `ladder_match_game` 全表归档，不把伪造的 G1 结果转换成新记录。
- 只迁移能与 LadderMatch 唯一对应、结构和结果均完整的 DuelLog 比赛段。
- 每个可靠物理单局重建两条玩家视角记录，并重新解析双方卡组类型。
- 无法可靠恢复的记录只保留 Match，不猜测先后攻、单局胜者或卡组。
- 不重算 LadderUser 及月记录的历史胜负和积分；执行器用逐行摘要保证它们不变。
- schema 变更、数据重建、旧表归档和验收均处于同一个事务；模拟模式最终回滚。
- 正式提交后仍保留旧表和迁移前 pg_dump，确认稳定前不清理。

本地备份审计得到 1362 条旧伪单局、1578 个可靠 Match、4043 个可靠物理单局和
8086 条待重建的玩家视角记录。线上停机后必须重新审计，最终行数以当时数据库为准。
