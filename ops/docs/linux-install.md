# 从全新 Linux 安装当前 1103 服务

**状态：路线 A（第 1–5 节与 6.1）已于 2026-11-15 在 Ubuntu 24.04.5 x86_64 虚拟机上由 AI 逐块首走通过，并经真实客户端完成 6.2 的私网对局验收；路线 B（Linux 批次）也已在实验 VM 上走通，并经真实客户端验证；真人照手册复现、正式服迁移尚未验证。**
仅支持空白 Ubuntu 24.04 LTS x86_64、Node 24.15.0、PostgreSQL 17，systemd 直接运行 Node，服务用户为 `srvpro`，不使用 PM2。
应用使用 Windows 同批 R4 `server-release.tar.gz`；本机编译 Linux 引擎二进制，再与交付资源组合。
与正式服引擎等价待核实，不阻塞候选 preflight、冒烟和真实客户端对局；不据此宣布正式切换。
Nginx/TLS/公网入口本阶段后置，不属于首走验收；网页、桌面助手和 Bot 分别交付。

先完成第 1–5.2 节的安装和维护工具准备，再按第 6 节做首轮私网对局；随后回到 5.2 排空停服、5.3 重启，最后按 6.2 复测新写入。
命令使用 Bash，每块自带变量，新终端也可继续。
“部署用户”是最初具有 sudo 权限的普通用户；“root”块先从该窗口执行 `sudo -i`，做完退出 root，回部署用户窗口。
srvpro 是 nologin 用户，通过 `sudo -u srvpro` 验证。不以 root 构建或运行 npm，不复制 Windows node_modules。
每块非零退出立即停在这里，保留输出和本节日志，不跳过检查。密码只用 `read -rs` 输入，不写进命令或历史，不启用 `set -x`。
配置、批次、日志和安装记录均为私有材料，不上传。

## 1. 取得材料并安装依赖

### 1.1 固定交接目录与 SHA 核对

维护者先把材料放到新机 `/srv/srvpro-input`，让部署用户可读；旧库批次只让 root 可读。
交接页写机器名、路线 A/B、文件相对路径/字节数/SHA-256/来源版本、端口和本批路径表。
不要求操作者从开发仓库制包、猜提交或自己挑旧服文件。

| 材料 | 固定位置与要求 |
| --- | --- |
| R4 应用与资源 | `server-release.tar.gz`、`server-release.tar.gz.manifest.json`，含 application、完整 Windows engine、四语 catalog |
| 运维材料 | 与本手册同一提交导出的完整 `ops/`，已展开，含 scripts/templates/docs/versions.json，清单逐文件覆盖 |
| Linux 源码 | `linux-build-input/linux-build-source.tar.gz`、`linux-build-input/manifest.json` |
| Node | `node-v24.15.0-linux-x64.tar.xz`、官方 `SHASUMS256.txt`，维护者取得并另在交接页记录 SHA |
| A 新装配置 | `linux.server.config.json`，从旧服完整生效配置生成，预填 Linux 路径、全部开关和维护状态，不含密码 |
| B 恢复材料（仅路线 B 必需） | 已展开的完整 `joint-batch/`，含 manifest、dump、release、files，由 root 保管；路线 A 没有它不算缺件 |
| 私有参数页 | `handover.md`，含实际配置连接位置、全部规则参数、域名/Origin、路径映射与差异理由，不含密码 |
| 校验清单 | `handover.tsv`，每行三列：字节数、SHA-256、相对路径，以 TAB 分隔，无表头；覆盖上述全部文件，清单自身大小/SHA 由独立交接页提供 |

**维护者怎样准备这批材料。** 本段面向维护者，不要求新机操作者制包。
应用用已发布的 R4 `server-release.tar.gz` 及其 manifest；`ops/` 用与本手册同一提交导出的版本。
两者提交可以不同，交接页分别写明应用制品来源与 ops/手册提交。
Windows 工作区检出是 CRLF，直接复制会把 CR 字节带入 Linux 的 unit 模板和脚本；必须从 Git 对象导出。
在可运行 Bash、Git、tar 和 Python 3 的维护者终端执行；交接目录为本批材料目录，ops 目标须不存在。

```bash
# 身份：维护者；工作目录：维护者的 srvprotianti 仓库根目录
set -euo pipefail
read -r -p 'Manual/ops commit: ' OPS_COMMIT
read -r -p 'Absolute handover directory: ' HANDOVER
test -d "$HANDOVER"
test ! -e "$HANDOVER/ops"
git -c core.autocrlf=false archive --format=tar "$OPS_COMMIT" ops | tar -x -C "$HANDOVER"
python3 - "$HANDOVER/ops" <<'PY'
import pathlib, sys
files = list(pathlib.Path(sys.argv[1]).rglob('*'))
bad = [str(p) for p in files if p.is_file() and b'\r' in p.read_bytes()]
assert not bad, 'CR bytes found: ' + repr(bad)
print('PASS ops: no CR bytes')
PY
```

成功：导出退出 0、无 CR 字节。失败保留目标，核对提交/文件，不从工作区补拷。
Node 固定从 `https://nodejs.org/dist/v24.15.0/` 取得 `node-v24.15.0-linux-x64.tar.xz` 和 `SHASUMS256.txt`，记录 URL、大小和 SHA。
官方同源摘要只防传输损坏；签名验证另行完成并记录，不能把同源 SHA 核对写成签名验证。
宿主用 deepmerge 将 `linux.server.config.json` 递归合并到 `data/default_config.json`，数组整体替换。
它是覆盖项，但必须显式写出全部布尔/数字开关的生效值，不能只交模板片段；字符串/路径也须按参数页核对。
按实际对象层次写键；`only_show_dbs` 下的 `news.cdb`、`pre-release.cdb` 是字面键，不按点拆层。
`handover.tsv` 覆盖目录内除自身外的全部文件，含 ops 每个文件、handover.md，以及路线 B 的 root 私有批次。
`handover.md` 不写自身 SHA；`handover.tsv` 自身大小和 SHA 只写在目录之外的独立交接页，经另一渠道交付。
清单使用普通文件的规范相对路径（不用 `./`、空路径段、TAB 或换行），材料目录不放符号链接。

维护者先用通用 `scp -r <本批交接目录> <部署用户>@<新机>:linux-handover-r4-1` 传到部署用户 HOME 的新中转目录。
路线 B 传输前先建立 0700 的私有中转父目录，并将 scp 目标改到该目录内的新子目录；源批次目录 0700、文件 0600，落地后由 root 保管。
在新机 root 窗口落地；`/srv/srvpro-input` 必须原先不存在（含悬空链接）。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
read -r -p 'Absolute staging directory in deploy HOME: ' STAGING
test -d "$STAGING"
test ! -e /srv/srvpro-input
test ! -L /srv/srvpro-input
cp -a "$STAGING" /srv/srvpro-input
chown -R root:root /srv/srvpro-input
find /srv/srvpro-input -path /srv/srvpro-input/joint-batch -prune -o -type d -exec chmod 0755 {} +
find /srv/srvpro-input -path /srv/srvpro-input/joint-batch -prune -o -type f -exec chmod 0644 {} +
if test -d /srv/srvpro-input/joint-batch; then
  find /srv/srvpro-input/joint-batch -type d -exec chmod 0700 {} +
  find /srv/srvpro-input/joint-batch -type f -exec chmod 0600 {} +
fi
```

成功：root 拥有，普通目录 0755、文件 0644，B 批次目录 0700、文件 0600。失败保留现场，不覆盖重跑。
中转副本也占磁盘空间；路线 B 落地核对后由维护者移除中转私有批次，避免部署用户保留旧库副本。

先核对清单本身，与独立交接页逐字符比较。只比对同目录内自带的摘要不构成独立交接核对。

```bash
# 身份：部署用户（可 sudo）；工作目录：/srv/srvpro-input
set -euo pipefail
cd /srv/srvpro-input
stat -c '%n %s bytes' handover.tsv
sha256sum handover.tsv
```

成功：大小和 SHA 与独立交接页完全相同。不同就停在这里，保留原件/输出，重新取得材料。
核对后进入 root 窗口，逐文件核对（包括 B 的私有批次）。清单须覆盖完整 ops 和批次，不能只列主归档。

```bash
# 身份：root（sudo -i）；工作目录：/srv/srvpro-input
set -euo pipefail
cd /srv/srvpro-input
test -s handover.tsv
python3 - <<'PY'
import pathlib
root = pathlib.Path('.')
listed = set()
for line in (root/'handover.tsv').read_text('utf-8').splitlines():
    fields = line.split('\t')
    assert len(fields) == 3, 'Expected bytes, SHA, relative path'
    size, digest, name = fields
    assert size.isascii() and size.isdigit(), 'Invalid file size'
    assert name and not name.startswith('/') and not any(p in ('', '.', '..') for p in name.split('/'))
    # Batch internals (empty logs, SQLite -wal) may legitimately be empty; delivered materials may not.
    assert int(size) > 0 or name.startswith('joint-batch/'), 'Empty material: ' + name
    assert name != 'handover.tsv' and name not in listed, 'Self entry or duplicate path: ' + name
    listed.add(name)
actual = set()
for p in root.rglob('*'):
    assert not p.is_symlink(), 'Unexpected symlink: ' + str(p)
    if p.is_file() and p.as_posix() != 'handover.tsv':
        assert p.stat().st_size > 0 or p.as_posix().startswith('joint-batch/'), 'Empty file: ' + str(p)
        actual.add(p.as_posix())
