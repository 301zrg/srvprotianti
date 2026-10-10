# 官网录像一键打开网页版

更新：2026-10-08。`replays.html` 每个录像下载入口后增加「网页播放」，没有关联玩家元数据的公开录像也支持。接口、下载权限和桌面助手不变。网页版需先发布含 `/replay-import` 的版本；标准播放范围及旧裁定证据见 [录像使用说明](../../../srvprotiantiweb/docs/replay-usage.md)。

## 文件交接

官网继续同源 GET `/api/public/replay/<编码后的单个文件名>`，检查 HTTP 状态、文件大小与流式累计长度。客户端入口统一从 [deck-web-open.js](web/assets/deck-web-open.js) 的 `clientEntry()` 取得，默认仍为 `https://black-surf-69e5.1627406938.workers.dev/`；保留完整发布子路径，可沿用 `window.SRVPRO_WEB_CLIENT_URL` 的 HTTPS 固定配置，不从页面参数取目标地址。

- 原件不超过 24 KiB、完整链接不超过 34 KiB：读取完成后在**同一标签页**进入公开内容 Hash 链接。接收器在路由和资源加载之前取得内容并清除参数，保存原字节后自动打开兼容的播放器。无需 HTTPS 页面回读 HTTP，也不依赖手机后台中的官网继续执行。
- 较大文件：先在官网完成读取，按钮变为「继续网页播放」；**下一次点击**才同步开新标签页，以受限 `postMessage` 交接 ArrayBuffer 副本。等待 ready 后只发送一次，接收方确认写入成功或临时保存才显示结果。只保留一份待交接文件；开始另一条记录会取消旧操作。交接结束后接收方清除 opener。
- 文件超过 8 MiB、404、关闭、取消、超时、弹窗拦截或坏文件头，显示提示并恢复按钮。YRP1、双打等暂不播放的可辨识文件仍可保存、下载，不声称播放成功。原下载入口保留。

两条路径只交接**已公开的录像**。小文件内容会短暂进入跳转 URL，读取后移除，不可用于需密码的文件。大文件 URL 仅包含精确 origin、随机 request 和协议版本。接收方沿用客户端 `deckImportOrigins` 精确白名单，默认允许 `http://121.4.34.71:7922`、`https://duel.ygomatch.xyz`；来源参数不能扩大白名单。双方匹配 origin、窗口引用、request、channel、版本、kind 和尺寸，不接受任意远程 URL。消息窗口不能加切断 opener 的 `noopener`/COOP；不保证 BiliToy 外壳转发此入口。

网页播放在浏览器运行，首次还需下载固定 Core/Lua。交接和保存不建立对战 WSS，保存确认不等于重演成功。iOS 真机仍需复测，尤其是大文件的新标签页交接；失败可先下载再从录像库导入。

## 手动上传

先发布网页版接收器，再覆盖服务器的以下**四个运行文件**，保持相对路径：

```text
plugins/ladder-web/web/replays.html
plugins/ladder-web/web/assets/deck-web-open.js
plugins/ladder-web/web/assets/replay-web-open.js
plugins/ladder-web/web/assets/replay-web-open.css
```

现有 `/assets/<basename>.js|css` 路由已支持新增资源，HTML/资源每次请求读取。没有修改插件 JS、配置或后端接口，因此刷新官网即可，**不需要重启 SRVPro、PM2 隧道或修改 Nginx**。资源版本参数避免继续用旧卡组脚本。不能先上传官网按钮而把网页版留在没有接收器的版本。

桌面助手的下载/原生打开不改，原下载链接和属性仍在。列表保留字号、列结构和表格横向滚动，操作同行，不加固定说明行；进度/失败提示仅在操作时展开。回退只需恢复旧 `replays.html`，新增资产可保留。

## 本地验收

```powershell
# 在包含接收器的 srvprotiantiweb 分支构建
npm run build:static
# 再到 srvprotianti，按实际检出目录指定客户端
$env:REPLAY_WEB_CLIENT_ROOT = 'F:\MyCardLibrary\srvpro\srvprotiantiweb\.audit-tmp\replay-phase2-work'
node plugins/ladder-web/tests/replay-web-open-ui.mjs
```

证书复用网页版 `.audit-tmp/deck-import-cert/{cert,key}.pem`，可用 `REPLAY_TEST_CERT_ROOT` 指定另一份本地证书。测试仅启动自己的 HTTP/HTTPS 临时端口，使用可公开的自有原生录像与明确不可播放的大 YRP1 测试文件，拦截外网，不读取真实玩家或正式服配置。真实文件、平台和真机需另验收；不把 Edge 触屏尺寸检查称为 Safari 真机通过。

2026-10-08 本地自动化通过：真实插件的 HTML/资源路由、本机 HTTP 官网与 HTTPS 客户端，桌面 1280×800、触屏 390×844 / 844×390，共四语 × 三尺寸。记录行高 37px / 33px / 37px，13px 原字号和同行按钮保持。确认小文件同标签页进入实际 Core 播放、完整静态子路径保留，大文件读取完成后才开新页、确认保存后释放 opener；原件下载逐字节相同，重复内容复用，未知来源/错误窗口/请求/kind/channel 无法导入。404、Content-Length 超限、无长度头的流式超限、弹窗拦截、坏文件提示及按钮恢复通过；不兼容大 YRP1 仅入库、不加载 Core，全部交接不建立 WSS。未测试正式服/iOS 真机。
