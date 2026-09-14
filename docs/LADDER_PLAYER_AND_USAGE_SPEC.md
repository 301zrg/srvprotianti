# 天梯玩家查询、卡片/卡组使用率与卡组详情设计稿

> 状态：需求对齐稿，尚未实施。状态基准：2026-09-14。
>
> 本文用于确认需求、接口、数据模型、性能策略和历史数据边界。已确认决定和剩余问题见
> 第 14 节；剩余事项明确后才能进入开发。现有页面的已实现行为仍以
> `WEB_PAGE_DEVELOPMENT_SPEC.md` 为准。

## 1. 本期范围

本期拟包含以下改动：

1. 天梯排行增加按纯胜场排序。
2. 使用介绍页支持显示“当前按纯胜场排序”。
3. 玩家进入天梯模式时，欢迎提示增加本月胜负差。
4. 新增玩家战绩查询页。
5. 新增卡片/卡组使用率页。
6. 新增细分类卡组胜率详情页。
7. 为卡片统计增加四语言卡片资料服务、可重建明细事实和聚合数据。

本阶段先完成设计，不修改实体、接口、页面或生产数据。

## 2. 当前数据能力与缺口

### 2.1 已有数据

`LadderUser` 已保存总等级分、总胜场和总负场；`LadderMonthRecord` 已按 `YYYYMM` 保存月等级
分、月胜场、月负场和月胜负差。

`LadderMatch` 已保存：

- 双方规范 ID 和显示名；
- 胜者、败者；
- 双方细分类卡组 ID；
- 双方结算前积分、积分变化和结算后积分；
- G1 先攻玩家、猜拳胜者；
- 月份、结算时间和可空的 G1 DuelLog 关联。

`LadderMatchGame` 已保存每个单局的双方玩家视角、单局胜者、局数、先后攻和主牌/换备标记。

### 2.2 已确认的数据取法与缺失处理

- Match 最终比分不新增字段。按 `matchId` 读取 `LadderMatchGame`，以物理局号
  `duelCount` 去重并统计各局 `winnerName`，得到查询玩家视角的 `2-0`、`2-1`、`1-0` 等
  比分。镜像记录缺失、同一局胜者冲突或没有足够证据时显示 `-`，不猜测。
- 已确认 `LadderMatch.createTime` 是结算时间：当前代码在 `settle` 的事务中执行
  `const now = new Date()`，随后用这个值创建 Match。页面只展示一列“结算时间”，不增加
  `startedAt`、`endedAt`。
- G1 初始卡组继续使用 `LadderMatch.duelLogId` 关联的 G1 DuelLog，再读取双方
  `DuelLogPlayer.startDeckBuffer`。关联、玩家映射或 buffer 缺失时，卡组下载及依赖卡组内容的
  信息直接显示 `-`。
- 不新增独立的权威卡组快照表。卡片使用率的派生表只处理能可靠取得并解码的 DuelLogPlayer；
  缺失样本通过覆盖率公开说明。

YGOPro 的 `UPDATE_DECK` 只把主卡组和额外卡组合并为 `client.main`，副卡组单独放在
`client.side`。要将 `client.main` 拆成主卡组与额外卡组，必须依据 `cards.cdb.datas.type` 判断
融合、同调、超量和连接怪兽类型。

当前仓库内发现的游戏文件：

- `ygopro/cards.cdb`：约 14981 张卡，抽样卡名为中文，是当前游戏配置使用的文件。
- `ygopro/cards1.cdb`：约 14949 张卡，抽样卡名同样为中文，不能视为另一语言版本。
- 仓库外的 `../111/cards.cdb` 不应成为本项目运行依赖。

项目根目录 `databases/` 已提供四语言文件，实施时移动到 `plugins/card-catalog/databases/`：

| 文件 | 大小约 | 卡片数 | 说明 |
| --- | ---: | ---: | --- |
| `cards.zh.cdb` | 7.68 MiB | 14981 | 中文；作为卡片类型和 alias 的权威来源 |
| `cards.en.cdb` | 7.68 MiB | 14981 | 英文；`datas` 与中文签名一致 |
| `cards.ja.cdb` | 11.26 MiB | 14968 | 日文；比中/英少 13 张 |
| `cards.ko.cdb` | 10.21 MiB | 14968 | 韩文；`datas` 与日文签名一致 |

四份合计约 38.6 MiB。日/韩缺失的卡名逐卡回退中文；不能因为某个语言 CDB 缺卡而把有效
牌组样本排除。

## 3. 排行与天梯欢迎提示

### 3.1 纯胜场排序

现有 `rankingBasis` 增加允许值 `wins`：

```json
{
  "_rankingBasisComment": "可选值：points（等级分）、wins（纯胜场）、diff（胜负差）、winRate（胜率）",
  "rankingBasis": "wins"
}
```

要求：

- `GET /api/ladder?rankingBasis=wins` 支持总榜和月榜。
- 总榜按 `LadderUser.wins DESC`；月榜按 `LadderMonthRecord.wins DESC`。
- 建议同胜场时仅按规范化 ID 升序保证结果稳定，不再暗中使用积分或负场作为第二排名依据。
- 排行页增加“按纯胜场”按钮，并支持 `rankingBasis=wins` 页面 GET 参数。
- 未传 `rankingBasis` 时继续实时读取 `ladder-analytics/config.default.json` 和部署
  `config.json`，修改默认值后无需重启。
- 使用介绍页增加四语言 `content3_wins` 文案，`/api/ladder-config` 返回 `wins` 时展示该文案。

### 3.2 进入天梯提示

欢迎提示在当前月等级分、胜场、胜率之外增加月胜负差：

