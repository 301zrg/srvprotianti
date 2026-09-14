# SRVPro 天梯插件化项目交接文档

> 状态基准：2026-09-14，分支 `restructure2`。本文描述的是
> `F:\MyCardLibrary\srvpro\srvprotianti` 当前代码；原项目行为基准始终是
> `F:\MyCardLibrary\srvpro\srvpro` 当前工作树。

## 1. 项目目标与技术栈

### 1.1 项目目标

本项目在原 SRVPro 游戏王服务器上增加 TT 天梯、天梯账户和计分、排行榜、卡组分类、
天梯统计、公开房间/录像页面以及 PostgreSQL 部署支持，同时保持这些能力可插拔。

核心验收原则是：删除 `srvprotianti/plugins/` 中的插件后，服务应退化为原 `srvpro`
的功能和安全行为；主项目只保留业务无关的插件宿主和通用事件钩子。原项目目录
`srvpro/` 只作只读比较，任何代码或数据修改都只能发生在 `srvprotianti/`。

### 1.2 技术栈

- Node.js、CommonJS；当前在 Node.js 24.15.0 下完成语法和测试验证。
- CoffeeScript 2.7：服务器主流程以 `ygopro-server.coffee` 等为源文件，再编译为 JavaScript。
- TypeScript 5.8：`data-manager/` 以 TypeScript 为源文件，并保留编译后的 JavaScript。
- TypeORM 0.2.29；数据库驱动包括 PostgreSQL `pg`、MySQL、SQL.js/SQLite 兼容路径。
- YGOPro 原生服务进程及 CTOS/STOC 协议；`ygopro-msg-encode`、`ygopro-deck-encode`、
  `ygopro-yrp-encode` 负责消息、卡组和录像数据处理。
- Node.js 内置 HTTP 服务、`ws` WebSocket、原生 HTML/CSS/JavaScript 页面。
- 测试以 Node.js 脚本和内存数据库集成为主，入口见 `package.json`。

## 2. 当前目录与模块结构

以下只列本次插件化工作直接涉及的实际文件。`ygopro/`、数据库 dump、
`SimpleMonitor.ps1`、运行时录像和日志不属于本次重构范围。

```text
srvprotianti/
├─ plugin-system.js                    通用插件宿主 PluginHost
├─ duel-finalization.coffee/.js        单局结束、胜者归一化和录像捕获状态机
├─ duel-finalization.test.js           单局结束回归测试
├─ ygopro-server.coffee/.js            主服务及通用插件钩子
├─ data-manager/
│  └─ DataManager.ts/.js               通用实体注册、仓储、连接和插件事务接口
├─ data/default_config.json            原项目默认配置；含通用内存阈值
├─ plugins/
│  ├─ README.md                        插件配置、职责和事件时序说明
│  ├─ deck_analysis/                   manifest ID 为 deck-classifier
│  │  ├─ plugin.json
│  │  ├─ config.default.json
│  │  ├─ index.js                      parseYdk、containsCards、classify
│  │  ├─ deck_analysis.json            卡组类型和家族元数据
│  │  ├─ deck_display.json             卡组胜率页展示分组，可热更新
│  │  ├─ DECK_DISPLAY_CONFIG.md        胜率展示配置说明
│  │  └─ deck_templates/*.ydk          数字 ID 命名的模板卡组
│  ├─ ladder-core/
│  │  ├─ plugin.json、config.default.json
│  │  ├─ index.js                      createService、captureGame、captureRpsWinner、settle
│  │  ├─ entities.js                   四个天梯 EntitySchema
│  │  ├─ diagnose-match.js             指定 Match 诊断工具
│  │  └─ migrations/202609-history-repair/
│  │     ├─ migrate.js                 audit/simulate/apply/verify 统一入口
│  │     ├─ 00-audit.sql ～ 05-align-game-decks.sql
│  │     ├─ display-name-overrides.json
│  │     ├─ rollback.sql
│  │     └─ README.md                  停机迁移及回退手册
│  ├─ ladder-analytics/
│  │  ├─ plugin.json、config.default.json
│  │  └─ index.js                      ranking、aggregateDeckStats、deckStats
│  ├─ public-room-web/
│  │  └─ plugin.json、config.default.json、index.js    公开房间 API
│  ├─ public-replay-web/
│  │  └─ plugin.json、config.default.json、index.js    公开录像 API
│  ├─ ladder-web/
│  │  ├─ plugin.json、config.default.json、routes.json、index.js
│  │  ├─ example-decks.json、WEB_CONFIG.md
│  │  └─ web/
│  │     ├─ intro.html、rooms.html、replays.html、ladder.html、deck-stats.html
│  │     ├─ assets/common.css、assets/site-shell.js
│  │     └─ example_decks/*.ydk
│  ├─ postgres-compat/
│  │  ├─ plugin.json、config.default.json
│  │  └─ index.js                      configure
│  └─ tests/
│     ├─ plugin-host.test.js
│     ├─ plugin-tests.js
│     └─ integration.test.js
└─ docs/
   ├─ REFACTORING_SPEC.md
   ├─ DEVELOPMENT_WORKFLOW.md
   ├─ DATA_MODEL_AND_MIGRATION.md
   ├─ WEB_AND_ANALYTICS_SPEC.md
   ├─ WEB_PAGE_DEVELOPMENT_SPEC.md
   ├─ LADDER_PLAYER_AND_USAGE_SPEC.md   新页面、数据模型和性能需求对齐稿（未实施）
   ├─ CADDY_HTTPS_DEPLOYMENT.md         当前天梯 HTTPS/Funnel 与未来 Caddy 部署草案
   ├─ FEATURE_INVENTORY.md
   └─ PROJECT_HANDOFF.md
```

