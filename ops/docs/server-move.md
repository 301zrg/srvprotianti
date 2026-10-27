# 服务器地址、WSS 与三端迁址

默认保留网页 Origin `https://ocg1103nexus.com`，只换游戏/WSS/API 地址。
这样玩家现有卡组和录像的 IndexedDB仍归原网站，网页静态托管不必搬到游戏机。
网站 Origin 真正变化时需要通知玩家在旧站导出、在新站导入；服务端备份不能迁移浏览器本地存储。

## 地址和责任表

| 项目/组件 | 输入 | 修改方式 |
| --- | --- | --- |
| 游戏宿主 TCP | host + port，原 7911 | 主配置 port、网络放行，原生/桌面用户对应设置 |
| Neos 内部端口 | 原 7977 | 主配置 neos.enabled/port，由 Nginx代理，不直接公网放行 |
| 官网/API | 新 HTTPS origin；后端原 7922 | Nginx server_name、网站入口、网页交接白名单、桌面 apiBaseUrl、机器人 gameApi.baseUrl |
| 网页在线连接 | `VITE_DUEL_WS_URL` | 公开 `wss://` URL，自动/手工发布共用验证器 |
| 网页卡组和录像接收 | `VITE_DECK_IMPORT_ORIGINS` | 精确 JSON origin 数组，不允许通配符或路径；`[]` 显式禁用 |
| 网页官网导航 | `VITE_WEBSITE_BASE_URL` | 网站 base URL；设置它不会自动扩大交接权限 |
| 官网页面打开网页端 | ladder-web/web/assets/web-client-config.js | 改网页对战端 URL、允许的 target origin；按现有交接契约配套 |
| 桌面既有用户 | settings 中 gameHost/gamePort/apiBaseUrl | 用户设置保存后下次操作生效，不重置昵称/密码/本地数据 |
| 桌面新发行默认 | resources/config.default.json 与发行游戏目录默认配置 | 现有用户覆盖始终优先；只改发行默认通常无需重新编 EXE |
| QQ/Discord | gameApi.baseUrl、指南地址、平台配置 | 单独部署，保留 config/data，先停旧实例再开新实例 |

地址写入无凭据参数表和私有安装记录。不要根据源码里的旧地址推断当前正式配置。

## Nginx 的 WSS 入口

使用 [nginx 模板](../templates/nginx.conf.example)，替换域名、证书与允许网页 Origin。
模板使用不同域名分开 WSS 和官网/API：例如 `duel.example.com`、`api.example.com`。
证书取得和自动续期按所用 DNS/证书管理服务完成，示例不会自签后当成浏览器可信证书。
在启用前先 `nginx -t`，通过后 reload；保留旧配置用于回退。

