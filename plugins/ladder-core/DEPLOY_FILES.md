# 天梯处罚与文案部署文件

## 待发布：天梯密码哈希（兼容版，迁机后单独发布，尚未上线）

按 `migrations/2027xx-hash-passwords/README.md` 分两步上线。第一次发布即“兼容版”，
`passwordHash.mode` 保持默认 `legacy`，`passwordChange.enabled` 保持 `false`。需要重启（走发布监控）：

| 文件 | 用途 |
| --- | --- |
| `ygopro-server.js`（源 `ygopro-server.coffee`） | TT 重连按账号授权、接管前复核；`realName` 只写昵称；recover 停用 |
| `plugin-system.js` | 新增 `callStrict`（授权钩子失败即拒绝） |
| `data-manager/DataManager.js`（源 `.ts`） | 后台 `playername` 按昵称匹配 |
| `plugins/ladder-core/index.js`、`i18n.json`、`config.default.json` | 认证、席位绑定结算、重连授权、改密码服务、新四语提示、新配置键 |
| `plugins/ladder-core/password-hash.js`、`password-guard.js`、`credentials.js` | 新增 |
| `plugins/ladder-core/credential-tools.js`、`reset-password.js`、`migrations/2027xx-*` | 新增离线脚本（只在 `hashed` 模式写入） |
| `plugins/ladder-analytics/index.js`、`player-duel-stats.js` | 把可信客户端 IP 传给准入 |
| `plugins/ladder-web/index.js`、`client-ip.js`、`plugin.json` | 改密码路由、IP、日志只记错误码；依赖加 `ladder-core` |
| `plugins/ladder-web/web/assets/site-shell.js`、`common.css` | 修改密码区；用户名拒绝全角＄/﹩ |

本地 `config.json` 里遗留的 `requirePassword` 会被忽略（启动日志提示）。无表结构变化。
使用白名单模板时同步 `ops/templates/nginx-website-routes.conf.example`（新增 `POST /api/ladder/account/password`）。

## 2026-11-24 等级分计算器与可热更的计分公式

在下列文件按相对路径覆盖后，**需要重启一次**（走发布监控，等房间空了再上）：

| 文件 | 用途 |
| --- | --- |
| `plugins/ladder-core/rating-formula.js` | 新增：计分公式，结算与计算器共用；之后改它可热更 |
| `plugins/ladder-core/index.js` | 结算改为调用上面的公式；热加载与自检；只读 `previewMatch` |
| `plugins/ladder-analytics/index.js` | 转发 `ratingPreview` |
| `plugins/ladder-web/index.js` | 新接口 `POST /api/ladder/rating-preview` |
| `plugins/ladder-web/web/ladder.html` | 计算器按钮与弹窗样式 |
| `plugins/ladder-web/web/assets/rating-calculator.js` | 新增：计算器页面逻辑与四语文案 |
| `plugins/ladder-web/web/assets/rating-rules.js` | 暴露生效规则给计算器 |

结算结果不变：公式逐行搬入新文件，集成测试中每场模拟对局的预估与实际写库结果逐项一致。
无数据库结构变化，不改配置。重启后，以后只改 `rating-formula.js` 时无需重启，替换文件后下一场生效；
新版本自检不通过会保留旧版并在日志里记 `ladder_rating_formula_invalid`；若新版本在真实对局上才出错，
该场自动改用上一版重算并记 `ladder_rating_formula_runtime_invalid`，新版本停用到文件再次变化为止。替换后应查看一次日志。

公网入口：现网 nginx 是整站转发，无需改动。若改用仓库的白名单模板（`ops/templates/nginx-website-routes.conf.example`），
该模板已加入 `POST /api/ladder/rating-preview`。

## 2026-10-20 Zombie 开关补齐