插件依赖顺序为：`deck-classifier` → `ladder-core` → `ladder-analytics`，
`ladder-web` 再依赖统计、公开房间和公开录像插件；`postgres-compat` 独立。目录名
`deck_analysis` 与 manifest ID `deck-classifier` 不同是当前既有事实，不能只改一处名称。

## 3. 已完成的关键改动

### 3.1 通用插件宿主与核心钩子

- `plugin-system.js` 的 `PluginHost` 已实现插件发现、依赖排序、默认/本地配置合并、
  `configure`/`register`/`init` 生命周期、钩子、实体和命名服务注册，以及插件错误隔离。
- `ygopro-server.coffee` 已在数据库连接前执行插件配置和实体注册，在数据库就绪后初始化插件。
- 主流程已提供随机模式、进房、开局、猜拳胜者、单局结果、DuelLog 保存、房间结束和
  HTTP 请求等通用钩子；主流程不直接判断 TT、天梯页面或卡组类型。
- `DataManager.registerEntities`、`getConnection`、`getRepository`、`pluginTransaction`
  为插件提供通用数据库能力；天梯实体不再放进主实体目录。

### 3.2 TT 天梯与结算

- `plugins/ladder-core/index.js` 已实现 TT 双人 Match、账户密码校验、总/月等级分、
  胜负记录和一次性事务结算。
- 同 IP 连续匹配默认允许，受限制玩家默认可与正常玩家匹配；两项均为插件配置。
- TT 沿用宿主断线重连能力，不因一次网络中断直接判负；宿主未启用重连时插件会告警。
- `DuelFinalization.handleWin` 已修正胜者坐标归一化：MSG_WIN 使用共享先后攻坐标，
  不再取决于哪一侧代理连接先上报。因此 Match 胜者、积分和各单局胜者使用同一可靠结果。
- `captureGame` 在每局 WIN 时复制不可变结果；`settle` 在 Match 结束时核对逐局胜者与
  最终比分，并在同一事务写入用户、月份、Match 和单局。`matchKey` 提供幂等保护。
- 宿主现会记录 `MSG_WIN.type` 和 `DUEL_END` 终局标记。YGOPro 后端 socket 关闭时先等待该
  连接的 STOC 队列排空；子进程退出时再等待房间内所有后端连接完成收尾，避免终局包尚在
  录像/插件异步处理中就向健康客户端发送“服务器关闭了连接”并执行 `CLIENT_kick`。