WebSocket 代理需要 HTTP/1.1 Upgrade/Connection 头，较长静默读超时避免默认超时中断对局。
这些是 transport 设置，不处理玩家动画队列。
[Nginx 官方 WebSocket 指南](https://nginx.org/en/docs/http/websocket.html)

Origin allowlist 使用精确匹配。浏览器来自允许的网页 origin 才接受；
当前模板默认拒绝不存在 Origin 的请求。若确需受控测试/原生 WebSocket，可在 map 中显式添加
`"" 1;`，验收后记录此选择。Origin不是游戏账号鉴权，非浏览器可以自行构造头。
用未授权浏览器 Origin 验证返回403，用已授权Origin验证101并可读到游戏包。
公网代理不要转发 `/api/maintenance/`、旧 `/api/message` 或其他管理路径；
管理使用 SSH 隧道/本机地址或单独受保护管理入口。

## 真实 IP 的边界

直连 Nginx是本指南默认：它将 `X-Forwarded-For` **覆盖为** `$remote_addr`，
不能用客户端自带链首IP作为真实玩家地址。
宿主的 `modules.trusted_proxies` 只信任实际代理地址，如 `127.0.0.1/32`、`::1/128`。
Neos支持既有 `trusted_proxy_header` 优先，再兼容默认字段 `ip_header`；显式空字符串关闭取头。
两字段不改变谁是可信代理。

若前面还有 Cloudflare/其他 CDN，$remote_addr 是该代理地址；必须按其官方受信IP范围配置
Nginx real_ip，阻断绕过入口，再验证远端玩家IP。不能直接信任任意来源的 CF-Connecting-IP/XFF。
本模板不自动开启额外 CDN 的 real_ip 行为。
WSS 内部7977与HTTP7922必须在云/主机防火墙阻止公网绕过代理。

## 网页自动发布

环境变量是公开参数，可以进入构建日志，但不得携带玩家或管理员凭据。
以 Bash 为例：

```bash
export VITE_DUEL_WS_URL='wss://duel.example.com/'
export VITE_DECK_IMPORT_ORIGINS='["https://api.example.com"]'
export VITE_WEBSITE_BASE_URL='https://api.example.com/'
npm ci
npm run build:cloudflare
```

产物 `dist/duel-config.js` 同时保留 WSS、明确给出的白名单和官网链接。
`dist/deployment-info.json` 留构建来源/时间/公开输入。
省略白名单维持原项目默认两个来源，**迁址时必须显式填新来源**；
设 `[]` 禁用消息导入，不能用空字符串代替 JSON数组。
域名有路径、尾斜杠、凭据、通配符或非 origin 的白名单输入会在构建前失败。

网站 base 可以有路径，但仍只允许 http/https，无凭据、query、fragment。
WSS 必须 wss，同样拒绝凭据/query/fragment。
Cloudflare托管配置与自动部署入口仍按网页项目文档设置；本阶段没有直接发布线上网站。

## 手工发行包

两个 Python打包入口使用同一个 Node 校验器，参数对应三个公开变量：

```bash
python scripts/package_test_release.py --help
python scripts/package_bilitoy_release.py --help
```

在该脚本现有必需参数之外加 `--deck-import-origins '["https://api.example.com"]'`
和 `--website-base-url 'https://api.example.com/'`，WSS 参数名按脚本 `--help`。
完整例子和脚本固有的部署 basepath 见网页
`docs/public-deployment-config.md`，不将 Cloudflare 根目录包与 BiliToy 子路径包混用。
公开配置内容应在ZIP中实查；手工修改一次 dist 后下一次构建会覆盖，持久输入必须放发布环境/参数。

官网端同样设置可信网页 target origin。测试从卡组页和录像页打开网页，
只有新官网 origin 正常发送，旧origin是否保留由操作者精确选择，不能无意全部放开。
重新构建一次后再测试，证明权限配置不会被发布脚本抹掉。

## 桌面与机器人

既有桌面用户在设置页面修改服务器三个字段，无需删除 config.user.json 或重新安装助手。
发行默认与用户覆盖的说明仍以桌面 settings.rs/README为准。
桌面内保存的环境资源、卡组、录像、昵称和密码保留；服务器迁址不触发706脚本来源替换。

QQ/Discord分别按服务端 `services/qq-bot/DEPLOYMENT.md`、`services/discord-bot/DEPLOYMENT.md`
构建包，在目标 OS重新 npm ci，保留 schedule-state、win-streak-state 等 data 文件。
停止旧实例防重复通知。不要在隔离恢复演练中开启正式群/频道主动推送。
修改 API/指南地址后核对公开查询、新鮮连胜与月榜状态，不能把搬迁当成补发旧消息。

## 切换顺序

1. 新机隔离恢复/验收、DNS/TLS先准备，旧机继续服务。
2. 进入维护、所有 writer停止，最后联合批次恢复到新空库；旧机不再接写入。
3. 新机私有配置切目标库、路径和网络，启动并做端口/插件/真实对局检查。
4. 更改 DNS/WSS公开发布输入、桌面和Bot地址；测试新建网页连接，旧连接不能跨服继承。
5. 新机开始正式写入后，旧机保持只读/停机，按新机再做备份。

DNS缓存和长连接可能仍指向旧机，不能只依赖TTL判断已全部切流。
新机已写入后的回退涉及两端数据选择，见 [回退边界](maintenance.md)。
