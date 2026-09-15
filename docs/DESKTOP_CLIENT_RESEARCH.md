# PC 本地客户端调研归档

> 调研日期：2026-09-16。状态：待办，优先级与 QQ/Discord 群机器人相近，当前不开发。

## 结论

建议建立独立仓库（暂名 `srvprotianti-desktop`），不放进服务器的 `plugins/`。它与服务端共享 API 契约和少量 Web 资源，但拥有独立发布周期、桌面权限、签名和自动更新风险。服务端仓库保留 API 规范；桌面项目通过固定版本的接口消费，避免复制两套可独立演化的页面逻辑。

技术上不一定使用 Electron。优先评估 Tauri 2：安装包和常驻内存通常更小，原生命令调用可通过明确的 capability/shell scope 收口，适合把程序暂放在 YGOPro 根目录并启动同目录可执行文件。若团队只熟悉 JavaScript、希望最快复用现有 HTML，则 Electron 仍可行，但必须关闭远程页面的 Node 集成并启用上下文隔离。

## 功能边界

- 本地配置：服务器基址、游戏服务器 IP/端口、用户名、YGOPro 路径、脚本源与更新通道。
- 房间页：把房间号转换为 YGOPro 加入/观战参数。
- 录像：下载到受控目录后用 `-r` 打开。
- 卡组：下载后用 `-d` 打开编辑器。
- 联机：YGOPro 支持 `-h`、`-p`、`-w`、`-n`，并要求 `-j` 作为加入房间时的最后参数；实现前以目标客户端 fork 的实际参数为准。
- 脚本更新：下载固定版本归档，校验 SHA-256，备份并原子替换；保留与旧录像相匹配的脚本快照或版本说明。

参考： [YGOPro command-line options](https://github.com/Fluorohydride/ygopro#command-line-options)、[Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)、[Tauri Security](https://v2.tauri.app/security/)、[Tauri Shell](https://v2.tauri.app/plugin/shell/)、[Tauri Updater](https://v2.tauri.app/plugin/updater/)。

## 对本地 gateball-viewer 的观察

`F:\MyCardLibrary\japanese\ygopro\gateball-viewer` 是 Electron 实现，已经验证了 `-r`、`-d`、`-h/-p/-w` 这类流程可行；但它体积较大，且服务器地址和可执行文件路径存在硬编码，只适合作为交互和参数参考，不宜直接作为本项目基础。

## 安全要求

- 远程 HTTP 页面不得直接获得任意本地命令执行能力。
- UI 只能调用预定义动作；路径必须规范化并限制在配置的 YGOPro/下载目录。
- 不把 QQ、Discord 或服务器管理密钥放进客户端。
- 更新源必须是 HTTPS、固定发布或提交，并进行哈希/签名校验；失败时保留旧版本。

## 与服务端协作方式

推荐保持现有网页可独立使用，桌面端增加一个受限桥接层。可将公共页面组件逐步提取为单独的纯前端包，或者让桌面端消费相同 JSON API；不要让服务端插件依赖桌面端。接口变更应先更新 `WEB_PAGE_DEVELOPMENT_SPEC.md` / `WEB_AND_ANALYTICS_SPEC.md`，再分别升级网页与桌面版本。

## 开发前置问题

- 最终支持官方 YGOPro 还是特定 ADS fork，以及各自启动参数差异。
- 是否必须支持 Windows 以外平台。
- 脚本源的发布格式、版本号、哈希和回滚策略。
- HTTP 服务器迁移 HTTPS 前，桌面端如何安全隔离远程内容与原生桥接。
