# 从零复现：范围与停点

本页面向不使用维护者交付材料、想用公开仓库自己搭一套 706 服的人。目前（2026-11）**还做不到完全照文档从零搭出与正式服相同的服务**。下面说明三件事：可复现规则的定义、路线 A 主配置模板，以及哪些工作停在了哪里。

## 可复现的规则

正式服的生效脚本树是“上游脚本 + 706 旧裁定覆盖层 + 历史残留”。2026-11-22 逐文件核对（CRLF 统一为 LF 后比 SHA-256，对照引擎 `cards.cdb` 的 5,267 张卡）后，结论是：只要满足下面四项，卡池内每张卡的生效脚本都与正式服相同。

| 组成 | 来源 | 指纹 |
| --- | --- | --- |
| 基础脚本 `script/` | `mycard/ygopro-scripts@5864b6f6e58d49738e0996b94e96655b51f420bf` | 见 [versions.json](../versions.json) `engine.source.scriptCommit` |
| 旧裁定覆盖 `expansions/script/` | `301zrg/specials` 标签 `706-20261112`（`82666114`）的 `706/` 子目录，399 个文件 | tree `415a9d02c422d2103b4ac968be0e0db8cd9c4bd1` |
| 组合版 `utility.lua` | 由当时的上游 `utility.lua` 正文，在 `Auxiliary.PreloadUds` 定义之后加一次 `PreloadUds()` 调用生成，放在覆盖层之外（不能放进 `specials/706/`，天梯助手的更新器遇到会报错） | `utilitySha256` `7b9953ea…`（versions.json `engine.scriptEnvironment`） |
| 1103 禁表 | `!2011.3.1` 段 134 张，与网页仓库 `resources-staging/1103/lflist.conf` 按卡号与数量逐项相同 | 纯 1103 表 `ea375c08…`；正式服完整表 `c75a96b1…` 另含上游附带的现代禁表 |

核对数字：
- 正式服基础层与上游不同、也没被覆盖的文件有 65 个，全部在卡池外；只在上游存在的 12 张卡也都在卡池外。
- 卡池内既没被覆盖、又与上游不同的文件：**0** 个。
- 这些基础层差异是历史残留，对局用不到，不需要公开。

### 组合 utility 与上游同步

所有版本都已固定，上游更新不会自动带来冲突。风险只出现在**主动同步上游卡脚本**的时候：
1. 同步前，检查新脚本调用的 `aux.*` / `Auxiliary.*` 函数是否都在组合件里。
2. 有缺的，就用这次同步对应的上游 `utility.lua`，按上表的方法重新生成组合件。
3. 跑旧裁定残局和普通房、TT 实测，再更新 versions.json 里的锁。

## 路线 A 主配置模板

[server.config.example.json](../templates/server.config.example.json) 是新装（路线 A，空库）的主配置模板，不含任何凭据。路径按 Linux 写；Windows 把 `/srv/srvprotianti/shared/` 换成 `C:/srvpro-lab/shared/`（正斜杠），其余不变。PG 连接写在 postgres-compat 插件配置（[模板](../templates/postgres-compat.config.example.json)）里，所以主配置的 `modules.mysql.enabled=false`。

模板里的值是两平台走查实际用过的配置。下表列出各项与正式服的差异；正式服的值来自 2026-11-15 的只读采样。

| 字段 | 模板 | 正式服 | 说明 |
| --- | --- | --- | --- |
| `version` / `alternative_versions` | `4962` / `[]` | 相同 | 程序默认是 4945，必须显式写。引擎源码头文件里的版本也可能覆盖运行值，验收时以实际握手版本 `0x1362` 为准 |
| `hostinfo` | OCG、Single、MR2（`duel_rule=2`），8000 LP，起手 5 张，每回合抽 1 张，`time_limit=180` | 相同 | 程序默认 MR5（`duel_rule=5`）。TT 由 `ladder-core` 插件按房间密码 `TT` 提供，不在这里配置 |
| `modules.side_timeout` | `3`（分钟） | 相同 | 早期 Windows 走查样例没写这一项，那时换备只受 `random_duel.hang_timeout=90` 秒约束 |
| `modules.stop` | 维护提示 | `false` | 新装首次启动保持维护，验收时再按手册解除 |
| `modules.tournament_mode.enabled` | `true`，录像、卡组、日志目录映射到 shared | `false` | 走查都在开启状态下通过；正式服关闭后，录像、重连、结算也经所有者复测通过。开启时多三项行为：录像另存到 `replay_path`、重连不要求同一 IP、宕机后恢复对局日志 |
| `modules.http.show_ip` / `show_info` | `false` | `true` | 新装收紧：HTTP 不显示玩家 IP 和详细信息；公开查询走插件和代理白名单 |
| `modules.neos.ping_interval` | `30` | 默认（main 自 `5d2ea95` 起为 30） | 走 Cloudflare 隧道（路线 T）时必须大于 0 且小于 100 |
| `modules.dialogues` / `tips` | 关闭 | 开启 | 新装默认关闭文案扩展 |
| `modules.trusted_proxies` | 回环 | 相同 | 代理入口改变时按[迁址](server-move.md#真实-ip-的边界)调整，Windows 路线 T 改读 `cf-connecting-ip` |

没列出的字段沿用程序默认值，包括随机房、断线重连（`wait_time=90000`）和 `heartbeat_detection.enabled=false`，这些与正式服一致。端口 7911/7922/7977 可以改，但要同步参数页、服务检查、防火墙和代理。

## 停点（2026-11 第二阶段收尾）

下面这些工作挂起，没有实施：

- **公开引擎资源包**：把组合 `utility.lua`、完整禁表和两平台构建清单发布到公开仓库（`specials` 的 `706-meta/` 或 `srvprotianti-resources`），让外人按现有正式锁校验。项目所有者已同意公开组合 `utility.lua`，但还没有发布。在此之前，外人只能按上文自行生成，再用 SHA 核对。
- **新打包工具**：从公开输入一路生成规则材料、Linux 离线源码包和交接目录的命令链（拟议的 `prepare-rule-inputs.py`、`pack-linux-source.py`、`engine.py assemble-resources`）。现有 `ops.py release` 和 Linux `handover.py` 仍假定材料由维护者备好。
- **“从零搭建”总入口**：一页串起选路线、取材料、构建、首装、公网入口、自建网页版和验收的目录。目前各专题手册各自完整，但缺这页导航。
- **网页仓库文档**：把自有 HTTPS 静态托管设为默认、替换旧默认地址、统一指向服务端迁址手册。
- **规则方面**：只用一套规则锁。不另做公开版的 `public-1103` 规则锁，正式迁移继续按现有正式资源核验。

将来要继续，从 `ops/docs/resources.md`、`ops/docs/ygopro-install.md` 和本页出发。