- `room_deleted` 现在携带通用终局原因。天梯只在收到完整 `DUEL_END` 或宿主已明确判定一方
  弃权时结算；单纯的子进程退出或房间删除即使暂存比分不相等，也不会写入积分和 Match。
- `captureRpsWinner` 从 G1 的 `SELECT_TP` 接收者记录 `coinWinner`；该玩家是猜拳胜者，
  不等同于其最终选择的 G1 先攻者。
- Match/单局数据保存不依赖录像成功。DuelLog 成功后只通过 `linkDuelLog` 补充可空关联。
- 每个物理单局写两条玩家视角记录；保留 `duelCount`、`isFirst`、`isMain`，已废弃
  重复字段 `gNumber` 和可由 `isMain` 反推的 `isSide`。
- `LadderMatchGame` 已包含对手名称和对手卡组类型，便于直接按玩家视角统计。

### 3.3 卡组分类

- `plugins/deck_analysis/index.js` 解析模板 YDK 的主卡组和额外卡组，并使用带重复数量的
  完整多重集包含判断；实战数据使用宿主已合并主卡组和额外卡组的 `client.main`。
- 模板中同一卡号出现几次就要求实战卡组至少投入几张，这是已确认的业务语义；不得改成
  忽略张数的集合包含或 65% 最大重合。以 8400 个现有 G1 卡组为样本，最新模板下 65%
  算法仍会改变 3145 个（37.44%）分类，主要是把缺少必带卡的牌组错误吸入具体类别。
- 副卡组不参与分类，也不需要在运行时查询 `cards.cdb`；没有完整匹配时统一返回
  “其他卡组”ID 4095。
- G1 未换备卡组定义整个 Match 的卡组类型，G2/G3 单局沿用 Match 中的 G1 类型。
- `plugins/deck_analysis/reclassify-database.js` 用于模板更新后重跑数据库中的有效天梯卡组类型。它只接受可唯一关联且双方
  原始牌组完整的 G1 DuelLog，同时更新 `ladder_match` 与活动的 `ladder_match_game`；无法证明 G1 的 Match 保持原值并报告，
  已停用的 `ladder_match_game_legacy_202609` 不处理。命令分为只读 `audit`、事务回滚 `simulate` 和带确认串的 `apply`，
  操作手册见 `plugins/deck_analysis/RECLASSIFY_DATABASE.md`。

### 3.4 排行榜、统计和页面

- `ladder-analytics` 提供总榜/月榜及等级分、胜负差、胜率排序。`ranking` 先对完整榜单
  编号，再搜索和分页，所以搜索结果保留全体玩家中的真实排名。
- 页面展示优先使用 `displayName`，认证和关联使用小写规范键 `name`；排行榜只展示一列
  “等级分”，总榜取总分，月榜取所选月份记录。
- `aggregateDeckStats` 使用 PostgreSQL/TypeORM SQL 聚合 Match 和双镜像单局，不把整张
  单局表载入 Node.js。统计按玩家视角计算，支持总计、指定对阵、先后攻、G1 主牌局和
  G2/G3 备牌局；同卡组总体自然为 50%，先后攻不被强制为 50%。
- 卡组统计只接纳 `g1FirstPlayer` 能明确对应双方之一的 Match；该字段为空或指向第三人的
  Match 视为脏数据，其 Match 和全部单局都不参与统计。单局还必须存在反向玩家视角，且
  两条镜像记录的 `isFirst` 恰好一方为 1；双方同为先攻、同为后攻、缺失或非法值都排除。
  这同时避免旧版两条伪 G1 记录均为 `isFirst=0` 时被错误算入后攻统计。上线时应先完成
  历史迁移再启用该统计口径，否则尚未回填 `g1FirstPlayer` 的旧 Match 会整体不可见。
- 统计使用 45 秒进程内缓存，新 Match 提交后失效，并在启动后异步预热。重启只丢缓存，
  原始数据不丢失。
- `ladder-web/routes.json` 统一声明五个公开页面及根路径，不再在主服务中硬编码页面清单。
- 五个 HTML 已集中到 `ladder-web/web/`；`public-room-web`、`public-replay-web` 只保留 API
  职责。公共导航、语言菜单和翻译入口由 `web/assets/site-shell.js` 生成，基础样式由
  `web/assets/common.css` 提供；新增页面不再复制这些代码。
