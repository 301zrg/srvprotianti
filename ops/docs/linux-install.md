本版对应脚本提交由 `ops/scripts/handover.py --commit <40位提交>` 导出时写入 `handover-params.json` 的 `opsCommit`；手册与脚本均取该提交的 Git blob。

# Linux 首次安装：按阶段运行与验收

适用 Ubuntu 24.04 x86_64、Node 24.15.0、PostgreSQL 17，固定发布名 linux-r4-1。路线 A 新库初始化，路线 B 在全新库/目录恢复联合批次。
脚本不替换版本锁，不代替真实客户端验收。公网 Nginx/TLS/WSS/Origin、DNS、证书续期、Bot 切换另按 [迁址](server-move.md)、[维护](maintenance.md)、[验收](validation.md) 执行。

## 操作者电脑：交接与传输

维护者在本地运行 `python ops/scripts/handover.py --repo REPO --commit COMMIT --materials MATERIALS --output NEW --params PARAMS`，可加 `--expected-config EXPECTED` 覆盖推导结果。
材料目录包含审核后的发布归档及 sidecar、Node 归档与 SHASUMS256.txt、linux-build-input、A 的 linux.server.config.json 或 B 的 joint-batch；工具不联网、不导出数据库。
参数须列机器名、部署 HOME 下中转路径、路线、端口、SSH 机内端口、实际测试源 CIDR、维护原文、全部 writerUnits、启用插件、extraMutableAssets（可空）。仅 A 填 `managementUsername: "maintenance"`。
期望配置含 `delivered`、`final`，各含 `host`、`adapter`（对象或 null）。生成器将归档默认配置与 A 交付配置或 B 批次 host-config 合并，读取 A 导出提交的适配模板或 B 批次的适配配置，再按 44 的规则推导 `final`。对象递归合并、数组替换、点键按字面处理，凭据值脱敏。覆盖文件使用相同结构。
输出 handover.tsv、handover.md、handover-params.json、expected-config.json；stdout 的“清单大小 + SHA”通过独立渠道发送给操作者，不能只在参数页取值。
输出必须新目录，部分输出保留，失败后换新目录，不覆盖源材料。原始私有配置不要贴到回执或公开日志。

只在操作者电脑传入目录。PowerShell：`scp -r NEW deploy@HOST:/home/deploy/NEW`；Bash：`scp -r ./NEW deploy@HOST:/home/deploy/NEW`。
替换机器/用户/路径；B 私有批次保持目录 0700、文件 0600。SSH 参数填新机监听端口，不填宿主 NAT 转发端口；测试 CIDR 按新机实际看到的源地址填写。

## 新机：入口、身份、续跑

首次部署用户登录，在交接目录的 ops/install/linux 下执行 `sudo bash install.sh run --staging /home/USER/NEW`。
H10-LAND 完成前，从原中转目录用首次命令续跑。落地完成后，在 `/srv/srvpro-input/ops/install/linux/` 执行 `sudo bash install.sh run`（resume 同义）。入口核对 root/SUDO_USER、系统与架构，单行展示机器名，内部切换部署用户、srvpro、postgres。
提示从 /dev/tty 读取，新口令输两遍、不回显、不进日志。A 新建 maintenance，使用维护工具时输入该账号口令。B 在新机的 52a 自动选取恢复出的账号，维护调用直接使用其口令。
`sudo bash install.sh status` 显示绑定、pending、当前检查点；状态和私有日志在 `/var/lib/srvprotianti-install/`（root 0700，文件 0600）。
看到 PASS 才完成，完成块续跑显示 SKIP。绑定变化立即停。pending 先做只读后置验证。首次动作若证实未开始，显示 `PROBE <块ID>: not started (proven)`，清除 pending 并按顺序续跑。其他动作返回 10 时显示 `PROBE <块ID>: not complete`。部分完成或无法判定时显示 `PROBE <块ID>: partial`，首次动作保留现场并停止。
完成的首次动作禁止重跑。账户、建库、restore、解包、复制、链接、unit 的现有目标禁止覆盖。禁止删状态重来、编辑 state.json 或整段重贴附录。
人工补救后 `sudo bash install.sh verify-block ID` 只读核验纳入状态；可重做块用 `sudo bash install.sh stage ID --redo`，列出并失效全部下游。
B 失败用 `sudo bash install.sh retarget --database NEW --restore-dir /private-restores/NEW [--shared /srv/srvprotianti/NEW]`，保留旧现场，全部目标必须全新。

