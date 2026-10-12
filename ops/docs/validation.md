# 验收、隔离演练与证据范围

## A–F 整改：当前事实与闭环表

2026-10-12 重新读取三个仓库及公开远端引用。以下是当前整改矩阵的维护位置，
不另外建立一份 deployment-readiness 文档；安装输入归属 [资源交接](resources.md)。
状态 `RESOLVED` 只表示所述代码/文档缺口已关闭，`PARTIAL`、`BLOCKED`、`NOT_RUN` 保留未通过的验收。
当前整体状态为 `NOT_DEPLOYMENT_REPRODUCIBLE`，生产迁移也未验收。

| 组件 | 核对的提交 | 说明 |
| --- | --- | --- |
| 服务端正式候选主线 restructure2 | c2b9204f6a5abae9bf478cb21a0870d79525b377 | 不包含上一轮引擎工具；整改工作树保留其全部源码 |
| 服务端已公开工具分支 | ac75669e2771791d859f67bd9a86bfba3f9cf6da | 当前整改基线，包含 PR #7 的固定引擎输入和 Windows 流程 |
| 网页 deploy/cloudflare | 6c76a2f694872f8f3140477da4b1510b562035be | 当前网页整改基线，含三个公开发布参数和构建命令 |
| 网页 main | 67e87a6f3df462de769369d7be1956076470d02f | 独立分支；不能替代部署分支执行最新发布契约 |
| 桌面 main | d6b2730d917f9a3ec1c762afd379785d3292dad0 | 当前桌面整改基线，旧发行默认仍是 HTTP 7922 |

三个原工作树均有既有未提交修改；本轮使用隔离工作树，未 reset/clean、未读取生产配置或连接生产服。
版本表是核对快照；实际发行以 archive/逐文件 manifest 和跨组件锁为准，不能只替换这些 SHA。

| ID | 现有文件级证据 | 当前状态 | 后续处理/阻塞 |
| --- | --- | --- | --- |
| P0-01 | 网页 README/公开配置；deployment.py sources | RESOLVED（入口/代码） | 已固定 deploy/cloudflare 来源并机械检查源码能力/来源；未合并、改默认分支或上线 |
| P0-02 | ops/versions.json、scripts/engine.py、docs/ygopro-install.md | PARTIAL / BLOCKED_EXTERNAL | 基础 Lua pin、现用卡池 LFS、覆盖组装已有，本轮新增干净基础脚本提交验证；Linux 制品、完整禁表和生产构建来源/规则等价证据仍缺 |
| P0-03 | 本页、cloud-validation-20261011.md | BLOCKED | 当前是 Windows；本机无 Linux Docker daemon，WSL2 分发停止且 HypervisorPresent=false；Ubuntu24/PG17/systemd/完整对局未执行 |
| P0-04 | deployment.py inputs/layout、公共参数表、linux-install.md | PARTIAL / BLOCKED | 已去除 inactive cards1 要求；审核 HostInfo/协议/私有输入/stop/管理员/路径与 Linux owner/link 守卫已实现；真实私有输入与 Linux 安装未验收 |
| P0-05 | 桌面 release-contract/package-portable、README | PARTIAL / BLOCKED | 支持审核公共参数生成 HTTPS 新发行默认，保留旧用户设置、输出新目录；Windows CI 原生 EXE/ZIP 已通过，真实域名和新默认/客户端实测仍缺 |
| P0-06 | versions.json；deployment.py lock/verify-lock | PARTIAL / BLOCKED | 更新核对快照并区分实际制品锁；archive 和独立 engine/catalog、web/desktop 指纹混配均拒绝；尚不能生成完整已验收 Linux 发行锁 |
| P1-01 | ladder-core/index.js:118–144；security-rfc.md | DESIGN_DELIVERED / BLOCKED_REVIEW | 密码仍按旧逻辑处理；只提交兼容迁移/传输/RFC/审核方案，未修改认证、表或密码 |
| P1-02 | backup-restore.md；drill.py | DESIGN_DELIVERED / BLOCKED_REVIEW | 补在线 WAL/录像增量/异地保留/告警设计；合成三局复制批次恢复通过；线上策略、异地与故障告警未实施 |
| P1-03 | deployment.py gate；acceptance.example.json | PARTIAL / NOT_RUN | 绑定制品锁的九阶段和独立迁服回执已实现；真实对局/systemd/客户端/安全审查不可由 unit test 跳过 |
| P1-04 | inputs/layout、health.py；安装/维护/备份文档 | PARTIAL / BLOCKED | 明确可写映射、owner/备份、容量和成功批次新鲜度；真实 Linux 权限和监控/告警落地未验收 |
| P1-05 | 桌面 provenance.json、prepare-pages/release-contract | PARTIAL / NOT_RUN | 逐文件适配快照和构建前漂移拒绝、当前 Windows CI 原生构建已通过；未宣称与最新上游等价，两个真实游戏客户端仍待验 |
| P1-06 | 两平台 DEPLOYMENT.md、公开迁址说明 | PARTIAL / NOT_RUN | 原有隔离/单实例/去重结构合理；全新依赖安装、94 项离线测试和分开打包通过；真实权限/出站/切换需批准的人工验收 |
| P1-07 | 网页 README、docs/archive、公开配置/迁址说明 | RESOLVED（文档） | 历史资料已有归档，本轮突出固定部署来源、正式三输入和开发/测试回退边界；未把 tunnel kit 当正式系统验收 |

