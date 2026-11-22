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

原生客户端的游戏 TCP 域名单独使用 DNS-only；普通 Cloudflare HTTP 代理不承载任意游戏 TCP 端口。
WSS/HTTPS 可按代理支持范围配置，不能凭 WSS 可用推定 TCP 可用。
[Cloudflare 代理限制](https://developers.cloudflare.com/dns/proxy-status/limitations/)

## 公网入口的两条路线与选择

| 路线 | 适用 | 模板 |
| --- | --- | --- |
| D 直连 | 新机所在地区允许该域名直接提供 80/443（已备案或境外） | [nginx.conf.example](../templates/nginx.conf.example) + [官网路由白名单](../templates/nginx-website-routes.conf.example) + [官网转发片段](../templates/nginx-website-proxy.conf.example) |
| T 隧道 | 未备案域名在大陆机房的 80/443 可能被厂商按 SNI/Host 拦截；改由本机隧道进程出站连到 Cloudflare | 路线 D 的 map 与官网部分，再加 [本机隧道入口](../templates/nginx-tunnel-local.conf.example) |

厂商是否拦截、拦哪些端口，选定机房后实测，不凭经验推断。原生 TCP（7911）不是 HTTP，两条路线下都单独用 IP 或 DNS-only 域名直连。
2026-11 在隔离实验机上按本节完整演练过 D 与 T（T 含真实 Cloudflare 命名隧道），证据只在本地审计目录，不随仓库提交。

## 隧道入口（路线 T）

1. 在 Cloudflare Zero Trust 后台建**远程管理隧道**，新机只保存该隧道的令牌：`sudo cloudflared service install <令牌>` 会生成 systemd 单元，令牌单独存在 `/etc/cloudflared/token`（root 0600）。不要在服务器上用 `cloudflared tunnel login` 的账户证书（`cert.pem`），那是整个域名的管理凭据。
2. 隧道的已发布路由指向 `http://127.0.0.1:7978`，Nginx 按[本机隧道入口](../templates/nginx-tunnel-local.conf.example)配置。
3. **服务端必须开启 Neos 心跳**：`modules.neos.ping_interval` 大于 0 且小于 100（默认 30 秒）。Cloudflare 会断开约 100–120 秒无流量的 WebSocket；实验中关闭心跳时空闲连接在约 125 秒被断，开启后长时间空闲不断。
4. 访问控制在 Cloudflare 侧做（WAF 自定义规则按主机名与来源 IP，或其他边缘规则），先生效再接通路由。Cloudflare 会直接拒绝客户端自带 `CF-Connecting-IP` 的请求（错误 1000），经边缘无法伪造该头。
5. 已知表现：Nginx 在 7978 拒绝的升级（如错误 Origin 的 403）经 cloudflared 返回给客户端时变成 502；拒绝仍然有效，排查时以 Nginx 日志为准。
6. 运维：重启 cloudflared 时旧进程会等已建立的 WebSocket 自然结束才退出，不会打断对局，但新进程接手可能延后一两分钟，应放进维护窗口；装成系统服务后开机自动接回隧道（实验中开机 43 秒内可用）。隧道地址固定，重启不变。
7. 删除隧道时，已发布路由生成的 DNS 记录不一定随之删除，需要到 DNS 记录里确认并删掉，避免留下指向已删隧道的悬空记录（访问会得到错误 1033）。

运营商到 Cloudflare 的接入节点可能被调度到很远的地区（实验中国内家宽在香港与伦敦之间切换），对局延迟以真人实测为准。
2026-11-22 在 Windows 实验机上实测：源站在国内家宽时，隧道连接器注册在洛杉矶，客户端从香港接入；WebSocket 往返中位约 570 ms，偶尔达到 3–4 秒，直连只有 1 ms。对局能正常打完、一次结算，但网页端体感明显卡。新服务器在国内时，选路线 T 之前先实测这一项。

### Windows 上的路线 T（无 Nginx）

Windows 手册不装 Nginx。2026-11-22 在 Windows 实验机上（脚本路线 B 安装）按下面的做法演练通过：握手放行与拒绝、真实 IP、4 分钟空闲不断、真人 TT（网页端经隧道）、无人登录重启 77 秒后恢复。

1. **安装 cloudflared**：从 GitHub 发布页取 `cloudflared-windows-amd64.exe`，用发布页列出的 SHA-256 核对，再核对 Authenticode 签名（Cloudflare, Inc.），然后放到 `C:\Program Files\cloudflared\`。
2. **保存令牌**：令牌存成 `C:\ProgramData\cloudflared\token`，用 `icacls` 去掉继承，只留 SYSTEM 和 Administrators。服务参数里不能出现令牌原文，所以不用 `cloudflared service install <令牌>`，改为自建服务：

   ```powershell
   $exe='C:\Program Files\cloudflared\cloudflared.exe'; $d='C:\ProgramData\cloudflared'
   New-Service -Name cloudflared -StartupType Automatic -BinaryPathName ('"' + $exe + '" tunnel --no-autoupdate --protocol http2 --logfile "' + $d + '\cloudflared.log" run --token-file "' + $d + '\token"')
   sc.exe failure cloudflared reset= 86400 actions= restart/5000/restart/5000/restart/60000
   Start-Service cloudflared
   ```

   日志中出现 `Registered tunnel connection` 即表示已连上。网络里有代理或 UDP 受限时，用 `--protocol http2`。
3. **已发布路由**：只填**子域名**，路径填 `^/neos$`，服务指向 `http://127.0.0.1:7977`；其他路径由隧道默认返回 404，暴露面与 Linux 的 7978 入口相同。不要给主域名加路由：演练中误加过一条，因为主域名已绑定 Worker，没有生效，删除即可。
4. **在 Cloudflare 上做访问控制**：没有 Nginx，Origin 白名单就放进 WAF 自定义规则（动作为 Block），先挂全部拒绝的规则，再接通路由。例如：

   ```
   (http.host eq "<子域名>" and (not ip.src in {<允许的来源>} or not any(http.request.headers["origin"][*] eq "<网页 Origin>")))
   ```

   这样缺少 Origin 的请求也会被拒，与 Nginx 模板的默认行为一致。
5. **真实 IP**：把 `modules.neos.trusted_proxy_header` 改为 `cf-connecting-ip`，`modules.trusted_proxies` 只保留回环地址（cloudflared 从 127.0.0.1 连入）。改完后重启应用。Cloudflare 一定会带上这个头，客户端自带的会被边缘拒绝。与 Nginx 方案的差异：没有这个头时，应用会把对端当成 127.0.0.1，不会返回 400。
6. **心跳**：同上文第 3 条；main 自 `5d2ea95` 起默认 30 秒。

7922 网站不经隧道。官网和网页客户端仍走各自的部署（Worker），网页客户端的 `duelWebSocketUrl` 指向这个子域名的 `/neos`。

## Nginx 的 WSS 入口（路线 D）

1. 停用 APT 自带的 `default` 站点（它也监听 80），按模板头部注释放置三个文件，替换域名、Origin 与证书路径。
2. 首次签发证书前，80 端口必须已有 `/.well-known/acme-challenge/` 的 location，否则 HTTP-01 无路可走；之后其余路径才跳转 HTTPS。签发用 `certbot certonly --webroot -w /var/www/acme --cert-name srvpro -d <官网名> -d <WSS名>`，不用 `--nginx`（避免 certbot 改写配置）。签发后该 location 保留，续期还要用。
3. `nginx -t` 通过后 reload；保留旧配置用于回退。
4. 续期：确认 `certbot.timer` 已启用；在 `/etc/letsencrypt/renewal-hooks/deploy/` 放 `nginx -t && systemctl reload nginx`。到期与续期失败都要有可达的告警。新证书刚签出时若服务器时钟比客户端快，会有约 1 秒的 `notBefore` 未生效窗口，属正常。

WebSocket 代理需要 HTTP/1.1 Upgrade/Connection 头，较长静默读超时避免默认超时中断对局。
这些是 transport 设置，不处理玩家动画队列。
[Nginx 官方 WebSocket 指南](https://nginx.org/en/docs/http/websocket.html)

Origin allowlist 使用精确匹配。浏览器来自允许的网页 origin 才接受；
当前模板默认拒绝不存在 Origin 的请求。若确需受控测试/原生 WebSocket，可在 map 中显式添加
`"" 1;`，验收后记录此选择。Origin不是游戏账号鉴权，非浏览器可以自行构造头。
用未授权浏览器 Origin 验证返回403，用已授权Origin验证101并可读到游戏包。

**官网只转发白名单路由**：公网入口按[路由白名单](../templates/nginx-website-routes.conf.example)逐个精确放行公开页面与接口（含方法），其余一律 404/405，不到达后端。
不转发的包括 `/api/maintenance/`、`/api/getrooms`、`/api/duellog`、`/api/archive.zip`、`/api/clearlog`、旧 `/api/replay*`（口令在查询串）、`/api/message` 以及所有 `OPTIONS` 预检。
精确路由要求原始请求路径与 Nginx 规范化后的路径一致，挡住编码、重复斜杠、`/./` 等变体；只有录像下载、示例卡组、静态资源三个前缀按严格字符集接受百分号编码的文件名。
插件新增公开路由时同步改白名单。管理使用 SSH 隧道/本机地址或单独受保护管理入口。

**防火墙**：公网只开 SSH、80、443 与原生游戏端口 7911；7922、7977（及路线 T 的 7978）只给本机。安装脚本 stage 61 为测试来源开放的 7922/7977 规则在接入公网前删除。Neos 与 HTTP 后端未指定监听地址，只能靠防火墙挡；有 IPv6 时同样核对。

**reload 与 restart**：日常改配置、换证只用 `reload`，已建立的 WSS 对局不断，旧 worker 在连接结束后退出。`restart` 会断开全部 WSS（实验中约 6.6 秒），客户端可在重连宽限内回到原对局，但应放在维护窗口。

## 真实 IP 的边界

直连 Nginx是本指南默认：它将 `X-Forwarded-For` **覆盖为** `$remote_addr`，
不能用客户端自带链首IP作为真实玩家地址。
宿主的 `modules.trusted_proxies` 只信任实际代理地址，如 `127.0.0.1/32`、`::1/128`。
Neos支持既有 `trusted_proxy_header` 优先，再兼容默认字段 `ip_header`；显式空字符串关闭取头。
两字段不改变谁是可信代理。
WSS 连接的 IP 只取自上述握手头；游戏协议里的 `EXTERNAL_ADDRESS` 包对 WSS 连接一律忽略并记一次警告，
因为 WSS 的物理来源总是受信的本机代理，采信该包会让客户端自行改写 IP。原生 TCP 仍按上游语义，仅受信代理来源可用该包报告地址。

两种“前面还有一跳”的情形不能混用：

- **路线 T，本机隧道进程**（如 cloudflared）：隧道只连 `127.0.0.1:7978` 的专用 server，Nginx 只在这一个仅回环的 server 上 `set_real_ip_from 127.0.0.1` 并取 `CF-Connecting-IP`。该头缺失、不是单一合法 IP、或指回本机时返回 400，不回落为 127.0.0.1（否则玩家会被当成本机）；Origin 白名单在这一跳同样生效。公网 443 server 不受影响，并会清空客户端自带的 `CF-Connecting-IP`。
- **CDN 直接代理到源站公网端口**：`$remote_addr` 是 CDN 节点，必须按其官方受信 IP 范围配置 `set_real_ip_from`，并在防火墙阻断绕过 CDN 直连源站，再验证远端玩家 IP。本仓库模板不提供这种写法。

任何情形都不能直接信任任意来源的 `CF-Connecting-IP`/XFF。
WSS 内部7977与HTTP7922必须在云/主机防火墙阻止公网绕过代理。

## 网页自动发布

环境变量是公开参数，可以进入构建日志，但不得携带玩家或管理员凭据。
以 Bash 为例：

```bash
export VITE_DUEL_WS_URL='wss://duel.example.com/neos'
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

Windows → Linux 使用联合备份恢复前，两端先将 `ops/` 升级到包含行摘要与文件清单顺序修复的版本，恢复机不得旧于备份机；版本要求及旧工具风险见 [摘要格式与旧批次](backup-restore.md#摘要格式与旧批次)。

1. 新机隔离恢复/验收、DNS/TLS先准备，旧机继续服务。
2. 进入维护、所有 writer停止，最后联合批次恢复到新空库；旧机不再接写入。
3. 新机私有配置切目标库、路径和网络，启动并做端口/插件/真实对局检查。
4. 更改 DNS/WSS公开发布输入、桌面和Bot地址；测试新建网页连接，旧连接不能跨服继承。
5. 新机开始正式写入后，旧机保持只读/停机，按新机再做备份。

DNS缓存和长连接可能仍指向旧机，不能只依赖TTL判断已全部切流。
新机已写入后的回退涉及两端数据选择，见 [回退边界](maintenance.md)。

### 回切的三种情形（2026-11 实验机演练过）

每种情形开始前都先：开维护、等房间与待完成任务归零（断线重连窗口内的房间也要等它结束）、停当前端，并在数据库确认只剩目标端一个运行账号连接。

1. **新端首次写入前回切**：新端在维护中只读启动核对后停止；旧端启动、解除维护，无数据取舍。
2. **新端已写入，保留新数据**：新端停写 → 联合备份并 verify → 恢复到**新的空库与新目录**（不覆盖旧库）→ 比对结构与权限（见下）→ 在维护中启动、核对同一场对局/积分/录像与新端一致、已注册账号能凭原口令登录 → 解除维护。
3. **新端已写入，放弃新数据**：回到旧端停写点，记录放弃的范围（账号、Match、单局、对局记录、录像各多少条）；放弃的数据保留在新端库与其联合批次中备查，不删除。

**结构与权限比对**：恢复路线得到的库中 `public` 模式属主为 `pg_database_owner`，而全新安装路线为 `srvpro_schema`；两者在“库属主为 `srvpro_schema`”时权限等价。直接比较 `pg_dump --schema-only` 文本会因此误报，应去掉注释与空行后比较 DDL，并另外比较库属主及 `srvpro_schema`/`srvpro_runtime` 对 `public` 的 CREATE/USAGE 权限。

双机并行、真实 DNS 缓存与长连接残留无法在单机演练，正式切换前在真实两台机器上补验。
