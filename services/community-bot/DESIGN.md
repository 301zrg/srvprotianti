# QQ / Discord 社群机器人设计与实现

> 功能契约与接入说明。日常开发、命令和运行说明先读 [README.md](./README.md)；修改行为口径或平台权限时再读本文。
> 独立服务与核心测试已实现。2026-09-23 已有 QQ 群联调及无主动权限码 `40034105` 的记录；不能据此认定 QQ 主动推送或 Discord 完整部署验收已完成。

## 1. 目标与边界

- 机器人作为 `services/community-bot/` 中的独立进程部署，可与游戏服务同机，也可在另一台常开机器运行。分别提供 QQ 群和 Discord 频道适配器，共用房间查询、去重、定时任务及指令逻辑。
- 首版只消费现有公开 API，游戏主服务启动、运行、匹配和结算均不依赖机器人是否在线；平台密钥、平台 SDK 和平台发送失败都留在机器人进程。
- 机器人只读取公开或专门授权的 API，不直接连接天梯数据库，不处理玩家密码或后台管理凭据。配置和密钥不提交 Git。
- 已确认的四项功能：TT 单人等待匹配提醒、每天北京时间 04:00 播报当月榜前 10、群成员查询全部公开房间、按玩家 ID 查询公开模式战绩。

## 2. “进入匹配”如何及时获知

当前 TT 房由 `ladder-core` 注册随机模式，首位玩家通过认证并取得有效座位后才会出现在 `GET /api/public/rooms`。此接口给出 `roomid`、`roomname`、`users`、`istart`；`roommode` 表示宿主对局模式，不能独立识别 TT 等随机模式，页面目前靠 `M#TT,RANDOM#` 房名规则识别 TT。等待期间玩家名称由 `hideNamesBeforeStart` 遮蔽。首版沿用公开页面的 TT 房名判定规则；以后若房名规则变化，页面与机器人需要同步修改，或由公开 API 增加显式随机模式字段。

| 方案 | 首位玩家进入后的检测时间 | 代价与限制 | 结论 |
| --- | --- | --- | --- |
| 每 10～15 秒查询公开 HTTP 房间接口 | 理想情况下平均约 5～7.5 秒，最慢接近轮询间隔，另加网络及平台发送时间 | 短暂等待房可能在两次查询间出现又消失 | 延迟偏高 |
| 每 5 秒查询公开 HTTP 房间接口 | 理想情况下平均约 2.5 秒 | 一台机器人约每分钟 12 次请求，仍可能漏掉不足一个轮询周期的短暂状态；需超时、退避、去重 | **首版方案，间隔可由 JSON 配置** |
| 独立机器人订阅经过脱敏的房间事件流 | 正常连接时接近实时 | 需修改游戏侧公开事件契约；当前 WebSocket 会发送原始玩家名 | 若实测 5 秒轮询不能满足需求，再设计升级 |

**提醒触发条件：**每次查询全部公开房间，筛选 `roomname` 符合当前页面的 TT 随机房规则、`istart === "wait"` 且恰好一名有效对战玩家的房间。按宿主 `get_playing_player()` 的席位口径统计 `users` 中 `0 <= pos < 4` 的玩家，不把观战席位计为第二人，也不使用已遮蔽的玩家名判断人数。新创建的 TT 房首次被观察到满足该条件时提醒一次；该房第二人入座、匹配成功、开局或后来又变回单人时均不另发提醒。房间刚创建但首位玩家认证失败、尚未取得有效席位时不提醒。

机器人启动或游戏 API 从不可用恢复时，先用一次快照建立基线，避免把所有旧等待房当成新提醒；随后按房间 `roomid` 与 `roomname` 记录本次生命周期是否已提醒。先观察到空 TT 房、后观察到首位玩家入座时也提醒。房间离开单人等待状态后仍保留已提醒标记，直到该房间从列表消失；同一房间短时消失又出现时还需冷却，避免接口抖动重复发送。轮询请求不得重叠；失败时按上限退避并记录日志，恢复后重新建立基线。机器人停机期间无法保证补发瞬时等待房；如果以后要求零漏报，需要游戏侧持久事件队列。

当前 `roomlist.coffee` 的 WebSocket 使用原始玩家名称，和公开 HTTP 的等待期匿名规则不同；首版不用它。单人等待提醒的消息正文只包含“当前有人正在等待天梯匹配”的目标语言译文，不带房间 ID、房名、玩家 ID 或其他房间信息。