assert actual == listed, 'File set mismatch: ' + repr(sorted(actual ^ listed))
print('PASS exact file set:', len(actual), 'files (including B private batch when present)')
PY
while IFS=$'\t' read -r bytes digest relative || [[ -n "$bytes$digest$relative" ]]; do
  [[ "$bytes" =~ ^[0-9]+$ && "$digest" =~ ^[0-9a-fA-F]{64}$ ]]
  test -n "$relative"
  [[ "$relative" != /* && "/$relative/" != *'/../'* ]]
  test -f "$relative"
  test "$(stat -c %s -- "$relative")" = "$bytes"
  printf '%s  %s\n' "$digest" "$relative" | sha256sum --check --strict -
done < handover.tsv
test -f ops/scripts/ops.py
test -f ops/scripts/engine-source.py
test -f server-release.tar.gz.manifest.json
test -f linux-build-input/manifest.json
```

成功：全部 OK，无漏件；交付材料无零字节文件。`joint-batch/` 内的空日志、SQLite `-wal` 等可以为 0 字节，由清单与批次 manifest 共同核对。失败停在这里，查原交接页，不解包。
在 1 vCPU 实验机上，14,155 个文件的逐文件核对整块调用约 188 秒；耗时随文件数、CPU 和存储变化。调用方须放宽命令超时，为数分钟的核对留足预算，不能把调用超时当作材料校验失败。
以下目录名为本批固定值，无需填写提交占位符。

路线 B 只有在上述独立清单及逐文件核对全部通过、确认 `/srv/srvpro-input/joint-batch` 已落地后，才删除部署用户 HOME 内的私有中转副本。下块删除输入的整份中转目录；输入最初 scp 使用的目录，不输入 HOME 本身。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
read -r -p 'Absolute deploy HOME: ' DEPLOY_HOME
read -r -p 'Absolute staging directory to remove: ' STAGING
test "$(realpath -e -- "$DEPLOY_HOME")" = "$DEPLOY_HOME"
case "$DEPLOY_HOME" in /home/*) ;; *) echo 'Expected deploy HOME under /home; stop'; exit 1 ;; esac
test "$(realpath -e -- "$STAGING")" = "$STAGING"
case "$STAGING" in "$DEPLOY_HOME"/*) ;; *) echo 'Staging must be below deploy HOME; stop'; exit 1 ;; esac
test -d "$STAGING/joint-batch"
test -d /srv/srvpro-input/joint-batch
cmp -- "$STAGING/handover.tsv" /srv/srvpro-input/handover.tsv
rm -rf --one-file-system -- "$STAGING"
test ! -e "$STAGING"
```

成功：中转目录已删除，root 保管的落地材料仍在。路径断言或核对失败就停，不放宽守卫。

### 1.2 Ubuntu、APT、Node 与 PG17

回到部署用户窗口，仅在参数页指定新机执行；先核对机器、系统、架构和可用空间。
首走空白系统安装后根分区已用约 6.8G，走完第 1–5 节约 8.6G；其中构建工作目录约 0.4G、安装目录约 0.3G、交接材料两份约 0.15G。
开始前建议根分区可用空间不少于 10 GiB；交接页另有预算时以交接页为准，按其值调整下块 MIN_FREE_GIB。

```bash
# 身份：部署用户（可 sudo）；工作目录：/
set -euo pipefail
cd /
hostnamectl
. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 24.04
test "$(uname -m)" = x86_64
df -h / /srv "$HOME"
MIN_FREE_GIB=10
test "$(df -B1 --output=avail / | tail -n 1)" -ge "$((MIN_FREE_GIB * 1024 * 1024 * 1024))"
sudo apt-get update
sudo apt-get install -y ca-certificates curl git git-lfs python3 xz-utils file \
  build-essential pkg-config libevent-dev libsqlite3-dev liblzma-dev postgresql-common ufw
```

成功：系统匹配、磁盘符合交接页预算、APT 退出 0。失败停在这里，看 `/var/log/apt/term.log`、`/var/log/apt/history.log`，修复网络/空间后可重跑。
Nginx 在后置的入口阶段再安装；云安全组/私网隔离继续限制公网访问。

```bash
# 身份：部署用户（可 sudo）；工作目录：/srv/srvpro-input
set -euo pipefail
cd /srv/srvpro-input
NODE_VERSION=24.15.0
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
awk -v f="$NODE_ARCHIVE" '$2==f {print}' SHASUMS256.txt > "$HOME/srvpro-node.sha256"
test "$(wc -l < "$HOME/srvpro-node.sha256")" -eq 1
sha256sum --check "$HOME/srvpro-node.sha256"
test ! -e /opt/node24
sudo install -d -m 0755 /opt/node24
sudo tar --extract --xz --file "$NODE_ARCHIVE" --strip-components=1 --directory /opt/node24
export PATH=/opt/node24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
node --version
npm --version
python3 --version
git lfs version
```

成功：Node v24.15.0、Python 3.12+，其余版本写安装记录。SHA 失败停在这里；/opt/node24 已存在先核对，不覆盖半产物。
维护者来源/签名流程见 [Node 官方下载](https://nodejs.org/en/download)；补丁升级须记录并重新验收。

按 [PostgreSQL 官方 Ubuntu 安装说明](https://www.postgresql.org/download/linux/ubuntu/) 配 PGDG，显式安装 17。

```bash
# 身份：部署用户（可 sudo）；工作目录：/
set -euo pipefail
cd /
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt-get update
sudo apt-get install -y postgresql-17 postgresql-client-17
pg_lsclusters
sudo systemctl cat postgresql@17-main.service
sudo systemctl enable --now postgresql@17-main.service
/usr/lib/postgresql/17/bin/pg_isready -h 127.0.0.1 -p 5432 -t 3
sudo -u postgres /usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -c 'SHOW server_version;'
/usr/lib/postgresql/17/bin/pg_dump --version
/usr/lib/postgresql/17/bin/pg_restore --version
apt-cache policy postgresql-17 postgresql-client-17 postgresql-common
dpkg-query -W postgresql-17 postgresql-client-17 postgresql-common build-essential libevent-dev libsqlite3-dev liblzma-dev
```

成功：17 main 在 5432 online，accepting connections，服务端/客户端均为 17。保存实际 APT 来源/包版本。
APT 包和 PG17 小版本不冻结，更新后重新验收；迁机不顺便升 PG 大版本。源批次/pg_dump 也须为 17，PG18 dump 不降到 17。
实例名依据 [Ubuntu postgresql-common](https://manpages.ubuntu.com/manpages/noble/man1/pg_ctlcluster.1.html) 的 version-cluster 模板；现场用 pg_lsclusters/systemctl cat 核对。
实例不是 17-main 或端口不是 5432 就停在这里，让维护者同步改参数页、unit 和配置，不启动别的实例凑数。
PG 失败查 `journalctl -u postgresql@17-main.service`、`/var/log/postgresql/postgresql-17-main.log`。5432 不开放公网。

## 2. 校验、解包和构建

### 2.1 在部署用户目录解包 R4

```bash
# 身份：部署用户（可 sudo）；工作目录：部署用户 HOME
set -euo pipefail
cd "$HOME"
INPUT=/srv/srvpro-input
WORK="$HOME/srvpro-linux-work"
test ! -e "$WORK"
install -d -m 0700 "$WORK" "$WORK/reports"
python3 "$INPUT/ops/scripts/ops.py" verify-release --archive "$INPUT/server-release.tar.gz" | tee "$WORK/reports/verify-release.json"
python3 "$INPUT/ops/scripts/ops.py" unpack-release --archive "$INPUT/server-release.tar.gz" --destination "$WORK/release"
test -f "$WORK/release/application/package-lock.json"
test -f "$WORK/release/components/engine/ygopro.exe"
test -f "$WORK/release/components/engine/strings.conf"
test -d "$WORK/release/components/engine/script"
test -d "$WORK/release/components/catalog"
```

成功：校验退出 0、三个组件齐全。失败停在这里，保留 reports 和半产物；解包目标必须不存在。
原 Windows engine 留作核对，不改归档或 sidecar。

<a id="4-取得兼容的-linux-引擎"></a>

### 2.2 取得兼容的 Linux 引擎

本批归档有 13,781 个普通文件，包含 source/ocgcore、lua、Linux premake5、premake5.lua、gframe、premake、resource、基础 script 等。
没有 Git 历史、Linux 成品或正式服完整规则。顶层 manifest 记录 source、dependencyArchives、archiveBytes/archiveSha256、files 和未验证声明。
主仓 5e63f18fb6b9a6ddc651bc2e8847eec9689ccbff，Core e04144d62499c17d0cfa8313f9742434ef99c3a7；
归档 10,275,327 字节，SHA-256 `d6f2850c213b7c934622ce75224517539b6281eba9523d58c206f589a7343d79`。
这只标识本批候选输入，不证明正式 EXE 来源或规则等价。换批次由维护者更新整套材料。
下面复用 engine-source.py 安全解包函数，再按 manifest 校验完整文件集合/大小/SHA，不联网下载源码。

```bash
# 身份：部署用户（可 sudo）；工作目录：部署用户 HOME/srvpro-linux-work
set -euo pipefail
WORK="$HOME/srvpro-linux-work"
INPUT=/srv/srvpro-input
cd "$WORK"
python3 - "$INPUT" "$WORK" <<'PY'
import hashlib, importlib.util, json, pathlib, sys
inputs, work = map(pathlib.Path, sys.argv[1:])
sys.path.insert(0, str(inputs/'ops/scripts'))
spec = importlib.util.spec_from_file_location('engine_source', inputs/'ops/scripts/engine-source.py')
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)
manifest = json.loads((inputs/'linux-build-input/manifest.json').read_text('utf-8'))
versions = json.loads((inputs/'ops/versions.json').read_text('utf-8'))
assert manifest['source'] == versions['engine']['source'], 'Build source profile differs'
archive = inputs/'linux-build-input/linux-build-source.tar.gz'
assert archive.stat().st_size == manifest['archiveBytes']
assert hashlib.sha256(archive.read_bytes()).hexdigest() == manifest['archiveSha256']
destination = work/'engine-build'
source.extract_archive(archive, destination)
expected = {row['path']: row for row in manifest['files']}
actual = {p.relative_to(destination).as_posix(): p for p in destination.rglob('*') if p.is_file()}
assert actual.keys() == expected.keys(), 'Source inventory differs'
for name, path in actual.items():
    assert path.stat().st_size == expected[name]['bytes'], name
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected[name]['sha256'], name
print('Source files verified:', len(actual))
PY
```

成功：Source files verified: 13781。失败停在这里，保留 engine-build 和原错误，核对交接；换新工作目录，不覆盖。

```bash
# 身份：部署用户（可 sudo）；工作目录：部署用户 HOME/srvpro-linux-work/engine-build/source
set -euo pipefail
WORK="$HOME/srvpro-linux-work"
cd "$WORK/engine-build/source"
test -f ocgcore/ocgapi.cpp
test -f lua/src/lua.h
test -f gframe/config.h
chmod 0755 premake5
cp -a premake/. .
cp -a resource/. .
./premake5 gmake --use-simd=sse2 2>&1 | tee "$WORK/reports/premake.log"
make -C build -j2 config=release 2>&1 | tee "$WORK/reports/engine-build.log"
test -x bin/release/ygopro
file bin/release/ygopro
ldd bin/release/ygopro | tee "$WORK/reports/engine-ldd.log"
! grep -q 'not found' "$WORK/reports/engine-ldd.log"
sha256sum bin/release/ygopro | tee "$WORK/reports/linux-engine.sha256"
c++ --version
make --version
```

成功：构建退出 0，ELF x86-64、ldd 无缺库。Lua 默认以 C++ 编译交付源码，不换系统 C Lua。
本包没有 Irrlicht 源码；固定 premake5.lua 为 SERVER_MODE=true、SERVER_ZIP_SUPPORT=false，此模式只需 Lua/event/sqlite/lzma，不启用 ZIP reader 或图形构建选项。
失败停在这里，看 reports/premake.log、engine-build.log、engine-ldd.log；不把 EXE 改名。
修正系统开发包后可续跑构建；源码校验失败必须换新目录。

### 2.3 组合资源、构建应用并安装

engine.py assemble 要求基础脚本/可选 706 层为固定干净 Git 检出；此包无 Git 历史，R4 完整生效脚本也不是该工具的纯上游候选。
engine.py verify/smoke 又依赖 assemble 的 format 2 manifest，因此不能对本组合调用或伪造 manifest。
本路线复制已由 release manifest 校验的完整 engine，仅新增 Linux ELF；不需另找卡池/禁表/706 输入，不以基础源码脚本覆盖资源。
保留 script、expansions/script、specials（如有）、组合 utility、cards.cdb、lflist.conf、strings.conf 原字节；Windows EXE 仅作对照。
第 4 节用现有 ops.py preflight 和相同启动参数的独立原生 TCP 冒烟验候选，规则兼容交真实客户端验收。

```bash
# 身份：部署用户（可 sudo）；工作目录：部署用户 HOME/srvpro-linux-work/release/application
set -euo pipefail
WORK="$HOME/srvpro-linux-work"
RELEASE="$WORK/release"
APP="$RELEASE/application"
export PATH=/opt/node24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd "$APP"
test ! -e "$RELEASE/components/linux-engine"
cp -a "$RELEASE/components/engine" "$RELEASE/components/linux-engine"
test ! -e "$RELEASE/components/linux-engine/ygopro"
install -m 0755 "$WORK/engine-build/source/bin/release/ygopro" "$RELEASE/components/linux-engine/ygopro"
test ! -e ygopro
test ! -L ygopro
test ! -e plugins/card-catalog/databases
test ! -L plugins/card-catalog/databases
ln -s ../components/linux-engine ygopro
ln -s ../../../components/catalog plugins/card-catalog/databases
npm ci 2>&1 | tee "$WORK/reports/npm-ci.log"
npm run build 2>&1 | tee "$WORK/reports/npm-build.log"
python3 /srv/srvpro-input/ops/scripts/ops.py catalog-check --catalog "$RELEASE/components/catalog" --versions /srv/srvpro-input/ops/versions.json
node plugins/postgres-compat/deployment/schema.js check-contract
npm test 2>&1 | tee "$WORK/reports/npm-test.log"
test ! -e /srv/srvprotianti/releases/linux-r4-1
test ! -e /srv/srvprotianti-ops
sudo install -d -m 0755 /srv/srvprotianti /srv/srvprotianti/releases
sudo cp -a "$RELEASE" /srv/srvprotianti/releases/linux-r4-1
sudo cp -a /srv/srvpro-input/ops /srv/srvprotianti-ops
sudo chown -R root:root /srv/srvprotianti/releases/linux-r4-1 /srv/srvprotianti-ops
sudo find /srv/srvprotianti/releases/linux-r4-1 /srv/srvprotianti-ops \
  \( -type d -o -type f \) -exec chmod go-w {} +
WRITABLE=$(sudo find /srv/srvprotianti/releases/linux-r4-1 /srv/srvprotianti-ops \
  \( -type d -o -type f \) -perm /022 -print)
test -z "$WRITABLE"
```

成功：构建/查询库/契约/测试退出 0，安装到本批新目录，两棵树均无 group/other 可写的文件或目录。失败停在这里，看 reports；卡库装载失败查插件日志，不关闭插件绕过。
R4 来自 Windows，归档和 npm 产物可能带 group/other 写权限；chown 不改模式，安装后立即去写权限，保留执行位。
锁文件有 14 项来自 registry.npmmirror.com（实际从 cdn.npmmirror.com 下载），新机须能访问 registry.npmjs.org 和 npmmirror 两处。
`dtrace-provider` 安装脚本在 Linux 上走 stub，不产生原生模块属正常；npm ci 的审计漏洞数不是本步失败条件，迁机不顺手升级依赖。
B 的 R4 资源须与联合批次中在用资源逐文件一致；不同就停止，维护者交付匹配资源，不用新卡库覆盖历史批次。
没有重新制包；原 Windows manifest 不覆盖新 ELF。以后发布 Linux 组合制品须另做新归档、manifest 和审核。

## 3. 建角色、新库与恢复分支

### 3.1 四个数据库身份与运维凭据

| 身份 | 密码与用途 |
| --- | --- |
| postgres | Ubuntu 默认由 OS postgres + peer 本机认证；本路线不设 TCP 密码，通过 sudo 建角色/库 |
| srvpro_schema | NOLOGIN，不设密码，拥有 schema/表/序列 |
| srvpro_runtime | 本节新设，游戏及运行账号验证使用，无建表/管理员权限 |
| srvpro_operator | 本节新设，备份/恢复/grant 使用，写 root 0600 ops.pgpass，不交给游戏 |

进入 root 窗口。目录/角色已存在就停，不能接管已用环境。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
test ! -e /etc/srvprotianti
install -d -m 0700 /etc/srvprotianti /etc/srvprotianti/reports /private-restores /private-backups
sudo -u postgres /usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -d postgres
```

成功：出现 postgres=#，在此提示符复制下一 SQL 块。失败停在这里，查 psql 原错误和 PG 日志。

```sql
CREATE ROLE srvpro_schema NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE srvpro_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE srvpro_operator LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT srvpro_schema TO srvpro_operator;
\q
```

成功：三次 CREATE ROLE、一次 GRANT，回到 root shell。下面设置两个新密码，记进密码管理器。
输入只放临时环境和管道，SQL 不进入 shell 历史或进程参数；passfile 特殊字符自动转义。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
umask 077
trap 'unset RUNTIME_PASSWORD OPERATOR_PASSWORD' EXIT
read -rs -p 'New PostgreSQL runtime password: ' RUNTIME_PASSWORD; printf '\n'
read -rs -p 'New PostgreSQL operator password: ' OPERATOR_PASSWORD; printf '\n'
export RUNTIME_PASSWORD OPERATOR_PASSWORD
python3 - <<'PY' | sudo -u postgres /usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -d postgres
import os
print('SET standard_conforming_strings = on;')
for role, key in [('srvpro_runtime', 'RUNTIME_PASSWORD'), ('srvpro_operator', 'OPERATOR_PASSWORD')]:
    value = os.environ[key]
    assert value and not any(c in value for c in '\r\n\x00'), 'Invalid password'
    print("ALTER ROLE " + role + " PASSWORD '" + value.replace("'", "''") + "';")
PY
python3 - <<'PY'
import os
value = os.environ['OPERATOR_PASSWORD'].replace('\\', '\\\\').replace(':', '\\:')
with open('/etc/srvprotianti/ops.pgpass', 'x', encoding='utf-8') as f:
    f.write('127.0.0.1:5432:*:srvpro_operator:' + value + '\n')
os.chmod('/etc/srvprotianti/ops.pgpass', 0o600)
PY
unset RUNTIME_PASSWORD OPERATOR_PASSWORD
```

成功：两次 ALTER ROLE，ops.pgpass 为 root 0600。失败停在这里，查原错误，不打印密码或文件内容；已成功创建的角色不重建。
轮换密码由维护者在维护窗口同步更新 passfile/实际运行配置，不覆盖不明旧文件。

### 3.2 A：没有旧数据

只走 A 或 B 其中一条。A 保持 [空库初始化](database-init.md#角色与空库) 的 libc C locale。
先进入 psql，再复制 SQL。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
sudo -u postgres /usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -d postgres
```

成功：postgres 提示符；失败停在这里，查 PG 日志。

```sql
CREATE DATABASE srvpro_1103 OWNER srvpro_schema TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C';
\connect srvpro_1103
ALTER SCHEMA public OWNER TO srvpro_schema;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE srvpro_1103 TO srvpro_runtime, srvpro_operator;
\q
```

成功：建库与授权完成。然后仅对该新空库执行 init：

```bash
# 身份：root（sudo -i）；工作目录：/srv/srvprotianti/releases/linux-r4-1/application
set -euo pipefail
APP=/srv/srvprotianti/releases/linux-r4-1/application
export PATH=/opt/node24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator PGPASSFILE=/etc/srvprotianti/ops.pgpass
cd "$APP"
node plugins/postgres-compat/deployment/schema.js check-contract
PGOPTIONS='-c role=srvpro_schema' node plugins/postgres-compat/deployment/schema.js init \
  --database srvpro_1103 --runtime-role srvpro_runtime --confirm-empty srvpro_1103 \
  --report /etc/srvprotianti/reports/schema-init.json
printf 'srvpro_1103\n' > /etc/srvprotianti/database-name
```

成功：退出 0，报告 ok:true。失败停在这里，看报告和 PG 日志；仅报告写失败时库可能已初始化，先 verify，不清库或重复 init。
`schema.js` 的 `DeprecationWarning: pgpass support is deprecated ...` 属预期，不是失败。
此后跳到 3.4，不执行 B。

### 3.3 B：导入已有数据

跳过 A 和 init。先核对批次，目标名必须与源库不同；源批次保持不动。
若只验证恢复而保留现有服务，先阅读本节的“只做恢复验证、不切换服务”分支，使用其中的新库名和新目录；不要先执行默认恢复块或写入服务选库文件。
恢复机的 `ops/` 不得旧于生成批次的工具，并须包含行摘要及文件清单顺序修复；先按 [摘要格式与旧批次](backup-restore.md#摘要格式与旧批次) 核对工具版本。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
BATCH=/srv/srvpro-input/joint-batch
OPS=/srv/srvprotianti-ops/scripts/ops.py
python3 "$OPS" verify --batch "$BATCH"
python3 - "$BATCH/manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1], encoding='utf-8'))
print('batch:', m['batchId'], 'source:', m['sourceDatabase'], 'dump major:', m['pgDumpMajor'])
assert m['pgDumpMajor'] == 17, 'This route needs a PG17 dump'
assert m['sourceDatabase']['serverVersionNum'] // 10000 == 17, 'This route needs a PG17 source'
assert m['sourceDatabase']['database'] != 'srvpro_restore_1103', 'Choose another NEW target name'
PY
sudo -u postgres /usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -d postgres
```

成功：校验退出 0、版本符合，进入 postgres 提示符。失败停在这里，查源批次，不改 manifest。
以本批 manifest 的 `sourceDatabase` 中实际编码、collate/ctype 为准，不从来源操作系统推断 locale；provider/datlocale 未记录时须由维护者补齐源端信息。
已验证两类样本：源 C/C → 目标内置 C.UTF-8；以及正式库副本的 `Chinese (Simplified)_China.936` → 目标内置 C.UTF-8。后者的恢复与内容核对通过，但这不等于排序验收。Windows 的中文 locale 名称不能直接用于 Linux。
目标用 PG17 内置 provider，不依赖 OS locale，升级 glibc 不会改变其排序并使索引失效。
**先建库再 restore**，复制以下 SQL：

```sql
CREATE DATABASE srvpro_restore_1103 OWNER srvpro_schema
  LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'
  ENCODING 'UTF8' TEMPLATE template0;
\connect srvpro_restore_1103
ALTER SCHEMA public OWNER TO srvpro_schema;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE srvpro_restore_1103 TO srvpro_runtime, srvpro_operator;
\q
```

成功：建库与授权完成。目标采用内置 C.UTF-8 排序，名称顺序是否变化须与实际源库比较；已验证 C/C 样本的排序差异已由维护者接受。
中文 locale 源库须用实际数据另行核对排序、唯一性、大小写转换/模式查询和排行榜分页，接受后才能开放。正式库副本的实测是：按名字排序的结果几乎全部改变，排行榜里主排序值相同的并列条目先后改变、前 10 名不变（数字见 [验收记录](validation.md#2026-11-16-正式库副本迁移演练windows--linux)）；是否接受仍由维护者在回执中写明。依据见 [PG17 建库参数](https://www.postgresql.org/docs/17/sql-createdatabase.html)、[内置排序](https://www.postgresql.org/docs/17/collation.html#COLLATION-MANAGING-STANDARD)。

ops.py restore **不建库**：先连接目标，要求无用户对象/无其他连接；目标名须不同于源名，confirm-new-database 须完全匹配，输出目录须不存在。
operator 没有 CREATEDB；继承 schema owner，以 no-owner/no-acl/role=srvpro_schema 恢复，然后 grant/verify。
工具不因 locale 不同自动拒绝，也不自动接受业务排序差异；全表内容摘要使用 COLLATE C 排序。

```bash
# 身份：root（sudo -i）；工作目录：/srv/srvprotianti/releases/linux-r4-1/application
set -euo pipefail
APP=/srv/srvprotianti/releases/linux-r4-1/application
BATCH=/srv/srvpro-input/joint-batch
RESTORE=/private-restores/batch1
export PATH=/opt/node24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator PGPASSFILE=/etc/srvprotianti/ops.pgpass
cd "$APP"
python3 /srv/srvprotianti-ops/scripts/ops.py restore --batch "$BATCH" \
  --destination "$RESTORE" --database srvpro_restore_1103 --confirm-new-database srvpro_restore_1103 \
  --owner-role srvpro_schema --runtime-role srvpro_runtime \
  --schema-tool "$APP/plugins/postgres-compat/deployment/schema.js" --pg-bin /usr/lib/postgresql/17/bin
printf 'srvpro_restore_1103\n' > /etc/srvprotianti/database-name
python3 - <<'PY'
import json, pathlib, sys
r = json.load(open('/private-restores/batch1/restore-result.json', encoding='utf-8'))
assert all(r[key] is True for key in ('complete', 'databaseAndFilesVerified', 'replayAssociationsVerified'))
print('databaseStateVerification:', r['databaseStateVerification'])
sys.path.insert(0, '/srv/srvprotianti-ops/scripts')
import ops
old = pathlib.Path('/private-restores/batch1/release/components')
new = pathlib.Path('/srv/srvprotianti/releases/linux-r4-1/components')
for name in ['engine', 'catalog']:
    assert ops.content_entries(ops.inventory(old/name)) == ops.content_entries(ops.inventory(new/name)), 'R4/batch resource mismatch: ' + name
print('Restore complete; inspect restore-map.json before copying private files')
PY
```

成功：退出 0，报告三项 true，完整表/内容/序列/录像关联与源批次一致，批次 release 的 engine/catalog 与交付 R4 相同。另核对 `databaseStateVerification` 的算法与匹配的记录行尾，含义见 [摘要格式与旧批次](backup-restore.md#摘要格式与旧批次)。

**运行组件核对。** 内嵌 release 相同不代表运行组件相同。若批次另有 engine/catalog 运行组件，按本批路径表对 `runtime/engine`、`runtime/catalog` 的相对文件名、大小和 SHA 逐项比较：Linux 批次的 engine 对照本轮 `components/linux-engine`（含新编译 ELF 与完整资源）；Windows 批次的 engine 对照本轮 `components/engine`，不以 Windows 二进制覆盖 Linux ELF。catalog 对照本轮 `components/catalog` 的全部 CDB。SQLite 的 `.cdb-wal`/`.cdb-shm` 仅在恢复证据中保留，不复制到运行目录；除这些边车外的缺件、多件或内容差异都须停下核对，不能静默忽略。没有独立运行组件时，使用已核对的 release 资源与本机编译的 Linux ELF。来源、构建开关和规则等价仍按第 2 节与参数页验收。
失败停在这里，看 restore-result.json 的 `failureCategory` 及受控差异信息，再看 schema-verification.json、PG 日志和原错误。
失败保留新库/目录，换全新库名及新目录重试，不 DROP、清空或复用半恢复目标。
额外 owner/扩展/tablespace 不由这套角色自动覆盖，报错交维护者处理。

**只做恢复验证、不切换服务。** 在已有实例上验证时，另建全新不同名空库与全新恢复目录，不执行上面写 `/etc/srvprotianti/database-name` 的命令，不执行第 4、5 节对运行配置和服务的操作。先按本节建库 SQL 将目标名全部改为 `srvpro_drill_restore_1103`，再执行：

```bash
# 身份：root（sudo -i）；工作目录：/srv/srvprotianti/releases/linux-r4-1/application
set -euo pipefail
APP=/srv/srvprotianti/releases/linux-r4-1/application
BATCH=/srv/srvpro-input/joint-batch
RESTORE=/private-restores/restore-check1
DATABASE=srvpro_drill_restore_1103
export PATH=/opt/node24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator PGPASSFILE=/etc/srvprotianti/ops.pgpass
cd "$APP"
test ! -e "$RESTORE"
test ! -L "$RESTORE"
python3 /srv/srvprotianti-ops/scripts/ops.py restore --batch "$BATCH" \
  --destination "$RESTORE" --database "$DATABASE" --confirm-new-database "$DATABASE" \
  --owner-role srvpro_schema --runtime-role srvpro_runtime \
  --schema-tool "$APP/plugins/postgres-compat/deployment/schema.js" --pg-bin /usr/lib/postgresql/17/bin
python3 - "$RESTORE/restore-result.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1], encoding='utf-8'))
assert all(r[key] is True for key in ('complete', 'databaseAndFilesVerified', 'replayAssociationsVerified'))
print('databaseStateVerification:', r['databaseStateVerification'])
PY
```

成功判据和失败保留规则与上面相同。后续五条查询也须显式连接这个隔离库，并使用新的报告路径；3.4 将读 database-name 的赋值行替换为 `DATABASE=srvpro_drill_restore_1103`，报告另存 `/etc/srvprotianti/reports/schema-runtime-check1.json`。不读写服务选库文件、不改运行配置或重启服务，这样只验证新库，不改变正在运行实例的连接；恢复扫描仍会占用同机资源。此验证不包含新库上的游戏实例或真实客户端验收。

恢复后、启动游戏前，运行下面五条只读核对查询：

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator PGPASSFILE=/etc/srvprotianti/ops.pgpass
PGOPTIONS='-c default_transaction_read_only=on' /usr/lib/postgresql/17/bin/psql -X \
  -v ON_ERROR_STOP=1 -d srvpro_restore_1103 -o /etc/srvprotianti/reports/locale-check.txt
```

成功：psql 提示符；查询输出写 locale-check.txt。失败停在这里，查连接/权限和 PG 日志。

```sql
BEGIN READ ONLY;
SELECT datname, datlocprovider, datlocale, pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database();
SELECT (SELECT count(*) FROM public."user") AS accounts, (SELECT count(*) FROM public.ladder_user) AS ladder_users, (SELECT count(*) FROM public.ladder_match) AS matches, (SELECT count(*) FROM public.duel_log) AS duels;
SELECT name, "displayName" FROM public.ladder_user ORDER BY name LIMIT 20;
SELECT value FROM (VALUES ('中文'), ('阿'), ('中'), ('A'), ('a'), ('é'), (' e'), ('e ')) AS samples(value) ORDER BY value;
SELECT name, count(*) FROM public.ladder_user GROUP BY name HAVING count(*) > 1;
COMMIT;
\q
```

成功：provider=b、locale=C.UTF-8、UTF8；行数与批次对应表一致；重复查询 0 行。
操作者审阅真实名称和混合字符排序，并在后续页面验收排行榜分页/名称查询。
回执附 locale-check.txt、检查人/时间，并写 **“排序差异已接受”**。未接受就停，不开放入房。
restore 完整性通过不能代替此接受记录。

### 3.4 A、B 都要验证运行账号

部署时数据库名从所选路线的文件读取，避免新终端误连另一条路线；只做恢复验证时按 3.3 显式设置 DATABASE 和独立报告路径，不读取该文件。输入新机 runtime 密码。
`schema.js` 的 `DeprecationWarning: pgpass support is deprecated ...` 属预期，不是失败。

```bash
# 身份：root（sudo -i）；工作目录：/srv/srvprotianti/releases/linux-r4-1/application
set -euo pipefail
APP=/srv/srvprotianti/releases/linux-r4-1/application
DATABASE=$(cat /etc/srvprotianti/database-name)
export PATH=/opt/node24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_runtime
unset PGPASSFILE PGOPTIONS
cd "$APP"
trap 'unset PGPASSWORD' EXIT
read -rs -p 'PostgreSQL runtime password: ' PGPASSWORD; printf '\n'
export PGPASSWORD
test -n "$PGPASSWORD"
node plugins/postgres-compat/deployment/schema.js verify --database "$DATABASE" \
  --runtime-role srvpro_runtime --report /etc/srvprotianti/reports/schema-runtime.json
unset PGPASSWORD
```

成功：退出 0、ok:true，警告逐项审阅。失败停在这里，查报告/PG 日志/角色权限，不开启 synchronize 修库。

## 4. 配置与普通服务账户

### 4.1 目录与参数页

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
if getent passwd srvpro >/dev/null; then echo 'srvpro already exists; stop'; exit 1; fi
useradd --system --user-group --no-create-home --home-dir /srv/srvprotianti --shell /usr/sbin/nologin srvpro
chown root:root /srv/srvprotianti /srv/srvprotianti/releases
chmod 0755 /srv/srvprotianti /srv/srvprotianti/releases
SHARED=/srv/srvprotianti/shared
test ! -e "$SHARED"
install -d -m 0750 -o srvpro -g srvpro "$SHARED"
for name in config replays tournament-decks tournament-logs deck_log logs privatePluginConfigs privatePluginConfigs/postgres-compat; do
  install -d -m 0750 -o srvpro -g srvpro "$SHARED/$name"
done
```

成功：srvpro 为 nologin 系统账户、目录齐全。失败停在这里，看 getent/stat 和原错误，不重复 useradd。

**配置等价。** A 必须用维护者从旧服完整生效配置生成的 linux.server.config.json，不只复制公共模板片段。
至少核对全部布尔/数字开关：side_timeout、random_duel.*、tournament_mode.*、http.*、mysql.enabled、reconnect、heartbeat_detection。
正式服 modules.side_timeout=3 分钟；遗漏会落回默认值，换备受 random_duel.hang_timeout=90 秒约束，可能被请出房间。
差异逐项消除或记在参数页；B 从完整恢复配置改连接和路径，不用新装模板覆盖。

| 字段 | 参数页样例（Linux 私网，以本批交付为准） |
| --- | --- |
| port / version / alternative_versions | 7911 / 4962 / [] |
| modules.stop / modules.welcome | 服务器维护中，请稍后重试。 / 1103 Tianti |
| modules.trusted_proxies | [127.0.0.1/32, ::1/128] |
| modules.side_timeout | 3 分钟，核对旧服完整生效值 |
| modules.tournament_mode | enabled=false、deck_check=true、show_ip=true、show_info=true |
| modules.tournament_mode.deck_path | /srv/srvprotianti/shared/tournament-decks/ |
| modules.tournament_mode.replay_path | /srv/srvprotianti/shared/replays/ |
| modules.tournament_mode.log_save_path | /srv/srvprotianti/shared/tournament-logs/ |
| modules.deck_log | enabled=false、local=/srv/srvprotianti/shared/deck_log/ |
| modules.http | port=7922、show_ip=true、show_info=true、public_roomlist=true、websocket_roomlist=true |
| modules.neos | enabled=true、port=7977、trusted_proxy_header=x-forwarded-for |
| modules.webhook.enabled / modules.update_util.enabled | false / false |
| modules.dialogues / modules.tips | 均为 enabled=false、get=false |
| hostinfo | lflist=0、rule=0、mode=0、duel_rule=2、no_check_deck=false、no_shuffle_deck=false、start_lp=8000、start_hand=5、draw_count=1、time_limit=180、no_watch=false、auto_death=false |

样例只说明字段，不照抄；实际值只取自参数页。
shared 路径保留末尾 `/`，宿主有字符串拼接。从 Windows 恢复必须改四个字段：
modules.tournament_mode.deck_path/replay_path/log_save_path、modules.deck_log.local。
其余插件私有配置里的 C:/...、盘符/反斜杠路径由维护者在映射表逐项说明，不全局替换所有字符串。

### 4.2 A：放置新装配置

A 执行本节；B 跳过两个块，转 4.3。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
SHARED=/srv/srvprotianti/shared
test ! -e "$SHARED/config/config.json"
test ! -e "$SHARED/privatePluginConfigs/postgres-compat/config.json"
install -m 0600 -o srvpro -g srvpro /srv/srvpro-input/linux.server.config.json "$SHARED/config/config.json"
install -m 0600 -o srvpro -g srvpro /srv/srvprotianti-ops/templates/postgres-compat.config.example.json \
  "$SHARED/privatePluginConfigs/postgres-compat/config.json"
```

成功：两个文件存在且 root/srvpro 以外不可读。失败停在这里，核对源/目标，不覆盖。
A 用适配插件连接：主配置 mysql.enabled=false、插件 enabled=true；4.4 统一填 runtime 密码。
首次新装创建独立且只有 stop 权限的 maintenance HTTP 管理账号：

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
trap 'unset MAINTENANCE_PASSWORD' EXIT
read -rs -p 'New HTTP maintenance password: ' MAINTENANCE_PASSWORD; printf '\n'
export MAINTENANCE_PASSWORD
python3 - <<'PY'
import json, os, pwd
value = os.environ['MAINTENANCE_PASSWORD']
assert value and not any(c in value for c in '\r\n\x00')
target = '/srv/srvprotianti/shared/config/admin_user.json'
payload = {'file': './config/admin_user.json', 'permission_examples': {}, 'users': {
    'maintenance': {'password': value, 'enabled': True, 'permissions': {'stop': True}}}}
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as f:
    json.dump(payload, f, ensure_ascii=False, indent=2)
    f.write('\n')
account = pwd.getpwnam('srvpro')
os.chown(target, account.pw_uid, account.pw_gid)
PY
unset MAINTENANCE_PASSWORD
```

成功：创建管理账号。失败停在这里，查目标存在性/权限，不打印 admin_user.json，不覆盖旧账号。

### 4.3 B：恢复路线：本批路径表

先审阅 /private-restores/batch1/restore-map.json，组件名以本批实际 manifest 为准。
下表兼顾两种来源：Windows 批次（适配配置组件名 adapter-config），以及按 [计划模板](../templates/backup-plan.example.json) 从 Linux 实例做的批次（plugin-config、auth-logs）。
维护者须补全额外组件/可变资产。files/ 属源批次，runtime/ 才是恢复输出。

| 批次组件 | restore 输出位置 | Linux 目标 | 是否要改 |
| --- | --- | --- | --- |
| recordings | /private-restores/batch1/runtime/recordings/ | /srv/srvprotianti/shared/replays/ | 原样，保留中文文件名 |
| host-config | runtime/host-config/ | shared/config/ | 路径/维护状态/生效 DB 连接 |
| adapter-config（Windows 批次，如果有） | runtime/adapter-config/config.json | shared/privatePluginConfigs/postgres-compat/config.json | 在用时改 DB |
| plugin-config（Linux 批次，如果有） | runtime/plugin-config/ | shared/privatePluginConfigs/ | 在用时改 DB；与 adapter-config 不会同时出现 |
| auth-logs（如果有） | runtime/auth-logs/ | shared/logs/ | 内容原样，允许空日志 |
| tournament-decks、tournament-logs、deck-logs | runtime/各组件/ | shared/tournament-decks/、tournament-logs/、deck_log/ | 内容原样 |
| service-config、service-env、旧环境文件 | runtime/service-config/、service-env/ 等 | 只保留对照 | 不安装 Windows 服务定义，不复制旧启动环境；4.4 新建 server.env |
| 应用单文件组件（如 app-runtime-*） | runtime/各组件/ | 不复制 | 2.3 的 npm run build 会重新生成；R4 归档在 Windows 打包，生成的 JS 与 Linux 构建只差换行符 |
| 引擎/catalog/其它插件配置和可变资产 | 本批 restore-map 的实际位置 | 本批 release/shared 对应位置 | 逐文件核对资源，维护者预填映射；漏项停止 |

下块先检查全部目标，再复制，不覆盖。维护者交付前按本批实际组件增减 rows，必须在参数页解释不适用项；
缺少必需组件就停，不能用空目录冒充恢复完成。额外路径须先填进 rows 再执行。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
python3 - <<'PY'
import pathlib, shutil
source = pathlib.Path('/private-restores/batch1/runtime')
shared = pathlib.Path('/srv/srvprotianti/shared')
rows = [('recordings', shared/'replays'), ('host-config', shared/'config'),
        ('tournament-decks', shared/'tournament-decks'), ('tournament-logs', shared/'tournament-logs'),
        ('deck-logs', shared/'deck_log')]
# Windows batches name the adapter config adapter-config (one file); Linux batches built
# from the plan template use plugin-config (whole privatePluginConfigs) and auth-logs.
assert not ((source/'adapter-config').exists() and (source/'plugin-config').exists()), 'Two adapter config components'
optional = [('adapter-config', shared/'privatePluginConfigs/postgres-compat'),
            ('plugin-config', shared/'privatePluginConfigs'), ('auth-logs', shared/'logs')]
rows += [(name, target) for name, target in optional if (source/name).exists()]
copies = []
for name, target in rows:
    origin = source/name
    assert origin.is_dir(), 'Missing component: ' + name
    for p in origin.rglob('*'):
        assert not p.is_symlink(), 'Unexpected link'
        if p.is_file():
            dest = target/p.relative_to(origin)
            assert not dest.exists() and not dest.is_symlink(), 'Target exists: ' + str(dest)
            copies.append((p, dest))
for origin, dest in copies:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(origin, dest)
assert (shared/'config/config.json').is_file()
assert (shared/'config/admin_user.json').is_file()
print('Private files copied:', len(copies))
PY
```

成功：文件数符合路径表、旧配置与录像齐全。批次中没有文件的组件（如空的 tournament-decks、tournament-logs、deck-logs）不会通过上述逐文件复制在目标产生目录；这些运行目录由 4.1 预建，不是漏复制。
失败停在这里，查 restore-map/原错误；已部分复制不覆盖重跑，保留后换新目标。
恢复目录 release/ 是旧批次原件，不自动替换本轮 R4；引擎/查询库与 R4 不同须停，由维护者核对匹配交付。

### 4.4 数据库连接要改哪里、哪些密码是新机的

正式旧服使用主配置 config/config.json 的 modules.mysql.db（mysql.enabled=true、db.type=postgres），适配插件无私有配置。
另一种是 plugins/postgres-compat/config.json 的 connection，enabled=true。按参数页选择一处，不同时配置两套独立生效连接。
A 用适配插件模板；B 保持原连接方式。下块识别实际生效的连接，改新机 DB/密码/路径，其余字段保留。
适配插件启用时会在运行期把 modules.mysql.enabled 置为 true，宿主每次保存设置（例如切换维护）都会把合并后的完整配置写回 config.json；
因此走适配插件的实例备份后，主配置里常见 mysql.enabled=true 和默认占位的 mysql.db。下块以插件 enabled 为准，此时不改主配置的 mysql.db。
不靠宿主自动迁移环境变量；server.env 仅写 NODE_ENV，避免旧环境覆盖 JSON 连接。

| 账号 | 密码来源 |
| --- | --- |
| srvpro_runtime、srvpro_operator | 第 3 节新设 |
| postgres / OS srvpro | postgres 本机 peer；srvpro nologin 无密码 |
| HTTP 管理账号（含 maintenance） | A 本节新设；B 沿用 admin_user.json 中旧密码 |
| 玩家账号 | B 随数据库恢复，沿用原账号 |

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
DATABASE=$(cat /etc/srvprotianti/database-name)
export DATABASE
trap 'unset RUNTIME_PASSWORD DATABASE' EXIT
read -rs -p 'This machine PostgreSQL runtime password: ' RUNTIME_PASSWORD; printf '\n'
export RUNTIME_PASSWORD
python3 - <<'PY'
import json, os, pathlib
shared = pathlib.Path('/srv/srvprotianti/shared')
host = shared/'config/config.json'
adapter = shared/'privatePluginConfigs/postgres-compat/config.json'
h = json.loads(host.read_text('utf-8-sig'))
a = json.loads(adapter.read_text('utf-8-sig')) if adapter.exists() else None
modules = h['modules']
plugin = a is not None and a.get('enabled') is True
# The adapter forces modules.mysql.enabled=true at runtime and the host persists it on any
# settings save, so an enabled adapter wins over the main-config switch.
legacy = not plugin and modules.get('mysql', {}).get('enabled') is True
assert legacy or plugin, 'No declared database connection'
print('Database connection declared in:', 'postgres-compat plugin' if plugin else 'main config modules.mysql.db')
connection = modules['mysql']['db'] if legacy else a['connection']
value = os.environ['RUNTIME_PASSWORD']
assert value and not any(c in value for c in '\r\n\x00')
connection.update(type='postgres', host='127.0.0.1', port=5432,
                  database=os.environ['DATABASE'], username='srvpro_runtime', password=value, synchronize=False)
if a is not None:
    a['synchronize'] = False
    a['environment'] = {key: '' for key in ['host', 'port', 'database', 'username', 'password']}
modules['stop'] = '服务器维护中，请稍后重试。'
paths = {'deck_path': 'tournament-decks', 'replay_path': 'replays', 'log_save_path': 'tournament-logs'}
for key, name in paths.items():
    modules['tournament_mode'][key] = str(shared/name) + '/'
modules['deck_log']['local'] = str(shared/'deck_log') + '/'
for path, payload in [(host, h)] + ([(adapter, a)] if a is not None else []):
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.chmod(path, 0o600)
print('Connection and four paths mapped; credentials not printed')
PY
test ! -e /etc/srvprotianti/server.env
printf 'NODE_ENV=production\n' > /etc/srvprotianti/server.env
chmod 0600 /etc/srvprotianti/server.env
unset RUNTIME_PASSWORD DATABASE
```

成功：连接/四路径更新、其它参数来自完整配置、server.env 为 root 0600。失败停在这里，查配置结构/参数页，不把密码文件贴入日志。
主配置 legacy 连接仍受 postgres-compat 安全策略约束 synchronize=false；不要另开第二套连接。
适配插件各连接字段的 environment 映射显式置空，覆盖其默认映射；实际连接只取本节 JSON，不从旧环境取密码。
其它 Windows 路径按本批表私下修正；回执逐项记配置等价结果，不能只写协议版本相同。

### 4.5 链接、最小权限与 replay

仍在 root 窗口。代码/资源 root 拥有，服务可写的只有 shared、config、日志和 Linux 引擎 replay 子目录。
config/logs 链接到 shared；适配配置链接只在确有文件时建立。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
APP=/srv/srvprotianti/releases/linux-r4-1/application
RELEASE=/srv/srvprotianti/releases/linux-r4-1
SHARED=/srv/srvprotianti/shared
for name in config logs; do
  test ! -e "$APP/$name"
  test ! -L "$APP/$name"
done
ln -s "$SHARED/config" "$APP/config"
ln -s "$SHARED/logs" "$APP/logs"
if test -f "$SHARED/privatePluginConfigs/postgres-compat/config.json"; then
  test ! -e "$APP/plugins/postgres-compat/config.json"
  test ! -L "$APP/plugins/postgres-compat/config.json"
  ln -s "$SHARED/privatePluginConfigs/postgres-compat/config.json" "$APP/plugins/postgres-compat/config.json"
fi
chown -R root:root "$RELEASE" /srv/srvprotianti-ops
find "$RELEASE" /srv/srvprotianti-ops -type d -exec chmod 0755 {} +
find "$RELEASE" /srv/srvprotianti-ops -type f -exec chmod a+r,u+w,go-w {} +
chmod 0755 "$RELEASE/components/linux-engine/ygopro"
chown -R srvpro:srvpro "$SHARED"
find "$SHARED" -type d -exec chmod 0750 {} +
find "$SHARED" -type f -exec chmod 0640 {} +
find "$SHARED/config" "$SHARED/privatePluginConfigs" -type f -exec chmod 0600 {} +
install -d -m 0750 -o srvpro -g srvpro "$RELEASE/components/linux-engine/replay"
chown srvpro:srvpro "$RELEASE/components/linux-engine/replay"
chmod 0750 "$RELEASE/components/linux-engine/replay"
test ! -e /srv/srvprotianti/current
test ! -L /srv/srvprotianti/current
ln -s "$APP" /srv/srvprotianti/current
sudo -u srvpro test -r "$APP/config/config.json"
sudo -u srvpro test -x /opt/node24/bin/node
sudo -u srvpro test -x "$APP/ygopro/ygopro"
sudo -u srvpro test -r "$APP/plugins/card-catalog/databases/cards.zh.cdb"
sudo -u srvpro test -w "$APP/config"
sudo -u srvpro test -w "$APP/logs"
sudo -u srvpro test -w "$APP/ygopro/replay"
sudo -u srvpro test ! -w "$APP"
sudo -u srvpro test ! -w "$APP/ygopro"
sudo -u srvpro test ! -w "$APP/ygopro/cards.cdb"
```

成功：全部 test 退出 0。失败停在这里，用 `namei -l /srv/srvprotianti/current/ygopro/replay`、stat 查父目录/目标，不 chmod 777。
**replay 必须存在且可写**：Windows 实测缺少它会在对局开始时引擎崩溃、客户端断开；Linux 也必须提前准备并实测。
replay 临时录像会增长，清理策略由维护者另定。
首走收紧后仍有约 116 个普通文件带执行位（多为 npm 包自带，另有归档里的 Windows EXE），不影响运行，本路线未做执行位最小化。
管理页面可变资产按 [部署 profile](../templates/deployment-profile.example.json) 的 mutablePluginAssets 单独映射 shared 并纳入备份，不给整个 plugins 写权；未映射前不宣称管理保存可用。

### 4.6 srvpro 身份 preflight 与原生冒烟

回到部署用户窗口：

```bash
# 身份：部署用户（可 sudo）；工作目录：/srv/srvprotianti/releases/linux-r4-1/application
set -euo pipefail
APP=/srv/srvprotianti/releases/linux-r4-1/application
RELEASE=/srv/srvprotianti/releases/linux-r4-1
cd "$APP"
sudo -u srvpro env PATH=/opt/node24/bin:/usr/bin:/bin python3 /srv/srvprotianti-ops/scripts/ops.py preflight \
  --platform linux --application "$APP" --engine "$RELEASE/components/linux-engine" \
  --catalog "$RELEASE/components/catalog" --versions /srv/srvprotianti-ops/versions.json
```

成功：preflight 退出 0，ELF/动态库/资源指纹/四语 CDB 通过。失败停在这里，查原错误/ldd/权限。
用 R4 原资源锁，不改正式锁凑通过；preflight 不读私有配置、不证明对局。
下块使用 engine.py smoke 相同启动参数，独立验证本组合，不要求专用 manifest。
原生进程身份 srvpro，15 秒内报告临时端口并可连接，然后终止该冒烟进程。

```bash
# 身份：部署用户（可 sudo）；工作目录：/srv/srvprotianti/releases/linux-r4-1/application
set -euo pipefail
cd /srv/srvprotianti/releases/linux-r4-1/application
sudo -u srvpro python3 - <<'PY'
import datetime, pathlib, queue, socket, subprocess, threading
engine = pathlib.Path('/srv/srvprotianti/releases/linux-r4-1/components/linux-engine')
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
log = pathlib.Path('/srv/srvprotianti/shared/logs')/('engine-smoke-' + stamp + '.log')
with log.open('x') as error:
    p = subprocess.Popen([str(engine/'ygopro'), '0', '0', '0', '0', 'F', 'F', 'F', '8000', '5', '1', '300', '0'],
                         cwd=engine, stdout=subprocess.PIPE, stderr=error)
    lines = queue.Queue()
    threading.Thread(target=lambda: lines.put(p.stdout.readline()), daemon=True).start()
    try:
        line = lines.get(timeout=15).strip()
        assert line.isdigit() and 0 < int(line) <= 65535, 'No valid engine port'
        with socket.create_connection(('127.0.0.1', int(line)), timeout=5):
            pass
        assert p.poll() is None, 'Engine exited during smoke'
        print('PASS native engine TCP smoke; log:', log)
    finally:
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(timeout=5)
        p.stdout.close()
PY
```

成功：PASS native engine TCP smoke，无残留冒烟进程。失败停在这里，看 shared/logs/engine-smoke-*.log、动态库/replay 权限；修外因后可重跑，保留旧日志。
这只证明原生启动与临时 TCP，不替代注册/TT/换备/结算/录像验收。

## 5. systemd、首次启动与开机恢复

### 5.1 安装与首次启动

[unit 模板](../templates/srvprotianti.service) 直接运行固定 Node，User/Group=srvpro，cwd=current，root 0600 EnvironmentFile 由 systemd 读取。
After/Wants 拉起并等待本机 postgresql@17-main.service；ExecStartPre 用 PG17 pg_isready，最多 30 次、间隔 2 秒、每次连接超时 1 秒，整体启动超时 100 秒。
就绪只证明 PG 可接连接，游戏所需插件/账号仍须检查。Restart=on-failure、RestartSec=5；KillMode=control-group 清理子引擎。

```bash
# 身份：部署用户（可 sudo）；工作目录：/
set -euo pipefail
cd /
UNIT=srvprotianti.service
test ! -e /etc/systemd/system/srvprotianti.service
sudo install -m 0644 /srv/srvprotianti-ops/templates/srvprotianti.service /etc/systemd/system/srvprotianti.service
sudo systemd-analyze verify /etc/systemd/system/srvprotianti.service
sudo systemctl daemon-reload
sudo systemctl enable --now "$UNIT"
# 三个端口须与参数页一致；恢复块也使用相同的等待和本次启动取证。
UNIT=srvprotianti.service
GAME_PORT=7911
HTTP_PORT=7922
WSS_PORT=7977
INVOCATION=$(sudo systemctl show "$UNIT" -p InvocationID --value)
test -n "$INVOCATION"
REPORT=$(sudo mktemp "/etc/srvprotianti/reports/start-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.log")
save_journal() {
  sudo journalctl -b -u "$UNIT" "_SYSTEMD_INVOCATION_ID=$INVOCATION" --no-pager -o cat \
    | sudo tee "$REPORT" >/dev/null
}
WAIT_STARTED=$SECONDS
CHECKS=0
READY=false
for ((attempt=0; attempt<=45; attempt++)); do
  CHECKS=$((CHECKS + 1))
  LISTEN=$(sudo ss -H -ltn)
  if awk '{print $4}' <<< "$LISTEN" | grep -E ":${GAME_PORT}$" >/dev/null \
    && awk '{print $4}' <<< "$LISTEN" | grep -E ":${HTTP_PORT}$" >/dev/null \
    && awk '{print $4}' <<< "$LISTEN" | grep -E ":${WSS_PORT}$" >/dev/null; then
    READY=true
    break
  fi
  if test "$attempt" -lt 45; then sleep 2; fi
done
printf 'Readiness checks: %s; elapsed: %s seconds\n' "$CHECKS" "$((SECONDS - WAIT_STARTED))"
save_journal
printf 'Full invocation journal (root 0600): %s\n' "$REPORT"
if test "$READY" != true; then
  sudo cat "$REPORT"
  echo 'Ports not ready within 90 seconds; stop'
  exit 1
fi
test "$(sudo systemctl show "$UNIT" -p InvocationID --value)" = "$INVOCATION"
sudo systemctl status --no-pager "$UNIT" postgresql@17-main.service
sudo ss -ltnp
sudo systemctl show "$UNIT" -p User -p MainPID -p ActiveEnterTimestamp -p ExecMainStartTimestamp -p NRestarts
sudo python3 - "$REPORT" <<'PY'
import json, re, sys
for line in open(sys.argv[1], encoding='utf-8'):
    try:
        record = json.loads(line)
    except ValueError:
        if re.search(r'warn|error', line, re.I):
            print(line.rstrip())
        continue
    if record.get('msg') in ('Plugin loaded', 'Card catalog loaded') or record.get('level', 0) >= 40 or 'server not open' in record.get('msg', ''):
        print(line.rstrip())
PY
sudo grep -Ec '"msg"[[:space:]]*:[[:space:]]*"Plugin loaded"' "$REPORT"
HTTP_STATUS=$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$HTTP_PORT/")
printf 'Local HTTP status: %s\n' "$HTTP_STATUS"
test "$HTTP_STATUS" = 200
```

成功：verify 无错误、两个 unit active，正确用户/cwd/脚本只有一份宿主，7911/7922/7977 按参数页监听，维护仍开启。
本次完整 journal 中 10 个插件各有一条 `Plugin loaded`：card-catalog、deck-classifier（目录名 deck_analysis）、ladder-core、ladder-analytics、ladder-usage-analytics、ladder-replay-enrichment、ladder-web、public-replay-web、public-room-web、postgres-compat。
若本批启用集合不同，以参数页为准逐一核对；块内 grep 直接统计 Plugin loaded，本批应为 10，只有总数相同不够。
`Card catalog loaded` 的 cards 非零、有 `NOTE: server not open due to config` 维护提示、无 level>=40 的应用日志，本机 HTTP 状态码为 200。
启动日志不含 metadataAvailable；该字段与四语装载使用 [实际插件装载](../../plugins/card-catalog/CARD_DATABASE_CONFIG.md#验证实际插件装载) 的独立验收命令：从本批 application 以 srvpro 身份运行，使用公共默认配置，不启动宿主、不读生产配置或 PG，也不是从运行进程读取状态。自定义卡库路径另验实际路径。
完整 journal 保存在 reports 下带时间戳的 root 0600 文件，仅取本次 invocation；屏幕显示插件/卡库/维护及 warn/error 行。
Node 输出到 stderr 的 `UnboundedCacheWarning`（lru-cache 的 TTL 提示）不是 JSON 日志，会被显示出来，属预期，不是失败。
等待每 2 秒一次，最多 90 秒；超时打印本次完整 journal 并非零退出，进程仍可能运行，先取证再按 5.4 处理。
失败停在这里，保留报告，按 5.4 定位；active/端口监听不能代替插件验收。
ProtectHome=true 不影响 /srv 中的运行文件，游戏不依赖部署用户 HOME。

### 5.2 维护工具、停写与联合备份

首次部署先准备维护工具，再去第 6 节做首轮私网验收；验收结束回本节进入维护、排空停服，再执行 5.3。
下面联合备份命令仅在本次确实要备份且已取得计划时执行。
复用 [维护开关操作](maintenance.md#维护开关操作) 的 Python 代码；从同批文档提取到 root 0600 文件，不含密码。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
python3 - <<'PY'
import os, pathlib
text = pathlib.Path('/srv/srvprotianti-ops/docs/maintenance.md').read_text('utf-8')
section = text.split('### 维护开关操作', 1)[1]
code = section.split('```python\n', 1)[1].split('\n```', 1)[0]
assert "stop_value = '服务器维护中，请稍后重试。'" in code
fd = os.open('/etc/srvprotianti/maintenance.py', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as f:
    f.write(code + '\n')
PY
```

成功：文件 root 0600。已存在就停在这里核对，不覆盖；提取失败查同批 maintenance.md 格式。
默认 HTTP 用户 maintenance；B 若没有该账号，维护者按原账号修改 username，不重建覆盖旧管理表。端口不同也须改 base 的本机端口。
下块通过 read -rs 提供口令，仅替代代码的 getpass 提示，不保存密码：

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
trap 'unset MAINTENANCE_PASSWORD' EXIT
read -rs -p 'HTTP maintenance password: ' MAINTENANCE_PASSWORD; printf '\n'
export MAINTENANCE_PASSWORD
python3 - <<'PY'
import getpass, os, runpy
getpass.getpass = lambda *args, **kwargs: os.environ['MAINTENANCE_PASSWORD']
runpy.run_path('/etc/srvprotianti/maintenance.py', run_name='__main__')
PY
unset MAINTENANCE_PASSWORD
```

成功：maintenanceEnabled=true、rooms=0、pendingCount=0、readyToStop=true 才继续停服。
未排空停在这里，等现有对局自然结束再重跑；查 journal 的 pending/录像/持久化告警，不踢玩家，不靠固定等待跳过。
文件默认进入维护；第 6 节隔离测试才临时改 stop_value 为字符串 'false'，测试完改回。
下块只停止游戏 unit；所有其它写库/录像/资产的 unit 须列入实际 backup-plan.writerUnits 并逐一停止，PG 保持运行。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
UNIT=srvprotianti.service
systemctl stop "$UNIT"
test "$(systemctl is-active "$UNIT" || true)" = inactive
systemctl show "$UNIT" -p MainPID -p ControlGroup -p Result
ss -ltnp
```

成功：inactive、MainPID=0，游戏端口不监听，同 cgroup 无宿主/子引擎。失败停在这里，看 journal，不开始备份。
首走无房间时停止在 1 秒内完成，Result=success、三个端口关闭，PG 保持运行；有房间先排空，不以此时间强行停服。
is-active 在 inactive 时非零属正常，块内已处理；failed 或 unit 不存在不能算停写成功。
备份前维护者按 [逐项状态清单](backup-restore.md#逐项状态清单) 和 [计划模板](../templates/backup-plan.example.json) 交付 root 0600 `/etc/srvprotianti/backup-plan.json`，填写真实 DB、归档、writerUnits、各组件。
新 ELF 与完整 Linux runtime、config/shared/可变资产须列入组件；只保存原 R4 归档会漏新 ELF。已核对仅差行尾的生成 JS 按逐项状态清单重建，无需逐个列组件。链接不作为组件源，列真实目标路径，组件不得重叠。
`releaseArchive` 必须指向真实归档文件，并有相邻的 `<归档文件名>.manifest.json`，不能填已展开目录。联合批次里的 `release.tar.gz` 配套文件名是 `release.manifest.json`；复用为下一次备份输入时，先在新的私有目录复制归档，并把清单副本命名为 `release.tar.gz.manifest.json`，不改原批次：

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
BATCH=/srv/srvpro-input/joint-batch
PREP=/private-backups/release-input1
test ! -e "$PREP"
test ! -L "$PREP"
install -d -m 0700 "$PREP"
cp -- "$BATCH/release.tar.gz" "$PREP/release.tar.gz"
cp -- "$BATCH/release.manifest.json" "$PREP/release.tar.gz.manifest.json"
chmod 0600 "$PREP/release.tar.gz" "$PREP/release.tar.gz.manifest.json"
cmp -- "$BATCH/release.tar.gz" "$PREP/release.tar.gz"
cmp -- "$BATCH/release.manifest.json" "$PREP/release.tar.gz.manifest.json"
```

成功后计划中的 `releaseArchive` 填 `/private-backups/release-input1/release.tar.gz`；工具仍会校验 sidecar 与归档成员。失败保留新目录，不覆盖重跑。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
export PATH=/opt/node24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator PGPASSFILE=/etc/srvprotianti/ops.pgpass
PLAN=/etc/srvprotianti/backup-plan.json
BATCH="/private-backups/1103-$(date -u +%Y%m%dT%H%M%SZ)"
test -f "$PLAN"
python3 /srv/srvprotianti-ops/scripts/ops.py backup --plan "$PLAN" --output "$BATCH" --pg-bin /usr/lib/postgresql/17/bin
python3 /srv/srvprotianti-ops/scripts/ops.py verify --batch "$BATCH"
```

成功：退出 0、无 FAILED.json。失败停在这里，保留批次和错误，查全部 writer 是否停写，不立刻恢复服务。
备份成功或维护者处理完失败现场后恢复运行：

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
systemctl start srvprotianti.service
# 三个端口须与参数页一致；恢复块也使用相同的等待和本次启动取证。
UNIT=srvprotianti.service
GAME_PORT=7911
HTTP_PORT=7922
WSS_PORT=7977
INVOCATION=$(sudo systemctl show "$UNIT" -p InvocationID --value)
test -n "$INVOCATION"
REPORT=$(sudo mktemp "/etc/srvprotianti/reports/start-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.log")
save_journal() {
  sudo journalctl -b -u "$UNIT" "_SYSTEMD_INVOCATION_ID=$INVOCATION" --no-pager -o cat \
    | sudo tee "$REPORT" >/dev/null
}
READY=false
for ((attempt=0; attempt<=45; attempt++)); do
  LISTEN=$(sudo ss -H -ltn)
  if awk '{print $4}' <<< "$LISTEN" | grep -E ":${GAME_PORT}$" >/dev/null \
    && awk '{print $4}' <<< "$LISTEN" | grep -E ":${HTTP_PORT}$" >/dev/null \
    && awk '{print $4}' <<< "$LISTEN" | grep -E ":${WSS_PORT}$" >/dev/null; then
    READY=true
    break
  fi
  if test "$attempt" -lt 45; then sleep 2; fi
done
save_journal
printf 'Full invocation journal (root 0600): %s\n' "$REPORT"
if test "$READY" != true; then
  sudo cat "$REPORT"
  echo 'Ports not ready within 90 seconds; stop'
  exit 1
fi
test "$(sudo systemctl show "$UNIT" -p InvocationID --value)" = "$INVOCATION"
sudo systemctl status --no-pager "$UNIT" postgresql@17-main.service
sudo ss -ltnp
sudo systemctl show "$UNIT" -p User -p MainPID -p ActiveEnterTimestamp -p ExecMainStartTimestamp -p NRestarts
sudo python3 - "$REPORT" <<'PY'
import json, re, sys
for line in open(sys.argv[1], encoding='utf-8'):
    try:
        record = json.loads(line)
    except ValueError:
        if re.search(r'warn|error', line, re.I):
            print(line.rstrip())
        continue
    if record.get('msg') in ('Plugin loaded', 'Card catalog loaded') or record.get('level', 0) >= 40 or 'server not open' in record.get('msg', ''):
        print(line.rstrip())
PY
sudo grep -Ec '"msg"[[:space:]]*:[[:space:]]*"Plugin loaded"' "$REPORT"
HTTP_STATUS=$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$HTTP_PORT/")
printf 'Local HTTP status: %s\n' "$HTTP_STATUS"
test "$HTTP_STATUS" = 200
```

成功：同 5.1 的三个端口、本次插件/卡库/维护日志、HTTP 200 判据全部通过，维护仍开启；首走恢复约 3–14 秒就绪，仅供参照。失败停在这里，看 journal；没有 Windows Stop/PM2 save/resurrect 步骤。

### 5.3 无人登录的开机自启验收

先完成第 6 节首轮私网客户端验收，再执行 5.2 的维护块确认排空；停全部 writer，游戏 inactive。确认两个 unit enabled，只重启参数页指定的新机：

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
systemctl is-enabled srvprotianti.service postgresql@17-main.service
test "$(systemctl is-active srvprotianti.service || true)" = inactive
date --iso-8601=seconds
reboot
```

成功：连接因新机 reboot 断开。失败停在这里，查 unit/journal，不重启其它机器。
**重启后不登录，至少等待 5 分钟。** 可从测试客户端私网观察游戏 TCP 端口，先不认证/开局。
等待后首次登录，在最初的部署用户 shell 执行；不要先 sudo -i，以免改变登录时间取证。

```bash
# 身份：部署用户（可 sudo）；工作目录：/
set -euo pipefail
cd /
LOGIN_SHELL_PID=$$
printf 'Boot: '; uptime -s
ps -p "$LOGIN_SHELL_PID" -o pid,lstart,args
last -F -n 12
SSH_JOURNAL=$(sudo journalctl -b -u ssh --no-pager)
# grep/head show the first Accepted records; awk drains input to avoid SIGPIPE with pipefail.
printf '%s\n' "$SSH_JOURNAL" | awk '/Accepted/ {if (++n <= 10) print}'
sudo systemctl status --no-pager srvprotianti.service postgresql@17-main.service
sudo journalctl -b -u postgresql@17-main.service -u srvprotianti.service --no-pager
sudo ss -ltnp
GAME_PID=$(systemctl show srvprotianti.service -p MainPID --value)
PG_PID=$(systemctl show postgresql@17-main.service -p MainPID --value)
test "$GAME_PID" -gt 0
test "$PG_PID" -gt 0
sudo ps -p "$GAME_PID","$PG_PID" -o user,pid,ppid,lstart,args
sudo systemctl show srvprotianti.service -p ExecMainStartTimestamp -p NRestarts
sudo readlink -f "/proc/$GAME_PID/cwd"
```

成功：PG/游戏在本次开机之后、首次登录 shell 之前创建，本次 boot journal 证明自动启动；cwd 为本批 application、用户 srvpro、端口正确。
last -F 不记录未分配终端的 SSH（自动化、ssh host cmd、scp），不能单独证明无人提前连接。
核对本次 boot 第一条 sshd Accepted 时间晚于游戏服务启动时间，先后应为：开机 → PG → 游戏服务 → 首次 SSH 连接；没有 Accepted 记录也不能据此证明无人登录。
首走从内核启动到应用监听约 19 秒，仅供参照；不能用后来新终端时间代替首次连接证据。
间隔几分钟再运行此块核对 MainPID 不变、NRestarts 不增加，维护仍开启；端口监听不能代替真实对局。
失败停在这里，保存 boot journal/进程时间/端口输出，不以手工 start 成功代替自启。
最后按第 6 节隔离解除维护，验证注册/结算/录像新写入，再重新排空。

### 5.4 常见失败与处理

| 现象 | 看哪里、怎么重来 |
| --- | --- |
| Permission denied、配置/卡库读不到 | namei -l 看父目录，sudo -u srvpro test -r/-x/-w；按 4.5 精确修 owner/mode，不给代码写权 |
| node: command not found、preflight 找不到 Node | 新终端定义 /opt/node24/bin 的 PATH；unit 用固定 PATH/绝对 ExecStart，不用个人 nvm |
| premake5 不能执行、Lua/头文件缺失 | file/执行位/premake.log；核对完整包，复制 premake/resource，装交接要求的开发包，再重跑构建 |
| 动态库加载失败、ldd not found | engine-ldd.log；补所需系统库后重做 preflight/冒烟，不换未知 binary |
| PostgreSQL readiness timeout、connection refused | PG unit status/journal、postgresql-17-main.log、pg_lsclusters；核对实例/端口后用下面恢复块 |
| 宿主 active 但 DB/必要插件失败 | game journal 的 postgres-compat/ladder/card-catalog 初始化；检查生效 DB 配置、runtime 密码和 schema-runtime 报告，修好后维护重启 |
| 对局开始断开、ygopro_process_exit | 先查 journal/冒烟日志/replay；按 4.5 补建并 chown/chmod，用 srvpro test -w，再测完整对局 |
| unit 203/EXEC、200/CHDIR、环境文件加载失败 | systemctl cat/status/journal；核对 /opt Node、current、cwd、root 0600 server.env，修后 verify/daemon-reload |
| Start request repeated too quickly | 保存 journal，修根因，再 reset-failed/start，不删除 unit 或放宽权限 |
| File exists、Destination must be NEW | 解包/链接/首次配置块仅首次执行；先核对现有目标，不用 -f；半产物换新目标并同步全部路径 |
| init requires empty、restore 有对象/连接 | 不清库强过；init 先 verify 看是否已成功；restore 保留失败新库/目录，换新名字，不先 init |
| locale 不支持、排序与旧服不同 | B 使用 PG17 builtin C.UTF-8，不复制 Windows 名称；审阅 3.3 样例/分页，未接受不开放 |

仅在已排空、游戏已停且根因已修复时执行下面恢复块；若还有对局先执行 5.2。

```bash
# 身份：部署用户（可 sudo）；工作目录：/
set -euo pipefail
cd /
sudo systemctl stop srvprotianti.service
sudo systemd-analyze verify /etc/systemd/system/srvprotianti.service
sudo systemctl daemon-reload
sudo systemctl reset-failed srvprotianti.service
sudo systemctl start srvprotianti.service
# 三个端口须与参数页一致；恢复块也使用相同的等待和本次启动取证。
UNIT=srvprotianti.service
GAME_PORT=7911
HTTP_PORT=7922
WSS_PORT=7977
INVOCATION=$(sudo systemctl show "$UNIT" -p InvocationID --value)
test -n "$INVOCATION"
REPORT=$(sudo mktemp "/etc/srvprotianti/reports/start-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.log")
save_journal() {
  sudo journalctl -b -u "$UNIT" "_SYSTEMD_INVOCATION_ID=$INVOCATION" --no-pager -o cat \
    | sudo tee "$REPORT" >/dev/null
}
READY=false
for ((attempt=0; attempt<=45; attempt++)); do
  LISTEN=$(sudo ss -H -ltn)
  if awk '{print $4}' <<< "$LISTEN" | grep -E ":${GAME_PORT}$" >/dev/null \
    && awk '{print $4}' <<< "$LISTEN" | grep -E ":${HTTP_PORT}$" >/dev/null \
    && awk '{print $4}' <<< "$LISTEN" | grep -E ":${WSS_PORT}$" >/dev/null; then
    READY=true
    break
  fi
  if test "$attempt" -lt 45; then sleep 2; fi
done
save_journal
printf 'Full invocation journal (root 0600): %s\n' "$REPORT"
if test "$READY" != true; then
  sudo cat "$REPORT"
  echo 'Ports not ready within 90 seconds; stop'
  exit 1
fi
test "$(sudo systemctl show "$UNIT" -p InvocationID --value)" = "$INVOCATION"
sudo systemctl status --no-pager "$UNIT" postgresql@17-main.service
sudo ss -ltnp
sudo systemctl show "$UNIT" -p User -p MainPID -p ActiveEnterTimestamp -p ExecMainStartTimestamp -p NRestarts
sudo python3 - "$REPORT" <<'PY'
import json, re, sys
for line in open(sys.argv[1], encoding='utf-8'):
    try:
        record = json.loads(line)
    except ValueError:
        if re.search(r'warn|error', line, re.I):
            print(line.rstrip())
        continue
    if record.get('msg') in ('Plugin loaded', 'Card catalog loaded') or record.get('level', 0) >= 40 or 'server not open' in record.get('msg', ''):
        print(line.rstrip())
PY
sudo grep -Ec '"msg"[[:space:]]*:[[:space:]]*"Plugin loaded"' "$REPORT"
HTTP_STATUS=$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$HTTP_PORT/")
printf 'Local HTTP status: %s\n' "$HTTP_STATUS"
test "$HTTP_STATUS" = 200
```

成功：active，同 5.1 的本次插件/卡库/维护日志、三个端口及 HTTP 200 判据全部通过。失败停在这里，保存 journal，不反复重试。
APT、只读 verify/preflight、维护操作、冒烟可重跑；构建可按日志续跑。
release/源码解包、restore、首次配置/链接/账户创建不能覆盖重跑；restore 必须换全新库和输出目录。

## 6. 私网、真实客户端与交付

### 6.1 防火墙与后置入口

按参数页输入 SSH 实际端口和测试客户端网段。先允许 SSH，再启用 ufw；保留原管理连接直到另开连接验证。
经 NAT 端口转发测试时，新机看到的客户端源地址是 NAT 网关（如 10.0.2.2，须现场核对），参数页测试网段要按新机实际看到的源地址填写。
用脚本逐条执行、无法保留原管理连接时，启用后立即新开连接验证 SSH，失败不要继续。

```bash
# 身份：部署用户（可 sudo）；工作目录：/
set -euo pipefail
cd /
read -r -p 'SSH port from handover page: ' SSH_PORT
read -r -p 'Test client private CIDR from handover page: ' TEST_CIDR
[[ "$SSH_PORT" =~ ^[0-9]+$ ]]
test "$SSH_PORT" -ge 1
test "$SSH_PORT" -le 65535
test -n "$TEST_CIDR"
GAME_PORT=7911
HTTP_PORT=7922
WSS_PORT=7977
sudo ufw allow "$SSH_PORT/tcp"
sudo ufw allow from "$TEST_CIDR" to any port "$GAME_PORT" proto tcp
sudo ufw allow from "$TEST_CIDR" to any port "$HTTP_PORT" proto tcp
sudo ufw allow from "$TEST_CIDR" to any port "$WSS_PORT" proto tcp
sudo ufw --force enable
sudo ufw status verbose
```

成功：SSH/私网规则符合参数页，测试客户端能连游戏端口。失败停在这里，看 ufw 输出、ss、上游/云安全组，不放开所有公网后端。
端口不同，执行前按参数页改块内三个变量。
Nginx 在入口阶段才安装；Nginx/TLS/WSS/Origin/真实 IP/证书续期和公网 DNS **本阶段后置，不属于首走验收**。
保留后续路线：[迁址](server-move.md)、[Nginx 模板](../templates/nginx.conf.example)。正式入口通常仅 TCP 7911 和 HTTPS/WSS 443，限制管理来源，不直接公网开放 7922/7977/5432。
原始游戏 TCP 域名用 DNS-only，普通 Cloudflare HTTP 代理不承载它；后置入口未完成不宣布公网部署成功。

### 6.2 真实验收与回执

确认仍在隔离网络，仅测试客户端可访问。root 私下编辑 /etc/srvprotianti/maintenance.py，将 stop_value 从维护提示改为字符串 'false'，运行 5.2 的维护密码块，确认 maintenanceEnabled=false 才测试入房。
测试结束改回维护提示，重跑并等 readyToStop=true，才停服/备份/reboot。

按 [验收与演练](validation.md) 顺序记录：必要插件和四语装载 → 新账号注册（B 另验旧账号/积分/历史）→ 普通房完整对局 → TT 全 Match/换备/一次结算与使用率 → 掉线重连/观战 → 旧录像播放/新录像写入下载 → 普通/特殊房代码与卡池限制。
重启前后均测新写入，记录 ELF SHA、Core/Lua 来源、构建开关和资源摘要；冒烟通过不能勾规则/对局验收。
首次验收结束回到 5.2 排空停服，按 5.3 做无人登录重启验收，再回本节复测；不要只做重启后的一轮就勾选前后均通过。
共享 PG、其它实例、Bot 不属于本 unit 的停止范围，不能靠停此 unit 宣称整机停写。
Bot 切换先停旧实例并移交去重状态，网页/桌面/证书/每日检查按 [上线后的交接](maintenance.md#上线后的交接与每日检查) 分别验收。

回执写操作者/主机/材料 SHA 与大小/APT 来源版本/数据路线/配置等价差异/卡住步骤时长/补充命令/报告和日志路径。
B 另附 restore-result、restore-map、schema-runtime、locale-check 和“排序差异已接受”。生产引擎等价、Nginx/TLS/公网分别标待核实/后置。
文档外补救先回填本手册，从干净快照重跑受影响步骤；AI 首走是预验收，用户按相同材料亲自复现与真实客户端结果分别填写。
