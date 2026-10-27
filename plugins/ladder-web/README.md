# ladder-web 开发入口

负责八个公开页面、公共样式/导航，以及天梯统计服务的 HTTP 适配。
普通页面任务从本文和目标源文件开始；只在改变 API、统计语义或其他模块时展开对应专题。
全项目开发底线见 [AGENTS.md](../../AGENTS.md)，不必预读整份交接历史。

## 源码与归属

| 文件 | 用途 |
| --- | --- |
| [plugin.json](plugin.json) | 真实依赖：`ladder-analytics`、`ladder-usage-analytics`、`deck-classifier` |
| [index.js](index.js) | HTTP 参数/响应适配、HTML/资源/示例卡组/模板下载 |
| [routes.json](routes.json) | 八页及 `/`、`/dashboard.html` 两个别名 |
| [web/](web/) | 原生 HTML/CSS/JavaScript，无前端打包器；页面业务脚本仍内联 |
| [web/assets/site-shell.js](web/assets/site-shell.js) | 七项公共导航、语言菜单、语言 URL、公共胜率配色 |
| [web/assets/web-client-config.js](web/assets/web-client-config.js) | 网页版 YGOPRO 统一入口配置：顶部开玩、房间观战、卡组打开、录像播放 |
| [web/assets/common.css](web/assets/common.css) | 公共样式和响应式布局 |
| [web/assets/deck-web-open.js](web/assets/deck-web-open.js) / [对应样式](web/assets/deck-web-open.css) | 四页卡组一键打开网页版；公开内容链接与受限消息交接 |
| [example-decks.json](example-decks.json) | 介绍页示例分组、四语言名称和下载文件 |

房间接口归 `public-room-web`，录像基础接口归 `public-replay-web`，卡组增强归
`ladder-replay-enrichment`。这些插件独立启用，不是本插件的 manifest 强制依赖。
排行、玩家记录和胜率由 `ladderAnalytics` 提供；使用率和细分类详情由
`ladderUsageAnalytics` 提供；分类、分组和模板由 `deckClassifier` 提供。
页面/HTTP 层不直接访问其他插件的实体文件，不自行读取或重写统计数据。

## 修改时保持的约定

- 新页在 `web/` 和 `routes.json` 注册；导航页接入 `SrvproWeb`，下钻页可复用所属导航。
  不在 `ygopro-server.coffee` 或生成的 JS 中硬编码业务页面。
- 四语言为中文、日语、英语、韩语；新增可见文案同时补齐。新链接使用 `L=ja|en|ko`，
  中文省略；继续兼容旧 `jp/en/kr` 参数，保留可分享的业务筛选状态。
- 动态文本使用 `textContent` 或统一转义；检查 `response.ok`，分别呈现加载、空数据和错误。
- 密码只留当前页面内存，通过 POST 请求体发送；不进 URL、日志、响应或持久化存储。
  下载权限由服务端每次校验，不能相信浏览器传来的 Match ID。
- 显示名与认证键分开；统计样本缺失显示明确空状态，不猜测比分、先后攻或卡组。
- 资源下载固定根目录并限制文件名/扩展名。页面不调用原管理员房间/录像接口。
- API 参数/字段/统计分母变化更新公共契约；页面交互变化只更新页面专题。
  普通样式修复不追加全局交接记录。

## 常见修改与验证

### 网页版 YGOPRO 地址配置与上传

八页的「点击开玩」、房间列表观战、卡组打开和录像网页播放统一读取
[web/assets/web-client-config.js](web/assets/web-client-config.js) 的开关和地址：

```js
window.SRVPRO_WEB_CLIENT_ENABLED = true;
window.SRVPRO_WEB_CLIENT_URL = 'https://ocg1103nexus.com/';
```

将开关改为 `false` 并上传该配置文件、刷新页面，即隐藏全部网页版 YGOPRO 入口；
卡组／录像下载、房名复制和站内导航仍可用。开关同时阻止公共地址函数生成网页客户端链接，
避免仅隐藏按钮却仍能通过旧处理函数跳转。改回 `true` 即恢复入口。
配置资产由插件以 `Cache-Control: no-store` 提供；如果前面另有 CDN 缓存，仍需清除该文件缓存。
首次部署开关时还需同步 `web/assets/site-shell.js`、`web/assets/common.css`、`web/rooms.html`
和 `index.js`，重启服务以启用配置资产的免缓存响应；之后切换只需改配置文件。

更换域名时只修改该文件中这行地址并上传同一路径，不再分别改 HTML 或业务脚本。
填写完整 HTTPS 网页地址，可保留部署子路径（如 `https://example.com/client/index.html`）；
这不是 `wss://.../neos` 对战隧道配置。`site-shell.js` 的 `SrvproWeb.clientEntry()` 统一校验
HTTPS 和无账号凭据，返回独立 URL，观战／导入仅替换 hash。配置不从页面 URL 参数读取；
仍兼容在配置脚本之前注入的固定 `window.SRVPRO_WEB_CLIENT_URL`。配置缺失／非法时，
顶部入口和观战链接不生成，原站内导航与下载可用；卡组／录像入口按原失败提示处理。