## 3. QQ 群接入准备

使用 QQ 开放平台的正式机器人应用及腾讯维护的 `@tencent-connect/qqbot-nodejs`。该 SDK 支持出站 WebSocket 和入站 Webhook，要求 Node.js 20+、ESM；独立进程可自行选版本。初期优先出站 WebSocket，部署端无需公网回调地址；若实际控制台要求或日后切换 Webhook，则另需可公网访问的 HTTPS 回调 URL、平台配置和验签。SDK 会用 AppID 与 AppSecret 换取访问令牌，通常无需人工提供长期 Access Token。当前配置显式使用 QQ 官方统一 API 地址 `https://api.bot.qq.com`，并只申请群聊/C2C 的 `1 << 25` intent，避免申请机器人未使用的额外事件权限。

| 需要准备 | 类型 | 用途 |
| --- | --- | --- |
| QQ 机器人 AppID | 应用标识，非密钥 | 标识机器人应用 |
| QQ 机器人 AppSecret | **密钥** | 换取平台访问令牌；仅注入机器人进程 |
| 目标群的 `group_openid` | 目标标识，非密钥 | 定向发到指定 QQ 群；它不是普通数字群号，可在机器人收到群事件后记录 |
| 机器人在目标群的准入、消息事件订阅、主动群消息权限及额度 | 平台/群设置 | 允许接收指令和定时、匹配类主动推送；以该应用控制台及目标群实际测试为准 |
| 沙箱测试成员/群、正式发布状态，及平台要求的出口 IP 白名单 | 部署条件 | 决定测试与正式环境能否访问 QQ OpenAPI |

**QQ 主动推送降级：**匹配提醒和凌晨月榜都是主动群消息，不能用群成员的一条旧消息 `msg_id` 伪装成被动回复。QQ 主动群消息存在权限和额度限制，服务将 `40034102` 和已有联调记录的 `40034105` 视为主动权限拒绝。配置可逐群关闭主动推送；关闭时不调用发送 API，而是把本应发送的提醒写入独立日志文件。若尝试发送后平台返回上述错误，本次进程内立即停用该群的后续主动推送，写入失败原因和后续待推送内容；被动查询指令继续可用。恢复主动推送需修正平台权限并重启机器人，当前没有配置热重载入口。

## 4. Discord 接入准备

创建 Discord Application 和 Bot，安装到目标服务器；机器人以 Gateway 接收 slash command 交互，用 Bot Token 调用 REST 主动发频道消息。初期不读取普通聊天内容，因此不需要 `MESSAGE_CONTENT` 特权 Intent。开发时可先注册目标服务器内的命令，确认后再考虑全局命令。

| 需要准备 | 类型 | 用途 |
| --- | --- | --- |
| Application ID | 应用标识，非密钥 | 注册 slash commands |
| Bot Token | **密钥** | Gateway 鉴权、注册命令和发送频道消息 |
| 目标 Guild ID、Channel ID | 目标标识，非密钥 | 注册测试命令、指定提醒和月榜频道 |
| 安装授权及频道权限 | 平台/服务器设置 | `bot` 与 `applications.commands` scope；目标频道允许查看频道、发送消息，按最终消息样式补充嵌入链接等权限 |
| Public Key | 条件项，公开验证键 | 只有改为 Discord 的 HTTP Interactions Endpoint 接收回调时才需要；当前 Gateway 接入无需配置 |
| Client Secret | 条件项，**密钥** | 只有另做用户 OAuth2 授权流程时才需要；当前实现无需配置 |

`discord.botToken` 必须填写 Developer Portal 的 Bot → Token。General Information 中的 64 位 Public Key 只用于验证 HTTP interactions，不能用于 REST 或 Gateway 登录；配置校验会直接拒绝把这种 Public Key 填入 `botToken`。

## 5. 已确认的查询与播报功能