## <a id="3-建角色新库与恢复分支"></a>第 1–3 节：交接、构建与数据库

下表的 stage 命令均加前缀 `sudo bash install.sh`；正常使用 run 自动串联，无需逐个执行。

| 阶段/命令 | 做了什么 | 成功看到什么 | 失败怎么办 |
| --- | --- | --- | --- |
| stage 10 | 落地、独立渠道大小/SHA、双格式清单/完整文件集；B 安全移除中转 | 参数确认且校验一致，PASS 10 | 核对源/目标/权限；清单不一致即停，不覆盖 |
| stage 12 | 系统/APT、固定 Node、PG17/5432 | 版本、ready、enabled 正确 | 查包/来源/空间；半 Node 目录保留 |
| stage 21 | 校验 R4，解压新工作目录 | 三组件与清单一致 | 保留半产物，不覆盖解压 |
| <a id="22-编译-linux-引擎"></a><a id="4-取得兼容的-linux-引擎"></a>stage 22 | 源码清单、普通用户编译 ELF、ldd/SHA | ELF/动态库正确 | 查 premake/编译日志，不换未知 binary |
| stage 23 | 普通用户组合资源、npm ci/build/test，root 安装 release/ops | 全部契约检查通过 | 查 WORK/reports；首次复制/链接不重跑 |
| stage 31 | owner/runtime/operator/schema 角色、授权、规定的 ops.pgpass | 角色/认证、0600 正确 | 不打印口令，部分角色保留人工核对 |
| stage 32（A） | 新库与 schema init | schema verify、选库文件通过 | init 报错先 verify，不清库 |
| <a id="33-b导入已有数据"></a>stage 33（B） | verify 批次、新库恢复、摘要/组件核对、五条 locale 查询 | 三标志 true；输入“排序差异已接受”，记录人/时间/批次/库 | 保留失败库/目录，retarget；排序分页留到 CP1 |
| stage 34 | 新机 runtime 认证与 schema verify | schema-runtime 通过 | 查角色/密码/库，认证可重新验证 |

## 第 4 节：配置、路径和原生检查

| 阶段/命令（同上前缀） | 做了什么 | 成功看到什么 | 失败怎么办 |
| --- | --- | --- | --- |
| stage 41 | 必需 expected-config；核对非游戏 writer；建 nologin srvpro、完整 shared | owner/mode 正确，PASS 41 | 缺期望/非游戏 unit 即停；游戏 unit 不提前安装 |
| stage 42（A） | 首次复制完整主配置和随包适配模板（如有），新建仅 stop 权限管理账号；按 `delivered` 比对 | 文件 srvpro 0600，实际差异有理由与批准人/时间 | 目标存在不覆盖，不用公共模板冒充完整配置 |
| <a id="43-b恢复路线本批路径表"></a>stage 43（B） | 全组件必需/可选、复制/重建/留证据分类；确认后映射，按 `delivered` 比对 | 旧配置/录像齐全、空目录预建、原件保留 | 未知/漏必需组件、adapter-config 与 plugin-config 同存即停；sidecar 不进运行目录、EXE 不覆盖 ELF |
| <a id="44-数据库连接要改哪里哪些密码是新机的"></a>stage 44 | 保持 B 连接方式，写新 runtime 密码/库/四路径、NODE_ENV；按 `final` 比对 | synchronize=false、环境映射清空、维护原文、无 Windows 路径 | 只改声明路径，不全局替换；不输出认证值 |
| stage 45 | 各链接独立记账；代码 root、shared srvpro 最小权限，准备 engine/replay | srvpro 可写 config/logs/replay，不可写代码/卡库 | namei/stat 查父目录，不 chmod 777，不赋整个 plugins 写权 |
| stage 46 | srvpro preflight、15 秒原生 TCP 冒烟并清理进程 | ELF/ldd/指纹/四语 CDB、PASS native engine TCP smoke | 查 shared/logs/engine-smoke；冒烟不代表真实对局 |

至少核对全部布尔/数字开关：side_timeout、random_duel、tournament_mode、http、mysql、reconnect、heartbeat_detection。
适配插件 enabled 优先，否则取主配置 modules.mysql.db；server.env 只写 NODE_ENV，禁止旧环境覆盖连接。适配插件启用时宿主保存设置会将 `modules.mysql.enabled` 写回 `true`，该项已登记为运行时写回，配置等价检查接受这个变化。
Windows 恢复的 tournament_mode.deck_path/replay_path/log_save_path 与 deck_log.local 指向绑定 shared，保留末尾 `/`。
额外路径用 pathMappings 的 document/keys/target 逐项声明，target 位于交付时的 shared 下。B retarget 后，44 使用新库与新 shared 核对这些目标。可变资产映射 shared 并列入备份。
`sudo bash install.sh check-config` 在 44 的连接块完成前读 `delivered`，完成后读 `final`，只列差异键。44 计划写入的改动已包含在 `final`，无需审批。