共用入口同时追加当前官网语言 `?lang=zh|en|ja|ko`，中文也明确传递。官网 URL 自身仍使用
原 `L=ja|en|ko`／旧语言参数。`clientEntry()` 每次取当前菜单语言，保留发布子路径与其他
固定参数，移除配置 hash 中过期的 `lang`；顶部开玩、观战、公开卡组、认证卡组交接、
小录像与大文件交接均继承这一参数。先发布支持 `lang` 的新版客户端，再上传官网文件。
本次语言更新需覆盖八个 HTML 与 `assets/site-shell.js`（版本 `20261009-lang`）；介绍页
复制提示已补齐四语，房间更新时间也随选定语言显示。首次部署还要更新资产响应头并重启服务；
后续仅切换配置文件中的开关或地址时，不必再次重启。

**首次安装本次统一配置时**，覆盖以下文件，保持服务器项目内的相对路径：

```text
plugins/ladder-web/index.js
plugins/ladder-web/web/intro.html
plugins/ladder-web/web/rooms.html
plugins/ladder-web/web/replays.html
plugins/ladder-web/web/ladder.html
plugins/ladder-web/web/deck-stats.html
plugins/ladder-web/web/player-stats.html
plugins/ladder-web/web/usage-stats.html
plugins/ladder-web/web/deck-detail.html
plugins/ladder-web/web/assets/web-client-config.js
plugins/ladder-web/web/assets/site-shell.js
plugins/ladder-web/web/assets/common.css
plugins/ladder-web/web/assets/deck-web-open.js
plugins/ladder-web/web/assets/replay-web-open.js
plugins/ladder-web/web/assets/replay-web-open.css
```

建议先上传配置和依赖资源，再上传 HTML；最后更新 `index.js` 并重启 SRVPro 或 PM2，
使配置资源的 `Cache-Control: no-store` 生效。各页按配置 → 公共脚本 → 卡组／录像脚本 → 页面业务的
顺序加载，新增版本参数避免本轮仍使用旧入口。后续只换配置文件并刷新页面即可；
如另有 CDN 强制缓存，应同时刷新 `/assets/web-client-config.js` 的缓存。

可打开官网 `/assets/web-client-config.js` 核对服务器上的配置，再检查顶部入口、观战、
卡组和录像。网页版自身的 WSS 来源白名单、官网向网页版传文件的 `deckImportOrigins`
仍各自按原契约配置；这里仅统一官网跳转的目的地址。桌面天梯助手不受影响。

2026-10-09 本地验收：八页及两个别名 × 四语言的新默认入口通过；仅替换配置资产即可
同步改变顶部、观战和卡组目标。`node plugins/ladder-web/tests/deck-web-open-ui.mjs --rooms`
通过桌面／320px 视口的观战链接与真实卡组导入，非法入口不会破坏站内导航；
`node plugins/ladder-web/tests/replay-web-open-ui.mjs` 通过四语 × 桌面／竖屏／横屏的录像交接，
含完整部署子路径、真实 Core 打开、原件字节和来源校验。页面脚本语法、文档链接及
`node plugins/tests/integration.test.js` 通过。未连接正式服或测试 iOS 真机。

### 验证入口

命令在 `srvprotianti` 根目录执行；按实际影响范围选择，不要求每次跑全部项目检查。

| 修改 | 必要验证 |
| --- | --- |
| 单页样式/文案 | 目标页四语言、桌面/窄屏、相关按钮/空状态；纯静态变更不构建 |
| `site-shell.js` / `common.css` | 八页导航、语言参数、响应式及相关共用展示 |
| `routes.json` / 资源路由 | 页面与别名可达，缺失返回 404，非法资源名不能越界 |
| HTTP 接口/下载 | 成功、错误、权限/公开范围、缺失文件和参数边界；检查消费页面 |
| 插件 JS | `node --check <改动文件>`；运行匹配的现有插件测试 |
| 仅文档 | 链接、路径和 `git diff --check`，无需启动服务 |

现有验证入口为 `node plugins/tests/plugin-tests.js`、
`node plugins/tests/integration.test.js` 和 `node plugins/ladder-web/tests/rooms-ui.test.mjs`；
房间类型在接口集成测试与页面展示测试中分别覆盖，路由、资源和玩家访问范围在集成测试中覆盖。
改动跨插件服务时可执行 `npm run test:plugins`；涉及宿主/编译源再按根规则扩大检查。
不要为验收读取真实密码、生产日志或连接生产数据库。

## 按需展开

- [页面详细契约](WEB_PAGE_DEVELOPMENT_SPEC.md)：只查目标页面章节；共享组件改动再查公共章节。
- [卡组一键打开、部署与验证](DECK_WEB_OPEN.md)：录像双方卡组、玩家战绩双方、示例和模板的网页版入口。
- [录像一键播放、部署与验证](REPLAY_WEB_OPEN.md)：公开录像交接、接收与手动上传清单。
- [公开 API 与统计语义](../../docs/WEB_AND_ANALYTICS_SPEC.md)：改参数、响应、分母、下载或访问范围时读。
- [数据模型与迁移](../../docs/DATA_MODEL_AND_MIGRATION.md)：改实体、权威数据或历史修复时读。
- [插件索引](../README.md)：定位接口提供方和跨插件依赖。
- [当前交接事项](../../docs/PROJECT_HANDOFF.md)：涉及部署阻塞或项目未完成工作时读。

历史需求稿保留在 `docs/LADDER_PLAYER_AND_USAGE_SPEC.md`，只用于追溯决定，不是本模块日常必读项。