| 功能 | 触发和数据来源 | 输出 |
| --- | --- | --- |
| TT 单人等待提醒 | 第 2 节定义的 5 秒房间状态轮询 | 仅向 JSON 指定且允许主动推送的 QQ 群、Discord 频道发送一次；QQ 不允许时写日志 |
| 每天 04:00 月榜前 10 | `Asia/Shanghai` 当天 04:00 请求 `GET /api/ladder?type=month&month=YYYYMM&page=1&pageSize=10`，**不传 `rankingBasis`**，由 `ladder-analytics/config.default.json` 与部署覆盖 JSON 中的当前 `rankingBasis` 决定排序 | 依 API 返回的 `rank` 顺序展示当月前 10 名的玩家名、等级分 `duelPoints`、胜 `wins`、负 `losses`、胜负差 `diff`；记录本次 `rankingBasis`，无数据则说明本月暂无记录；QQ 无主动权限时写日志 |
| 查询全部房间 | QQ 群内 `@机器人 房间`；Discord `/rooms`。请求 `GET /api/public/rooms` | 仅输出接口返回的所有 `roomname`（可用于进房的名称），一行一条；不附加人数、玩家、模式、状态或统计 |
| QQ 指令帮助 | 已配置群内 @机器人，但消息无法识别为上述两个 QQ 指令 | 按该群 `languages` 的顺序输出每种语言的指令名称、格式和说明，合成一条回复 |
| 按 ID 查询玩家战绩 | QQ 群内 `@机器人 战绩 <玩家ID>`；Discord `/player id:<玩家ID>`。请求 `POST /api/ladder/player`，传精确 ID、北京时间当前 `YYYYMM` 和空密码 | 展示总战绩与本月战绩的排名、等级分、胜场、负场、胜负差、胜率，以及本月使用卡组及各自胜率；另附接口按 `recentMatchLimit` 返回的积分变化折线图。文字结果按目标的全部配置语言分别生成完整区块；查无此人则提示；不展示对战记录明细或卡组下载链接 |

月榜查询显式传入按北京时间计算的 `YYYYMM`，避免机器人部署机器与游戏服务时区不同；接口响应中的 `rankingBasis` 应记录在日志中。排序不在机器人里重新实现，也不强制按等级分排序。如果插件部署配置热更新，下一次 04:00 播报自然采用新的默认排序。若有多个目标群/频道，04:00 只查询一次月榜，再按目标分别发送或记日志。

群内查询只在 JSON 配置的目标群/频道接受，机器人不读取玩家密码，也不调用 `/api/getrooms` 管理接口。QQ 指令以平台允许的 @ 消息触发；Discord 使用 slash commands，不依赖读取普通聊天内容。对玩家 ID 设长度和格式边界，避免刷屏；房间号列表过长时按平台限制分成多条消息，每条仍保持一行一个房间号。公开玩家接口虽然使用 POST，但空密码即公开模式，不要求玩家向机器人提交凭据。房间可见范围严格等于现有公开 API 的结果，不另加未确认的公开/私有过滤规则。

玩家使用卡组取公开响应的 `summary.month.decks`，按接口现有的使用 Match 数降序展示卡组名称、使用场数和 `winRate`。折线图取同一公开响应的 `chart`，它是**最近 `recentMatchLimit` 场已结算 Match（可跨月）**，以第一场 `pointsBefore` 为起点，依时间顺序连接每场 `pointsAfter`；绘成可在 QQ、Discord 发送的 PNG 图片，不在图里输出对手、牌组或逐场对战明细。无对局时说明暂无可绘制的积分变化。图像发送失败须记录日志并告知查询者。

## 6. 自动消息与多语言

每个 QQ 群在 JSON 中配置 `languages` 数组，可从 `zh-cn`、`ja-jp`、`en-us`、`ko-kr` 选择一种或多种；按数组顺序把同一条文案的译文用 ` / ` 连接，**合成一条消息只发送一次**。空数组、未知语言或重复语言在启动时视为配置错误。Discord 每个频道也使用相同字段，默认示例为单一中文。翻译字典由机器人服务保存，不依赖游戏主服务的私有文案。

匹配提醒的中文原文固定为“当前有人正在等待天梯匹配”。日、英、韩译文保持同一语义；多语言时仍不附带房间号和玩家信息。每天 04:00 的月榜标题和列名按目标的 `languages` 合并翻译，玩家姓名与数值每行只出现一次，避免四份榜单重复发送。QQ 指令帮助和玩家战绩文字需要每种语言的完整语句与字段标签，因此按配置顺序生成独立语言区块，再合成一条回复。该日 04:00 机器人停机或查询失败时**不补发**，成功发送过的目标也不得在重试或重启时重复收到当天榜单。