在已具备下文 2026-10-10 功能的服务器上，本次仅需更新 `ygopro-server.js` 和
`plugins/ladder-core/index.js`，并重启游戏主服务；源码维护同步 `ygopro-server.coffee`。
保留主配置和插件本地配置。默认 `countAfkPenalty: false` 不变，现在同时控制 AFK、flee、Zombie
的计次与旧处罚检查；倒计时、踢人对象、弃权与天梯积分变化保持原行为。
无需依赖或数据库结构迁移，既有 `ban` 表的手动账号/IP 封禁保持。

`random-duel-afk.test.js` 覆盖两个 Zombie 入口、开关热更、旧记录/混合记录、普通模式及无插件场景。
历史清理是另行授权的一次性运维操作，不是程序启动动作，不随开关切换自动执行。

## 2026-10-10 功能的完整部署基线

范围：天梯挂机/强退计次开关、旧处罚提示过滤、对手挂机时退出仍可能扣分的说明、四语进房错误、
四语默认欢迎和处罚提示，以及核心词典补齐和英文低 LP 文案。本清单覆盖前次和本次修改，
不将工作区其他功能的未提交文件作为本次修复的复制要求。

## 正式运行需复制的完整清单

路径相对于正式服务的启动根目录，与本地 `srvprotianti/` 对应。按相同相对路径覆盖以下六个文件后重启：

| 文件 | 用途 |
| --- | --- |
| `ygopro-server.js` | 通用挂机/强退及历史处罚钩子、避免重复计次、读取天梯提示策略、四语处罚提示 |
| `data/i18n.json` | 补齐核心翻译键，修正刷新失败键、处罚短文案和英文低 LP 提示 |
| `plugins/ladder-core/index.js` | 天梯处罚豁免策略、四语欢迎和进房拒绝、对手退出提示策略 |
| `plugins/ladder-core/i18n.json` | 天梯四语文案与仍可能扣分的说明 |
| `plugins/ladder-core/afk-policy.js` | 处罚计次开关的实时读取和边界校验；新增文件必须一起复制 |
| `plugins/ladder-core/config.default.json` | `countAfkPenalty: false` 和默认欢迎词入口 |

主目录 JS 已完成编译，按运行文件复制即可；只复制整个插件目录不能更新宿主逻辑。

保留服务器原有的主配置和插件本地 `config.json`。本地 `countAfkPenalty` 覆盖项优先于默认文件；
要关闭天梯挂机/强退计次，它应为布尔值 `false`，或删除该覆盖项采用默认值。开关后续修改可热更，
本次替换程序与词典文件需要重启。自定义欢迎词继续按原值显示；旧值“天梯比赛”自动采用四语。

本次挂机/文案修复没有新增依赖或数据库结构迁移。历史处罚不删除；关闭开关只在天梯匹配中
忽略纯挂机/强退记录，其他违规和其他模式仍按原规则处理。

## 可选同步的源码、测试与文档

以下文件用于在服务器保留完整维护材料，当前运行不依赖它们；本地已构建，无需为了本次部署修改 npm 脚本：

```text
ygopro-server.coffee
package.json
random-duel-afk.test.js
ladder-messages.test.js
plugins/README.md
plugins/ladder-core/README.md
plugins/ladder-core/LANGUAGE_AUDIT.md
plugins/ladder-core/DEPLOY_FILES.md
```

## 重启后的验收点

- 默认天梯欢迎显示中、英、日、韩；错误昵称/密码和三类拒绝进房同样返回四语。
- 对手挂机时提示含“不视为强退，但仍可能扣除天梯积分”。
- `countAfkPenalty: false` 下挂机/强退不计次，纯此类历史记录不显示处罚提示，原有积分结算继续生效。
- `/refresh`、录像发送、版本兼容等消息在切换语言后显示对应翻译，不显示 `${…}` 原始键。
- 其他违规处罚提示包含四语原因与各自语言的剩余时间。

断线重连语言保留和历史观战消息语言问题按用户要求保持原状。验证记录见 [语言核查](LANGUAGE_AUDIT.md)。