```text
<玩家>你好，你的本月等级分为<P>，胜场为<W>，胜负差为<D>，胜率为<R>%
```

其中 `D = wins - losses`。该提示当前沿用服务器内聊天中文文案，不随网页语言参数变化。

## 4. 页面与导航规划

拟新增页面：

| 页面 | 标准路径 | 导航建议 |
| --- | --- | --- |
| 玩家战绩查询 | `/player-stats.html` | 加入顶部导航 |
| 卡片/卡组使用率 | `/usage-stats.html` | 加入顶部导航 |
| 卡组胜率详情 | `/deck-detail.html` | 作为使用率页的下钻页，不单独加入顶部导航 |

三个 HTML 均放入 `plugins/ladder-web/web/`，接入现有 `site-shell.js` 和 `common.css`。新增导航
文案必须同时提供中、日、英、韩四种语言。卡组详情页在公共导航中把“卡片/卡组使用率”标记
为当前所属栏目。

## 5. 玩家战绩查询页

### 5.1 页面参数

建议地址：

```text
/player-stats.html?player=<玩家ID>&month=YYYYMM&page=1&L=zh|ja|en|ko
```

| 参数 | 规则 |
| --- | --- |
| `player` | 可选，玩家规范 ID 或显示 ID；服务端去空格并不区分大小写精确匹配 |
| `month` | 可选，`YYYYMM`；非法或缺失时使用服务器当前月 |
| `page` | 可选，最小 1；默认 1，每页固定 20 条 |
| `L` | 沿用公共语言参数 |

密码不得写入页面 URL、GET 参数、浏览器历史或导航链接。搜索框允许输入 `id` 或
`id$password`，页面只把 ID 写入地址；密码仅保存在当前页面内存中，并通过 POST 请求体发送。
当前采用 HTTP 时该请求体仍是明文链路。页面刷新后密码和私有访问状态丢失，需要重新输入。

### 5.2 排行榜入口

排行页中实际显示、未被 `******` 隐藏的玩家 ID 改成链接。点击后新开或当前页进入：

```text
/player-stats.html?player=<URL编码ID>&month=<排行页当前月份>&L=<当前语言>
```

被隐藏的 ID 不生成链接。总榜点击时月份仍建议带当前月份，供查询页的月度摘要使用。

### 5.3 搜索与认证

- 搜索只做精确 ID，不做模糊匹配。
- `id$password` 以第一个 `$` 分隔；ID 中不允许 `$`，密码可继续包含 `$`。
- ID 不存在时展示“未找到该玩家”，不得触发自动注册。
- 未提供密码或密码不正确时均进入公开模式，并显示同一个四语言 toast：
  “未提供正确密码，仅展示公开范围内的对战记录。”
- 不向前端返回密码、密码是否存在或密码错误的具体原因。
- 历史无密码账户无法证明查询者身份，始终只按公开模式处理，不自动注册或授予完整记录权限。

建议接口为：

```http
POST /api/ladder/player-profile
Content-Type: application/json

{
  "playerId": "player",
  "password": "仅在用户输入时存在",
  "month": "202609",
  "page": 1,
  "pageSize": 20
}
```

响应使用 `recordAccess: "public" | "authenticated"` 表示实际权限。密码比较由
`ladder-core` 提供的认证服务完成，页面插件和分析插件不得直接读取或返回 `LadderUser.pass`。

### 5.4 上方摘要板块

展示：

- 玩家显示 ID；
- 总积分、总胜场、总负场、总胜负差、总胜率；
- 所选月份、月积分、月胜场、月负场、月胜负差、月胜率；
- 最近 10 场 Match 的总天梯积分变化折线图。

胜负差均为 `wins - losses`；无对局时胜率显示 `0.00%`。所选月没有月记录时按初始积分
1000、0 胜、0 负展示，但应标识该月无比赛。

折线图始终取该玩家全历史最新 10 场，不受所选月份影响。建议使用原生 SVG，不增加前端
图表依赖；按时间正序绘制“最早到最新”，包含最早一场结算前的基线点和每场结算后的点，
最多 10 场记录、11 个点；不足 10 场时有几场就绘制几场，没有对局时显示空状态。悬停或
键盘聚焦显示时间、对手、赛果、积分前后值及变化量。

### 5.5 下方对战记录板块

已确认：

- 认证成功：展示该玩家所选月份的全部 Match，月份同时过滤上方摘要和下方记录列表。
- 公开模式且所选月份是当前月：只展示该玩家当前月最新 10 场，且最多一页。
- 公开模式且所选月份不是当前月：不展示任何对战记录。
- 所有记录按 `LadderMatch.createTime DESC, id DESC` 排列；认证模式每页 20 条。

每条记录展示：

| 字段 | 来源/规则 |
| --- | --- |
| 是否赢得猜拳 | `coinWinner` 是否等于查询玩家；缺失显示未知 |
| 是否 G1 先攻 | `g1FirstPlayer` 是否等于查询玩家；缺失显示未知 |
| Match 胜负 | `winnerName` |
| 单局比分 | 查询玩家得分在前，如 `2-1`、`1-2`、`1-0`、`0-1` |
| 玩家积分变化 | 对应 A/B 的 `duelPointsDelta`，带正负号 |
| 玩家卡组 | 对应 A/B 的细分类 `deckTypeId` 四语言名称 |
| 对手 | 对方显示名 |
| 对手卡组 | 对方细分类 `deckTypeId` 四语言名称 |
| 对手积分变化 | 对方 A/B 的 `duelPointsDelta`，通常为负但不硬编码为负 |
| 结算时间 | `LadderMatch.createTime` |
| 双方初始卡组下载 | 下载 G1 开始时的卡组；数据缺失时按钮禁用并说明原因 |

