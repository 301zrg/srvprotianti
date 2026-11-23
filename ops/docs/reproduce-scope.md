# 从零复现：范围与规则一致性

本页面向不使用维护者交付材料、想用公开仓库自己搭一套 706 服的人。操作步骤见[从零搭建](from-scratch.md)；本页说明三件事：为什么这样搭出来的服务与正式服规则一致、路线 A 主配置模板的取值，以及验证到了什么程度。

## 可复现的规则

正式服的生效脚本树是“上游脚本 + 706 旧裁定覆盖层 + 历史残留”。只要满足下面四项，卡池内每张卡的生效脚本都与正式服相同。所需资产都在公开仓库里，并且与正式服使用**同一套锁**（`ops/versions.json` 的 `resourceFingerprints`、`engine.scriptEnvironment`、`engine.publicLayout`）。

| 组成 | 公开来源 | 指纹 |
| --- | --- | --- |
| 基础脚本 `script/` | `mycard/ygopro-scripts@5864b6f6e58d49738e0996b94e96655b51f420bf` | `engine.publicLayout.scriptTreeSha256`（13,538 个 Lua） |
| 旧裁定覆盖 `expansions/script/` | `301zrg/specials` 标签 `706-20261112`（`82666114`）的 `706/` 子目录，399 个文件 | tree `415a9d02…`；`engine.publicLayout.overlayTreeSha256` |
| 组合版 `utility.lua` | `301zrg/srvprotianti-resources` 的 `engine/1103-706/utility.lua`（2026-11-23 公开）。它由正式服旧 `utility.lua` 正文，在 `Auxiliary.PreloadUds` 定义之后加一次 `PreloadUds()` 调用生成。运行时放在 `expansions/script/utility.lua`，与 706 的 399 个文件合计 400 个；它不能放进 specials 的 `706/` 目录，否则天梯助手的更新器会报错 | `7b9953ea…` |
| 禁限表 `lflist.conf` | 同一资源仓库的 `engine/1103-706/lflist.conf`，即正式服完整表：第一段 `!2011.3.1` 是 1103 禁表（134 张），`hostinfo.lflist=0` 选中的就是它 | `c75a96b1…` |

引擎在服务器模式下按 `specials/ > expansions/ > script/` 的顺序找脚本（`gframe/data_manager.cpp`），`utility.lua`、`special.lua` 也走同一条路径，所以覆盖层与组合件会优先生效，和正式服相同。

`engine.py assemble-production` 按上表组出“正式布局”的引擎目录，安装器照常按正式锁校验它，不需要另一套规则锁。唯一不同的是二进制：由你自己从固定源码编译，SHA 自然与正式服的 `ygopro.exe` 不同。

### 一致性核对（2026-11-23）

用公开来源组出的生效脚本树，与正式服 2026-11-12 的脚本快照逐个文件比较（统一换行后比 SHA-256）：

| 类别 | 结果 |
| --- | --- |
| 全局脚本（`constant`、`utility`、`procedure`、`special`） | 4 个全部相同 |
| 卡池内有脚本的卡 | 4,378 张全部相同（另有 889 张通常怪兽，两边都没有脚本） |
| 不同 | 65 张，全在卡池外 |
| 只在上游存在 | 12 张，全在卡池外 |

这 77 个文件是基础层的历史残留，对局用不到。

### 组合 utility 与上游同步

所有版本都已固定，上游更新不会自动带来冲突。风险只出现在**主动同步上游卡脚本**的时候：
1. 同步前，检查新脚本调用的 `aux.*` / `Auxiliary.*` 函数是否都在组合件里。
2. 有缺的，先比对现有组合件与这次同步对应的上游 `utility.lua`，确认正式服旧版里有没有要保留的差异；再以上游正文为基础，在 `Auxiliary.PreloadUds` 定义之后加一次 `PreloadUds()` 调用，重新生成组合件。
3. 跑旧裁定残局和普通房、TT 实测，把新组合件发布到资源仓库，再更新 versions.json 里的锁和 `engine.publicLayout` 摘要。

## 路线 A 主配置模板