## 第 5–6 节：两轮客户端验收与重启

run 顺序：51 → 52a → 61 → CP1 → 52b → 52c → 52d → 53a → 人工重启 → 53b → CP2。不能按数字顺序跳过检查点。

| 阶段/命令（同上前缀） | 做了什么 | 成功看到什么 | 失败怎么办 |
| --- | --- | --- | --- |
| stage 51 | 首次安装 unit、verify、enable --now；等端口至多 90 秒，保存本次 invocation journal | srvpro/cwd、三端口、每个插件/卡库、维护提示、无应用 warn/error、HTTP 200 | 保留 reports/start-* 私有报告；active 不代表插件通过 |
| stage 52a | 安装维护模块。B 由新机脚本从恢复的 admin_user.json 选择首个启用且有 stop 权限的账号。生成独立 writers.json，全部 unit（含游戏）loaded 后确认 | root 0600 工具/清单、认证 status 可用。B 状态只记选定标记及账号名 SHA-256 前 12 位 | 无可用账号、清单缺失/改变或 unit 不存在即停 |
| stage 61 | 真实 sshd 端口，先允许 SSH 再私网规则/ufw | 另开 SSH 登录成功后输入 yes | 保留旧连接；查 ss/ufw/上游，不放开全部公网 |
| stage CP1 | off → 人工首轮客户端验收 → on；记录检查人/时间 | false 后才能入房，验收后恢复 true | 实际失败不确认，保留客户端与服务证据 |
| stage 52b | on 并查询自然排空 | maintenanceEnabled=true、readyToStop=true | 等对局/持久化自然完成后 run，不踢人、不用固定等待强停 |
| stage 52c | 再查排空，按 writers.json 逐一 stop | 全部 inactive、MainPID=0、cgroup 空、游戏端口关闭 | 缺清单即停；failed/不存在不算停写；PG 保持运行 |
| stage 52d | B 新私有目录复制 release/sidecar；生成或校验完整计划；可选 backup+verify | plan 包含 DB/release/new ELF/runtime/shared/服务配置/额外资产，writers 一致；verified 或 NOT_BACKED_UP | 计划不同不覆盖；部分备份保留，不立即起服；skip 仍须停全部 writer |
| stage 53a | 全部 writer inactive/enabled，记录 boot_id 与 ExecMainStartTimestamp | WAIT 53a，人工 reboot 本机 | 不自动 reboot；重启后首次 SSH 登录前至少等 5 分钟 |
| stage 53b | boot_id 改变，journal 内核→PG→游戏→首条 sshd Accepted，游戏领先至少 5 分钟；间隔 60 秒 | MainPID 不变、NRestarts=0、维护仍开 | 缺证据/boot_id 未变即拒绝，不手工 start 补证 |
| stage CP2 | off → 重启后新写入复测 → on → 自然排空 | 独立检查人/时间，新注册/结算/录像写入通过且 readyToStop=true | 未排空停 CP2-DRAIN，run 继续，端口不能代替验收 |

维护使用 `sudo bash install.sh maintenance on`、`off`、`status`，端口与提示来自交接页，status 只做认证查询。B 只由新机脚本读取恢复出的管理配置，安装器的日志、状态和屏幕均不显示账号名或口令。游戏宿主按既有行为将维护认证的账号名写入自身应用日志。
52d 后不自动起服；若决定跳过重启，显式 `sudo bash install.sh stage 51 --restart-only`，使 52b 起全部后续失效并重新验证。
两轮均按 [验收](validation.md) 检查：必要插件/四语、新账号注册（B 加旧账号/积分/历史）、普通完整对局、TT 全 Match/换备/一次结算/使用率、
掉线重连/观战、旧录像/新录像写入下载、房间代码/卡池；B 在 CP1 检查中文排序分页，CP2 必须再次产生注册/结算/录像新写入。
回执记录操作者、机器、材料 SHA/大小、APT 来源版本、路线、配置差异批准、ELF SHA/Core/Lua/编译开关/资源摘要、报告路径与 NOT_RUN。
最终维护保持开启且已排空；正式开放由用户另行决定。Bot 切换先停旧实例并移交去重状态，公网入口分别验收。