## 7. JSON 配置与运行要求

服务目录使用可提交的 [config.default.json](./config.default.json) 和不提交的同目录 `config.json`。默认文件放完整结构和示例占位值，QQ/Discord 默认 `enabled: false`，不含真实密钥或真实群 ID；正式文件只写覆盖项。启动时加载默认 JSON，再以正式 JSON 的字段覆盖；对象递归合并，群/频道数组整体替换，避免示例目标混入生产。缺少已启用平台的必要凭据或目标 ID 时明确报配置错误。正式文件、日志和定时状态文件已加入 `.gitignore`。配置变更后重启独立机器人进程。

配置结构只在默认 JSON 中维护，字段合并和约束以 [src/config.mjs](./src/config.mjs) 为准，本文不复制整份示例。

正式 `config.json` 中配置 QQ AppID/AppSecret、目标 `group_openid`、Discord Application ID/Bot Token、目标 Guild/Channel ID，以及游戏公开 API 地址。所有这些平台参数都从 JSON 读取；不要求环境变量承载 API 密钥。日志文件记录时间、平台、目标、事件类型、结果/错误码与必要的脱敏内容，不记录密钥、Access Token、玩家密码或未公开的玩家名。QQ 因无主动权限跳过的每条匹配提醒和每天月榜都要有日志记录，且日志不能只写在控制台。

首次查找 QQ 群 OpenID 时，可把唯一一个目标临时配置为 `temp`。服务收到首个群消息事件后，在当前进程中将该目标绑定到事件里的真实 `group_openid`、立即继续处理本次命令，并写入 `qq_group_discovered` 日志；维护者再把真实值写回正式配置。群消息接收、命令识别和回复失败分别写诊断事件，平台错误只保留业务错误码，不记录用户消息正文或密钥。

- 两个平台各自可独立启停。正式 JSON 不提交 Git；密钥不得进入示例、错误日志或机器人群消息。
- 游戏 API 请求有超时，对网络故障、429 和 5xx 最多重试一次，间隔 300 毫秒；房间轮询失败时另有最高 60 秒退避。QQ/Discord 发送由对应 SDK 处理，服务未统一实现 `Retry-After` 调度；不能把平台限流验收写成自动测试已保证。游戏 API 不可用时查询命令提示暂不可用，恢复后按最新快照继续，不群发旧提醒。
- 如果机器人部署在个人电脑，必须保持联网和不休眠，且能访问游戏 API、QQ/Discord；凌晨 4 点机器人离线或查询失败的当日榜单不补发。
- 验收至少覆盖：首位玩家有效入座、拒绝/断线后空房不提醒、观战者不算第二人、第二人入座、开局、同一房间更新、机器人重启、游戏服务重启、QQ 无主动发送权限写日志、四种语言及复数语言合成一次推送、QQ 未识别 @ 消息的多语言帮助、查询只列房间号、公开玩家总/月排名与战绩的多语言文字及跨月 `recentMatchLimit` 场 PNG 折线图、月榜排序热更新与跨月、04:00 错过不补发、平台限流。

## 8. 参考资料

- 公开房间契约：[public-room-web/README.md](../../plugins/public-room-web/README.md)；公开玩家与排行榜入口：[ladder-web/README.md](../../plugins/ladder-web/README.md)。
- 宿主与页面：[roomlist.coffee](../../roomlist.coffee)、[ladder-core/index.js](../../plugins/ladder-core/index.js)、[rooms.html](../../plugins/ladder-web/web/rooms.html)。
- [腾讯 QQ Node.js SDK](https://github.com/tencent-connect/qqbot-nodejs)及[使用指南](https://github.com/tencent-connect/qqbot-nodejs/blob/main/USAGE.md)：凭据、双传输方式及主动消息额度说明。
- [腾讯机器人文档项目中的主动消息限制讨论](https://github.com/tencent-connect/bot-docs/issues/262)及[腾讯关联项目的权限失败报告](https://github.com/tencent-connect/openclaw-qqbot/issues/43)：仅作为风险信号，最终额度以目标应用实测和控制台为准。
- [Discord 官方入门](https://docs.discord.com/developers/quick-start/getting-started)及[Application Commands 文档](https://docs.discord.com/developers/docs/interactions/slash-commands)：应用凭据、Gateway intents、命令和安装权限。
