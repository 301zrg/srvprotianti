# 使用 Codex 云端做后续 Linux 测试

可以用 Codex Cloud 补做 Linux 编译、PostgreSQL 17 空库初始化与数据库/录像联合恢复演练。
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
| 原生引擎 | 完整封存资源到位后按 Linux 指南编译，记录 ELF/ldd/SHA | 该云端 CPU/系统上的构建与启动结果 |
| WSS/Nginx | 能安装依赖时做本机代理与协议联调 | 临时环境的代理行为；正式 DNS/证书另验 |
| systemd | 先检查 PID 1，静态检查 unit；有可用 systemd 再启动测试 | 不能由 SQL 演练推定重启后会正确开服 |
| 桌面助手、动画、完整对局 | 留在 Windows 真机和真实游戏客户端验收 | 云端 shell 结果不替代玩家实际使用结果 |

当前官方文档把 computer/browser use 列为云端未支持能力；已有浏览器脚本是否能以无头 CLI
运行，需要安装浏览器依赖后实际检查，不能预先填“通过”。
[云端环境说明](https://learn.chatgpt.com/docs/environments/cloud-environments)

## 1. 把本轮代码与资源准备给云端

云端从 GitHub 取得的分支不会自动包含本机未提交或未推送的源码。
先审核完整差异，将需要测试的工具/代码纳入已推送的测试分支或经过审核的 release。
运维材料位于服务端仓库的 `ops/`，随服务端分支一起取得，无需另外创建文档仓库。
各项目继续保有自己的代码/契约；`ops/` 统一组织测试和安装步骤。

环境选服务端和网页仓库；运维材料包含在服务端中。桌面仓库可一并选入做文档核对，但不把 Linux 构建当作 Windows 发行验收。
查询四语 CDB 在独立 [资源仓库](https://github.com/301zrg/srvprotianti-resources) 通过 Git LFS 发布，
服务端 `ops/versions.json` 固定资源提交和指纹，按下一节直接下载，不需要从本机手动上传。
执行前核对 [资源发布状态](resources.md#从线上取得四语查询库)，资源提交与四份 LFS 对象尚未上线时记录阻塞，不填下载成功。
引擎、Lua/Core/scripts、两套在线 CDB 和网页固定资源快照若被忽略，
仍要通过审核后的非私密资源包提供并校验 SHA，不能临时改用浮动上游资源。
合成演练不需要真实备份、玩家录像、生产配置或正式数据库密码。

## 2. 创建环境并检查准备结果

在 ChatGPT 网页/桌面选择 `Work in > Cloud`，创建环境并选择 GitHub 仓库。
让 Codex 完成依赖准备，审阅测试结果后保存并 Publish，再启动新任务。
这里的 Publish 保存云端环境，不是发布游戏网站或开服。
[Codex Cloud 官方入口说明](https://learn.chatgpt.com/docs/cloud)

准备环境时明确要求 Node 24.15.0、Python 3、Git、Git LFS、PostgreSQL 17 服务端和客户端，以及 Linux 编译依赖。
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
本批工具位于 PR #5 的 `codex/catalog-lfs-20261011` 分支；合并前选该分支，合并后可选包含它的 `restructure2`。
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

拿到完整封存引擎后按 [Linux 安装第 4 步](linux-install.md#4-取得兼容的-linux-引擎)
编译，并用 `ops.py preflight` 检查。缺资源时写明缺项，不填引擎测试成功。
接着可在隔离配置下执行本机 TCP/WSS 与合成对局；正式卡池和特殊房间代码需对照旧服确认。
生产 systemd/reboot、公开 DNS/TLS、机器人平台权限、Windows 桌面和真人动画检查仍按
[验收表](validation.md) 单独记录。

## 5. 可直接交给云端的任务说明

```text
按 srvprotianti/ops/docs/codex-cloud-testing.md 执行隔离 Linux/PG17 验证。
先记录真实 OS、CPU、Node、PG客户端/服务端、各repo分支和代码状态。
选包含本次 catalog-fetch/catalogSource 的已发布服务端分支并固定完整commit，安装git-lfs。
本批服务端选codex/catalog-lfs-20261011（PR #5；合并后可用包含它的restructure2），网页选deploy/cloudflare。
按versions.json从独立资源仓库取固定四语CDB，运行catalog-check核对结构、字节及SHA。
npm ci后执行CARD_DATABASE_CONFIG.md的只读Node真实装载验收，必须无warning、metadataAvailable=true、size>0、四份fingerprint。
已有查询库先校验，不自动覆盖；缺库/LFS失败不得填通过，记录失败或阻塞原因。
只创建新临时loopback cluster、合成库和合成录像，不访问正式数据库或私密配置。
依次运行服务端完整检查、schema真实PG演练、运维联合恢复、网页构建和两类打包。
网页使用指南中的三项example.invalid公开配置，确保python命令指向Python 3并有SQLite标准库。
资源齐全再编译固定YGOPro引擎；缺项单独报告，不替换成浮动上游版本。
保留命令退出码、内容/序列/文件SHA、维护与错误目标拒绝检查的报告。
不发布网站、不推送分支、不自动重置积分/连胜、不清理未知目录。
用表格分别列已通过、未执行和失败项；停止本任务创建的cluster。
```

保存测试证据并下载需要长期保留的材料；云端任务状态不代替代码仓库和备份。
本指南对实际生产部署覆盖范围的判断来自项目运行方式，云端通过后仍按具体测试环境解释结论。