比分按本节开头确认的 `LadderMatchGame` 规则实时计算，不新增 `playerAScore`、
`playerBScore`。查询只对当前页最多 20 个 Match ID 聚合，已有 `(matchId)` 索引可以命中，
预计不会形成严重性能问题；只有实测 `EXPLAIN ANALYZE` 超出目标时才重新讨论冗余比分字段。

页面只展示 `LadderMatch.createTime` 一列结算时间，不新增时间字段。对局卡组下载从关联的 G1
`DuelLogPlayer.startDeckBuffer` 取得；比分、时间以外的卡组内容拿不到时均显示 `-`。

卡组下载不得把密码放入 URL。建议使用 POST 下载接口，页面在请求体中再次携带当前内存中
的凭据；公开可见的最近 10 场允许无密码下载，私有历史记录必须再次通过相同认证。现有公开
录像页已经公开部分双方卡组，但新接口仍不能让用户通过猜测 Match ID 绕过记录可见范围。

### 5.6 页面控件和状态

- 搜索框、搜索按钮、刷新按钮、月份选择、首页、上一页、下一页、刷新本页。
- Enter 与搜索按钮等效；搜索后回到第 1 页。
- 首次加载、玩家不存在、无月记录、无公开记录、卡组数据缺失、网络错误分别展示明确状态。
- 认证降级 toast 支持四语言，使用公共 toast 组件或本期新增的轻量公共实现。

## 6. 卡片/卡组使用率页

### 6.1 页面参数和时间范围

建议地址：

```text
/usage-stats.html?metric=monster&period=month&month=202609&page=1&L=...
```

| 参数 | 可选值 | 默认值 |
| --- | --- | --- |
| `metric` | `monster`、`spell`、`trap`、`extra`、`side`、`deck` | `monster` |
| `period` | `today`、`week`、`month`、`all` | `month` |
| `month` | `YYYYMM`，只在 `period=month` 时生效 | 当前月 |
| `page` | 卡片榜 1～4，每页 50；卡组榜默认不分页 | 1 |

时间边界已确认由插件配置固定为 `Asia/Shanghai`：

- 本日：上海时区当日 00:00 至当前时刻。
- 本周：上海时区周一 00:00 至当前时刻，不是滚动 7 天。
- 月份：对应自然月起止；当前月统计到当前时刻。
- 所有：全部可用且通过完整性校验的历史样本。

### 6.2 六个切换按钮

页面提供：怪兽使用率、魔法使用率、陷阱使用率、额外使用率、Side 使用率、卡组使用率。
切换后同步页面 GET 参数并回到第 1 页。

区域定义：

- 怪兽：只统计主卡组中的怪兽；不统计额外卡组和 Side。
- 魔法：只统计主卡组中的魔法；不统计 Side。
- 陷阱：只统计主卡组中的陷阱；不统计 Side。
- 额外：只统计额外卡组怪兽；不统计主卡组和 Side。
- Side：统计 Side 中全部卡，不再按怪兽/魔法/陷阱拆分。
- 卡组：统计 G1 初始卡组的细分类 ID。

主卡组/额外卡组通过 CDB 类型位拆分。融合、同调、超量、连接怪兽进入额外；仪式、灵摆等
实际放在主卡组的怪兽仍进入主卡组怪兽。

异画和原画按中文权威 CDB 的 `datas.alias` 归并：`alias > 0` 时使用 alias 指向的原画密码作为
统计 ID，否则使用自身密码。同一副牌同时投入原画和异画时，归并后数量相加，再进入投入
1/2/3 张统计。页面显示并链接原画密码；原画资料缺失时才回退实际卡片密码。

### 6.3 卡片使用率表

只展示所选维度前 200 名，每页 50 条，共最多 4 页。列为：

1. 排名；
2. 卡片密码；
3. 当前页面语言的卡片名称；
4. 使用该卡的卡组样本数；
5. 使用率；
6. 投入 1 张的样本数；
7. 投入 2 张的样本数；
8. 投入 3 张的样本数。

一个“卡组样本”定义为一场已结算 Match 中一名玩家的 G1 初始卡组，因此一场正常 Match
产生两个样本；同一玩家或相同牌表多次参赛会重复计数。使用率为：

```text
包含该卡的有效卡组样本数 / 该时间范围内全部有效卡组样本数
```

Side 使用率的分母为全部有效样本，包括没有 Side 卡的牌组。投入数量按目标区域内该
卡归并后的实际数量计算。正常牌组最多 3 张；已确认超过 3 张的历史脏样本整副排除并写入
审计结果，不并入使用数、使用率分母或“投入 3 张”列。

排序建议依次为：使用样本数降序、卡片密码升序。排名使用连续序号。卡片密码和卡片名称都
使用：

```text
https://ygocdb.com/card/<卡片密码>
```

并以 `target="_blank" rel="noopener noreferrer"` 新开标签页。

卡片使用率的分母只包括成功取得并解码 G1 初始卡组的有效样本，缺失卡组不纳入分子或
分母。页面同时展示统计覆盖率：有效卡组样本数 / 该时期全部天梯玩家-Match 视角数，避免
历史卡组缺失被误解为完整数据。

### 6.4 卡组使用率表

展示全部细分类卡组：排名、四语言卡组名、使用样本数、使用率。分母为该时期全部已结算
Match 的两个玩家视角；它不要求 G1 DuelLogPlayer 卡组数据完整，因为 `LadderMatch` 已保存
分类 ID。

- 除“其他”外，卡组名可点击并进入 `/deck-detail.html`，携带稳定 `deckTypeId`、当前时期、
  月份和语言参数。