[server.config.example.json](../templates/server.config.example.json) 是新装（路线 A，空库）的主配置模板，不含任何凭据。路径按 Linux 写；Windows 把 `/srv/srvprotianti/shared/` 换成 `C:/srvpro-lab/shared/`（正斜杠），其余不变。PG 连接写在 postgres-compat 插件配置（[模板](../templates/postgres-compat.config.example.json)）里，所以主配置的 `modules.mysql.enabled=false`。

模板的取值来历：
- Windows 的手工走查和脚本走查（11-22）用的都是这套取值；
- 早期的 Linux 走查（11-15、11-17）用的是正式等价配置（下表“正式服”一列）；
- 2026-11-23 的外人路线 Linux 走查用的是本模板。

R5 及更早的 Windows 交付缺 `side_timeout` 和 `neos.ping_interval` 两项。下表列出各项与正式服的差异；正式服的值来自 2026-11-15 的只读采样。

| 字段 | 模板 | 正式服 | 说明 |
| --- | --- | --- | --- |
| `version` / `alternative_versions` | `4962` / `[]` | 相同 | 程序默认是 4945，必须显式写。引擎源码头文件里的版本也可能覆盖运行值，验收时以实际握手版本 `0x1362` 为准 |
| `hostinfo` | OCG、Single、MR2（`duel_rule=2`），8000 LP，起手 5 张，每回合抽 1 张，`time_limit=180` | 相同 | 程序默认 MR5（`duel_rule=5`）。TT 由 `ladder-core` 插件按房间密码 `TT` 提供，不在这里配置 |
| `modules.side_timeout` | `3`（分钟） | 相同 | 早期 Windows 走查样例没写这一项，那时换备只受 `random_duel.hang_timeout=90` 秒约束 |
| `modules.stop` | 维护提示 | `false` | 新装首次启动保持维护，验收时再按手册解除 |
| `modules.tournament_mode.enabled` | `true`，录像、卡组、日志目录映射到 shared | `false` | 两种取值都经过真实客户端验收。开启时多三项行为：录像另存到 `replay_path`、重连不要求同一 IP、宕机后恢复对局日志 |
| `modules.mysql.enabled` | `false` | `true` | 正式服把 PG 连接写在主配置；新装改由 postgres-compat 插件承载。宿主保存设置时可能把它写回 `true`，以插件为准 |
| `modules.http.show_ip` / `show_info` | `false` | `true` | 新装收紧：HTTP 不显示玩家 IP 和详细信息；公开查询走插件和代理白名单 |
| `modules.http.public_roomlist` | 不写，取程序默认 `false` | `true` | 新装不开旧版公开房间列表；公开房间改由 public-room-web 插件提供 |
| `modules.neos.ping_interval` | `30`（秒） | 默认（main 自 `5d2ea95` 起为 30 秒） | 走 Cloudflare 隧道（路线 T）时必须大于 0 且小于 100 |
| `modules.dialogues` / `tips` | 关闭 | 开启 | 新装默认关闭文案扩展 |
| `modules.trusted_proxies` | 回环 | 相同（程序默认） | 可信代理的地址白名单；代理入口改变时按[迁址](server-move.md#真实-ip-的边界)调整 |
| `modules.neos.trusted_proxy_header` | `x-forwarded-for` | 相同 | 从可信代理读取真实 IP 的请求头；Windows 路线 T 没有 Nginx，改为 `cf-connecting-ip` |

没列出的字段沿用程序默认值，包括随机房、断线重连（`wait_time=90000` 毫秒）和 `heartbeat_detection.enabled=false`，这些与正式服一致。端口 7911/7922/7977 可以改，但要同步参数页、服务检查、防火墙和代理。

## 验证到了什么程度

- 规则一致性：见上文的逐文件核对。
- Linux：在干净的 Ubuntu 实验机上，**只用公开仓库**按[从零搭建](from-scratch.md)第 3 步准备材料，再用安装脚本在干净机器上走路线 A，见[验证记录](validation.md)。
- Windows：引擎二进制由 CI 工作流 `stage2-engine-validation` 在 GitHub 的 Windows 机器上从固定源码编译；CI 同时按外人路线组装并做原生冒烟。用它组出的发布包，在干净的 Windows 实验机上走安装脚本路线 A，见[验证记录](validation.md)。
- 没做：外人真人照文档走一遍；公网入口、网页客户端自建托管的端到端演练。后者见[迁址](server-move.md)和网页仓库文档。
