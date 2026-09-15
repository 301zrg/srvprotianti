# SRVPro 天梯插件化项目交接文档

> 状态基准：2026-09-16，分支 `restructure2`。本文描述的是
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

以下只列本次插件化工作直接涉及的实际文件。`ygopro/`、数据库 dump、运行时录像和日志
不属于本次重构范围。旧 `SimpleMonitor.ps1` 已确认无调用且接口/路径过时，于 2026-09-16 删除。

```text
srvprotianti/
├─ README.md                             当前项目入口和文档导航
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
│  ├─ card-catalog/
│  │  ├─ plugin.json、config.default.json、index.js
│  │  ├─ CARD_DATABASE_CONFIG.md
│  │  └─ databases/cards.{zh,ja,en,ko}.cdb  本地部署文件，不提交 Git
│  ├─ ladder-usage-analytics/
│  │  ├─ plugin.json、config.default.json、entities.js、index.js
│  │  └─ backfill.js、BACKFILL.md       使用率显式历史回填
│  ├─ public-room-web/
│  │  └─ plugin.json、config.default.json、index.js    公开房间 API
│  ├─ public-replay-web/
│  │  └─ plugin.json、config.default.json、index.js    公开录像 API
│  ├─ ladder-replay-enrichment/
│  │  └─ plugin.json、index.js               录像的天梯卡组类型与筛选增强
│  ├─ ladder-web/
│  │  ├─ plugin.json、config.default.json、routes.json、index.js
│  │  ├─ example-decks.json、WEB_CONFIG.md
│  │  └─ web/
│  │     ├─ intro.html、rooms.html、replays.html、ladder.html、deck-stats.html
│  │     ├─ player-stats.html、usage-stats.html、deck-detail.html
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
   ├─ README.md                         文档用途、状态和维护索引
   ├─ REFACTORING_SPEC.md
   ├─ DEVELOPMENT_WORKFLOW.md
   ├─ DATA_MODEL_AND_MIGRATION.md
   ├─ WEB_AND_ANALYTICS_SPEC.md
   ├─ WEB_PAGE_DEVELOPMENT_SPEC.md
   ├─ LADDER_PLAYER_AND_USAGE_SPEC.md   新页面、数据模型、性能口径及上线步骤
   ├─ CADDY_HTTPS_DEPLOYMENT.md         当前天梯 HTTPS/Funnel 与未来 Caddy 部署草案
   ├─ CARD_POOL_PORTING_GUIDE.md        其他单一卡池实例适配指南
   ├─ DECOUPLING_IMPLEMENTATION_PLAN.md 2026-09-16 解耦设计与验收边界
   ├─ DESKTOP_CLIENT_RESEARCH.md        PC 本地客户端延期调研归档
   ├─ SRVPRO2_MIGRATION_RESEARCH.md     srvpro2 长期迁移调研归档
   ├─ FEATURE_INVENTORY.md
   ├─ PROJECT_HANDOFF.md
   └─ archive/
      ├─ UPSTREAM_README.md             上游旧 README，只读历史归档
      └─ VERIFY_LEGACY.md               早期验证清单，只读历史归档
```

插件依赖主链为：`deck-classifier` → `ladder-core` → `ladder-analytics`，同时
`card-catalog` 与前三者共同支持 `ladder-usage-analytics`；`ladder-replay-enrichment` 组合
`public-replay-web` 与天梯/卡组服务。`ladder-web` 只依赖自身实际调用的两种统计和分类服务，
不再用 manifest 捆绑公开房间/录像插件；`public-room-web`、`public-replay-web` 和
`postgres-compat` 可独立加载。目录名
`deck_analysis` 与 manifest ID `deck-classifier` 不同是当前既有事实，不能只改一处名称。

## 3. 已完成的关键改动

### 3.1 通用插件宿主与核心钩子

- `plugin-system.js` 的 `PluginHost` 已实现插件发现、依赖排序、默认/本地配置合并、
  `configure`/`register`/`init` 生命周期、钩子、实体、翻译和命名服务注册，以及插件错误隔离。