## 失败诊断与补救边界

`sudo bash install.sh diagnose` 只读 unit/端口/磁盘/路径/journal，不 reset-failed、start、删库或改状态；输出保留在私有现场。
修根因后用 verify-block 只读检查。53b 缺证据需重新安排停写与无人登录重启，不能用后来终端、last -F 或手工 start 替代。
共享 PG、其它实例、Bot 的 writer 须显式列清单；停游戏 unit 不能代表整机停写。

## 附录：原手册命令块（审阅与定位用）

以下 44 块完整保留 main 8fb0645 原命令与行号；正文、脚本和设计 §10 为当前执行依据。
旧版文档提取/手改维护源码、直接 reboot、备份后自动 start、登录 shell 时间取证均已被正文流程替代。
附录中的首次动作仅供核对，禁止手工重跑或整段粘贴；人工补救后 verify-block 纳入状态。隔离恢复验证、公网入口与故障恢复动作为脚本范围外。

### 附录 B01：1.1 固定交接目录与 SHA 核对

原手册 L41-56；身份：维护者；工作目录：维护者的 srvprotianti 仓库根目录。
机器：维护者/操作者电脑。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B02：身份：维护者；工作目录：维护者的 srvprotianti 仓库根目录

原手册 L72-88；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B03：身份：root（sudo -i）；工作目录：/

原手册 L95-101；身份：部署用户（可 sudo）；工作目录：/srv/srvpro-input。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

```bash
# 身份：部署用户（可 sudo）；工作目录：/srv/srvpro-input
set -euo pipefail
cd /srv/srvpro-input
stat -c '%n %s bytes' handover.tsv
sha256sum handover.tsv
```

### 附录 B04：身份：部署用户（可 sudo）；工作目录：/srv/srvpro-input

原手册 L106-146；身份：root（sudo -i）；工作目录：/srv/srvpro-input。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B05：身份：root（sudo -i）；工作目录：/srv/srvpro-input

原手册 L154-169；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B06：1.2 Ubuntu、APT、Node 与 PG17

原手册 L179-194；身份：部署用户（可 sudo）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B07：身份：部署用户（可 sudo）；工作目录：/

原手册 L199-216；身份：部署用户（可 sudo）；工作目录：/srv/srvpro-input。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B08：身份：部署用户（可 sudo）；工作目录：/srv/srvpro-input

原手册 L223-239；身份：部署用户（可 sudo）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B09：2.1 在部署用户目录解包 R4

原手册 L251-266；身份：部署用户（可 sudo）；工作目录：部署用户 HOME。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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
test -f "$WORK/release/components/engine/ygopro.exe" || python3 -c 'import json,sys; assert json.load(open(sys.argv[1], encoding="utf-8"))["runtimeStatus"] == "public-production-layout"' "$WORK/release/components/engine/engine-manifest.json"
test -f "$WORK/release/components/engine/strings.conf"
test -d "$WORK/release/components/engine/script"
test -d "$WORK/release/components/catalog"
```

### 附录 B10：2.2 取得兼容的 Linux 引擎

原手册 L282-311；身份：部署用户（可 sudo）；工作目录：部署用户 HOME/srvpro-linux-work。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B11：身份：部署用户（可 sudo）；工作目录：部署用户 HOME/srvpro-linux-work

原手册 L315-335；身份：部署用户（可 sudo）；工作目录：部署用户 HOME/srvpro-linux-work/engine-build/source。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B12：2.3 组合资源、构建应用并安装

原手册 L350-384；身份：部署用户（可 sudo）；工作目录：部署用户 HOME/srvpro-linux-work/release/application。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B13：3.1 四个数据库身份与运维凭据

原手册 L406-413；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
test ! -e /etc/srvprotianti
install -d -m 0700 /etc/srvprotianti /etc/srvprotianti/reports /private-restores /private-backups
sudo -u postgres /usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -d postgres
```

### 附录 B14：身份：root（sudo -i）；工作目录：/

原手册 L417-423；身份：新机 root 派发的 postgres 超级用户 SQL 上下文。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

```sql
CREATE ROLE srvpro_schema NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE srvpro_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE srvpro_operator LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT srvpro_schema TO srvpro_operator;
\q
```

### 附录 B15：身份：root（sudo -i）；工作目录：/

原手册 L428-453；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B16：3.2 A：没有旧数据