- “其他”只展示，不可点击，始终放在最后，排名为非其他类数量加 1，不按其使用数插入中间。
- 其他类别按使用数降序、卡组类型 ID 升序排列。
- 卡组四语言名称实时读取 `deck_analysis.json`；响应只返回需要的公开元数据。

## 7. 卡组胜率详情页

### 7.1 页面参数与搜索

建议地址：

```text
/deck-detail.html?deckTypeId=580&q=<模糊名称>&period=month&month=202609&L=...
```

- 从使用率页进入时必须传稳定 `deckTypeId`，不依赖翻译后的名称。
- 手工搜索支持对细分类四语言名称和 `code` 做不区分大小写的包含匹配。
- `deckTypeId` 有效时优先于 `q`。
- 模糊查询没有结果时显示“暂无该卡组类型”。
- 模糊查询命中多个结果时弹出候选列表，列出当前语言名称并可附细分类 code；用户点击后才
  展示一个卡组的详情，并把稳定 `deckTypeId` 写入 URL。
- 页面没有 `deckTypeId`、没有搜索词且用户尚未选择候选时，详情区域保持空白，不自动选择
  默认卡组。
- “其他”没有详情页；直接输入 4095 时提示该类型不支持详情。

### 7.2 展示方案

页首标题为细分类卡组的当前语言名称，摘要卡展示：

- 所选时间范围；
- 卡组使用样本数；
- 全部卡组样本数；
- 卡组使用率。

下方把 12 个指标拆成四个标签页，每个标签页只显示三列，使窄屏更直观：

| 标签页 | 三列指标 |
| --- | --- |
| Match | 综合、G1 先攻、G1 后攻 |
| 全部单局 | 综合、先攻、后攻 |
| 主牌局（G1） | 综合、先攻、后攻 |
| 换备局（G2/G3） | 综合、先攻、后攻 |

每个标签页的行是“总计”以及所有细分类对手卡组。总计固定第一行，其余按卡组配置顺序或 ID
稳定排列。为避免桌面端信息隐藏在 hover 中、触屏无法悬停，每个单元格固定显示两行：第一
行是两位小数胜率，第二行用较小的中性文字显示 `胜场/样本数`。鼠标 tooltip 可以保留为
补充，但不能成为查看样本数的唯一方式。分母为 0 时显示“数据不足”，不显示伪造的 `0/0`。
颜色规则复用现有卡组胜率页。

详情统计沿用现有 12 指标定义和玩家视角模型，但时间过滤扩展为本日、本周和指定月份。
同卡组内战、G1 先攻合法性和镜像单局完整性规则不得改变。

## 8. 推荐数据模型

### 8.1 `LadderMatch` 不新增比分和时间字段

已确认不增加 `playerAScore`、`playerBScore`、`startedAt`、`endedAt`。玩家记录列表先分页取得
最多 20 个 Match，再一次性按这些 Match ID 聚合 `LadderMatchGame`，避免逐行 N+1 查询。
现有 `ix_ladder_game_match(matchId)` 足以支撑这个范围，预计比分实时计算不会造成明显开销。

玩家历史查询建议拆成 A/B 两个索引分支并使用 `UNION ALL`，均按月份和玩家精确过滤。上线
前先观察 `EXPLAIN ANALYZE`；只有现有索引不能满足目标时才增加：

```text
(playerAName, monthKey, createTime)
(playerBName, monthKey, createTime)
```

不为尚未出现的性能问题冗余保存比分。

### 8.2 不建立 `LadderDeckSnapshot`

G1 `DuelLogPlayer.startDeckBuffer` 已确认为初始卡组唯一来源，缺失即可接受，因此独立快照表
不再是严格需要，本期不建立。玩家页面按 `LadderMatch.duelLogId` 查 G1 DuelLog 和双方玩家；
找不到唯一映射或 buffer 解码失败时显示 `-`。

卡片使用率不能在每次页面请求时重复解码这些 buffer，所以仍需建立可重建派生表，但它不是
新的卡组原始数据副本。投影状态单独记录每个 Match/玩家是否成功、缺失或异常，供覆盖率、
审计与重新处理使用。

### 8.3 `LadderDeckCardFact`：可重建卡片事实

建议由新插件 `ladder-usage-analytics` 管理，每个有效 G1 玩家牌组、区域、归并后卡片一行：

| 字段 | 说明 |
| --- | --- |
| `matchId`、`duelLogPlayerId`、`playerName` | 唯一来源和审计身份 |
| `cardId` | 按 `datas.alias` 归并后的原画密码 |
| `zone` | `main`、`extra`、`side` |
| `copies` | 该区域中原画与异画合计投入数量 |
| `deckTypeId`、`playedAt`、`dayKey`、`monthKey` | 查询维度；`playedAt` 使用 Match 结算时间 |

唯一约束为 `(matchId, playerName, zone, cardId)`。事实表可从 LadderMatch、G1 DuelLogPlayer
和 CDB 重建，不是权威原始数据。

另建轻量
`LadderUsageProjection(matchId, playerName, status, reason, algorithmVersion, projectedAt)`：

- `success` 表示事实已生成；
- `missing` 表示没有可用 G1 DuelLogPlayer/buffer；
- `invalid` 表示 buffer、卡片 ID 或归并后投入数量非法；
- 唯一约束为 `(matchId, playerName, algorithmVersion)`。

投影失败不得回滚或影响天梯结算。插件收到带 `matchId` 的 `ladder_match_committed` 后处理，
并在启动时按批次补扫未投影 Match；缺失数据按规则记录而不是反复无限重试。

### 8.4 日聚合与总聚合

为了让页面查询不解码 base64，也不扫描所有历史事实，建议维护：

