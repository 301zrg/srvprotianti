# 共享数据契约与迁移边界

> 仅在修改跨模块字段、结算/统计语义、schema 或历史数据工具时补读。
> 字段类型与索引的实现以实体及显式迁移核对；本文件维护业务含义，不复制全部 EntitySchema。

## 数据所有权与访问

| 所有者 | 数据 | 使用方式 |
| --- | --- | --- |
| [ladder-core](../plugins/ladder-core/README.md) | LadderUser、LadderMonthRecord、LadderMatch、LadderMatchGame | 运行时消费者经 `ladderCore.entities/getRepository()` 获取 |
| [ladder-usage-analytics](../plugins/ladder-usage-analytics/README.md) | 使用率样本、卡片事实、日/总汇总，共八张派生表 | 由投影服务写入，可从可靠事实显式重建 |
| 宿主 DataManager | DuelLog、DuelLogPlayer 等原有数据 | 日志/牌组来源；不是天梯结算成功的必要条件 |
| [deck-classifier](../plugins/deck_analysis/README.md) | 类型与展示分组元数据 | 通过 `deckClassifier` 服务读取，消费者不直接读 JSON |

自有业务表由所属插件提供并注册 EntitySchema；生产 `synchronize=false`。
实体负责运行时映射，迁移负责 DDL，两者必须一致；运行角色权限也属于迁移交付。

## 身份与时间

- `name` 是去首尾空格、转小写的规范键，用于唯一性、关联与认证；
  `displayName` 用于保留玩家名称大小写，不能反向覆盖规范键。
- `LadderMonthRecord` 以 `(name, monthKey)` 唯一；`monthKey` 为 `YYYYMM`。
  历史榜单读取对应月记录，不使用用户表当前月快照代替。
- 玩家战绩/投影使用 Match 的结算时间 `createTime`；不把某一局录像时间替代整场时间。
- `coinWinner` 是 G1 的 `SELECT_TP` 接收者，即猜拳胜者；与 G1 先攻者、
  单局胜者、整场胜者分别记录。无可靠历史证据时保持 `NULL`。

## Match 与单局

`LadderMatch` 一行是一场 Match，`matchKey` 唯一。双方名称、类型、胜负及结算前后积分
记录在同一事实中。双方用户、月记录、Match 和单局必须在同一个事务提交，重复终局不得重复计分。

`LadderMatchGame` 以玩家视角保存；每个可靠物理单局恰好两行 A→B、B→A：

| 字段/组合 | 契约 |
| --- | --- |
| `matchId + duelCount + playerName` | 唯一单局视角身份，实体已有唯一约束 |
| `duelCount` | 从 1 开始；不重新引入重复的 `gNumber` |
| `isMain` | 仅 `duelCount === 1` 为 1；其余为 0，不重新引入 `isSide` |
| `isFirst` | 本行玩家是否本单局先攻；可靠双镜像中恰好一行为 1 |
| `winnerName` | 本单局胜者，不用 Match 胜者替代 |
| `deckTypeId/opponentDeckTypeId` | 固定为双方 G1 未换备类型，G2/G3 不重新定义 Match 类型 |
| `duelLogId` | 可空的精确单局日志关联，不能无条件取“该房间最新日志” |

单局事件在 WIN 胜者归一化后、录像保存前捕获，插件立即复制数组/标量，避免换备和房间销毁改写结果。
完整 Match 需明确 `DUEL_END` 或宿主判定弃权；进程退出和暂存领先比分不构成结算证据。
终局比分还需与逐局 WIN 一致。具体重连与拒绝结算条件由 ladder-core 文档维护。

## 录像与分类来源

- 录像保存失败不能导致用户积分、Match 和已捕获单局回滚；缺日志则保留空关联。
  当前协议流程仍等待 `saveDuelLog` 返回；录像文件使用异步回调写入，事件的日志 ID 可空。
  “不依赖保存成功”不等于已经采用可靠后台队列，也不表示事件发生时文件已落盘。
- 实战 `client.main` 已合并主卡组与额外卡组，`client.side` 为副卡组；
  分类使用模板 main + extra 的带张数完整包含，不计 side，也不运行时查 CDB。
- 模板规则、变体文件名、冲突顺序及 4095 回退由
  [分类模块](../plugins/deck_analysis/README.md) 维护；历史重分类不能用无法证明 G1 的日志猜测替换。
- 统计能否纳入某条记录、镜像检查与分母定义见 [API/统计契约](WEB_AND_ANALYTICS_SPEC.md)。
  事实记录存在不等于满足每一种统计口径。

## 使用率投影与恢复

- 样本以 `(matchId, playerName)` 幂等；正常有效 Match 最多两侧样本。
  卡组快照缺失仍可计卡组分母，不计卡片分母；中文 CDB 元数据不可用时当前实现跳过整场投影。
- 投影在 Match 提交后处理；失败不回滚已提交计分。历史重建必须显式运行，普通启动不扫描历史补齐。
- 模板重分类不仅影响 Match/单局类型，还可能影响样本类型及卡组日/总汇总；
  已安装派生表时需按工具手册一致更新，相关表仅部分存在时应拒绝执行。
- 算法版本、卡片目录版本与异常原因保留在样本中，不能把未知牌组或无效卡片伪造成有效样本。

## 迁移规则与入口

代码变更、隔离测试库演练、生产执行是不同动作。默认交付可审查的脚本和命令；
正式执行须有任务中的明确授权和目标环境，不能因实现工具而顺便改生产数据。

- schema/历史处理先提供只读预检或 dry-run、影响范围、事务边界、幂等/拒绝重复策略、
  执行后校验和回退/备份恢复方案；线上停服备份后重新审计，不照搬旧本地行数。
- 不在普通启动隐式迁移。可事务化的步骤尽量原子完成，不能回滚的步骤说明恢复路径。
- 用户展示名仅从唯一可靠写法恢复；歧义报告后由维护者明确 override，不按频次猜测。
- 历史伪单局先归档，只从唯一关联且结构完整的 DuelLog 重建；证据不足保留空值与报告。
  不从不完整 Match 重算、清零旧用户/月累计积分与胜负。
- 保留旧表和迁移前备份直到验收；旧错误胜者更正须另行核对证据及所有受影响账户/月份。

| 操作 | 唯一操作手册 |
| --- | --- |
| 旧天梯单局修复、展示名、G1 类型对齐 | [历史修复](../plugins/ladder-core/migrations/202609-history-repair/README.md) |
| 使用率建表、权限、回退 | [使用率迁移](../migrations/202609-player-usage/README.md) |
| 使用率历史回填 | [BACKFILL](../plugins/ladder-usage-analytics/BACKFILL.md) |
| 模板变化后的历史重分类 | [RECLASSIFY_DATABASE](../plugins/deck_analysis/RECLASSIFY_DATABASE.md) |

各工具的 audit/simulate/apply/verify 能力及确认参数并不完全相同，执行时读对应手册，
不要把一个工具的命令模式套到另一个工具。是否已生产执行记录在 [交接](PROJECT_HANDOFF.md)。