- 插件翻译在 `register` 阶段以 `api.registerTranslations()` 注册。宿主拒绝插件之间或插件与
  核心字典的同语言同键覆盖，再统一合并并重建翻译正则；五种 `ladder_*` 文案已从
  `data/i18n.json` 移到 `plugins/ladder-core/i18n.json`。
- `ygopro-server.coffee` 已在数据库连接前执行插件配置和实体注册，在数据库就绪后初始化插件。
- 主流程已提供随机模式、进房、开局、猜拳胜者、单局结果、DuelLog 保存、房间结束和
  HTTP 请求等通用钩子；`duel_result.players` 复制所有有效对局席位，不再以 `pos < 2` 写死
  双人模式，具体插件自行验证人数。主流程不直接判断 TT、天梯页面或卡组类型。
- `Room.policy_overrides` 提供正向命名的 `hideNamesBeforeStart`、`allowEarlySurrender` 通用策略；
  已删除天梯导向的 `plugin_hide_names` 和语义相反的 `plugin_no_early_surrender`。
- `DataManager.registerEntities`、`getConnection`、`getRepository`、`pluginTransaction`
  为插件提供通用数据库能力；天梯实体不再放进主实体目录。

### 3.2 TT 天梯与结算

- `plugins/ladder-core/index.js` 已实现 TT 双人 Match、账户密码校验、总/月等级分、
  胜负记录和一次性事务结算。
- `ladderCore` 服务公开只读 `entities` 映射和按名称取仓储的 `getRepository()`；统计、使用率和
  维护工具不再穿透目录直接加载 `ladder-core/entities.js`。插件自身迁移/测试仍可引用其内部实体。
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
- `deckClassifier` 现在也是卡组元数据的唯一运行时读取边界，提供细分类查询/列表/搜索和
  展示分组接口，并按文件修改时间热更新 `deck_analysis.json`、`deck_display.json`。
  `ladder-analytics`、`ladder-usage-analytics` 和录像增强不再各自读取这些文件。
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

- `ladder-analytics` 提供总榜/月榜及等级分、纯胜场、胜负差、胜率排序。`ranking` 先对完整榜单
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
- `ladder-web/routes.json` 统一声明八个公开页面及根路径，不再在主服务中硬编码页面清单。
- 八个 HTML 已集中到 `ladder-web/web/`；`public-room-web`、`public-replay-web` 只保留 API
  职责。公共导航、语言菜单和翻译入口由 `web/assets/site-shell.js` 生成，基础样式由
  `web/assets/common.css` 提供；新增页面不再复制这些代码。
- `public-replay-web` 已恢复为不依赖天梯的录像扫描、DuelLog 基础补充和下载服务；
  `ladder-replay-enrichment` 通过 `publicReplayWeb.registerEnrichment()` 添加 G1 卡组分类、名称
  与筛选。完整插件集下 API 契约不变，移除增强插件后基础录像列表仍可工作。
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
- `docs/WEB_PAGE_DEVELOPMENT_SPEC.md` 已按当前实现登记八页的路由、URL/API 参数、展示字段、
  按钮行为、加载/空/错误状态、公共组件边界和回归清单；以后改变页面契约时须同步更新该文档。
- `docs/LADDER_PLAYER_AND_USAGE_SPEC.md` 所述纯胜场排名、玩家战绩查询、卡片/卡组使用率、
  卡组胜率详情、四语言 CDB 与增量统计已完成代码实现。玩家查询使用 POST 请求体传密码，
  时间取 Match 结算时间，比分从单局计算，初始卡组回查 G1 DuelLogPlayer；公开/认证可见性和
  下载均在服务端校验。生产仍须执行新迁移和显式历史回填，不能把“代码完成”等同于“线上已有
  历史统计”。HTTPS/Funnel/Caddy、`bindAddress`、密码哈希和额外认证加固仍为延期安全债。
