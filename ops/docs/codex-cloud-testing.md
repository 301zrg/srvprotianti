# 使用 Codex 云端组织 Linux 与 Windows 验证

可以用 Codex Cloud 补做 Linux 编译、PostgreSQL 17 空库初始化与数据库/录像联合恢复演练。
2026-10-12 新流程加入固定 YGOPro 构建输入、现用 5,267 卡 LFS 卡池、可选旧裁定组装，以及原生 Windows 验证。
云端任务首先记录真实 OS；Linux 工作区只能产生 Linux 运行证据。Windows 原生部分由 Codex 整理/审查任务，
交给 GitHub `windows-2022` runner 或隔离 Windows VM 执行；不能把 Linux 上检查 EXE、WSL 或 Wine 写成 Windows 部署通过。
2026-10-11 用户已提供按本指南执行的 [隔离云端验证报告](cloud-validation-20261011.md)：
真实四语查询库、服务端和网页构建、PG17 与合成数据库/录像联合恢复通过；
完整固定在线引擎与生产验收未执行。本轮依据用户报告记录结果，未直接复阅云端原始日志。
该次环境安装脚本和启动指南仍是配置草稿，未保存并发布可复用环境快照；
未来任务恢复环境是否成功需要另行验证。

## 适合覆盖的范围

| 检查 | 云端执行方式 | 结果能证明什么 |
| --- | --- | --- |
| 服务端和网页 | 安装锁定依赖，构建、单元/集成测试、检查真实 dist/ZIP | 实际云端 OS/Node 下的代码与制品 |
| 四语查询库 | 从独立资源仓库 LFS 取固定提交，校验 SQLite/指纹并加载真实 cardCatalog | 查询资源能取得，中文元数据及四语目录实际可用；不代替在线引擎验收 |
| PostgreSQL 17 | 临时 cluster、20 表初始化、真实 TypeORM 写入与 dump/restore | PG17 的结构、权限、序列和数据兼容性 |
| 联合备份恢复 | `drill.py` 生成合成数据库、中文文件名、三类录像关联 | 文件字节/数据库内容及拒绝错误目标的能力 |
| Linux 原生引擎 | 固定源码/依赖 + LFS 卡池 + 可选覆盖，原生编译、assemble/verify/smoke | ELF、依赖和临时 TCP 启动；真实裁定/对局另验 |
| Windows 原生引擎 | 手动双系统 workflow 的 windows-2022 job，或 Windows VM 的同一流程 | 实际 Windows MSBuild、x64 PE 与原生启动；不能由 Linux job 替代 |
| Windows PG17/服务 | 隔离 Windows VM 按 windows-install.md 启动 PG17 cluster、SCM 服务、重启 | 数据库与原生服务流程；必须使用 Windows 实际日志，runner 编译结果不够 |
| WSS/Nginx | 能安装依赖时做本机代理与协议联调 | 临时环境的代理行为；正式 DNS/证书另验 |
| systemd | 先检查 PID 1，静态检查 unit；有可用 systemd 再启动测试 | 不能由 SQL 演练推定重启后会正确开服 |
| 桌面助手、动画、完整对局 | 留在 Windows 真机和真实游戏客户端验收 | 云端 shell 结果不替代玩家实际使用结果 |