- `ladder-web` 通过受限的 `/assets/<filename>` 路由提供公共 CSS/JS：只允许固定资源目录下
  的单层 basename 和 `.css`、`.js` 扩展名，页面 HTML 仍由 `routes.json` 单独声明。
- 默认排名依据在每次排行榜/配置请求时重新读取插件默认及部署 JSON；介绍页示例卡组改由
  `ladder-web/example-decks.json` 和 `/api/example-decks` 提供。两者保存后刷新页面即可生效，
  不要求重启游戏服务器。
- 卡组胜率展示分组已从 `deck_analysis.json` 独立到 `deck_display.json`。统计接口每次读取
  展示配置并把分组内容纳入缓存身份，配置变化不会继续复用旧矩阵；精确成员可使用
  `archetypeIds`，旧 family/custom 推导仍保持兼容。
- 排行页支持 `type`、`month`、`rankingBasis` 页面参数，胜率页支持 `month`、`metric`；录像
  和排行分页均增加首页按钮。公开房间状态会显示 `Duel:N Turn:N` 或 `Duel:N Siding`。
- `docs/WEB_PAGE_DEVELOPMENT_SPEC.md` 已按当前实现登记五页的路由、URL/API 参数、展示字段、
  按钮行为、加载/空/错误状态、公共组件边界和回归清单；以后改变页面契约时须同步更新该文档。
- `docs/LADDER_PLAYER_AND_USAGE_SPEC.md` 已记录纯胜场排名、玩家战绩查询、卡片/卡组使用率、
  卡组胜率详情、四语言 CDB、从 G1 DuelLogPlayer 派生卡片事实和聚合表的已确认设计；该文档
  当前只是需求对齐稿，产品口径均已确认；维护者已决定本期保持 HTTP 简单直连并允许密码
  查询，HTTPS/Funnel/Caddy、`bindAddress`、密码哈希和额外认证加固均记录为延期安全债；
  在此之前不得把其中内容描述为已实现。
- 本期只修改同级 `../config.json` 对应的当前卡池环境（游戏 7911、Web 7922）；
  `../config-srvpro2.json` 对应的 2337/2338 旧环境不动。
- `docs/CADDY_HTTPS_DEPLOYMENT.md` 记录了当前环境无域名时的 Tailscale Funnel 备选，以及未来
  有域名后使用 Caddy、Windows 防火墙、可选 `bindAddress`、认证接口保护、验收与回退步骤；
  当前明确不在服务器安装代理或修改防火墙。Funnel 只代理 Web 7922 时不影响游戏 TCP 7911，
  其带宽限制只涉及页面、API 与下载。
- `replays.html` 已展示 `duelCount` 和本局胜者；卡组下载文件名包含 `-gN-`。

### 3.5 HTTP 接口与部署兼容

- 原 `/api/getrooms` 和 `/api/replay...` 已恢复原项目的鉴权及响应路径。
- 页面改用独立无密码接口：`/api/public/rooms`、`/api/public/replays`、
  `/api/public/replay/<filename>`；公开录像下载限制在录像根目录并校验文件名，中文文件名
  使用兼容浏览器的 `Content-Disposition`。
- 录像列表以磁盘文件为准，DuelLog 只补充局数、胜者和卡组数据，避免历史关联缺失导致
  实际存在的录像不显示。
- `postgres-compat.configure` 可从插件本地配置或环境变量提供 PostgreSQL 连接，并将
  `synchronize` 默认设为 `false`，避免普通启动自动执行 DDL。
- 通用最大内存占用阈值已由 `modules.max_mem_percentage` 控制，默认值为 98。

### 3.6 历史数据迁移工具

- `migrate.js` 及分阶段 SQL 已完成审计、事务模拟、正式执行、验收和紧急回退支持；
  不输出数据库密码，也不改两个主配置文件。
- 本地备份已成功完成一次 `audit`、回滚式 `simulate`、`apply` 和 `verify`。该次快照为
  2324 个 Match、1362 条旧伪单局；从 1578 个可靠 Match 的 4043 个物理单局恢复了
  8086 条玩家视角记录，旧记录已归档。此数字仅代表当时本地备份。