- `LadderCardUsageDaily(dayKey, zone, cardId, deckCount, copy1, copy2, copy3, invalidCopies)`；
- `LadderDeckUsageDaily(dayKey, deckTypeId, deckCount)`；
- `LadderUsageSampleDaily(dayKey, validCardSamples, totalDeckSamples)`；
- 对应的卡片、卡组和样本总累计表，专门服务 `period=all`。

今日读取一个日桶，本周最多合并 7 个日桶，月份最多合并 31 个日桶，全部记录直接读取总累计
表。聚合表必须能从 Fact 全量重建，并带 `algorithmVersion` 和 CDB 数据指纹；禁止
只保留不可审计的累计数。

## 9. 四语言 CDB 方案

建议新建独立插件：

```text
plugins/card-catalog/
├─ plugin.json
├─ config.default.json
├─ index.js
├─ CARD_DATABASE_CONFIG.md
└─ databases/
   ├─ cards.zh.cdb
   ├─ cards.ja.cdb
   ├─ cards.en.cdb
   └─ cards.ko.cdb
```

推荐文件名固定使用 BCP 47 风格语言后缀，不使用含义不明的 `cards1.cdb`、`cards2.cdb`。
四个实际文件已由维护者放在项目根目录 `databases/`，建立插件时移动到上述目录。二进制
不进入普通 Git，只提交 `.gitkeep`、配置模板和部署校验说明，部署时由维护者放入。

服务启动时：

1. 使用 `sql.js` 逐个只读打开 CDB，只取需要的 `id`、`type`、`alias`、`name` 后立即关闭；
   不能让四个 SQLite Database 实例、文件 Buffer 或卡片描述常驻内存。
2. 只从中文权威 CDB 的 `datas` 建立 `cardId -> {type, canonicalId}` 紧凑映射；
   `canonicalId = alias > 0 ? alias : id`。
3. 从四份 `texts` 只读取 `id,name`，建立四个紧凑名称映射，不加载 `desc` 和 `str1..str16`。
4. 校验四份 CDB 的卡片 ID 集和 `datas` 版本；当前已知中/英一致、日/韩一致但少 13 张。
   非中文文件只负责名称，不覆盖中文权威 type/alias；缺少翻译时逐卡回退中文，再回退密码。
5. 记录文件 hash/mtime 作为投影版本依据。固定卡池部署不要求运行期热重载；替换 CDB 后重启
   并显式执行重建。卡名更新无需重算统计，type/alias 变化必须重建 Fact 和聚合。

`card-catalog` 只提供卡片元数据服务；`ladder-core` 不依赖它。`ladder-usage-analytics` 依赖
`ladder-core`、`deck-classifier` 和 `card-catalog`。`ladder-web` 再依赖使用率服务并发布页面。

## 10. API 草案

| 接口 | 方法 | 用途 |
| --- | --- | --- |
| `/api/ladder` | GET | 增加 `rankingBasis=wins` |
| `/api/ladder/player-profile` | POST | 摘要、曲线、按权限裁剪的对战记录 |
| `/api/ladder/player-deck` | POST | 在同等权限校验后下载指定初始卡组 |
| `/api/ladder/usage/cards` | GET | 卡片前 200、分页和样本覆盖率 |
| `/api/ladder/usage/decks` | GET | 全部细分类卡组使用率 |
| `/api/ladder/deck-detail` | GET | 单一卡组使用率及 12 指标对阵明细 |
| `/api/ladder/deck-types` | GET | 模糊搜索细分类公开元数据；也可合并到详情接口 |

所有公开 GET 接口必须校验枚举、月份和分页上限。任何 SQL 排序字段必须由服务器枚举映射，
不能直接拼接用户输入。玩家 POST 接口设置请求体大小上限和统一错误响应；认证速率限制作为
延期安全债，本期不实施。

## 11. 查询性能与缓存

- 玩家摘要只查主键用户、唯一月记录以及玩家 A/B 两个索引分支。
- 最近 10 场曲线和记录分页使用 `createTime DESC, id DESC` 游标或稳定排序；页面可继续展示页码，
  但深分页优先考虑游标，避免大 OFFSET。
- 卡片榜只读日/总聚合，不在请求时解析初始卡组，不读取整张 DuelLogPlayer。
- 卡组使用率只读细分类日/总聚合。
- 卡组详情的 12 指标继续使用 PostgreSQL `GROUP BY` 和完整性过滤，按
  `period + deckTypeId + algorithmVersion` 缓存；新 Match 提交后只失效相关当前日、周、月和
 全部键。
- 当前日/周缓存建议 30～60 秒；已结束月份和历史详情在进程存活期可长期缓存。
- 上线前必须对玩家历史、卡片榜、卡组榜、详情页分别保存 `EXPLAIN ANALYZE` 基线；禁止以
  全表载入 Node.js 的方式换取开发便利。

在上述 Fact + 日/总聚合方案下，支持“全部记录”的页面成本不会随原始牌组数据
量线性增长，本期确认直接支持 `period=all`。真正较大的成本是首次历史回填和重建投影，不是
日常页面查询；它们应作为可暂停、可续跑、可审计的离线维护命令执行。

### 11.1 4 核 4 GiB Windows 部署的内存约束

当前同机运行两个相近天梯环境、5～10 个房间时整机已使用约 3.2～3.4 GiB，只剩约
0.6～0.8 GiB，不能采用“四份 CDB 全部常驻 + 全量统计缓存”的直接实现。

按本设计实现时：

- 四份 CDB 磁盘合计约 38.6 MiB，但只逐份打开；常驻数据只有约 1.5 万个 type/alias 和
  约 6 万条四语言卡名，不保存卡片描述。