新增实际故障：全新 Windows CRLF 检出使五个 CoffeeScript 源码截取测试及 SQL 契约比对失败；
已在测试读取和 contract.js 中只规范化换行，DDL 内容修改仍被拒绝，没有修改实体、认证或天梯规则。
末尾的真实业务矩阵仍是整服放行条件。

## 本轮 A–F 交付与新证据

| 工作包 | 文件与结果 | 未完成范围 |
| --- | --- | --- |
| A | 本页、resources.md、versions.json：核对三源及十三项问题，保留原 dirty 工作树 | 公共源码不能证明原服部署版本 |
| B | deployment.py/test_deployment.py、参数/回执模板；网页三个公开输入必填，桌面受控默认/快照清单 | 完整跨制品锁待真实 Linux engine/Windows EXE 与审核域名 |
| C | engine.py/test_engine.py：基础 Lua 固定干净提交校验；实际固定卡池与四库回下载均匹配 | Linux ELF 编译、完整生产规则/禁表等价 BLOCKED_EXTERNAL |
| D | linux-install.md、输入/layout 守卫、SQL CRLF 契约修复；synthetic 私有输入不变且不泄漏测试通过 | Ubuntu24/PG17/Nginx/TLS/systemd/reboot 与实际私有输入 BLOCKED |
| E | 网页公开输入/类型/lint/完整 Cloudflare/普通 ZIP/Toy 构建；桌面 8 项前端及 Windows CI 的 29 项 Rust/EXE/ZIP；Bot 55+16+23 离线测试及独立包重新安装/测试 | 真实新默认/两游戏客户端、移动端和平台权限 NOT_RUN |
| F | 增强 drill.py 三局事实与各局录像；health.py/test_health.py、持续备份提案/security-rfc、分阶段 gate | 异地、真人完整业务、安全/备份批准及真实迁服未通过 |

本轮 Windows / Node24.15.0 / Python3.13.14：服务端 build 与全部 npm test 通过，schema
20 表实体/DDL 契约及参数测试通过；运维回归涵盖来源、私有输入不变、混包拒绝、备份/恢复守卫与健康契约。
运维回归 59 项通过，最终部署边界 9 项复测通过，额外拒绝可写根/父目录和未知代码链接。
网页公开输入 8 项、Toy 适配 5 项、
Cloudflare 发布错误/取消/预览回归、类型与 lint 通过；实际 Cloudflare dist、普通 ZIP 和 Toy ZIP 已生成并核对，
使用 `.invalid` 合成公开地址，四语环境/禁表/固定 replay 资源检查通过，不能直接作为正式网站上传。
新下载的四语查询 CDB 实际加载 14,981 卡，新增状态接口返回 200、四语及中文元数据完整；缺库回归返回 503。
桌面 check 通过只证明前端与发行输入逻辑；本机未找到 Rust/MSVC 工具链。

