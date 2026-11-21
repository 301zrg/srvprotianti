# 2026-10-12 候选分支隔离 Linux/PG17 验证记录

本记录完整登记用户提供的本轮结果与限制。本轮助手没有接入该云端环境、
直接复阅原始日志或取得 `evidence.tar.gz`；下列“通过”均表示用户报告的执行结果，
不是本机重新执行的声明。问题状态与发布条件仍以 [唯一验收矩阵](validation.md) 为准。
本文前半部保留最初失败的历史事实；当前 Lua 下载与引擎进展以末尾
[2026-10-13 后续结果](#2026-10-13-后续结果北京时间) 为准。

## 所测源码与实际环境

三仓均使用 `codex/deployment-readiness-20261012` 候选分支；
`deployment.py sources --candidate` 已确认审核基线后继、要求的源码能力及 `dirty=false`。
网页来源是 `deploy/cloudflare` 审核基线的后继。候选优先于旧 PR #5/#7，
不表示已合并、上线或跨制品兼容性通过。

| 仓库 | 报告记录的完整 HEAD |
| --- | --- |
| srvprotianti | `6c8f0700e34a05bd3a7cefab7649ef27023e62e7` |
| srvprotiantiweb | `fd99c77b1873b2692dd93bdfe28c389724281561` |
| srvprotianti-desktop | `b9e0bf06deac014b60c904a88a12a182cd646de1` |

| 项目 | 报告记录 |
| --- | --- |
| 系统 | Debian 13.6、Linux x86_64；非 root `agent`；PID 1=`tail` |
| Node / npm | 24.15.0 / 11.12.1 |
| Python / SQLite | 3.12.14 / 3.53.1；`python`、`python3` 均可用 |
| Git LFS | 3.6.1 |
| PostgreSQL | 服务端和客户端均为 17.11；独立临时 cluster |

这不是 Ubuntu24/systemd 或 Windows 验收环境。源码副本在原 checkout 外，
原代码、测试、依赖声明与锁文件均未改。

## 报告结果

| 状态 | 检查 / 证据范围 |
| --- | --- |
| 通过 | 完整最终安装脚本：服务端锁定安装、原始 build、`npm test` 的 16 个入口、schema contract 和 `schema.test.js`；运维 unittest 59 项，包含 deployment/engine/health/恢复。 |
| 通过 | 按原固定提交复用四语查询库，重查 SQLite、字节和 SHA；真实插件装载无 warning，`metadataAvailable=true`，14,981 张卡、四份 fingerprint。已有目录只校验，没有覆盖或重复下载。 |
| 通过 | 新临时 PG17 cluster 的 20 表、真实 TypeORM `synchronize=false` DML、权限及 DDL 拒绝、constraints/indexes/sequences、dump/restore；schema 报告 `ok=true`。 |
| 通过 | 更新后的合成数据库/录像联合恢复 `complete=true`；保留 G1–G3 事实及各局录像，复制批次先验后恢复。内容哈希、schema/序列、原文件 SHA、积分/历史/连胜、三类录像、权限与新写入均一致；拒绝源库、非空目标和损坏录像。`offHostCopyVerified=false`。 |
| 通过 | 网页 8 项公开配置测试、typecheck、lint、`build:cloudflare`、普通包和 Toy 包；`deployment.py` 实际根路径产物检查通过，使用合成 fixture。dist/普通包各 16 项固定 SHA；Toy 15 项 SHA、`current.json` 语义及 13 项改名映射一致；三项合成公开参数和候选源码提交一致。 |
| 通过 | 桌面 `npm ci`、`npm run check`：类型、前端构建及 8 项测试；本项没有执行 Windows EXE、原生助手或游戏行为。 |
| 通过 | 引擎 5,267 卡 LFS 池下载与复查：资源提交 `7b29eb288411b64531e4a7c41642fb4beecf8709`，1,695,744 字节，SHA-256 `a49f0652ad54a7f55c569284ca154f0ec435fc26ebdd728927052e57b9d816e5`。 |
| 通过（部分输入准备） | 固定 YGOPro/Core/基础 script 提交已取得并匹配，基础 script 干净；706 覆盖 `d6008e9832e5666e665a84dca2e8e59810b3cdfa`、纯 1103 禁表和 Premake beta8 归档 SHA 已校验。纯 1103 禁表不等于生产多禁表，inactive `cards1.cdb` 不再要求。 |
| 通过（编译依赖探针） | 本地已签名 Debian 开发包提供 libevent/SQLite/liblzma 头文件与链接；本地 sysroot 编译探针实测 2.1.12 / 3.46.1 / 5.8.1。没有声称系统 dpkg 安装了这些 dev 包，也没有完成引擎编译。 |
| 失败 / BLOCKED_NETWORK | `engine-source.py` 两次均在官方 Lua 5.4.8 压缩包下载处被代理 CONNECT 403 拒绝，包含 `require_escalated` 重试。日志保留；没有换版本、改 SHA 或禁用 TLS。取得源码/Core/script 不等于整个 prepare 通过。 |
| 未执行 | 原生 SSE2 编译、ELF/ldd/二进制 SHA、overlay 与 base 组装/verify/smoke/preflight，缺固定 Lua 归档。`engine-validation.sh` 仅准备及 Bash 语法检查通过，后半段没有执行。 |
| 未执行 / BLOCKED | Windows 引擎 MSBuild/PE 原生 smoke、Windows PG17/SCM/reboot 和真机；已整理 `WINDOWS-NOT-RUN.md`。默认 main 当前缺手动 Stage2 workflow，本云端任务未触发 Actions、未推送。 |
| 未执行 / BLOCKED | 正式公开/私有输入与 layout、完整跨制品 lock/gate、Ubuntu24/PG17/systemd、真实 TCP/WSS/IP/TT 三局/换备/结算/录像/usage/旧裁定对照、双客户端/手机、异机备份/安全/迁服回执。 |

上述 Windows 未执行项是本云端任务的范围；此前独立的桌面 Windows CI #29 仍按
[验收矩阵](validation.md) 记录其 EXE/ZIP 和 29 项 Rust 测试证据，不能代替 Windows 引擎或整服验证。
Python SQLite 3.53.1 与 sysroot 原生链接探针 SQLite 3.46.1 是不同运行环境，不能互换版本记录。
合成数据库/录像结果不能证明真实完整对局、真实录像播放或异机备份。

## 合成参数与证据位置

三项网页公开参数仍为：

```text
VITE_DUEL_WS_URL=wss://game.example.invalid/neos
VITE_DECK_IMPORT_ORIGINS=["https://ladder.example.invalid"]
VITE_WEBSITE_BASE_URL=https://ladder.example.invalid/
```

`deployment.fixture.json` 仅为测试 fixture；其中 `reviewed=true` 是单元断言所需字段，
不是操作者签认，fixture 不能生成真实放行 gate。没有猜测正式配置或凭据。

报告给出的 PG17 证据位置为云端相对路径 `../runs/pg17.6DdbA7D6`，
没有复制到当前本地工作区，也不是公开下载链接。退出 trap 已停止本任务 cluster，55432 确认空闲。
`logs/` 保存完整 stdout/stderr，以及命令、cwd、UTC 时间和退出码；`results.json` 生成时间使用 UTC+8。
原始上传指南已保存。`evidence.tar.gz` 包含本轮日志、元数据、合成 dump/录像及恢复报告，
没有打包整个引擎源码或玩家数据；本轮消息没有提供该归档的下载位置或归档 SHA。

## 下载阻塞与后续执行边界

`www.lua.org` 已加入环境配置草稿；网络要求已保存，尚不能据此认定网络策略已应用。
实际应用网络变更后，在**新的目录**重试原始 `engine-source.py`，保留首次失败目录和日志。
固定输入仍为 `https://www.lua.org/ftp/lua-5.4.8.tar.gz`，
SHA-256 `4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae`。
不改固定版本/SHA、不关闭 TLS；整个 prepare 成功后，按
[原生引擎指南](ygopro-install.md) 执行尚未运行的编译、组装与预检，并分别保留实际结果。

安装/启动说明和仓库清单已成功更新为环境草稿。未来任务复用还需保存并 Publish 环境，
之后实际验证恢复；保存草稿不等于已应用网络策略或已发布可复用快照。

本云端任务未访问生产数据库、发布网站、正式开服或推送分支。
仍缺完整候选引擎输出、旧正式 EXE 来源/行为等价证据、审核正式输入、Windows 受控包及九阶段真实回执。
当前只能声明所列隔离代码/PG17 测试通过，整体保持 `NOT_DEPLOYMENT_REPRODUCIBLE`。

## 2026-10-13 后续结果（北京时间）

以下仍按用户提供的云端报告登记，助手未接入实例或直接复阅原始日志。
北京时间为 2026-10-13，所给命令日志 UTC 日期为 2026-10-12。

### Linux 原生引擎：先前补丁轮次

用户报告恢复包 SHA、补丁后 67 项测试及完整输入准备通过；Linux SSE2 原生编译、
x86_64 ELF、动态依赖和二进制 SHA 检查通过。启用及省略 706 覆盖的两套新运行目录
均完成组装、校验、原生 TCP 启动与预检，本轮无失败。
这些编译/运行结果来自先前使用恢复包的轮次；消息没有给出二进制 SHA 的具体值、
完整制品 manifest 或原始编译日志，不能据此签发跨制品锁。
真实对局、旧裁定差异、WSS、Windows 引擎/整服、systemd 和生产验收未执行。

### 官方下载：网络配置实际生效

此前运行实例仍是 spec revision 4，没有 Lua 域名规则，默认代理 CONNECT 返回 403。
用户报告发布后 spec 和 observed spec 均为 10，保留 `restricted`、`package_managers`，
新增 `www.lua.org`；实例策略文件包含该域名。状态接口仍报 `unknown`，
不能将接口状态改写为 `enforced`，实际成功请求证明本次目标已可访问。

命令为 `python3 /tmp/lua-official-published-z9jjsz72/probe.py`；
UTC 从 `2026-10-12T17:13:26.776774+00:00` 至 `2026-10-12T17:13:29.801295+00:00`。
退出 0、HTTP200、最终 URL 等于固定官方 URL，374,332 字节，固定 SHA-256 完全匹配。
使用默认 HTTPS 代理，未绕过；TLS `CERT_REQUIRED` 和主机名检查开启。
报告证据路径为云端 `/tmp/lua-official-published-z9jjsz72/result.json`。

### 默认完整准备：干净公开候选轮次

用户报告在同一 Bash 会话取得完整服务端仓库，检出
`6c8f0700e34a05bd3a7cefab7649ef27023e62e7`，工作区干净，在全新目录执行
`engine-source.py --platform linux` 的默认流程，退出码 0。
UTC 从 `2026-10-12T17:19:06Z` 至 `2026-10-12T17:20:00Z`。
没有使用离线包、`--lua-archive`、已有归档缓存，没有修改固定版本或覆盖旧目录，也没有重复编译。

| 输入 | 独立复核的提交 / SHA-256 |
| --- | --- |
| Lua，374,332 字节 | `4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae` |
| YGOPro | `5e63f18fb6b9a6ddc651bc2e8847eec9689ccbff` |
| Core | `e04144d62499c17d0cfa8313f9742434ef99c3a7` |
| script | `5864b6f6e58d49738e0996b94e96655b51f420bf` |
| Premake Linux 归档 | `63edd3e7461eebdd45b500a3c7e8ad4e7a67d68f230010f9a97cbb71b4ec59c8` |

证据目录为云端 `/tmp/lua-default-prepare.b7pU3elt`，包含 `command.txt`、`stdout.log`、
`stderr.log`、`engine-inputs/source-report.json` 和 `verification.json`。
这些云端路径均未复制到当前本地工作区，不是本地文件或公开下载地址。

**Lua 官方下载与默认完整准备的阻塞已解除（用户报告）。**
最新默认准备轮次没有重新编译，不能把先前补丁轮次的二进制自动当作这次干净来源的新制品。
完整生产规则/来源等价、审核正式输入、实际制品封存与跨组件 lock/gate、双系统和真实业务回执仍待完成。
未来新任务是否完整恢复已发布环境的源码、依赖和资源仍需另验；本次访问成功只证明所列执行实例。