- 迁移不重算或清空 `ladder_user`、`ladder_month_record` 的历史积分和胜负。
- 四个历史展示名决定已写入 `display-name-overrides.json`：`_salgu_`、`rainydevil`、
  `hakushu` 使用小写，`不是一般人的认真` 保持原写法。

## 4. 重要设计决策和原因

| 决策 | 原因 |
| --- | --- |
| 核心只提供通用宿主/钩子，业务全部放插件 | 删除插件后才能恢复基准行为，也避免天梯逻辑再次与房间主流程缠绕。 |
| 插件使用 `config.default.json` 加本地 `config.json` | 默认值可审查、部署值可覆盖；密码和环境差异不进入主配置或版本库。 |
| PostgreSQL 是可选插件，且默认关闭 `synchronize` | 天梯部署需要 PostgreSQL，但原项目不应被强制绑定；生产启动时自动 DDL 曾造成权限错误和不可控结构变更。 |
| WIN 时立即捕获单局，Match 结束后统一事务提交 | WIN 消息到达时胜者、先后攻和牌组仍在内存中；录像可能失败或晚到，不能成为积分和结果的前置条件。 |
| 子进程关闭先排空 STOC 队列，结算要求明确终局 | YGOPro 在发送 REPLAY/DUEL_END 后几乎立即关闭 socket；Node 异步处理可能仍未完成。关闭信号不能替代终局协议，也不能把暂存领先比分当成完整 Match。 |
| 每个物理单局保存两条玩家视角记录 | 与胜率定义直接对应，使 A 对 B 和同卡组内战都能用同一聚合模型；唯一键为 Match、局数、玩家。 |
| 单局冗余保存对手名称/卡组类型 | 虽可回查 Match，但直接字段能明确一条视角的对手，并简化、加速按对阵聚合和历史校验。 |
| 删除 `gNumber`、`isSide` | `gNumber` 与 `duelCount` 重复；`isSide` 等价于 `isMain=0`。减少字段间不一致风险。 |
| Match 全程沿用 G1 卡组类型 | 换备不改变卡组种类，逐局重新分类会让同一 Match 被拆成不同类型。 |
| 用 `client.main` 匹配主卡组和额外卡组 | 宿主解析后该数组已包含两者，可避免每局查询 `cards.cdb`；side 数组明确排除。 |
| 排名先全量编号，再搜索 | 搜索仅筛选展示对象，不能把被搜索玩家重新排成搜索结果中的第 1 名。 |
| 统计先用 SQL 聚合和短时内存缓存 | 当前规模不值得承担快照表、增量水位和算法版本迁移的复杂度；缓存重建不影响数据正确性。 |
| 旧伪单局归档，只恢复可唯一关联的 DuelLog | 伪造或猜测单局胜者会污染胜率；无法证明的数据宁可缺失，原记录仍可审计和回退。 |
| 保留旧用户累计胜负和积分 | 天梯用户系统比完整 Match 记录更早上线，清零或从不完整 Match 重算会丢失真实历史。 |
| 原管理 API 保持鉴权，页面另开公开 API | 兼容监控和既有管理调用，同时不为网页便利而扩大旧接口的数据暴露范围。 |

## 5. 已知的坑、待办与未解决问题

### 5.1 必须处理

1. **结算节点弹出问题已完成代码修复，仍需两个真实客户端冒烟验收。** 根因已确认是
   YGOPro 在排入 REPLAY/DUEL_END 后几乎立即关闭 socket，而宿主原先不等异步 STOC 队列
   完成就发送红字并 `CLIENT_kick`。现已增加连接/房间两级排空屏障、终局状态和结构化退出
   日志；正常终局不再走错误提示。异常退出没有 `DUEL_END` 或明确弃权证据时，天梯拒绝按
   当前领先比分结算。上线前仍须覆盖自己投降、对手投降、G2/G3、`MSG_WIN type=0x04`、
   录像延迟/缺失和子进程异常退出。

