# 使用 Codex 云端做后续 Linux 测试

可以用 Codex Cloud 补做 Linux 编译、PostgreSQL 17 空库初始化与数据库/录像联合恢复演练。
本次只是交付可执行步骤，还没有创建云端环境或提交云端任务；现有通过记录仍是本机结果。

## 适合覆盖的范围

| 检查 | 云端执行方式 | 结果能证明什么 |
| --- | --- | --- |
| 服务端和网页 | 安装锁定依赖，构建、单元/集成测试、检查真实 dist/ZIP | 实际云端 OS/Node 下的代码与制品 |
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
引擎、Lua/Core/scripts、两套在线 CDB、查询四语 CDB 和网页固定资源快照若被忽略，
要通过审核后的非私密资源包提供并校验 SHA，不能临时改用浮动上游资源。
合成演练不需要真实备份、玩家录像、生产配置或正式数据库密码。

## 2. 创建环境并检查准备结果

在 ChatGPT 网页/桌面选择 `Work in > Cloud`，创建环境并选择 GitHub 仓库。
让 Codex 完成依赖准备，审阅测试结果后保存并 Publish，再启动新任务。
这里的 Publish 保存云端环境，不是发布游戏网站或开服。
[Codex Cloud 官方入口说明](https://learn.chatgpt.com/docs/cloud)

准备环境时明确要求 Node 24.15.0、Python 3、Git、PostgreSQL 17 服务端和客户端，以及 Linux 编译依赖。
PGDG/Node/Premake 下载失败时检查实际域名访问权限；可能需要允许 `apt.postgresql.org`、
`www.postgresql.org`、`nodejs.org` 与 GitHub release 下载域名。
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
/usr/lib/postgresql/17/bin/pg_dump --version
```

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
npm ci
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

网页在自己目录执行 `npm ci`、`npm run test:public-config`、
`node node_modules/typescript/bin/tsc --noEmit`、`npm run lint`、`npm run build:cloudflare`，
再运行普通/Toy 打包并检查三项公开参数及资源 SHA。
使用 `example.invalid` 合成域名，不调用 `deploy:cloudflare` 发布线上内容。

拿到完整封存引擎后按 [Linux 安装第 4 步](linux-install.md#4-取得兼容的-linux-引擎)
编译，并用 `ops.py preflight` 检查。缺资源时写明缺项，不填引擎测试成功。
接着可在隔离配置下执行本机 TCP/WSS 与合成对局；正式卡池和特殊房间代码需对照旧服确认。
生产 systemd/reboot、公开 DNS/TLS、机器人平台权限、Windows 桌面和真人动画检查仍按
[验收表](validation.md) 单独记录。

## 5. 可直接交给云端的任务说明

```text
按 srvprotianti/ops/docs/codex-cloud-testing.md 执行隔离 Linux/PG17 验证。
先记录真实 OS、CPU、Node、PG客户端/服务端、各repo分支和代码状态。
只创建新临时loopback cluster、合成库和合成录像，不访问正式数据库或私密配置。
依次运行服务端完整检查、schema真实PG演练、运维联合恢复、网页构建和两类打包。
资源齐全再编译固定YGOPro引擎；缺项单独报告，不替换成浮动上游版本。
保留命令退出码、内容/序列/文件SHA、维护与错误目标拒绝检查的报告。
不发布网站、不推送分支、不自动重置积分/连胜、不清理未知目录。
用表格分别列已通过、未执行和失败项；停止本任务创建的cluster。
```

保存测试证据并下载需要长期保留的材料；云端任务状态不代替代码仓库和备份。
本指南对实际生产部署覆盖范围的判断来自项目运行方式，云端通过后仍按具体测试环境解释结论。