- `card-catalog` 从 `plugins/card-catalog/databases/cards.{zh,ja,en,ko}.cdb` 逐份载入必要字段，
  中文库提供类型和 alias，异画归并为原画；SQLite/WASM 只存在于短生命周期读取子进程，
  当前开发机实测主进程 RSS 增量约 25.5 MiB；CDB 不提交 Git。`ladder-usage-analytics` 为每个
  Match 的双方保存幂等样本、可重建卡片事实、按日汇总和全量汇总；页面查询不扫描历史
  deckbuffer。卡组快照缺失仍计卡组使用率、不计卡片分母。
- 新页面为 `/player-stats.html`、`/usage-stats.html` 和 `/deck-detail.html`；公共导航增加玩家
  战绩与使用率，详情页归属使用率。天梯欢迎语增加月胜负差，排行页 ID 在未隐藏时可进入玩家页。
- 八页标题按语言使用中、日、英、韩本地化的服务器名前缀，切换语言时同步改变浏览器标题和
  顶部标题。介绍页新增服务器介绍、AI 开发/翻译说明及高亮注意事项，
  并按四语言 CDB 使用“血之代偿/血の代償/Ultimate Offering/희생의 제물”；两处卡名均链接到
  `ygocdb.com/card/80604091`。排行页补充总数据
  不清除、月数据每月重计的说明；大类卡组胜率页补充合并子类口径。玩家记录新增双方变化后
  积分并支持双方卡组下钻；详情页固定“其他”为末行，其余对手卡组可在本页切换查看。
- `deck_analysis.json`、`deck_display.json`、`ladder-web/example-decks.json` 的相关卡组译名已统一；
  使用率细分类以 `deck_analysis.json` 为权威，大类以 `deck_display.json` 为权威，示例下载名
  另由 `example-decks.json` 维护。此次仅修改 JSON 文本，没有改动四份 CDB。
- 本期只修改同级 `../config.json` 对应的当前卡池环境（游戏 7911、Web 7922）；
  `../config-srvpro2.json` 对应的 2337/2338 旧环境不动。
- `docs/CADDY_HTTPS_DEPLOYMENT.md` 记录了当前环境无域名时的 Tailscale Funnel 备选，以及未来
  有域名后使用 Caddy、Windows 防火墙、可选 `bindAddress`、认证接口保护、验收与回退步骤；
  当前明确不在服务器安装代理或修改防火墙。Funnel 只代理 Web 7922 时不影响游戏 TCP 7911，
  其带宽限制只涉及页面、API 与下载。
- 排行榜、玩家摘要/记录、卡组胜率和卡组详情已统一使用 `site-shell.js` 的胜率动态色值：
  50% 中性，0%/100% 分别以 `#ef837f`/`#73d6a3` 为红绿端点。排行前三名改用排名/玩家的
  金银铜色、左边线和行底色，避免覆盖胜负语义色；排序依据列使用独立紫蓝底色。玩家页对手
  ID 可在当前页切换查询且会清除内存密码，双方积分变化和胜负结果按正负着色。
- 玩家战绩页底部常驻公开/带密码模式说明，明确公开模式的当前月最近 10 条范围、带密码模式的
  所选月分页范围、两种模式允许的可见卡组下载，以及密码不进入 URL 的边界。
- 卡组详情会说明完整包含模板卡片才命中分类；“模板文件”通过受限接口下载分类器实际加载的
  数字 `.ydk`。`deckClassifier` 只允许按已加载 ID 取模板，不接受路径输入。
- `replays.html` 已展示 `duelCount` 和本局胜者；卡组下载文件名包含 `-gN-`。本期新增双方起始
  卡组类型列与“至少一方为指定类型”的筛选：普通列表只分类当前页，筛选复用已保存的 G1
  单局分类并缓存 60 秒，不改数据库表。缺少可靠关联时类型显示横杠，录像本身仍可下载。
- 客户端消息语言原本已有 `client.lang`、地理位置默认值和 `${...}` 翻译机制，但没有切换命令。
  现在支持 `/zh`、`/en`、`/ja`（`/jp`）、`/ko`（`/kr`）以及相应反斜杠写法（例如 `\en`）；
  命令只修改当前连接，确认后以新语言重新发送当前房间的入场提示，并通过通用
  `client_language_changed` 钩子让天梯插件重新查询、发送本月等级分/胜场/胜负差/胜率；不写
  数据库或配置。天梯战绩行已拆为五语言 i18n 片段，不再硬编码中文。