2. **线上历史迁移尚未执行。** 正式服务器仍曾持续产生数据，必须按迁移 README 在维护
   窗口停服、重新备份、重新 `audit`、`simulate`、`apply`、`verify`；不得照搬本地行数。
   本地 JSON 报告是旧快照，不能作为线上验收结果。

3. **已由错误胜者逻辑写入的测试/线上记录不会被代码修复自动纠正。** 修复部署后只保证
   新对局。旧错误 Match 必须依据可靠的 G1/G2/G3 证据单独更正或删除，不能从错误的
   `ladder_match_game.winnerName` 反推；同时要一致处理用户、月记录和积分变化。

4. **旧版迁移后的卡组类型需额外校正。** 若数据库是在加入 G1 冻结规则前完成迁移，先执行
   `05-align-game-decks.sql`，再用最新版 `verify` 确认 `deck_type_mismatches=0`。当前保存的
   本地 verify 报告没有该字段，属于早期报告，需重新生成后才算最新验收。

5. **生产级实战验收未完全自动化。** 仍需验证空插件目录启动、普通房/随机房/观战/重连、
   原管理 API 鉴权，以及两个真实客户端完成 G1～G3 后的胜者、猜拳、先后攻、镜像单局、
   录像失败降级和断线重连。

### 5.2 数据与性能注意项

- 历史 `coinWinner` 若没有可靠协议记录，应保持 `NULL`，不能用 `g1FirstPlayer` 猜测。
- 以后出现新的用户名大小写歧义时，迁移应停下并补充人工 override；业务关联继续使用
  小写 `name`，展示使用 `displayName`。
- 排行榜当前为保证全局排名，会把所选总榜或月榜全部行取回后在 Node.js 编号。当前用户量
  可接受；规模明显增长时应改成 SQL 窗口函数，在外层搜索和分页，保持相同排名语义。
- 卡组统计达到单月约 50 万玩家视角行、接口 P95 超过 300 ms，或改为多进程部署时，
  再评估带算法版本和处理水位的持久化快照。现在的进程缓存重启后会自动重建。
- `public-replay-web` 依赖配置中的录像目录。目录不存在、权限不足或 DuelLog schema 未就绪
  会返回 500；文件存在但数据库关联缺失时仍会列出，只是局数/胜者可能采用缺省值。

### 5.3 当前工作区状态

- 工作区不是干净状态。`config/config.json`、`config/admin_user.json` 有本地改动且包含敏感
  信息，禁止覆盖、提交、复制到其他环境或在日志/文档中展开内容。
- `.gitignore` 当前未提交改动已加入 `plugins/*/config.json`；这是已确认的插件配置约定，
  后续整理提交时应保留。
- `plugins/ladder-web/web/deck-stats.html` 有未提交的 tooltip、百分比精度和颜色显示调整；
  它是当前工作区改动，不应在合并或部署时被误删，也不应在未审核前宣称已发布。
- 若干编译后 `.js` 被 Git 标记为修改，但当前文本 diff 主要只显示换行符状态。提交前应运行
  构建并逐项检查 diff，避免把纯 CRLF/LF 变化混入业务提交。
- 根目录旧 `VERIFY.md` 和 `docs/FEATURE_INVENTORY.md` 记录的是插件化之前的状态，其中
  `synchronize: true`、业务仍耦合主程序等描述已经过期。当前开发以本文、
  `REFACTORING_SPEC.md`、`DEVELOPMENT_WORKFLOW.md`、`DATA_MODEL_AND_MIGRATION.md`、
  `WEB_AND_ANALYTICS_SPEC.md`、`WEB_PAGE_DEVELOPMENT_SPEC.md` 和迁移 README 为准。

## 6. 修改代码时必须遵守的约定

### 6.1 范围和架构

- 永远不修改 `F:\MyCardLibrary\srvpro\srvpro`；只在 `srvprotianti` 中工作。
- 不读取或修改 `config/config.json`、`config/admin_user.json`。需要部署值时使用插件
  `config.json` 或声明过的环境变量。
- TT、ladder、卡组模板、天梯统计、公开页面和 PostgreSQL 部署策略不得写回主流程。
  主项目新增内容必须对任何插件都通用，并能在插件不存在时安全空操作。