- 预计每个 Node 进程新增稳态内存约 15～30 MiB，两个环境合计约 30～60 MiB；这是设计
  目标，不是上线前的保证值。
- 实际诊断脚本逐份读取 CDB 时进程 RSS 约从 71 MiB 升到最高 102 MiB。正式实现会使用更
  紧凑结构并及时关闭数据库，但两个环境升级/重启应错峰，避免临时峰值叠加。
- 卡片事实和聚合留在 PostgreSQL，不整表加载到 Node.js；API 每次最多返回 50 行，卡组详情
  只返回一个卡组。
- 进程内缓存必须是有上限的 LRU，建议总估算体积不超过 8～16 MiB、条目不超过 64～128，
  不允许按任意搜索词无限增长。
- 历史投影按小批次串行执行并主动让出事件循环；不能在游戏进程里一次读入所有 DuelLog 或
  Fact。重建工具优先在维护窗口独立进程运行。
- 使用率/详情接口增加并发上限、请求超时和短期缓存，避免多个同时聚合查询让 PostgreSQL
  `work_mem` 与 Node 响应对象叠加。

因此该方案的稳态内存增量应当可控，远小于房间进程本身，但当前机器余量已经偏小，不能只靠
估算承诺“绝不会超内存”。上线验收必须同时启动两个环境并保持约 10 个房间做至少 30 分钟
冒烟，记录各 Node 进程 RSS、整机可用内存和页面并发查询峰值；建议以单个环境新增 RSS
不超过 40 MiB、两环境运行时整机仍保留至少 300 MiB 可用内存作为最低验收线。超过即关闭
名称常驻缓存或下调缓存上限，不进入生产。

## 12. 历史数据回填与上线

### 12.1 可回填内容

- 玩家摘要、积分曲线、积分变化、猜拳、G1 先攻和双方卡组类型可直接使用现有 Match 字段。
- 历史和新比分都从 `LadderMatchGame` 的各局胜者计算；局号或胜者冲突时显示 `-`。
- 页面统一把 `LadderMatch.createTime` 显示为结算时间，不回填开始时间。
- 卡片 Fact 只从唯一关联的 G1 `DuelLogPlayer.startDeckBuffer` 生成；关联缺失、玩家对应不
  唯一、buffer 无法解码时跳过并报告。玩家页面对应下载按钮显示 `-`。

### 12.2 工具要求

历史回填不得在普通服务启动时隐式执行。维护工具必须提供：

- `audit`：只读统计可回填 Match/玩家样本、缺失原因、异常卡片和四语言覆盖率；
- `simulate`：事务内写入后汇总并回滚；
- `apply`：要求明确确认串，支持批次和断点续跑；
- `verify`：核对每个 Match/玩家的投影状态、Fact 唯一性、日聚合与事实重算结果；
- `rebuild`：按算法版本或 CDB 指纹重建派生 Fact/聚合，不改 LadderMatch 和 DuelLogPlayer。

新实体不能依赖 TypeORM `synchronize` 自动改生产库；必须提供显式迁移 SQL 和回退方案。

## 13. 回归与验收范围

- 四种排名依据的总榜、月榜、默认配置热更新和稳定分页。
- 天梯欢迎提示的积分、胜场、胜负差、胜率一致性。
- 玩家 ID 大小写、`id$password`、错误密码、空密码、历史无密码账户和不存在账户。
- 密码不出现在 URL、响应、日志、DOM 持久属性或下载文件名。
- 公开当前月最近 10 场、私有所选月全部记录、月份切换、分页、比分和双方积分变化方向。
- 三个新页面四语言、移动端横向滚动、空/加载/错误/toast 状态。
- 五种卡片区域互斥规则、卡片投入数、前 200 和每页 50。
- 同一牌表重复参赛按多个样本计数；同一张卡在一个样本只增加一次使用样本数。
- “其他”卡组永远最后且不可下钻。
- 卡组详情 12 指标与现有胜率页相同口径，日/周/月边界正确。
- CDB 缺语言、ID 不一致、alias 原画/异画归并、卡片类型变化、投影中断及重建幂等。
- 历史数据缺失时展示覆盖率和未知状态，不伪造比分、时间或卡组。

## 14. 需求确认状态

### 14.1 已确认

1. 认证成功时，下方记录按所选月份过滤并展示该月全部记录；公开模式只在当前月展示最新
   10 场，不足 10 场按实际数量展示，过去月份不公开记录。
2. 公开模式可下载其可见记录中双方的初始卡组；任何卡组数据缺失都显示 `-`。
3. 比分由 `LadderMatchGame` 计算，不新增比分字段；只展示 `LadderMatch.createTime` 这一列
   结算时间，不新增时间字段。
4. 纯胜场并列时只按 ID 升序稳定排序。
5. 一名玩家参加一场 Match 的 G1 初始牌组算一个样本；重复玩家、重复牌表重复计数。
6. Side 使用率的分母包含没有投入 Side 卡的有效牌组。
7. 四语言 CDB 已由维护者提供，实施时从根目录 `databases/` 移到 card-catalog 插件目录；
   固定卡池下不要求运行期更新。
8. 异画按 CDB alias 与原画合并为同一张卡。
9. 卡组详情模糊搜索命中多个结果时弹出候选列表；没有参数和输入时详情区为空白。
10. 顶部导航只增加“玩家战绩”和“使用率”，卡组详情仅作为下钻页。
11. 归并后超过 3 张的整副异常样本排除并记录审计。
12. 卡组详情单元格固定显示“胜率”和较小的“胜场/样本数”两行，不依赖鼠标悬停。
13. 卡片使用率、卡组使用率和卡组详情都支持 `period=all`，使用日聚合和总累计表控制成本。
14. 日/周/月边界使用 `Asia/Shanghai`，本周从周一 00:00 开始。
15. 卡片使用率只以成功取得并解码初始卡组的有效样本为分母，同时显示有效样本覆盖率。
16. 四份 CDB 不进入普通 Git，由部署时放入插件数据目录。
17. 中文 CDB 的 type/alias 是权威；其他语言只提供名称，日/韩缺失的 13 张回退中文。
18. 历史无密码账户不自动注册且始终按公开模式处理。