- tips 支持旧字符串和按 `zh-cn/ja-jp/en-us/ko-kr` 保存的对象；随机提示按每个客户端当前
  `client.lang` 选择文案，同一房间的不同语言玩家可以看到同一提示的不同翻译。`/tip` 与
  `/tips` 均可触发。当前 `config/tips.json` 的四条既有内容均已补齐四语言；语言切换提示按产品
  要求改为一条逗号连接的中、日、英、韩四语句子，所有客户端随机到该项时看到同一句。玩家刚
  进入 TT 天梯房间时，`ladder-core` 还会通过 `${ladder_language_switch_tip}` 主动发送这条四语
  提示；它不会在执行语言切换命令后重复发送。西班牙语客户端对未提供西语的本地化提示回退英语。
- `intro.html` 的天梯连接说明下方新增 `/tip`、语言切换和用命令响应辅助判断疑似掉线的说明；
  四个网页语言分别显示 `/zh`、`/ja`、`/en`、`/ko`。服务器介绍末尾明确“支持掉线重连但不支持
  云录像”，与当前运行能力和延期事项保持一致。

### 3.5 HTTP 接口与部署兼容

- 原 `/api/getrooms` 和 `/api/replay...` 已恢复原项目的鉴权及响应路径。
- 页面改用独立无密码接口：`/api/public/rooms`、`/api/public/replays`、
  `/api/public/replay/<filename>`；公开录像下载限制在录像根目录并校验文件名，中文文件名
  使用兼容浏览器的 `Content-Disposition`。
- `/api/public/replays` 可接收 `deckTypeId`，并返回用于筛选的细分类清单及当前页双方类型；
  `/api/ladder/deck-template?deckTypeId=` 提供实际分类模板附件，无匹配 ID 时返回 404。
- 上述录像卡组字段和 `deckTypeId` 筛选由 `ladder-replay-enrichment` 提供；基础
  `public-replay-web` 不认识天梯实体，也不强制双人席位。
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
- 新使用率表迁移位于 `migrations/202609-player-usage/`。生产先执行
  `001-create-usage-projections.sql`；若管理员建表而 Node 使用独立数据库角色，还必须执行
  `grant-runtime-role.psql` 授予八张统计表和五个序列的最小运行权限。之后再按
  `plugins/ladder-usage-analytics/BACKFILL.md` 停服执行
  audit、simulate、带确认串的 apply。普通启动只处理新 Match，不自动扫描或回填历史。

### 3.7 文档入口

- 根 `README.md` 已由上游旧说明改为当前分支入口，提供项目定位、状态边界、最小验证命令和
  一级文档导航；`docs/README.md` 记录全部项目文档的用途、维护状态及同步规则。
- 重构前的根 README 已保存到 `docs/archive/UPSTREAM_README.md`，只用于上游背景和无 Git
  历史的压缩包交接，不再作为当前安装或部署说明。早期根 `VERIFY.md` 已移到
  `docs/archive/VERIFY_LEGACY.md`，其自动建表等旧描述不作为当前验收依据。现有规范文件暂不移动，避免打断内部链接；
  以后如按 architecture/features/operations 分组，应使用一次独立文档提交统一完成。
- `docs/CARD_POOL_PORTING_GUIDE.md` 已列出其他单一卡池部署必须替换的卡组分类/模板、示例卡组、
  页面介绍/标题、房间提示和天梯规则，并提出把 1103 内容集中为环境包。一个实例只支持一个
  卡池，不跨卡池共用数据库统计或录像目录。

## 4. 重要设计决策和原因