- 新插件使用 `plugins/<plugin-dir>/plugin.json` 声明稳定 manifest ID 和依赖；依赖服务通过
  `api.provide`/`api.get` 传递，不直接访问另一个插件的内部状态。现有
  `deck_analysis` 目录名不要未经全局检查就改名。
- 公开页面统一放在 `plugins/ladder-web/web/`，路由登记在 `routes.json`；新导航项集中修改
  `web/assets/site-shell.js`，公共视觉规则修改 `web/assets/common.css`，不要在各页面复制
  顶部导航、语言菜单或全站基础样式。
- 每个插件提交安全的 `config.default.json`；部署专用 `config.json` 不提交。新配置必须有
  默认值、明确语义和边界校验，布尔字段优先使用正向、无双重否定的名称。

### 6.2 命名和数据约定

- JavaScript 使用 CommonJS、`'use strict'`、两空格缩进；函数和变量使用 `camelCase`，
  类和 EntitySchema 常量使用 `PascalCase`，插件目录/manifest ID 原则上使用 kebab-case。
- 账户键 `name` 一律用 `normalizeName` 处理为去空格小写；页面显示用 `displayName`，不能
  为显示目的覆盖规范键。月份键统一为 `YYYYMM`。
- 物理 Match 使用不可重复 `matchKey`；单局身份为 `matchId + duelCount + playerName`。
  一个物理单局必须恰好对应两条玩家视角记录。
- `duelCount` 从 1 开始；`isMain=1` 仅表示 G1，G2/G3 为 0；不要重新引入 `gNumber`
  或 `isSide`。猜拳胜者、G1 先攻者、单局胜者和 Match 胜者是四个不同概念。
- 插件接收房间事件时尽快复制需要的标量和数组，不长期保存可变的 Room/Client 对象。
  G1 卡组分类结果应冻结到 Match 状态中。

### 6.3 源码、注释与错误处理

- CoffeeScript/TypeScript 是源文件，生成 JavaScript 必须同步；禁止只改
  `ygopro-server.js` 或只改 `DataManager.js`。纯 JavaScript 插件无需另造 CoffeeScript。
- 注释说明“为什么”和协议/事务边界，重点覆盖事件时序、坐标换算、幂等、历史兼容、
  隐私及降级行为；避免把代码逐句翻译成注释。
- 插件错误应带插件名和钩子名写结构化日志。HTTP 处理器一旦认领请求，必须结束响应并
  返回 `true`；不能写了一半响应后再交给主路由。
- 公开下载必须使用固定根目录和 `path.basename`/路径边界校验；不得把后台接口的 IP、
  密码或未脱敏房间信息直接暴露给公开页面。

### 6.4 数据库与迁移

- 正常启动不得依赖 TypeORM 自动改表；PostgreSQL 保持 `synchronize=false`。
- schema 变化必须同时提供迁移、回滚/恢复说明、审计和验收查询。生产迁移先备份，优先在
  单事务中执行，并用唯一键保证可重复运行或明确拒绝重复运行。
- 不根据不可靠数据猜测历史值；能为空则为空，需人工决定则生成报告并停止。
- 修改结算时必须保持用户、月记录、Match 和游戏行在同一事务；录像与 DuelLog 始终是
  可选旁路，不得让文件系统失败回滚比赛结果。

### 6.5 测试与提交

- 最低自动检查：`npm test`、`npx tsc --noEmit`、`node --check ygopro-server.js`；修改
  CoffeeScript/TypeScript 后还要运行 `npm run build` 并检查生成 diff。
- 改动协议胜者映射、结算或统计公式时，必须增加回归样本，至少覆盖消息从两侧先到、
  G1/G2/G3、同卡组、不同卡组、先后攻、平局/异常结果和录像缺失。
- 提交前先检查工作区，不覆盖用户已有修改；敏感配置、dump、录像、日志、迁移报告和
  `node_modules` 不进入提交。
- 手工部署不能只复制单个插件入口。涉及宿主时要同步 `ygopro-server.js`、
  `duel-finalization.js`、`plugin-system.js`、`data-manager/DataManager.js`、相关默认配置和
  完整插件目录；服务器上的旧天梯实体/旧 Web 文件需按版本清单移除，避免重复实体或旧路由。
