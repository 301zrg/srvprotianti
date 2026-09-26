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
| [web/assets/common.css](web/assets/common.css) | 公共样式和响应式布局 |
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

命令在 `srvprotianti` 根目录执行；按实际影响范围选择，不要求每次跑全部项目检查。

| 修改 | 必要验证 |
| --- | --- |
| 单页样式/文案 | 目标页四语言、桌面/窄屏、相关按钮/空状态；纯静态变更不构建 |
| `site-shell.js` / `common.css` | 八页导航、语言参数、响应式及相关共用展示 |
| `routes.json` / 资源路由 | 页面与别名可达，缺失返回 404，非法资源名不能越界 |
| HTTP 接口/下载 | 成功、错误、权限/公开范围、缺失文件和参数边界；检查消费页面 |
| 插件 JS | `node --check <改动文件>`；运行匹配的现有插件测试 |
| 仅文档 | 链接、路径和 `git diff --check`，无需启动服务 |

现有验证入口为 `node plugins/tests/plugin-tests.js` 和
`node plugins/tests/integration.test.js`；路由、资源和玩家访问范围在集成测试中覆盖。
改动跨插件服务时可执行 `npm run test:plugins`；涉及宿主/编译源再按根规则扩大检查。
不要为验收读取真实密码、生产日志或连接生产数据库。

## 按需展开

- [页面详细契约](WEB_PAGE_DEVELOPMENT_SPEC.md)：只查目标页面章节；共享组件改动再查公共章节。
- [公开 API 与统计语义](../../docs/WEB_AND_ANALYTICS_SPEC.md)：改参数、响应、分母、下载或访问范围时读。
- [数据模型与迁移](../../docs/DATA_MODEL_AND_MIGRATION.md)：改实体、权威数据或历史修复时读。
- [插件索引](../README.md)：定位接口提供方和跨插件依赖。
- [当前交接事项](../../docs/PROJECT_HANDOFF.md)：涉及部署阻塞或项目未完成工作时读。

历史需求稿保留在 `docs/LADDER_PLAYER_AND_USAGE_SPEC.md`，只用于追溯决定，不是本模块日常必读项。