### 14.2 公网认证方案已确认

本期只修改持续开发的当前卡池环境。同级部署配置 `../config.json` 已由维护者明确授权检查，
可确认游戏端口为 `7911`、Web 端口为 `7922`、内置 SSL 关闭且没有 `bindAddress`。另一套使用
`../config-srvpro2.json`、游戏端口 2337/Web 端口 2338 的旧环境仍是未解耦代码，本期完全不动。

维护者当前没有可用自有域名，并明确接受娱乐用途、零成本账户在现有 HTTP/YGOPro TCP 下的
凭据泄露风险。本期采用简单直连方案：

1. Web 继续使用公网 HTTP 7922；带正确密码时允许查询私有记录，不因非 HTTPS 返回 426。
2. 不部署 Tailscale Funnel 或 Caddy，不新增 `bindAddress`，不调整现有端口与防火墙结构。
3. 不在本期迁移 `LadderUser.pass` 明文存储，也不自研 RSA、challenge/HMAC、SRP/OPAQUE 等
   应用层密码协议。
4. HTTPS、密码哈希、认证限速、敏感接口专用 CORS/安全响应头等作为已知安全债记录，等域名、
   服务器或风险等级变化后再评估，不阻塞本期页面开发。
5. SQL 参数绑定、枚举白名单、输入长度/分页上限、HTML 安全渲染和卡组下载权限检查仍属于
   正常功能正确性要求，本期必须实施；它们不引入额外代理、证书或明显常驻内存开销。

## 15. 传输安全、认证与 SQL 注入边界

### 15.1 当前环境与代码能力

SRVPro 已内置 HTTPS 服务。默认配置位于 `data/default_config.json`：

```json
{
  "modules": {
    "http": {
      "port": 7922,
      "ssl": {
        "enabled": false,
        "port": 7923,
        "cert": "ssl/fullchain.pem",
        "key": "ssl/privkey.pem"
      }
    }
  }
}
```

启用后，启动代码会读取 PEM 证书和私钥，并让 HTTPS 与 HTTP 使用同一个
`httpRequestListener`，所以现有相对页面、资源和 API 地址无需改写。

当前限制：

- HTTPS 开启后，原 HTTP 端口仍会继续监听，没有自动跳转到 HTTPS。
- 证书或私钥路径错误会使启动失败。
- 证书只在进程启动时读取，续期后需要重启 SRVPro 才能加载新证书。
- 当前 HTTP 层默认设置 `Access-Control-Allow-Origin: *`；带密码端点不能照搬这一策略。
- 反向代理后的真实访问 IP 需要从受信任代理的 `X-Forwarded-For` 获取，否则认证限速会把
  所有用户识别为代理服务器。

当前部署的 Web 端口是 `7922`，游戏 TCP 端口是 `7911`。更重要的是，现有
`LadderUser.pass` 为明文列，`ladder-core` 使用明文比较；玩家进入 TT 时使用的 YGOPro 原生
TCP 连接也会携带 `id$password`。因此只保护新增网页接口并不能让同一密码在整个系统中都不
再明文传输。页面必须提醒玩家使用天梯专用密码，不得复用邮箱、论坛或其他重要账户密码。

### 15.2 为什么不采用“HTTP 上再自行加密密码”

在 HTTP 页面中加入 RSA/Web Crypto，只能对付单纯抓包的被动窃听者。主动中间人既可以替换
服务器下发的 JavaScript 或公钥，也可以篡改查询结果和下载内容，所以浏览器没有一个可信
起点来判断自己拿到的加密代码是否真实。

随机 challenge 加 HMAC 可以避免直接发送明文并降低简单重放，但抓到 challenge 和 proof
后仍可离线猜测低强度密码，主动中间人也仍可替换页面或实时转发认证。SRP、OPAQUE 等 PAKE
协议能解决更多问题，但实现和审计成本明显超出本项目规模，而且仍不能保护网页响应与下载
内容；不自行设计密码协议。

单独发放“网页访问令牌”只能减少游戏密码泄露后的连带影响。令牌在 HTTP 上仍是可复制、可
重放的 bearer credential，不能替代 TLS。短期令牌如果也经网页或游戏明文链路发放，收益同样
有限。

### 15.3 方案 A：无自有域名时使用 Tailscale Funnel（未来备选）

Tailscale Funnel 可以把本机 `127.0.0.1:7922` 代理为公开的 `https://<设备>.<tailnet>.ts.net`
地址，自动提供有效 HTTPS 证书；访问玩家不需要安装 Tailscale，也不要求本机拥有公网 IP、
配置 DNS 记录或开放 80/443。基本目标命令形式为：

```powershell
tailscale funnel --bg 7922
```

正式执行前仍要完成 Windows 安装、账户/设备归属、MagicDNS、HTTPS 和 Funnel 授权；`--bg`
会持久保存配置并在 Tailscale/设备重启后恢复，但仍须实际做重启验收。它的限制是：当前仍为 beta；只能使用 tailnet 的
`*.ts.net` 名称；公网入口仅支持 443、8443、10000；流量经过 Tailscale 加密代理并受不可配置
带宽限制。鉴于本站使用量较小，可以先做压力和录像/卡组下载测试再决定是否长期采用。