当前官方文档把 computer/browser use 列为云端未支持能力；已有浏览器脚本是否能以无头 CLI
运行，需要安装浏览器依赖后实际检查，不能预先填“通过”。
[云端环境说明](https://learn.chatgpt.com/docs/environments/cloud-environments)

## 1. 把本轮代码与资源准备给云端

A–F 新整改应选择本轮 `codex/deployment-readiness-20261012` 三仓候选提交，而不是只复跑旧 PR #7。
先核对 [基线矩阵与发布 gate](validation.md) 中实际源/制品记录；该分支没有合入或部署的含义。
让云端运行 deployment.py 的来源/公开输入/实际网页产物检查、最新运维与 schema 回归，
并从新的隔离 PG17 cluster 执行更新后的 drill.py（G1–G3/各局录像、复制批次恢复）。
缺完整 Linux 引擎、真实 Ubuntu24/systemd、私有审核参数、Windows 原生环境或客户端时保留 BLOCKED，
不把旧 Debian 用户报告或 Windows PG18 演练填入当前 Ubuntu24/PG17 gate。

云端从 GitHub 取得的分支不会自动包含本机未提交或未推送的源码。
先审核完整差异，将需要测试的工具/代码纳入已推送的测试分支或经过审核的 release。
运维材料位于服务端仓库的 `ops/`，随服务端分支一起取得，无需另外创建文档仓库。
各项目继续保有自己的代码/契约；`ops/` 统一组织测试和安装步骤。
本轮已发布 [测试分支](https://github.com/301zrg/srvprotianti/tree/codex/stage2-engine-windows-20261012)，
并创建 [草稿 PR #7](https://github.com/301zrg/srvprotianti/pull/7)；任务启动时记录实际完整 SHA。
如果尚未合入默认分支，Linux 云任务仍可选择该测试分支；Actions 的手动按钮另受第 5 节默认分支条件限制。

环境选服务端和网页仓库；运维材料包含在服务端中。桌面仓库可一并选入做文档核对，但不把 Linux 构建当作 Windows 发行验收。
查询四语 CDB 在独立 [资源仓库](https://github.com/301zrg/srvprotianti-resources) 通过 Git LFS 发布，
服务端 `ops/versions.json` 固定资源提交和指纹，按下一节直接下载，不需要从本机手动上传。
执行前核对 [资源发布状态](resources.md#从线上取得四语查询库)，资源提交与四份 LFS 对象尚未上线时记录阻塞，不填下载成功。
当前引擎卡池同样从固定 LFS 提交取得，源码/Core/基础 Lua 和构建依赖由 `engine-source.py` 固定。
旧裁定覆盖可选但启用时须匹配清单；正式完整禁表与当前生产脚本的一致性仍须另外核验。
只用旧 PR #5 分支会缺少本轮 engine 工具，必须选包含本轮交付的服务端提交。
合成演练不需要真实备份、玩家录像、生产配置或正式数据库密码。

## 2. 创建环境并检查准备结果

在 ChatGPT 网页/桌面选择 `Work in > Cloud`，创建环境并选择 GitHub 仓库。
让 Codex 完成依赖准备，审阅测试结果后保存并 Publish，再启动新任务。
这里的 Publish 保存云端环境，不是发布游戏网站或开服。
[Codex Cloud 官方入口说明](https://learn.chatgpt.com/docs/cloud)

准备环境时明确要求 Node 24.15.0、Python 3.12+、Git、Git LFS、PostgreSQL 17 服务端和客户端，以及 Linux 编译依赖。
Ubuntu 中 Git LFS 可通过 `sudo apt-get install -y git-lfs` 安装；任务开始时检查 `git lfs version`。
PGDG/Node/Premake 下载失败时检查实际域名访问权限；可能需要允许 `apt.postgresql.org`、
`www.postgresql.org`、`nodejs.org` 与 GitHub release 下载域名。
下载四库还需要能访问 GitHub 资源仓库和 LFS 返回的实际下载域名；限网环境应在安装阶段完成下载并保存准备结果。
不要因失败直接更换数据库大版本或构建资源。

安装依赖放入 Install script，测试服务启动与就绪检查放入 Start skill。
改变依赖/资源后重新准备并 Republish，再创建新任务，不能假设仓库刷新会重跑安装。
[环境安装和更新方式](https://learn.chatgpt.com/docs/environments/cloud-environments)

先记录真实环境，不假定它等同 Ubuntu 24.04 生产服务器：

```bash
cat /etc/os-release
uname -m
ps -p 1 -o comm=
id
node --version
npm --version
python3 --version
git lfs version
/usr/lib/postgresql/17/bin/pg_dump --version
```

### 取得固定四语查询库并验收

云端必须选包含 `catalog-fetch` 和 `catalogSource` 的已发布服务端分支，记录实际完整 commit。
本轮必须选择包含 `engine-source.py`、`engine.py`、Windows 指南和更新后 `versions.json` 的测试分支或已审核提交。
PR #5 已合并，但旧 `codex/catalog-lfs-20261011` 本身不能覆盖本轮新增引擎验证。
网页选择 `deploy/cloudflare`。不能用尚未包含本批工具的服务端分支替代本批测试。
下面在服务端 checkout 中运行；首次下载目标必须不存在：

```bash
SERVER_SOURCE=/absolute/path/srvprotianti
cd "$SERVER_SOURCE"
git rev-parse HEAD
python3 ops/scripts/ops.py catalog-fetch \
  --destination plugins/card-catalog/databases --versions ops/versions.json
python3 ops/scripts/ops.py catalog-check \
  --catalog plugins/card-catalog/databases --versions ops/versions.json
npm ci
```

环境安装阶段已下载四库时，只运行 `catalog-check` 核实固定版本，跳过再次下载；工具不会覆盖已有目标。
校验失败时记录原因，在新工作区重新准备，不删除未知目录或改用网页裁剪库。
依赖安装后，执行 [查询库配置中的只读 Node 装载验收](../../plugins/card-catalog/CARD_DATABASE_CONFIG.md#验证实际插件装载)，
必须确认无四语加载警告、`metadataAvailable=true`、`cardCatalog.size>0`、四份 fingerprint 齐全。
缺库、LFS 下载失败、只有指针或中文元数据不可用，应列为失败/阻塞项，不能用合成演练的结果替代。

## 3. 独立启动 PostgreSQL 测试 cluster

以下整块在同一个 Bash 会话执行。将 SERVER_SOURCE 和 OPS_SOURCE 改成实际 checkout 路径。
只操作新临时目录、loopback 和 55432；端口已占用就停止核对，不能借用未知数据库。
如果当前用户为 root，要求环境已具备 `postgres` 系统用户和 `runuser`。

```bash
set -euo pipefail
SERVER_SOURCE=/absolute/path/srvprotianti
OPS_SOURCE="$SERVER_SOURCE/ops"
PG_BIN=/usr/lib/postgresql/17/bin
test -x "$PG_BIN/initdb"
test -f "$SERVER_SOURCE/plugins/postgres-compat/deployment/schema.js"
test -f "$OPS_SOURCE/scripts/drill.py"
python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 55432))
PY
TEST_CLUSTER=$(mktemp -d /tmp/srvpro-cloud-pg.XXXXXXXX)
PG_RUN=()
if [ "$(id -u)" -eq 0 ]; then
  id postgres
  chown postgres:postgres "$TEST_CLUSTER"
  PG_RUN=(runuser -u postgres --)
fi
"${PG_RUN[@]}" "$PG_BIN/initdb" -D "$TEST_CLUSTER/data" \
  --username=stage2_owner --auth=trust --encoding=UTF8 --locale=C
trap '"${PG_RUN[@]}" "$PG_BIN/pg_ctl" -D "$TEST_CLUSTER/data" -m fast -w stop' EXIT
"${PG_RUN[@]}" "$PG_BIN/pg_ctl" -D "$TEST_CLUSTER/data" \
  -l "$TEST_CLUSTER/postgres.log" \
  -o "-h 127.0.0.1 -p 55432 -k $TEST_CLUSTER" -w start
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=stage2_owner
unset PGOPTIONS PGPASSWORD PGPASSFILE PGDATABASE

cd "$SERVER_SOURCE"
python3 ops/scripts/ops.py catalog-check \
  --catalog plugins/card-catalog/databases --versions ops/versions.json
npm run build
npm test
node plugins/postgres-compat/deployment/schema.test.js
export SRVPRO_SCHEMA_TEST_CONFIRM=isolated
node plugins/postgres-compat/deployment/isolated-postgres.test.js \
  --pg-bin "$PG_BIN" --report-dir "$SERVER_SOURCE/.audit-tmp/cloud-pg17-schema"

cd "$OPS_SOURCE"
python3 -m unittest discover -s tests -v
python3 scripts/drill.py \
  --server-source "$SERVER_SOURCE" \
  --workdir "$OPS_SOURCE/.audit-tmp/cloud-pg17-joint" \
  --suffix cloud17 \
  --confirm-isolated-cluster 127.0.0.1:55432 --pg-bin "$PG_BIN"
```

临时 trust 认证只用于这个云端合成测试 cluster；正式部署使用数据库指南的私有认证。
测试保留报告与合成库，退出会话时 trap 停止自己创建的 cluster。
重复运行须用新的 report/workdir/suffix；不要删除未知目录来跳过检查。
如测试报错，保留日志和失败报告，先修复原因再创建新的测试批次。

## 4. 网页、引擎和真实部署的补充测试

网页在自己的 `deploy/cloudflare` checkout 执行以下命令。npm 构建脚本调用 `python`，
环境必须提供指向 Python 3 的 `python` 命令及 SQLite 标准库，只有 `python3` 命令时先补齐。
三项公开参数使用合成域名，只用于构建和制品检查，不连接正式服务：

```bash
python --version
python -c 'import sqlite3; print(sqlite3.sqlite_version)'
export VITE_DUEL_WS_URL='wss://game.example.invalid/neos'
export VITE_DECK_IMPORT_ORIGINS='["https://ladder.example.invalid"]'
export VITE_WEBSITE_BASE_URL='https://ladder.example.invalid/'
npm ci
npm run test:public-config
node node_modules/typescript/bin/tsc --noEmit
npm run lint
npm run build:cloudflare
python3 scripts/package_test_release.py
python3 scripts/package_bilitoy_release.py
```

检查实际 dist 和两类 ZIP 中的三项公开参数及资源 SHA，不调用 `deploy:cloudflare` 发布线上内容。

按 [引擎安装指南](ygopro-install.md) 在新 staging 目录执行 engine-source、fetch-pool、Linux 编译、
带 overlay 的 assemble、verify、smoke 和 `ops.py preflight --platform linux`。资源就绪不再依赖从本机搬整个 ygopro 目录。
可以先用固定纯 1103 禁表做隔离检查；记录它没有验证完整多禁表/特殊房。缺资源或编译失败时保留原因，不填成功。
接着可在隔离配置下执行本机 TCP/WSS 与合成对局；正式卡池和特殊房间代码需对照旧服确认。
生产 systemd/reboot、公开 DNS/TLS、机器人平台权限、Windows 桌面和真人动画检查仍按
[验收表](validation.md) 单独记录。

## 5. Windows 原生验证的云端入口

仓库提供只手动执行的 [Stage 2 native engine validation](../../.github/workflows/stage2-engine-validation.yml)，
矩阵为 `ubuntu-24.04` 和 `windows-2022`。后者是 GitHub 提供的原生 Windows runner。
[GitHub runner 系统说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

这个 workflow 会在两平台运行源码测试、准备固定源码与依赖、下载 LFS 卡池/四语库、MSBuild 或 make 编译，
组装旧裁定覆盖、校验并原生启动临时引擎。它只上传脱敏 JSON 元数据，不发布程序或完整运行目录。
纯 1103 禁表是此次 CI 的范围，不自动声明生产多禁表/所有特殊房等价。

GitHub 要求 `workflow_dispatch` 文件先存在于仓库默认分支；仅推一个新测试分支，通常不会出现 Run workflow 按钮。
本轮读取 GitHub 仓库元数据确认默认分支是 `main`，本 PR 的目标是 `restructure2`；仅合入 PR #7 不满足默认分支条件。
需要 Actions 入口时，由维护者审阅后将这个手动 workflow 文件纳入 `main`，运行时再选择本轮完整测试分支。
也可以直接在真实 Windows VM 手动执行指南。workflow 进入默认分支后在 GitHub Actions 选此 workflow，
点击 Run workflow、选择包含本轮工具的测试分支；执行者需要该仓库写权限。
[手动运行条件与分支选择](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

有已授权 GitHub CLI 环境时，可由用户或明确授权的任务执行：

```bash
gh workflow run stage2-engine-validation.yml --repo 301zrg/srvprotianti --ref YOUR_REVIEWED_TEST_BRANCH
gh run list --repo 301zrg/srvprotianti --workflow stage2-engine-validation.yml --limit 5
gh run watch RUN_ID --repo 301zrg/srvprotianti --exit-status
gh run download RUN_ID --repo 301zrg/srvprotianti --dir ./new-stage2-reports
```

Linux 云端可检查两个 job 的日志与 JSON；Windows job 必须有 Windows OS、MSBuild 退出码、PE x64、binary SHA 和原生 smoke 成功。
失败 job 不能因仍生成了环境报告而填通过。workflow 本轮尚未实际触发，整服验证不在该 workflow 内。

继续按 [Windows 安装指南](windows-install.md) 在隔离 Windows VM 执行 PG17 空库/真实 TypeORM/联合恢复、
私有测试配置下启动宿主、SCM 停启/崩溃恢复/重启，以及真实普通房/TT/WSS/旧裁定对局。
现有 backup 的生产停写守卫是 systemd 专用，Windows SCM 守卫尚未实现；不能用 confirm-isolated 绕过正式 Windows 检查。
这些结果必须单独列为未执行、失败或通过。不要因为当前正式服已经是 Windows 就省略新安装验证。

## 6. 可直接交给云端的任务说明

第一次创建/更新环境时：

```text
为本次 srvprotianti 第二阶段准备隔离云端环境，先读 ops/docs/codex-cloud-testing.md。
服务端选择包含 engine-source.py、engine.py、Windows 指南及更新 versions.json 的本轮测试分支，记录完整 SHA。
Install script 安装 Node24.15.0、Python3.12+、Git LFS、PG17 server/client 及 Linux 编译依赖。
按清单准备固定引擎构建输入、环境小库和四语库；已有目录只校验，缺资源不得换浮动版本。
Start skill 记录实际 OS/CPU/PID1，并检查需要的测试服务就绪。只操作新目录，不读生产配置或连接正式数据库。
先检查准备结果；保存并 Publish 环境后，在新任务验证资源和依赖确实能复用。
```

Linux 任务：

```text
按 srvprotianti/ops/docs/codex-cloud-testing.md 执行隔离 Linux/PG17 验证。
先记录真实 OS、CPU、Node、PG客户端/服务端、各repo分支和代码状态。
选包含本轮 engine-source.py/engine.py、Windows指南、更新 versions.json 的服务端测试分支并固定完整commit，安装git-lfs。
网页选deploy/cloudflare并记录完整commit；不要只用旧PR #5分支。
按versions.json从独立资源仓库取固定四语CDB，运行catalog-check核对结构、字节及SHA。
npm ci后执行CARD_DATABASE_CONFIG.md的只读Node真实装载验收，必须无warning、metadataAvailable=true、size>0、四份fingerprint。
已有查询库先校验，不自动覆盖；缺库/LFS失败不得填通过，记录失败或阻塞原因。
只创建新临时loopback cluster、合成库和合成录像，不访问正式数据库或私密配置。
依次运行服务端完整检查、schema真实PG演练、运维联合恢复、网页构建和两类打包。
网页使用指南中的三项example.invalid公开配置，确保python命令指向Python 3并有SQLite标准库。
按ygopro-install.md取得固定源码/Core/基础Lua/依赖，下载并校验现用5267卡LFS池，原生Linux SSE2编译。
用固定706覆盖和审核禁表在新目录assemble，再verify/smoke/preflight；单独保留不启用overlay的规则验证范围。
记录ELF/ldd、程序SHA、全部文件manifest。源头与生产EXE等价性、旧裁定效果和真实对局尚未验证时明确保留未通过状态。
保留命令退出码、内容/序列/文件SHA、维护与错误目标拒绝检查的报告。
不发布网站、不推送分支、不自动重置积分/连胜、不清理未知目录。
用表格分别列已通过、未执行和失败项；停止本任务创建的cluster。
```

Windows 任务：

```text
读ops/docs/windows-install.md和codex-cloud-testing.md，整理本轮Windows原生验证报告。
先确认代码完整SHA及workflow_dispatch已在默认分支。实际执行GitHub Actions需用户明确授权；否则只整理可复制命令。
检查Stage 2 workflow的windows-2022和ubuntu-24.04两个job，Windows必须实际MSBuild、PE32+ x64、binary SHA和原生smoke通过。
只有Linux容器、EXE头检查或Wine/WSL的结果不得填Windows上线通过；缺日志或失败job分别记录。
在隔离Windows Server2022 VM按指南执行PG17空库/TypeORM/权限/真实dump restore和合成数据库录像联合恢复。
核验应用工作目录、配置/ACL/录像路径、宿主spawn引擎、SCM服务停启/崩溃/孤儿子进程/重启。
保留未完成的Windows生产停写守卫状态，不把confirm-isolated用于正式实例。
用测试账号完成普通房、TT G1-G3换备、观战重连、旧裁定差异、录像及四语统计，并测试WSS/Origin。
分别列源码编译、引擎启动、PG17、完整业务、服务重启、生产网络的证据；不访问正式C:\srvpro/数据库或发布网站。
```

保存测试证据并下载需要长期保留的材料；云端任务状态不代替代码仓库和备份。
本指南对实际生产部署覆盖范围的判断来自项目运行方式，云端通过后仍按具体测试环境解释结论。