| 决策 | 原因 |
| --- | --- |
| 核心只提供通用宿主/钩子，业务全部放插件 | 删除插件后才能恢复基准行为，也避免天梯逻辑再次与房间主流程缠绕。 |
| 翻译、实体和卡组元数据通过插件服务注册/取得 | 避免核心字典残留天梯词条，也避免运行时插件穿透其他插件目录读取内部文件。 |
| 公开录像基础服务与天梯增强分开 | 录像扫描/下载本身不依赖天梯；卡组筛选作为可选组合能力加载。 |
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
  会返回 500；文件存在但数据库关联缺失时仍会列出，只是局数/胜者/卡组类型可能采用缺省值。
  卡组筛选仅在用户选择类型时查询 `LadderMatchGame`，当前没有为 `deckTypeId` 单独增加索引；
  60 秒缓存可覆盖低频页面访问。若录像/单局规模显著增长或筛选 P95 超过 300 ms，应先查看
  PostgreSQL `EXPLAIN ANALYZE`，再决定是否用正式迁移增加 `(deckTypeId, duelLogId)` 索引。
- **录像/DuelLog 保存仍位于单局结束关键流程的同步等待链。** 本轮为了避免改变录像文件、
  DuelLog 与 `ladder_match_game.duelLogId` 的准确关联，没有将其改为后台队列，也没有调整
  `duel_result → persist replay → duel_log_saved` 顺序。若以后优化延迟，必须先设计持久队列、
  幂等键、失败重试和逐局对账，不能只用无等待 Promise 代替当前 `await`。

### 5.3 已确认延期与规划项

- **HTTPS 与认证加固继续延期。** 当前不在服务器安装代理或修改防火墙；以后按
  `docs/CADDY_HTTPS_DEPLOYMENT.md` 实施 HTTPS/Funnel/Caddy、`bindAddress`、密码哈希和
  额外认证保护。
- **云录像继续保持关闭，列为与 HTTPS 同期以后处理的功能。** 普通 `.yrp` 会由客户端使用
  本地 duel core 和卡片脚本重新演算，脚本版本不一致可能导致录像中断；现有云录像保存的是
  对局当时已经生成的观察者 STOC 协议流，播放时解压并直接发送给客户端，不再运行客户端卡片
  Lua 脚本，因此原则上可以绕过“服务器更新脚本、玩家客户端脚本未同步”的问题。它仍依赖客户
  端与录像之间的网络协议兼容，以及客户端 CDB/图片能够识别相应卡号，不能承诺跨大版本长期
  兼容。启用前必须用更新前、更新后两套真实客户端做交叉播放；同时补齐单局/单日大小监控、
  最大长度、保存期限、清理任务、读取限流和损坏数据降级。当前实现会在对局期间把完整观察者
  流保存在 Node.js 内存，结束后压缩并写入数据库；考虑线上 Windows 服务器只有 4 核 4 GB、
  常驻内存已约 3.2～3.4 GB，不得未经压测直接开启。