原手册 L463-468；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
sudo -u postgres /usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -d postgres
```

### 附录 B17：身份：root（sudo -i）；工作目录：/

原手册 L472-479；身份：新机 root 派发的 postgres 超级用户 SQL 上下文。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

```sql
CREATE DATABASE srvpro_1103 OWNER srvpro_schema TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C';
\connect srvpro_1103
ALTER SCHEMA public OWNER TO srvpro_schema;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE srvpro_1103 TO srvpro_runtime, srvpro_operator;
\q
```

### 附录 B18：身份：root（sudo -i）；工作目录：/

原手册 L483-495；身份：root（sudo -i）；工作目录：/srv/srvprotianti/releases/linux-r4-1/application。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B19：3.3 B：导入已有数据

原手册 L507-523；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B20：身份：root（sudo -i）；工作目录：/

原手册 L531-540；身份：新机 root 派发的 postgres 超级用户 SQL 上下文。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B21：身份：root（sudo -i）；工作目录：/

原手册 L549-576；身份：root（sudo -i）；工作目录：/srv/srvprotianti/releases/linux-r4-1/application。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B22：身份：root（sudo -i）；工作目录：/srv/srvprotianti/releases/linux-r4-1/application

原手册 L587-609；身份：root（sudo -i）；工作目录：/srv/srvprotianti/releases/linux-r4-1/application。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B23：身份：root（sudo -i）；工作目录：/srv/srvprotianti/releases/linux-r4-1/application

原手册 L615-622；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator PGPASSFILE=/etc/srvprotianti/ops.pgpass
PGOPTIONS='-c default_transaction_read_only=on' /usr/lib/postgresql/17/bin/psql -X \
  -v ON_ERROR_STOP=1 -d srvpro_restore_1103 -o /etc/srvprotianti/reports/locale-check.txt
```

### 附录 B24：身份：root（sudo -i）；工作目录：/

原手册 L626-635；身份：新机 root 在前块设置的 srvpro_operator 环境中运行 psql（只读查询）。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B25：3.4 A、B 都要验证运行账号

原手册 L647-663；身份：root（sudo -i）；工作目录：/srv/srvprotianti/releases/linux-r4-1/application。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B26：4.1 目录与参数页

原手册 L671-685；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B27：4.2 A：放置新装配置

原手册 L720-730；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B28：身份：root（sudo -i）；工作目录：/

原手册 L736-758；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B29：4.3 B：恢复路线：本批路径表

原手册 L783-817；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B30：4.4 数据库连接要改哪里、哪些密码是新机的

原手册 L839-884；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B31：4.5 链接、最小权限与 replay

原手册 L896-938；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B32：4.6 srvpro 身份 preflight 与原生冒烟

原手册 L950-959；身份：部署用户（可 sudo）；工作目录：/srv/srvprotianti/releases/linux-r4-1/application。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B33：身份：部署用户（可 sudo）；工作目录：/srv/srvprotianti/releases/linux-r4-1/application

原手册 L966-997；身份：部署用户（可 sudo）；工作目录：/srv/srvprotianti/releases/linux-r4-1/application。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B34：5.1 安装与首次启动

原手册 L1010-1074；身份：部署用户（可 sudo）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B35：5.2 维护工具、停写与联合备份

原手册 L1093-1107；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B36：身份：root（sudo -i）；工作目录：/

原手册 L1113-1126；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B37：身份：root（sudo -i）；工作目录：/

原手册 L1133-1142；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B38：身份：root（sudo -i）；工作目录：/

原手册 L1151-1165；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B39：身份：root（sudo -i）；工作目录：/

原手册 L1169-1180；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B40：身份：root（sudo -i）；工作目录：/

原手册 L1185-1240；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B41：5.3 无人登录的开机自启验收

原手册 L1248-1256；身份：root（sudo -i）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

```bash
# 身份：root（sudo -i）；工作目录：/
set -euo pipefail
cd /
systemctl is-enabled srvprotianti.service postgresql@17-main.service
test "$(systemctl is-active srvprotianti.service || true)" = inactive
date --iso-8601=seconds
reboot
```

### 附录 B42：身份：root（sudo -i）；工作目录：/

原手册 L1262-1283；身份：部署用户（可 sudo）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B43：5.4 常见失败与处理

原手册 L1312-1371；身份：部署用户（可 sudo）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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

### 附录 B44：6.1 防火墙与后置入口

原手册 L1385-1404；身份：部署用户（可 sudo）；工作目录：/。
机器：参数页绑定的 Ubuntu 新机。前置条件：正文对应路线全部前序块通过，口令/路径私下核对。
首次动作禁止重跑；只用于审阅定位，人工补救后执行 verify-block。

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