- 修改公开页面的路由、参数、接口字段、按钮、显示内容、状态、隐私规则或统计展示口径时，
  必须同步更新 `docs/WEB_PAGE_DEVELOPMENT_SPEC.md`；涉及公开 API 或统计定义时还要同步更新
  `docs/WEB_AND_ANALYTICS_SPEC.md`。

## 7. 当前验证结论

截至本文生成时：

- `npm test` 通过：单局结束、插件宿主、插件单元和插件集成四组测试均成功。
- `ygopro-server.js`、`duel-finalization.js`、`plugin-system.js` 及所有插件 `index.js`
  通过 Node.js 语法检查。
- `npx tsc --noEmit` 通过。
- 结算回归已增加 `MSG_WIN.type`/`DUEL_END` 状态捕获，以及“子进程异常退出且暂存比分
  不相等也不得结算”的集成样本。
- 尚未因此宣告线上可直接升级；第 5 节中的停机迁移、错误历史记录处置和真实客户端冒烟
  测试仍是部署前置条件。

## 8. 2026-09-14 卡组统计展示差额诊断

- `deck-stats.html` 的“总 M 局”来自 `rowGroup::all`，按定义包含该卡组对阵所有卡组类别的玩家视角；页面矩阵只展示
  `deck_display.json` 中 `isDisplayed=true` 的八个分组。因此八列之和不应被假定等于总 M 局，未展示的类别并没有丢失。
- 当时运行中的 `202609` 接口实际返回六武众总 M 局 255，而不是 225；八个展示分组之和为 95，未展示部分为 160。
  用迁移快照、迁移的唯一关联条件和迁移时模板复原后，得到 1578 个可靠 Match、4043 个物理单局，并逐项复现
  `255 = 95 + 160`。未展示 160 局为：其他 140、星骸植物 12、守墓 4、龙骑兵团 1、废铁 1、TG 代行 1、念动力 1。
- 当前 `loadDisplayGroups` 通过卡组 `code` 是否等于家族代码或以家族代码为前缀来推导成员。`SYNCHRO_SPEED` 因而进入
  同调均，但 `JUNK_DOZER_PLANT` 不会进入；这与元数据中同调均配置 `includeBranches: [0, 1]` 的意图不一致，导致
  星骸植物被计入总计却不在八列中出现。是否新增“其他/未展示”列、展开全部类别，或只修复同调家族映射属于页面产品口径，
  修改前应由需求方确认；现在可在 `deck_display.json` 中用显式 `archetypeIds` 修正成员，但不得简单把总计改为八列之和，
  否则会静默丢掉大量有效对局。

## 9. 2026-09-14 随机匹配空房回收

- 随机房间会在 `Room.join_player` 的异步 `before_join_room` 校验之前创建并启动 YGOPro 子进程。此前首位玩家校验失败时只关闭
  客户端，不回收尚无玩家的 Room；玩家在等待校验时断开则更可能发生“关闭事件先执行、校验后把已关闭客户端加入 Room”的
  竞态。后一种 Room 的 `players` 中残留无有效座位的幽灵客户端，公开房间页显示 0 人，匹配器也不会选择它。
- `join_player` 现在会在校验拒绝后回收真正为空的等待房，并在所有异步校验完成后、加入 Room 前再次检查 `client.isClosed`。
  天梯认证异常也由 `ladder-core` 明确转为拒绝结果，避免插件钩子异常被宿主隔离后意外放行。
- 新增 `room-lifecycle.js` 统一判断有效等待玩家，并增加随机房间兜底清理器。若零有效玩家状态持续超过
  `modules.random_duel.empty_room_timeout`（默认 30 秒），房间子进程会被终止并从 `ROOM_all`/房间列表删除；对局已经开始的房间
  不受影响。HTTP 与 WebSocket 房间列表还会隐藏尚未取得有效座位、已经关闭或正在删除的随机等待房；客户端收到
  `TYPE_CHANGE` 取得座位后再发布/更新房间。结构化日志事件为 `empty_waiting_room_cleanup` 和 `empty_waiting_room_reaped`。
