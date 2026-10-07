# 官网卡组一键打开网页版

更新：2026-10-08。四页保留原下载入口，旁边增加网页打开按钮，目标是已实现卡组接收功能的 `srvprotiantiweb` 编辑器。此功能只打开卡组，不启动决斗或播放录像。

| 页面 | 新按钮 | 取得内容与传递方式 |
| --- | --- | --- |
| `replays.html` | 两位玩家各有「点击网页打开」 | 使用列表中该玩家、该小局的原始 deckbuffer，编码到公开内容链接；由网页版按卡库区分主卡组与额外，备牌保留 |
| `player-stats.html` | 「点击网页打开玩家卡组」「点击网页打开对手卡组」 | 每次继续 POST `/api/ladder/player/deck`，沿用公开模式／密码模式原访问权限；仅把返回的 YDK 通过消息交接发送到新标签页 |
| `intro.html` | 每个示例旁的「点击网页打开卡组」 | 同源读取原示例 YDK，再通过内容链接进入网页版 |
| `deck-detail.html` | 每个模板旁的「点击网页打开卡组」 | 按当前类型 ID 和模板文件名读取原模板接口，再通过内容链接进入网页版；模板仍可能是不完整、不可直接参战的卡组 |

公开内容在同一标签页打开，不依赖切到新标签页后原页继续运行，也不要求 HTTPS 网页版回读 HTTP 官网。玩家战绩可能含需密码才能下载的历史卡组，因此统一使用消息交接，卡组内容和密码都不进入跳转 URL；密码只用于官网原 POST 请求。点击时冻结本次玩家／密码／Match／side，查询其他玩家不会改变已发起的请求身份。

共用实现位于 [deck-web-open.js](web/assets/deck-web-open.js)，默认入口与现有房间观战链接一致：`https://black-surf-69e5.1627406938.workers.dev/`。以后换地址时修改这里的 `CLIENT_ENTRY`；保留客户端完整子路径，只替换 hash。页面运营者也可在载入该脚本前设置 `window.SRVPRO_WEB_CLIENT_URL`，只接受无账号凭据的 HTTPS 入口。不要从页面查询参数设置目标地址。

消息交接对齐客户端 [卡组接收契约](../../../srvprotiantiweb/docs/deck-import.md)：双方验证精确 origin、窗口引用、请求标识、版本和类型，指定精确 `targetOrigin`，等待接收方 ready。只有接收方确认导入／临时打开才显示对应结果；重复 ready 不重复发内容。没有 `noopener` 的新标签页在用户点击中同步创建，交接完成后由接收方解除 opener；不要给两站添加切断交接的 `COOP: same-origin`。

客户端默认允许官网来源 `http://121.4.34.71:7922` 和 `https://duel.ygomatch.xyz`。若官网换域名／端口，需同时在客户端 `duel-config.js` 的 `deckImportOrigins` 更新精确 origin。公开内容链接不依赖这份消息白名单。

读取失败、无权访问、弹窗被阻止、页面关闭、超时或超限，会在对应按钮组内显示四语提示，恢复按钮供重试。原下载功能仍可作为下载后手动导入的备用方式。内容限制 64 KiB，公开内容 URL 限制 4 KiB；消息交接等待 45 秒，公开文件读取等待 20 秒。iOS 原页暂停仍可能影响私有卡组的跨标签页交接，应真机复测。

新增样式在 [deck-web-open.css](web/assets/deck-web-open.css)，只作用于卡组操作。下载与打开成组；玩家双方各一组，避免混淆；按钮至少 44px 高，长名称可换行，窄屏表格继续在原容器中横向滚动。公共导航和其他四页不改样式。旧下载链接及其下载属性保留，桌面助手原有下载处理保持可用。

录像页旧 `downloadDeck()` 仍存在把主／额外合并区全部写入 `#main` 的历史转换问题。本次新入口直接发送原 buffer，正确打开融合／同调／超量，并保留备牌里的额外怪兽；没有复用该错误 YDK 转换。旧下载分区修正需要后续按卡库服务契约实施。

## 部署

先上传包含接收入口的网页版静态包（客户端提交 `c6970af` 或后续兼容版本），再覆盖服务器这六个文件：

```text
plugins/ladder-web/web/replays.html
plugins/ladder-web/web/player-stats.html
plugins/ladder-web/web/intro.html
plugins/ladder-web/web/deck-detail.html
plugins/ladder-web/web/assets/deck-web-open.js
plugins/ladder-web/web/assets/deck-web-open.css
```

当前 `ladder-web/index.js` 每次请求读取 HTML，并已提供通用 `/assets/<basename>.js|css` 路由。只更新上述文件，不改插件 JS／配置／下载接口，因此刷新页面即可，不需要重启 SRVPro、PM2 隧道或 reload Nginx。页面的资源版本参数用于取到这次新增的脚本和样式。

复测顺序：公开录像双方 → 示例 → 每个模板 → 玩家战绩公开模式和密码模式双方 → 权限拒绝 → 手机。网页端应正确显示三分区和重复张数，导入过程不建立对战 WSS。回退时恢复四份旧 HTML，新增资产可以保留，不影响旧页面。

## 验证

2026-10-08：四页内联脚本语法检查、`node plugins/tests/plugin-tests.js`、`node plugins/tests/integration.test.js` 通过。原接口／权限规则未改；现有集成测试使用临时 SQL.js 数据库。

跨项目浏览器回归：

```powershell
Set-Location F:\MyCardLibrary\srvpro\srvprotiantiweb
npm run build
python scripts/make_local_cert.py .audit-tmp/deck-import-cert
Set-Location ..\srvprotianti
node plugins/ladder-web/tests/deck-web-open-ui.mjs
```

测试依赖相邻网页版的 Node 依赖和构建产物；通过真实官网插件页面／资源路由，使用本机 HTTP 合成接口、本机 HTTPS 客户端和无头 Edge，保持默认弹窗限制、拦截外网。已通过四页 × 四语言 × 桌面／320px 触控视口样式检查，以及 12 次真实编辑器导入；核对当局与初始卡组不同、融合／同调／超量、备牌、重复张数、密码不传入 URL／payload、原下载、404／无权限、弹窗被阻止时不发下载请求、超限响应和按钮恢复。未读取真实玩家数据、生产数据库，未访问正式服；不替代 iOS Safari 真机、正式部署或 BiliToy 外壳测试。