- **Challonge 接入继续关闭，恢复前迁移到 API 2.1。** 当前 `challonge.ts` 仍调用已弃用的 v1
  API，而且只负责读取一届既有比赛、清空/批量上传参与者、按未完成对阵创建房间和回写比分，
  不包含创建、启动、结束比赛和跨比赛选手晋级。预定赛制采用两届独立比赛：第一届为 64 人
  瑞士轮 6 轮，结束后按最终排名取前 16 名并上传到第二届单败淘汰赛，不依赖 Challonge 的两阶段
  模式。免费 Standard 套餐允许创建不限数量的比赛且单届上限 256 人，所以“两届比赛”和人数
  本身不超套餐限制；风险来自免费应用每月 500 次的 API 请求额度。瑞士轮共有
  `32 × 6 = 192` 场，淘汰赛有 `8 + 4 + 2 + 1 = 15` 场，共 207 场；按当前
  每批 10 人的上传代码，两届分别需要 1 次清空加 7 次上传、1 次清空加 2 次上传，共 11 次准备
  请求，若自动创建/启动/结束两届比赛还要继续增加。按当前默认的每小局回写，一场 Match 为
  2～3 次 PUT，仅比分就需要 414～621 次，再加读取比赛、晋级名单、重试等请求，即使每月只办
  一次这种完整赛事也很可能超过免费应用每月 500 次 API 请求额度。若只在 Match 最终结算时回写，
  理论主体可降为 207 次 PUT，连同两届准备请求通常可控制在额度内，但仍须为读取、断线重试和
  管理操作留预算。迁移时应以 [Challonge API 2.1 文档](https://challonge.apidog.io/) 为准，配置
  瑞士轮和淘汰赛两个 tournament ID，按最终排名显式生成晋级名单，并增加月度计数/熔断、超时、
  带退避重试与幂等保护后再启用。
- **QQ/Discord 群机器人属于以后独立实施的服务。** 实现时放在同一仓库的
  `services/community-bot/`，拥有独立 `package.json`、锁文件、配置、测试和启动入口，不放进
  `plugins/`。插件会加载到游戏 Node.js 主进程，而机器人需要独立控制内存、故障、Node/ESM
  版本和部署位置；它只消费 HTTP API，不需要游戏进程内钩子。业务层和两个平台 adapter 自写，
  但使用平台 SDK 处理鉴权、WebSocket 心跳、断线恢复和限流，不从零实现协议，也不引入带管理
  后台、插件市场等本项目不需要的通用机器人框架。QQ 采用腾讯维护的
  `@tencent-connect/qqbot-nodejs`；Discord 优先采用 application/slash commands，并使用
  `@discordjs/rest`、`@discordjs/ws` 等模块。机器人只调用现有公开/受限 API，不直连天梯数据
  库；匹配提醒先以 10～15 秒轮询房间状态、状态去重和冷却实现，凌晨 4 点月榜使用定时任务。
  密钥只通过环境变量或不提交的部署配置注入。该服务应独立进程运行，避免其故障和 ESM/Node
  版本要求影响游戏主进程。同仓库不等于同机器：主服务器内存不足时，可只复制该服务目录到
  维护者个人电脑临时运行。此方案不增加游戏服务器常驻内存，但个人电脑必须保持联网、不休眠并
  能在北京时间凌晨 4 点运行；API 请求必须设置超时、有限重试、短时缓存和不可用时的降级提示。
  个人电脑方案仅查询公开房间、公开玩家数据和公开排行榜，不通过当前纯 HTTP 链路传输玩家密码
  或后台凭据。
- **PC 本地客户端与群机器人同级延期。** 调研结论保存在
  `docs/DESKTOP_CLIENT_RESEARCH.md`：建议单独 GitHub 仓库，优先评估 Tauri 2，Electron 可作为
  熟悉 JS 时的备选；通过受限本地桥接启动 YGOPro 的加入/观战、录像和卡组参数，脚本更新必须
  固定版本并校验哈希。远程 HTTP 页面不得直接获得任意本地命令权限。
- **迁移 srvpro2 大幅延后。** `docs/SRVPRO2_MIGRATION_RESEARCH.md` 记录其 TypeScript、WASM
  核心、Worker 隔离和事件架构优势，也记录 1103 核心/协议/录像兼容和现有数据/插件重写风险。
  当前结论是高难度迁移，先稳定 srvprotianti，不在生产环境原地替换。

### 5.4 当前工作区状态

- 工作区不是干净状态。`config/config.json`、`config/admin_user.json` 有本地改动且包含敏感
  信息，禁止覆盖、提交、复制到其他环境或在日志/文档中展开内容。
- `.gitignore` 当前未提交改动已加入 `plugins/*/config.json`；这是已确认的插件配置约定，
  后续整理提交时应保留。
- `plugins/ladder-web/web/` 的 tooltip、统计颜色、玩家交互、模板下载和录像筛选均仍是当前
  工作区未提交改动；不应在合并或部署时被误删，也不应在未审核前宣称已发布。
- 若干编译后 `.js` 被 Git 标记为修改，但当前文本 diff 主要只显示换行符状态。提交前应运行
  构建并逐项检查 diff，避免把纯 CRLF/LF 变化混入业务提交。
- `docs/archive/VERIFY_LEGACY.md` 和 `docs/FEATURE_INVENTORY.md` 记录的是插件化之前的状态，其中
  `synchronize: true`、业务仍耦合主程序等描述已经过期。当前开发以本文、
  `REFACTORING_SPEC.md`、`DEVELOPMENT_WORKFLOW.md`、`DATA_MODEL_AND_MIGRATION.md`、
  `WEB_AND_ANALYTICS_SPEC.md`、`WEB_PAGE_DEVELOPMENT_SPEC.md` 和迁移 README 为准。

### 5.5 当前批次手工部署清单

线上若已经运行本次页面调整前的 `srvprotianti` 插件化版本，停服备份后可按以下清单更新：

- 整体合并 `plugins/`，但**不得覆盖服务器现有的任何 `plugins/*/config.json`**。本地当前存在
  `plugins/ladder-analytics/config.json`，它是部署覆盖而不是通用代码；Windows 资源管理器整拖
  前应先排除该文件。`plugins/card-catalog/databases/cards.{zh,ja,en,ko}.cdb` 不在 Git 中，但
  `card-catalog` 运行需要，必须确认服务器已有正确版本或单独复制。
- 新版完整插件目录必须包含 `ladder-replay-enrichment/` 和 `ladder-core/i18n.json`；旧的两个空
  目录 `public-room-api/`、`public-replay-api/` 已删除，不承载运行功能。
- `docs/` 和根 `README.md` 只用于交接，不影响运行；可以整体复制。
- 必须额外复制根目录 `ygopro-server.js`，否则 `/en`、`\en` 等客户端语言切换命令不会生效；
  同时复制源文件 `ygopro-server.coffee`，避免以后重新构建把功能覆盖掉。
- 必须额外复制 `plugin-system.js` 和 `data/i18n.json`。前者负责合并插件翻译，后者只保留通用
  语言切换帮助和确认文案；天梯文案随完整 `plugins/ladder-core/` 复制。
- 必须单独复制 `config/tips.json`，才能启用本批四语言轮播内容和语言切换提示。不得整体覆盖
  `config/`，尤其禁止覆盖线上 `config/config.json` 和
  `config/admin_user.json`。
- `migrations/202609-player-usage/` 是使用率统计首次上线所需的 PostgreSQL 建表、授权与回退
  文件。若生产已经执行并验证过该迁移，不要重复执行；若尚未执行，应复制该目录并严格按其
  README 停服操作。只复制文件不会自动改库。
- `package.json` 本期只新增 `ladder:usage-backfill` 维护命令，没有新增 npm 依赖；运行功能不依赖
  覆盖它，也不需要因此重新执行 `npm install`。若希望在线上用该 npm 命令，再复制
  `package.json`；也可直接运行对应 Node 脚本。
- `.gitignore` 不影响服务器运行，无需复制。

如果线上仍是旧 `srvpro` 或尚未包含插件宿主的早期版本，上述“增量清单”不适用。除完整
`plugins/` 外，还必须同步当前版本的 `plugin-system.js`、`duel-finalization.coffee/.js`、
`ygopro-server.coffee/.js`、`data-manager/DataManager.ts/.js`、相关实体/默认配置和 `package.json`；
这种跨版本部署应按完整版本包进行，不建议人工挑几个文件覆盖。

## 6. 修改代码时必须遵守的约定

### 6.1 范围和架构

- 永远不修改 `F:\MyCardLibrary\srvpro\srvpro`；只在 `srvprotianti` 中工作。
- 不读取或修改 `config/config.json`、`config/admin_user.json`。需要部署值时使用插件
  `config.json` 或声明过的环境变量。
- TT、ladder、卡组模板、天梯统计、公开页面和 PostgreSQL 部署策略不得写回主流程。
  主项目新增内容必须对任何插件都通用，并能在插件不存在时安全空操作。
- 新插件使用 `plugins/<plugin-dir>/plugin.json` 声明稳定 manifest ID 和依赖；依赖服务通过
  `api.provide`/`api.get` 传递，不直接访问另一个插件的内部状态、实体文件或元数据文件。
  天梯实体使用 `ladderCore.entities` / `ladderCore.getRepository()`；卡组元数据使用
  `deckClassifier`；插件文案使用 `api.registerTranslations()`。现有
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

- `npm test` 通过：单局结束、插件宿主、插件单元和插件集成等测试均成功。
- `ygopro-server.js`、`duel-finalization.js`、`plugin-system.js` 及所有插件 `index.js`
  通过 Node.js 语法检查。
- `npx tsc --noEmit` 通过。
- 新测试覆盖翻译注册/冲突保护、通用多人 `duel_result` 源码约束、通用房间策略名、八页路由、
  纯胜场排序、玩家公开/认证记录、最终比分计算、模板受限下载、
  录像 G1 类型识别/筛选和每 Match 两侧使用率样本；卡片单元测试覆盖类型识别、异画归并与
  超过 3 张整副排除。
- 结算回归已增加 `MSG_WIN.type`/`DUEL_END` 状态捕获，以及“子进程异常退出且暂存比分
  不相等也不得结算”的集成样本。
- 尚未因此宣告线上可直接升级；第 5 节中的停机迁移、错误历史记录处置和真实客户端冒烟
  测试仍是部署前置条件。本批功能还必须执行 `migrations/202609-player-usage/` 和显式使用率
  回填后，才能验收历史月份与全部时期数据。

## 8. 2026-09-14 卡组统计展示差额诊断

- `deck-stats.html` 的“总 M 局”来自 `rowGroup::all`，按定义包含该卡组对阵所有卡组类别的玩家视角；页面矩阵只展示
  `deck_display.json` 中 `isDisplayed=true` 的八个分组。因此八列之和不应被假定等于总 M 局，未展示的类别并没有丢失。
- 当时运行中的 `202609` 接口实际返回六武众总 M 局 255，而不是 225；八个展示分组之和为 95，未展示部分为 160。
  用迁移快照、迁移的唯一关联条件和迁移时模板复原后，得到 1578 个可靠 Match、4043 个物理单局，并逐项复现
  `255 = 95 + 160`。未展示 160 局为：其他 140、星骸植物 12、守墓 4、龙骑兵团 1、废铁 1、TG 代行 1、念动力 1。
- 当前 `deckClassifier.getDisplayGroups()` 通过卡组 `code` 是否等于家族代码或以家族代码为前缀来推导成员。`SYNCHRO_SPEED` 因而进入
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

## 10. 2026-09-16 本体与插件解耦收尾

- 实施前设计记录为 `docs/DECOUPLING_IMPLEMENTATION_PLAN.md`，本节记录执行结果。
- 天梯翻译已迁出核心字典；插件宿主新增带冲突保护的翻译注册/合并能力。
- Room 的天梯导向字段已替换为通用正向策略；通用 `duel_result` 已解除双人席位截断，TT 插件
  仍在自身边界要求恰好两名玩家，因此天梯数据口径未变。
- 跨插件运行时实体访问已改为 `ladderCore` 服务契约；卡组元数据和展示分组统一由
  `deckClassifier` 读取。迁移脚本和插件自身测试的内部引用不属于运行时耦合。
- `public-replay-web` 与天梯解耦，新 `ladder-replay-enrichment` 保持完整部署下原有卡组字段和
  筛选行为；`ladder-web` 已移除仅用于捆绑加载的公开房间/录像依赖。
- 录像/DuelLog 同步等待链没有修改；本轮没有 schema 或生产数据迁移。
- 已删除无用 `SimpleMonitor.ps1` 和两个空 API 目录；早期 `VERIFY.md` 已归档。
- 新增其他卡池适配指南，并归档桌面客户端、srvpro2 调研。桌面客户端优先级与群机器人相近，
  srvpro2 迁移优先级大幅延后。
- 本轮最终执行 `npm run build`、`node --check ygopro-server.js`、`npm test`、
  `npx tsc --noEmit --pretty false` 和 `git diff --check` 均通过。尚未替代第 5 节要求的生产迁移与
  两个真实客户端冒烟验收。
