# Web、公开 API 与卡组统计规范

## 1. 页面路由

可公开访问的页面不得硬编码在 `ygopro-server.js` 的条件分支中。Web 插件使用自己的 JSON 配置声明路由，例如：

```json
{
  "/": "web/rooms.html",
  "/intro.html": "web/intro.html",
  "/rooms.html": "web/rooms.html",
  "/replays.html": "web/replays.html",
  "/ladder.html": "web/ladder.html",
  "/deck-stats.html": "web/deck-stats.html"
}
```

五个页面文件统一位于 `plugins/ladder-web/web/`。`public-room-web` 和
`public-replay-web` 只提供接口，不再持有页面副本。全站导航、语言菜单及语言 URL 处理使用
`web/assets/site-shell.js`，公共基础样式使用 `web/assets/common.css`；两者由受限的
`/assets/<filename>` 静态资源路由提供。

插件宿主必须验证：

- URL 路径不能冲突或穿越目录。
- 文件必须位于对应插件目录中。
- 禁止页面配置覆盖原项目受保护的 API。
- 路由冲突、文件缺失和非法 Content-Type 必须记录明确错误。
- 静态资源只允许从固定 `web/assets` 目录读取单层 basename，并限制为 `.css`、`.js`。

## 2. 原接口兼容

以下接口恢复并保持基准项目鉴权和响应行为：

- `/api/getrooms`
- `/api/replay...`

监控项目继续使用原 `/api/getrooms`，不要求修改现有监控调用。

## 3. 新公开接口

页面使用独立接口：

- `GET /api/public/rooms`
- `GET /api/public/replays`
- `GET /api/public/replay/<filename>`
- `GET /api/ladder`
- `GET /api/ladder-config`
- `GET /api/ladder-deck-stats`
- `GET /api/example-decks`

公开录像接口必须使用安全文件名、固定录像根目录、正确的下载响应头，并禁止路径穿越。

## 4. 排行榜页面

- 用户名使用 `displayName`，不展示规范化的小写键。
- 只保留一个“等级分”列。
- 总榜的等级分来自总记录。
- 月榜的等级分来自所选 `LadderMonthRecord`。
- API 对当前榜单统一返回 `points`。
- 搜索和分页不改变玩家在完整榜单中的真实排名。
- 排序依据可为等级分、胜负差或胜率，并由天梯插件配置限制可用选项。
- 页面 URL 支持 `type=total|month`、`month=YYYYMM` 和
  `rankingBasis=points|diff|winRate`。未显式传排序依据时，后端每次请求实时读取
  `ladder-analytics/config.default.json` 与部署 `config.json`，修改默认值无需重启服务器。
- 分页区提供首页、上一页、下一页和刷新本页。

## 5. 录像页面

列表至少展示：

- 时间或录像文件名。
- 双方玩家。
- 文件大小。
- 当前小局 `duelCount`，显示为 `G1`、`G2`、`G3`。
- 本单局胜者；未知或平局时显示明确状态。
- 录像下载。
- 双方卡组下载。
- 分页区提供首页、上一页、下一页和刷新本页。

卡组下载文件名：

```text
<录像名>-g<duelCount>-<玩家原始名称>.ydk
```

## 5.1 介绍页与胜率页可热更新配置

- 介绍页的示例卡组分类、顺序、四语言名称和下载文件来自
  `ladder-web/example-decks.json`，由 `/api/example-decks` 在请求时读取。
- 胜率页展示分组来自 `deck_analysis/deck_display.json`，卡组分类元数据仍在
  `deck_analysis/deck_analysis.json`。统计请求每次重读展示文件，并把实际分组纳入缓存身份。
- 两份 JSON 保存后均无需重启服务器；已经打开的页面需要刷新或重新请求数据。
- 胜率页 URL 支持 `month=YYYYMM` 和稳定的 `metric` 指标 ID。

## 6. 统计样本模型

统计以“一个参赛卡组视角”为一个样本。

### 不同卡组

A 对 B 产生：

- 一条 A 对 B 样本。
- 一条 B 对 A 样本。

每条样本根据该玩家是否获胜、是否先攻以及是否为主牌局分别累加。

### 同卡组内战

A 对 A 产生两条 A 样本：

- 胜者视角一条胜利样本。
- 败者视角一条失败样本。

因此 A 对 A 总体胜率恒为 `1 / 2 = 50%`。

先攻和后攻统计不强制为 50%：

- 先攻胜率只统计先攻玩家视角。
- 后攻胜率只统计后攻玩家视角。
- 同卡组先攻胜率与后攻胜率在样本完整时互补，合计为 100%。

## 7. Match 统计

来源为 `LadderMatch`。

- 将 A/B 两侧展开成两个玩家视角。
- 总胜率 = 该类型胜利样本数 / 该类型参与样本数。
- 对指定类型胜率只统计 `deckTypeId -> opponentDeckTypeId` 对应样本。
- Match 先攻/后攻以第一局先攻者为准。
- 同卡组内战的总体处理遵守上一节规则。
- `g1FirstPlayer` 为空或不能对应 Match 双方之一时，整场 Match 及其单局均不进入卡组统计。

## 8. 单局统计

来源为 `LadderMatchGame` 的双镜像记录。

- 总单局胜率按全部玩家视角统计。
- 先攻胜率只统计 `isFirst = 1`。
- 后攻胜率只统计 `isFirst = 0`。
- 主牌局只统计 `isMain = 1`。
- 备牌局只统计 `isMain = 0`。
- 指定对阵使用 `deckTypeId` 和 `opponentDeckTypeId`。
- 每个物理单局必须有两个相反的玩家视角，且 `isFirst` 恰好一方为 `1`；无法唯一确定
  先后攻的单局不参与任何单局统计。

所有比率的响应必须同时返回分子和分母，前端不得只收到百分比，以便展示“数据不足”和核验结果。

## 9. 查询性能

禁止读取整张 `LadderMatchGame` 后在 Node.js 中过滤。

第一版使用：

- PostgreSQL 按月份过滤。
- SQL `GROUP BY` 聚合卡组、对手、先后攻和主/备牌维度。
- `LadderMatch.monthKey`、`LadderMatchGame.matchId` 及常用分类字段索引。
- 当前月份 30 至 60 秒进程内缓存。
- 启动后异步预热当前月份，不能阻塞游戏服务启动。
- 已结束月份在进程存活期内不主动失效。

服务器重启后进程内缓存会丢失，但原始比赛数据不会丢失。启动预热或首次请求会重新生成一次结果。

达到以下任一条件后再引入持久化快照：

- 单月单局视角记录超过约 50 万行。
- 统计接口 P95 超过 300 ms。
- 多进程部署导致重复聚合成为明显负担。

持久化快照必须带有：

- 统计算法版本。
- 月份。
- 已处理的最大 Match/单局水位。
- 生成时间。
- 可重复构建和失效机制。

在指标定义稳定和取得真实 `EXPLAIN ANALYZE` 数据前，不提前创建快照表。