本轮候选桌面提交 `b9e0bf06deac014b60c904a88a12a182cd646de1` 的
[Windows CI #29](https://github.com/301zrg/srvprotianti-desktop/actions/runs/38250365562)
已成功：实际 Windows Server 2025 / windows-2025-vs2026、Node22.23.3、Rust1.99.0 MSVC，
前端检查、rustfmt、29 项 Rust 测试、原生 EXE、便携目录、ZIP 和 artifact 上传全部通过；Release job 被跳过。
这关闭本轮原生桌面构建未测试项，但默认 CI 未传 deployment.json，仍属旧默认开发包；
不是 Windows Server2022/PG17/SCM 整服验收，也不证明新地址、玩家已有设置或两个游戏客户端已实测。
Artifact 11748420251 的 GitHub digest 为
`sha256:38d17114f1a11c9748846f27bc00cc4c550afbf4d1483f00d8faaa5f64af5269`，
仅记录平台元数据，本轮未下载/运行 EXE；构建实际源码 SHA 以 artifact 自带 manifest 为准。

独立新建 Windows PG18.4 cluster 的更新版联合恢复报告保存在工作区
`.audit-tmp/readiness-evidence/pg18-20261012T115728Z/drill/drill-result.json`：
20 表、runtime DML/DDL 拒绝、合成 G1–G3 六行事实及对应各局录像、全表内容/序列、账号积分连胜、原始文件 SHA、
linked/orphan/missing 分类、映射权限与新写入均通过；源库/文件不变，拒绝同源库、非空目标和损坏录像。
恢复使用本机复制且重新校验的批次，不是异地副本，不是真实可播放录像。测试 cluster 已停止，未连接旧 cluster 或生产。
`linuxSystemdValidated=false`、`engineAndNetworkValidated=false`、`offHostCopyVerified=false` 保持未通过。

新的 npm ci 报告已知依赖风险：服务端 35（8 critical）、网页 33（26 high）、桌面 1 high，
Bot 各依赖安装报告 1 high；未经可达性/兼容性审查未 force 升级。此风险已纳入安全审查与放行回执。

这份表区分“实现”“本机自动验证”“隔离 Linux 自动验证”和“正式服务验收”。
工具通过不会自动使其他栏变为通过。本轮没有核验正式环境是否部署了所测代码，
也没有读取其私密配置或数据。

第二阶段原工具交付和 Linux/PG17 隔离基础验证已有记录；2026-10-12 按新要求加入引擎资源安装更新和 Windows Server 路线。
完整开服、真实数据迁服和生产验收仍有未执行项；不能将这一阶段完成解释为这些项目全部通过。

## 分阶段发布 gate

`ops/versions.json.repositories` 是已核对的来源基线，不是跨制品兼容性保证。
`sources` 默认要求精确 SHA；`--candidate` 只允许已核对基线的后继并记录实际 HEAD/dirty，
仍须审核差异。不要把版本表换成三个最新 SHA 后宣称已验收。

```bash
python3 ops/scripts/deployment.py sources --server ../srvprotianti \
  --web ../srvprotiantiweb --desktop ../srvprotianti-desktop \
  --versions ops/versions.json --candidate
python3 ops/scripts/deployment.py web-artifact --dist ../srvprotiantiweb/dist \
  --profile /private-staging/deployment.json --versions ops/versions.json \
  --commit REPLACE_WITH_ACTUAL_WEB_ARTIFACT_SOURCE_SHA
```

先审核、提交源码，再构建全新 server archive、根路径网页 dist 和 Windows 受控便携目录。
`lock` 绑定实际三个来源、公开参数/版本表、server archive、engine/catalog/web/desktop 全部文件 SHA，
还核对 archive 中 engine/catalog 与独立组件完全相同，拒绝混包、漏件、额外文件及旧默认。
基础 Lua 必须来自固定干净脚本提交；Linux 引擎完整资源仍须维护者准备，不能用合成/Windows binary 替代。

```bash
python3 ops/scripts/deployment.py lock --server ../srvprotianti --web ../srvprotiantiweb \
  --desktop ../srvprotianti-desktop --profile /private-staging/deployment.json \
  --versions ops/versions.json --archive /private-staging/server-1103.tar.gz \
  --web-dist ../srvprotiantiweb/dist --desktop-package /private-staging/desktop-new \
  --engine /private-staging/linux-engine-new --catalog plugins/card-catalog/databases \
  --output /private-staging/deployment-lock.json
```

输出必须是新文件。`--fixture` 仅用于示例输入和单元验证，fixture lock 永远不能通过发布 gate。
`--allow-reviewed-dirty` 仅在逐项审查公共源码/生成差异后使用，并保留 dirty；默认拒绝未提交来源。
读取既有 archive 不连接数据库，不读取生产配置。网页 Toy 相对路径包不适用本根路径 gate。

复制 [验收回执模板](../templates/acceptance.example.json) 到私有安装记录，所有阶段默认 NOT_RUN。
每项实际完成后，由审核人填写同一 `deployment-lock.json` SHA、operator、带时区时间、真实日志/录屏/报告位置，
以及对应检查结果。必须绑定同一制品锁，不可搬用旧构建回执。模板各字段对应下面业务矩阵，
手工签认真实性仍需审查；工具只检查完整性与声明，不证明日志没有伪造。

```bash
python3 ops/scripts/deployment.py gate --lock /private-staging/deployment-lock.json \
  --receipts /private-staging/acceptance.json --profile /private-staging/deployment.json \
  --versions ops/versions.json --archive /private-staging/server-1103.tar.gz \
  --web-dist ../srvprotiantiweb/dist --desktop-package /private-staging/desktop-new \
  --engine /private-staging/linux-engine-new --catalog plugins/card-catalog/databases
```

`gate` 先重新验证锁定文件；缺项是 NOT_RUN/BLOCKED，不放行时退出码 2，坏输入/制品退出码 1。
必须通过 installation-inputs、真实 Ubuntu24/PG17、原生 engine、TCP/WSS/IP、TT 三局/换备/结算/录像/usage、
systemd 子进程/重启、备份/安全审查、双原生客户端/桌面与移动端才能输出 deploymentReproducible=true。
不能把合成 SQL、TCP listen、HTTP200 或 WSS101 填成完整对局证据；每份回执须明确未以合成结果代替真人对局。
生产迁服另加 `--migration` 和真实私有恢复、切流无双写、回退回执，不由空服通过自动推出。
安全审查入口为 [凭据 RFC](security-rfc.md)，持续备份设计归 [联合备份](backup-restore.md)。

## 自动验证入口

资源/双系统新增入口：`python3 -m unittest discover -s ops/tests -v`，
`engine-source.py`、`engine.py check-pool/assemble/verify/smoke` 和 `ops.py preflight --platform linux|windows`。
完整命令归属 [引擎指南](ygopro-install.md)、[Windows 指南](windows-install.md) 和 [云端步骤](codex-cloud-testing.md)。

服务端：

```bash
npm run build
npm test
node plugins/postgres-compat/deployment/schema.js check-contract
node plugins/postgres-compat/deployment/schema.test.js
```

网页：

```bash
npm run test:public-config
node node_modules/typescript/bin/tsc --noEmit
npm run lint
npm run build:static
```

数据库演练参数以各项目工具 README 为准。
自动/手工发布要实查产物而不是只检查源配置函数，例子使用合成域名，不能直接替代正式地址。

运维标准库测试与真实PG演练入口见 [scripts README](../scripts/README.md)。
PG使用单独测试cluster/角色/`srvpro_drill_*` 库和合成录像，真实账号、私有配置不参与。
全部验证报告先写私有报告目录，再摘录不含凭据/玩家数据的结论到公开文档。

## 两条演练路线

### A：全新安装

全新Linux或隔离VM → OS/Node/PG17 →release校验解包/引擎构建→新空库初始化→
runtime只读schema验证→systemd/Nginx→测试账号和完整TT/普通房→录像/统计→reboot。

结果要记录OS、CPU、Node/npm、PG客户端/服务端、代码dirty/制品SHA、引擎binarySHA、
Core/Lua/scripts/CDB/禁表指纹、域名/端口/Origin和每项失败定位。
不从开发机隐含node_modules、私有配置、原库和Windowsbinary借依赖。

### B：联合恢复

合成库产生账号/积分/Match/单局/使用率及三类录像样本 →自然排空并停所有writer→
联合backup与verify→异机复制后verify→不同名字新空库/新目录restore→
内容/序列/schema/角色/SHA/录像分类一致→路径映射→新写入→重启。

先在合成样本上证明工具，然后再由管理员在私有隔离目标上恢复一份真实批次。
全量数据体积、真实locale、现场新增表/扩展会影响耗时与兼容性；不能用几行合成样本估算正式恢复时间。

## 2026-10-12 新增验证范围

| 项目 | 本轮直接证据 | 尚待验证 |
| --- | --- | --- |
| 运维工具 | Windows/Python 3.13.14 下 45 项标准库测试通过，含 12 项引擎/归档边界测试 | Linux/Windows runner 上重复执行 |
| 引擎卡池 LFS | 现服只读取得小库，用户批准后公开发布；从完整 SHA 回下载，1,695,744 字节、SHA/SQLite/5,267 行全部匹配 | 真实入房与卡池限制行为 |
| 固定 Windows 构建输入 | YGOPro/Core/基础脚本提交及 Lua/Premake/libevent/SQLite/xz 下载 SHA 均匹配，Premake 实际生成 VS2022 方案 | 该固定源码的 MSBuild 原生编译，本机缺少 C++ 工具链 |
| Windows 原生临时引擎 | Windows/AMD64，旧服 EXE + 固定基础 Lua + 706 覆盖组装；13,932 文件校验、原生启动/TCP、Windows 预检和 Node 相对路径 spawn 通过 | 编译来源等价性、旧裁定触发、完整宿主与真实对局；本机不是全新 Windows Server |
| Linux 原生引擎 | 已提供固定输入、编译、组装和双系统 CI 入口 | 本轮尚未执行 Linux 编译、ELF/ldd/启动及真实对局 |
| Windows PG17/服务 | 隔离 cluster、SCM 服务模板、重启与完整业务验证步骤已写入指南 | 本轮未执行 PG17 Windows 全流程、SCM/reboot/完整网络；PG18 历史演练不能代替 |
| Windows 生产联合备份 | SQL/文件演练可用于隔离 Windows PG；现有生产停写守卫依赖 systemd | Windows SCM writer 守卫未实现，不允许用 isolated 标记代替生产停写证明 |
| 双系统 workflow | 只手动执行，固定 Ubuntu24.04/windows-2022；只上传元数据 | 本轮未触发；workflow_dispatch 进入默认分支后再手动运行 |

本机报告原件在 `.audit-tmp/stage2-refresh-20261012/`，包括 pool-download.json、windows-assembly.json、
windows-engine-smoke.json、windows-preflight.json、windows-node-spawn.json 和 source-windows-v1/source-report.json；不公开旧服 EXE 或完整 Lua 运行目录。
CDB 发布范围仅为用户批准的现用小库，不能扩大为其他引擎资产的发布授权。

## 真实服务验收表

2026-10-11 本机已通过服务端完整构建和 `npm test`，以及 PostgreSQL 部署工具测试。
运维工具 17 项标准库测试和部署参数/实体/DDL 契约检查通过；
28 份交付文档的 336 个本地链接、JSON/示例 Python 与 39 个 Bash 块的语法检查通过。
隔离 Windows PostgreSQL 18.4 已完成空库初始化、真实 TypeORM 对 20 表写入、拒绝重复初始化、
权限/约束/历史结构/序列验收和真实 dump/restore。
联合恢复演练已核对全部表内容摘要、序列、原始文件 SHA、积分、连胜和三类录像关联；
新 runtime 写入成功，拒绝原库、非空目标和损坏文件。
网页已通过 7 项公开配置测试、5 项 Toy 打包测试、类型检查、lint、完整 Cloudflare 构建，
并实际检查 Edge 中 4 种配置场景、普通 ZIP 与 Toy ZIP 的公开参数和资源映射。
本次 ZIP/dist 使用合成示例域名，正式部署必须重新构建。

本地证据位于工作区 `.audit-tmp/pg18-stage2/drill/postgres-drill.json`、
`.audit-tmp/ops-pg18-drill-20261011b/drill-result.json` 和
`srvprotiantiweb/.audit-tmp/stage2-web-validation.json`；不随公开运维仓库提交。

2026-10-11 收到用户提供的 [隔离云端验证报告](cloud-validation-20261011.md)：
Debian 13.6 x86_64、Node 24.15.0、PostgreSQL 服务端/客户端 17.11 下，
固定四语 LFS 下载与真实查询插件装载、服务端构建/测试、33 项运维测试、
PG17 空库/TypeORM/权限/真实 dump 与 restore、合成数据库和录像联合恢复及网页产物检查均通过。
本轮仅根据该报告登记结果，没有直接复阅云端原始日志。
完整固定 706 在线引擎资源未提供，原生引擎与完整对局未执行；PID 1 为 `tail`，生产 systemd/reboot 也未执行。
首次安装辅助脚本中途修改导致的失败已完整重跑成功；环境快照仍是待保存和发布的草稿。

| 项目 | 做法和预期结果 | 当前状态 |
| --- | --- | --- |
| 空库结构及权限 | 20表/约束/序列齐全，runtime无永久DDL/owner权限 | 本机 PG18 与用户报告的隔离 Linux PG17 通过；正式库另验 |
| 恢复完整性 | 每表内容/行数/序列与批次相同；没有自动重置连胜/积分 | 本机及用户报告的 Linux PG17 合成联合恢复通过；真实批次另验 |
| Linux引擎 | ELF x86_64、SSE2、依赖可用、正确cwd、固定脚本/CDB | 尚未真实Linux执行 |
| TCP入房 | 两测试客户端、正确协议版本、普通房可完整结束 | 待Linux/真实协议 |
| TT账户/结算 | 注册与密码认证、G1–G3/换备、一场Match只结算一次 | 现有单元/集成验证与真实对战分开 |
| 重连/观战/恢复 | 中断、宽限、重连、后入观战和支持录像恢复 | 待真实客户端 |
| 卡池/CDB | 环境内允许、超池TT拒绝、异画兼容、现有特殊房代码 | 现服 cards.cdb 在用、cards1.cdb 未加载已确认；真实迁移行为仍待验收 |
| 四语/使用率 | 四语名称和中文metadata可用，Match投影正常 | 本机及用户报告的 Linux 真实四库装载通过；在线对局投影另验 |
| 录像 | 新录像与DuelLog事实、历史列表/下载/支持播放一致 | 工具分类/字节验证与真实播放分开 |
| WSS/TLS/Origin/IP | 允许Origin101，错误Origin403，不信任玩家自带XFF | 本地回归与真实代理检查分开 |
| 自动+手工网页发布 | 三公开输入实际进入dist与ZIP，新官网入口正确 | 本机及用户报告的云端合成配置产物通过；正式配置需重新构建验收 |
| 维护 | 未established/deleting/排队/异步写不允许ready；stop权限鉴权 | 本地回归；真实systemd停机待执行 |
| systemd/reboot | 重启后正确版本、路径、权限、端口恢复，无孤儿进程 | 尚未真实Linux执行 |
| Windows 原生服务/reboot | 新安装、低权限身份、工作目录、SCM 停启、崩溃恢复及子引擎清理 | 指南/模板已提供；尚未全新 Windows Server 执行 |
| Bot/桌面迁址 | 不重复推送、保留本地状态，设置指向新服务器 | 文档已补；实际账号/桌面操作待执行 |

## 本机Linux验证限制

2026-10-10尝试启动本机WSL Ubuntu，系统返回 `HCS_E_HYPERV_NOT_INSTALLED`，
虚拟化运行条件不可用；Docker Linux daemon也未可用。
未修改BIOS/Windows虚拟化设置，未把Windows真实PG演练写成Linux成功。
本机PG18.4是另建cluster、仅127.0.0.1:55432；未连接原本机18服务或正式PG17。
这证明本机 SQL/权限/联合 dump 恢复的实测范围；Linux/PG17 隔离证据见上面的用户云端报告，
systemd/真实客户端和完整在线引擎的未执行状态仍保留。

运维仓库提供在有Linux条件后可执行的演练工具；部署/恢复工具与文档可以先交付，
后续 Linux/PG17 自动复测可走 [Codex 云端测试](codex-cloud-testing.md)。
第三阶段已提供 [环境复用与解耦方案](other-environments-plan.md)，具体实施仍需用户确认，
尚未开始实施解耦。

## 记录格式

每条验收记录包含：执行日期/操作者、版本/制品、隔离目标、命令、退出码、预期/实际结果、
报告位置、未通过项和解决方式。只保存脱敏结论到公开仓库。
“未执行”“失败”“通过但有限制”分别记录，不用一个含糊的已测试覆盖所有条件。