Funnel 若只代理 Web 端口 7922，不会经过或改变游戏 TCP 7911，因而不会直接影响玩家对战
延迟；其带宽限制主要影响页面、API、录像及卡组下载。本期仍按维护者决定不部署，保留为未来
无自有域名时的备选。

若选此方案，建议新增通用可选 `modules.http.bindAddress` 并把当前环境设为 `127.0.0.1`，同时
关闭公网直连 7922。该配置只影响网页/API，不影响游戏端口 7911；未配置时保持现有监听行为。

### 15.4 方案 B：有域名后的 Caddy（长期推荐）

取得自有域名后，由 Caddy 统一监听 80/443、自动申请续期证书并反向代理
`127.0.0.1:7922`，仍是控制权和长期可维护性更好的方案。另一套 2338 旧环境不纳入当前改造；
将来若也迁移，应另行验收，不能直接套用本期配置。

完整草案见 [CADDY_HTTPS_DEPLOYMENT.md](./CADDY_HTTPS_DEPLOYMENT.md)。公网 IP 或本地域名由
Caddy 自动签发的本地证书不会被普通玩家浏览器自动信任；让所有玩家手工安装自建根证书既
不现实也容易造成更大信任风险，所以不作为公开站点方案。

### 15.5 方案 C：继续使用纯 HTTP（本期采用）

维护者已明确接受风险，本期允许在 HTTP 下用 `id$password` 查询私有记录。密码仍必须通过
POST 请求体传输，不得放入页面 GET 参数；服务端不主动把密码写入业务日志或响应。这里的
POST 只避免 URL、浏览器历史和常规访问日志泄露，不提供链路加密，无法阻止同网段、恶意热点、
被劫持路由或代理读取和修改通信。

本期不增加 HTTPS 强制、Funnel、认证限速、专用 CORS 或安全响应头。用户应为天梯使用独立、
可丢弃的密码，不应复用任何重要账户密码；该约束只记录在开发文档，不额外增加页面流程。

### 15.6 密码存储迁移

现有明文 `LadderUser.pass` 是独立于 HTTPS 的风险。未来建议改为带版本前缀和独立 salt 的
Argon2id 或 scrypt 哈希，新登录/结算校验统一调用验证函数；历史明文账户在首次成功登录时
原位升级，禁止把密码或哈希复制进日志。由于服务器只有 4 GiB 内存，哈希参数与认证并发必须
在正式机压测后选定，并配合队列/限速，不能让大量并发验证叠加内存峰值。

这项迁移保护数据库备份或数据库账户泄露，不解决 YGOPro TCP 和 HTTP 的链路窃听；两层保护
不能互相替代。

本节为已知安全债，本期不实施。

### 15.7 SQL 注入结论与实现规则

项目结构不是天然免疫 SQL 注入。当前 `ladder-analytics` 的月份条件使用 TypeORM 参数绑定，
排序表达式由服务端枚举映射生成；`ladder-core` 的名称查询也通过 ORM 参数传入，这是应继续
保持的安全模式。但只要未来把玩家 ID、月份、搜索词、排序字段或表/列名直接插入 SQL 字符串，
仍会产生注入风险。

本期新增接口必须遵守：

- 玩家 ID、月份、模糊搜索值全部使用参数绑定；`LIKE` 通配符即使需要转义，也不能改成字符串
  拼接。
- `rankingBasis`、`period`、`metric`、`zone`、排序方向和列名只接受白名单枚举，再映射到固定
  SQL 片段；ORM 不能自动安全绑定列名或排序方向。
- `page`、`pageSize` 转整数并限制范围，卡片榜总计最多 200 条、单页 50 条；拒绝额外字段和
  超长输入。
- 数据库应用账户使用完成运行期查询所需的最低权限；生产启动继续保持
  `synchronize=false`，DDL 只走显式迁移。

### 15.8 安全债与本期最低实现边界

- 本期最低边界：带密码请求使用 POST JSON；密码不进入 GET 参数、业务日志、toast、响应或
  DOM 持久属性。请求体长度、玩家 ID、月份和分页均设置合理上限。
- 每个对局和卡组下载请求都在服务端重新检查“该玩家是否拥有并可见该 Match”，不能只相信
  浏览器传来的 matchId，避免越权下载（IDOR）。
- 玩家名、卡组名、卡名及数据库文本均按不可信输入处理，使用 `textContent` 或统一转义，禁止
  拼进 `innerHTML`；外部卡片链接使用固定 `https://ygocdb.com/card/<纯数字ID>` 并加
  `noopener`。
- 查询设置稳定排序、分页上限、超时和并发上限；缓存使用有界 LRU，防止搜索词或月份组合
  造成内存无限增长。错误只给客户端通用文案，详细原因仅写不含敏感数据的服务端日志。
- 上线前检查 PostgreSQL 端口、管理接口、旧 HTTP API 和备份文件没有公网暴露；轮换任何曾
  出现在终端输出、日志、截图或版本库中的数据库凭据。
- 延期安全债：HTTPS/Funnel/Caddy、`bindAddress`、密码哈希、认证限速、敏感接口专用 CORS、
  `Cache-Control: no-store`、`Referrer-Policy`、`nosniff` 和 HSTS。服务器、域名或使用范围
  变化时应重新审查，不得把“账号价值低”解释为这些风险在技术上不存在。

### 15.9 官方参考

- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- [Tailscale：无需 DNS/公网 IP 分享本地服务](https://tailscale.com/docs/use-cases/application-testing/share-local-dev-server-with-internet)
- [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [OWASP TLS Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html)
- [OWASP SQL Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html)
- [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP REST Security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)
