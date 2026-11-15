# 数据库、录像与资源的联合备份和恢复

恢复需要同一停写批次的数据库和文件。`pg_dump` 自身的数据库一致性不能代替文件系统一致性。
本工具使用停机窗口，并在备份前后核对写入进程、数据库状态、文件字节，发现变化就失败。
自动数据库对比覆盖表内容/行数、关系字段、索引/约束和序列；
现场额外函数、触发器、view 定义、扩展版本、RLS 策略及 large object 内容仍须单独验收。
dump 会保存可支持的对象，但 `complete:true` 不表示任意现场扩展都经过逐项语义比较。
完整备份是私有资产，包含账号信息、卡组/录像、IP、配置和可能的机器人凭据；不进入公开 GitHub 仓库。

## 先确认备份边界

Windows/PM2 使用 `node ops/scripts/windows-backup.cjs backup PLAN OUTPUT PYTHON [PG_BIN] --queue-root QUEUE_ROOT`。计划沿用本页 database/components/releaseArchive，另以 `writerGuard` 替换 `writerUnits`：明确 `manager:"pm2"`、`writerInventoryReviewed:true`、`pm2Home`、`pm2Script`、`coordinatorLock` 和 `apps:[{"name":"实际名称","script":"绝对脚本路径"}]`。所有路径填实际绝对路径，已有发布器的 `QUEUE_ROOT` 必须经管理员核对为现有发布 batch 的父目录；没有发布器的新装机按下面的 Windows 完整示例建立唯一协调根，锁必须精确等于该目录的 `coordinator.lock`；程序不自动发现全机发布器。

入口只验证已经停写的应用。它复用发布协调器的全局锁，并直接使用指定 PM2 安装包已有的 axon RPC，只调用 `getReport/getMonitorData`，不调用会自动启动 daemon 的 CLI；安装包不具备对应模块则拒绝。检查同一 daemon PID/启动时间/PM2_HOME、精确应用名和脚本、`stopped + pid=0 + watch=false + fork_mode`。Python 对实际解析的计划字节计算 SHA，在复制/dump 前后重新验证持锁身份与停写状态。实际 PM2 兼容性仍须在目标机验收，合成测试不能替代。

按 Windows 手册部署的机器，见 [5.9 备份前停服与恢复运行](windows-install.md#59-备份前停服与恢复运行)：用 `<前缀>-Stop` 任务进入“应用 stopped、daemon 仍在”的状态，并按该节步骤在备份后恢复运行。

该锁约束遵守此约定的发布器和运维工具；人为执行 PM2 start、外部计划任务或其他 writer 不会自动被它禁止。必须先完成 writer 清单审核和现场停写。共享 PostgreSQL 整体、其他实例不自动停止。正常子进程退出释放本锁；状态不明的中断保留锁和证据，不能盲删重试。

QQ/Discord 自身的私有配置、缓存和去重状态另作一致性备份；只调用游戏公开 API 不代表会写游戏数据库。浏览器数据、玩家桌面设置/脚本事务状态也不在服务器备份覆盖范围。

### Windows 完整示例

先决条件：已按 [Windows 安装 5.9](windows-install.md#59-备份前停服与恢复运行) 进入维护，排空并 `-RunTask Stop` 成功。

组件只列可变状态：录像、主配置目录、数据库适配器配置文件（若在用）、shared 下其它目录、服务配置，以及部署 profile 的 `mutablePluginAssets` 里实际存在的项。逐项盘点，只添加存在且不重叠的源路径；主配置提供连接且适配器配置不存在时，删除 `adapter-config` 这一项。
程序、引擎、卡库由批次自带的 release 归档覆盖，不重复列；先确认归档覆盖实际生效版本，日志另行归档。实测把引擎目录和整个 plugins 列入会有两万多个文件，备份从 26 秒变成 20 多分钟。

下面是测试路径的计划模板，保存为 `C:\srvpro-private\backup\plan-a2.json`，使用 UTF-8 无 BOM；JSON 中 Windows 反斜杠必须双写。各字段按现场填写，占位说明不写入 JSON：

- `format`：保持 `1`。
- `database`：改为正在使用的完整应用库名。
- `runtimeRole`：改为游戏数据库角色。
- `releaseArchive`：改为审核过的当前 release 归档路径，保留配套 manifest。
- `replayComponent`：对应实际录像组件的 `id`。
- `components`：每项 `id` 是本批组件名，`source` 改为实际源路径；源路径不能重叠。
- `writerGuard.manager`：Windows/PM2 保持 `pm2`。
- `writerInventoryReviewed`：仅在审核全部 writer 并停写后填 `true`。
- `pm2Home`、`pm2Script`：改为本机 PM2 Home 和固定安装入口。
- `coordinatorLock`：必须精确等于下方 `$Queue` 的 `coordinator.lock`。
- `apps`：逐项填真实应用 `name` 和绝对入口 `script`，不能遗漏 writer。

```json
{
  "format": 1, "database": "srvpro_1103", "runtimeRole": "srvpro_runtime",
  "releaseArchive": "C:\\srvpro-input\\server-release.tar.gz", "replayComponent": "recordings",
  "components": [
    {"id":"recordings","source":"C:\\srvpro-lab\\shared\\replays"},
    {"id":"host-config","source":"C:\\srvpro-lab\\release\\application\\config"},
    {"id":"adapter-config","source":"C:\\srvpro-lab\\release\\application\\plugins\\postgres-compat\\config.json"},
    {"id":"tournament-decks","source":"C:\\srvpro-lab\\shared\\tournament-decks"},
    {"id":"tournament-logs","source":"C:\\srvpro-lab\\shared\\tournament-logs"},
    {"id":"deck-logs","source":"C:\\srvpro-lab\\shared\\deck_log"},
    {"id":"service-config","source":"C:\\srvpro-service"}
  ],
  "writerGuard": {
    "manager":"pm2", "writerInventoryReviewed":true, "pm2Home":"C:\\srvpro-pm2",
    "pm2Script":"C:\\srvpro-tools\\pm2\\node_modules\\pm2\\bin\\pm2",
    "coordinatorLock":"C:\\srvpro-private\\backup\\queue\\coordinator.lock",
    "apps":[{"name":"srvpro-lab","script":"C:\\srvpro-lab\\release\\application\\ygopro-server.js"}]
  }
}
```

已有发布器的机器必须复用它的队列目录，不能另建根绕过原协调锁。没有发布器的新装机，先确认没有既有队列，再建一个管理员专属目录作为唯一协调根；以后安装发布器也必须用它。
以下仅用于没有发布器的新装机，在管理员 PowerShell 中执行；`C:\srvpro-private` 已按安装手册限制为 SYSTEM/Administrators，子目录继承该私有 ACL：

```powershell
$ErrorActionPreference='Stop'
$Private='C:\srvpro-private'
$Root="$Private\backup"
$Queue="$Root\queue"
foreach ($path in @($Root,$Queue,'C:\srvpro-backups')) {
  if (Test-Path -LiteralPath $path) { throw "Directory already exists; inspect ACL and purpose: $path" }
  New-Item -ItemType Directory -Path $path | Out-Null
  Set-Acl -LiteralPath $path -AclObject (Get-Acl -LiteralPath $Private)
}
notepad.exe "$Root\plan-a2.json"
```

在记事本保存计划前选择 UTF-8 无 BOM。已有目录的机器由维护者核对并沿用私有目录及 ACL，不重复执行上面的初始化块。
在管理员 PowerShell 直接运行下面一块；已有发布器时替换 `$Queue` 并同步计划的 `coordinatorLock`。`a2` 是新批次 ID，改为未用 ID，计划名和输出目录同步改；数据库连接使用 operator 的 `ops.pgpass`，授权见 [数据库角色](database-init.md)。

```powershell
$ErrorActionPreference='Stop'
$App='C:\srvpro-lab\release\application'
$Root='C:\srvpro-private\backup'
$Queue="$Root\queue"
$Plan="$Root\plan-a2.json"
$Batch='C:\srvpro-backups\batch-a2'
$Python='C:\Python314\python.exe'
$PG='C:\Program Files\PostgreSQL\17\bin'
Set-Location -LiteralPath $App
$env:PATH="$PG;$env:PATH"
$env:PGHOST='127.0.0.1'; $env:PGPORT='5432'; $env:PGUSER='srvpro_operator'
$env:PGPASSFILE='C:\srvpro-private\ops.pgpass'
Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
Remove-Item Env:\PGOPTIONS -ErrorAction SilentlyContinue
if ((Test-Path -LiteralPath $Batch) -or (Test-Path -LiteralPath "$Queue\coordinator.lock")) { throw 'Preserve existing evidence; stop' }
node ops/scripts/windows-backup.cjs backup $Plan $Batch $Python $PG --queue-root $Queue
if ($LASTEXITCODE -ne 0) { throw 'Backup failed; preserve evidence' }
python ops/scripts/ops.py verify --batch $Batch
if ($LASTEXITCODE -ne 0) { throw 'Batch verification failed; preserve evidence' }
```

备份期间不要关闭窗口；失败或中断时保留现场，协调锁仍在时不要恢复 writer。verify 退出 0 只说明批次内部校验通过，不代表已完成恢复验收。
结束后按 [Windows 安装 5.9](windows-install.md#59-备份前停服与恢复运行) 恢复运行，核对通过后才解除维护。

### 逐项状态清单

操作者在私有批次记录中填写每行的实际源路径、写入者、目标路径、纳入/不纳入理由和恢复结果。
不适用项须写原因，不能空白；本表不是允许递归打包整个服务器根目录的清单。

| 状态 | 交接及恢复核对 |
| --- | --- |
| 应用数据库 | 全库全部表、历史归档、序列、索引/约束、扩展、owner/runtime；核对账号/积分/连胜/Match/单局/使用率和新增写入。正式 PG17.9 当前观察到 21 张 public 表，不能按 20 表契约过滤导出 |
| 服务器录像 | 真实 yrp 路径、大小/SHA、与库关联分类；历史缺失按源批次保留事实，不猜补 |
| 游戏/管理/插件配置 | 主配置、admin_user、插件 config、启动环境、禁用/黑名单；禁止作为公开模板上传 |
| 规则与资源 | 引擎、Core/Lua 来源、完整基础/覆盖脚本、组合 utility、cards.cdb、全部生效 lflist、四语查询库和逐文件 SHA |
| 管理页面可写资产 | 卡组模板、分类/展示 JSON、赛事卡组/日志、deck_log；路径来自实际配置，不能只备份 Git 中的默认文件 |
| Bot 自身状态 | 各平台 config、整个 data（每日/月报/连胜去重、月报制品、状态卡）、代理配置；恢复锁文件前核对旧进程，不直接重放旧 PID 锁 |
| 发布与服务状态 | 发布队列/回执/协调锁、PM2 定义、计划任务/服务、Nginx、证书续期、定期备份；重建进程和权限，不能复制 PID/socket 当恢复 |
| 日志及历史备份 | 应用/认证/引擎/代理/Bot 日志按保留策略另归档；历史备份不递归进入新备份 |

2026-11-13 只读盘点发现正式赛事日志与主配置目录共用 `config/`；计划组件不能重叠。
实际路径、服务账户、PM2 全机应用表及队列位置只保存在私有现场记录。
只读盘点不建立停写一致性，也不表示已导出真实数据。

Windows 守卫的管道 PID 探测使用 `pipe-server-pid.ps1` 与系统
[GetNamedPipeServerProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid)。
需完整交接 scripts 目录；PowerShell 执行策略或权限阻止探测时保持拒绝，不全局降低策略来跳过检查。

参照 [backup-plan.example.json](../templates/backup-plan.example.json) 填自己的私有计划：

- `database`：正在使用的完整应用库，包含宿主、天梯、八张使用率表及现场新增表。
- `releaseArchive`：审核并校验过的当前工作树与资源制品及其 sidecar manifest。
- `runtimeRole`：游戏服务运行数据库角色。
- `writerUnits`：所有可能写本批资产的真实 systemd units，不能只写游戏服务后漏掉更新任务或机器人。
- `components`：实际录像目录、config 目录、各插件私有配置、四语 CDB、原始引擎资源、
  tournament deck/log、deck_log、机器人 config/data、环境文件等独立路径。
- 认证日志 `shared/logs`、管理页面修改过的模板/分类/展示文件及现场其他可写资产也要列入计划。
- `replayComponent`：components 中实际 yrp 保存目录的 ID。

组件不允许路径重叠。例如完整 private tree 已包含 config，就不要另列 config 子目录。
可将不连续的私有文件逐个列为独立 component；单文件在恢复组件目录下保留原文件名。
符号链接不静默跟随：列实际目标路径，不把链接树误当数据已备份。
改系统配置、Nginx、systemd、证书续期和机器人路径时同步该计划。

维护的是“一份完整应用库”的逻辑备份，不是只导出四张天梯表。
archive 保留 schema、data、序列、索引、约束和数据库 large objects；角色与 tablespace 不在单库 dump 中。
本指南选择在新机显式重建 owner/runtime 角色并映射，额外 tablespace/扩展/全局角色另列交接项。
[PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)

## 1. 进入维护并等自然结束

先停止 cron/timer/后台改库、更新资源任务和会写备份范围的机器人。
在既有受权限保护的管理页面设置 `modules.stop` 为维护提示；该行为拒绝新入房，
允许现有对局自然结束，既有允许的重连继续工作。不要使用 kick all/reboot 代替自然排空。

新宿主提供只读 `GET /api/maintenance/status`：

```json
{
  "maintenanceEnabled": true,
  "rooms": 0,
  "pendingWork": {},
  "pendingPersistence": {},
  "pendingCount": 0,
  "readyToStop": true
}
```

状态计数包含未建立、正在删除的房间，既有客户端/后端协议处理，以及 yrp、DuelLog 和云录像任务。
请求使用 HTTP Basic，用户必须已有 `stop` 权限，不能通过查询参数传密码。
在本机端口访问，或通过管理者自己的 SSH 隧道访问；不要经公网无 TLS发送 Basic。
用 root 0600 curl 配置文件放凭据，避免 shell 历史和 URL 日志：

```bash
sudo curl --config /etc/srvprotianti/maintenance-curl.conf \
  --fail --silent --show-error http://127.0.0.1:7922/api/maintenance/status
```

本接口不改变动画顺序、队列容量或消息丢弃行为。
`readyToStop` 是此刻可以停服务的条件，不是整机停写证明；任意第三方插件/后台进程仍须列入停写范围。
房间不清零时检查等待房、重连宽限、卡住的后端和持久化告警，不能用固定 sleep 直接跳过。
确认条件成立后停止游戏服务及其他 writer units：

```bash
sudo systemctl stop srvprotianti.service
sudo systemctl is-active srvprotianti.service
```

is-active 的预期是 inactive；其退出码此时通常非 0，不应被解释为“停止失败”。
真正停止失败、状态 failed、unit 不存在或数据库仍有其他连接时，备份工具拒绝继续。
`KillMode=control-group` 清理子房间；不要在仍有活跃对局时执行 stop。

## 2. 做联合批次

操作者使用只供备份/恢复的数据库管理连接，密码放 0600 `.pgpass` / PGPASSFILE。
以下正式备份/恢复命令在管理员 `sudo -i` 打开的 root shell 中执行，
以便读取 0600 私有配置、环境文件与完整批次；SQL 身份仍是独立 srvpro_operator。
事先创建 root 0700 的 `/private-backups`、`/private-restores`，并私下安装 0600 的 ops.pgpass。
连接角色要能读取全部表/序列、进行需要的恢复授权；不能使用 runtime 角色做 DDL。
工具显式用 `--database` / plan.database，不依赖 PGDATABASE 的猜测。
源库、pg_dump 和新目标优先同为 17；客户端不能比源库旧。

```bash
export PATH=/opt/node24/bin:$PATH
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator
export PGPASSFILE=/etc/srvprotianti/ops.pgpass
python3 /srv/srvprotianti-ops/scripts/ops.py backup \
  --plan /etc/srvprotianti/backup-plan.json \
  --output /private-backups/1103-20261011T020000Z \
  --pg-bin /usr/lib/postgresql/17/bin
```

`srvpro_operator` 应由管理员事先配置为单独运维身份，具备 schema owner 的管理/读取权限。
不要把管理员连接凭据放进游戏 service.env；使用 TCP或 Unix socket 时按自己 pg_hba 的认证方式设置。
输出目录必须新建；源资产内不能出现备份输出目录。
工具检查全部 writer units 已 loaded+inactive，目标数据库没有其他会话。
执行 pg_dump 后再核对库内容/序列和所有源文件，任一变化/错误产生 FAILED.json，不作为可恢复批次。
备份期间不要恢复 writer、数据库管理编辑器或自动更新任务。

manifest 包含批次、数据库版本/编码/locale、dump 客户端大版本、owner 策略，
完整文件路径/大小/SHA、每表行数/内容 SHA、结构、序列状态与录像关联分类。
内容校验会扫描数据库，超大历史库的停机耗时需先演练，不承诺固定分钟数。

每表内容 SHA 的算法记录在 `databaseState.rowDigestFormat`，当前值为 `pg-row-json-copytext-c-utf8-lf-v1`：
按 `row_to_json` 文本的 C 排序逐行导出，每条记录去掉 psql 给出的一个行尾（Windows 为 CRLF，Linux 为 LF）后统一补 LF 再计入 SHA，
字段内容本身的字节不改；会话固定 UTF8、UTC、ISO 日期、`intervalstyle=postgres`、`bytea_output=hex`、`extra_float_digits=3`。
同一份数据在 Windows 和 Linux 上得到相同摘要。源库必须是 UTF8。记录缺行尾、出现空行或混合行尾时备份失败，不产生摘要。
每次扫描另用一条语句对所有表执行 `count(*)`，与导出的记录数逐表核对，因此每次备份比旧工具多两轮全表计数。
外层 `format` 仍为 1。

```bash
python3 /srv/srvprotianti-ops/scripts/ops.py verify --batch /private-backups/1103-20261011T020000Z
```

verify 退出 0 表示批次内部文件和 release archive 校验通过；它不等于已经在新机恢复成功。
备份完成后先启动仍保持 stop 的游戏服务，核对正常后按维护指南取消维护，再启动其他 writer；
保留这一批原始只读资产。

## 3. 异机保存和定期演练

将完整批次复制到另一台机器或私有备份存储，传输后再次运行 verify。
例子只演示私有 SSH 目标，实际用户名/路径由管理员填写：

```bash
rsync -a -- /private-backups/1103-20261011T020000Z/ backup-user@backup-host:/private/1103-20261011T020000Z/
```

跨 Windows/Linux 传输同样适用：文件清单按路径、大小、SHA 逐项核对，与清单内的条目顺序无关
（两种系统对同目录文件名的排序不同）。传输与解包须保留批次内的空组件目录和原始文件名，缺少空目录时 verify 会拒绝。

使用受控传输和存储权限；需要加密时使用团队已经具备且交接了解密密钥的工具。
校验清单可以检测漏件/损坏，但不是针对不可信备份来源的数字签名。
`manifest.json` 自身不在批次文件清单内；需要防止清单被改写（包括删掉 `rowDigestFormat` 让新批次按旧格式解释）时，
在批次之外另行保存 `manifest.json` 的整文件 SHA，恢复前核对。
设定自己的保留期、备份频率、可接受的数据丢失窗口和恢复时间目标；备份失败要有人接收并处理。
留在同一台游戏服务器的备份不满足换机/磁盘损坏恢复需求。

## 4. 恢复到全新隔离库和新目录

按 [Linux 安装](linux-install.md) 准备 OS/Node/PostgreSQL；按 [角色指南](database-init.md)
创建 schema owner、runtime、一个**不同名字的全新空库**，不要执行 init。
同一名字即使在别的主机上也会被当前工具拒绝，先用新的 staging 库名完成恢复/验收，再切运行配置。
source/target 不同名字、新路径和 confirm 参数是防覆盖约束。

```bash
python3 /srv/srvprotianti-ops/scripts/ops.py restore \
  --batch /private-backups/1103-20261011T020000Z \
  --destination /private-restores/1103-check-20261011 \
  --database srvpro_1103_restored \
  --confirm-new-database srvpro_1103_restored \
  --owner-role srvpro_schema --runtime-role srvpro_runtime \
  --schema-tool /srv/srvprotianti/current/plugins/postgres-compat/deployment/schema.js \
  --pg-bin /usr/lib/postgresql/17/bin
```

schema-tool 使用与该 release 配套的工具；新机尚无 current 时使用已安装 staging application 内的绝对路径。
操作者的连接角色必须能 SET ROLE 到 owner，建对象及授权；`--no-owner --no-acl --role` 将对象映射到目标 owner，
再显式授予 runtime。工具使用 `--exit-on-error --single-transaction`，检查每个进程退出码。
它不会自动启动游戏或套用历史初始化/连胜/修复脚本。
旧大版本 archive 不能用更旧目标恢复；本工具也拒绝目标大版本低于 dump 客户端，
同源/同客户端/同目标 17 是本阶段的优先路线。
[PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)

成功得到 `restore-result.json` 的 complete=true、schema-verification.json、restore-map.json。
文件校验、全库内容/序列、录像关系须与批次一致；Linux 引擎、权限与网络验收仍标记未验证。
失败时保留新库和新目录的失败证据，换一个全新目标重试；工具没有覆盖已有目标的开关。

### 摘要格式与旧批次

恢复所用的 ops 工具必须不旧于生成批次的工具。**先升级恢复机上的 `ops/`，再恢复带 `rowDigestFormat` 的批次**：
旧工具不认识这个字段，`verify` 可能照常通过，而 `restore` 要到 pg_restore 写入目标库之后才在比较处失败，留下一个不可用的目标。

| 批次 | 新工具的处理 |
| --- | --- |
| 带 `rowDigestFormat` 且值受支持 | 目标库须为 UTF8；整库状态严格相等才通过，不尝试其它算法 |
| 带 `rowDigestFormat` 但值未知、为空或类型不对 | `verify` 与 `restore` 在创建目录、解包和 pg_restore 之前拒绝 |
| 没有该字段（本格式之前的 Windows/Linux 批次） | 每表导出一次，同时算出 LF、CRLF 两份整库候选；必须有一份候选与清单的结构、每表行数与 SHA、序列**全部**相同 |

旧批次不允许一部分表按 LF、另一部分按 CRLF 匹配。所有表都为空时两份候选相同，结果记为 `ambiguous-empty`。
旧批次的清单与原始文件不会被改写，也不需要为了恢复去编辑清单。

`restore-result.json` 的 `databaseStateVerification` 记录所用算法与匹配的记录行尾（`lf`、`crlf` 或 `ambiguous-empty`）；
它描述摘要字节，不证明源机器的操作系统。比较失败时 `failureCategory` 与 `failureDetails` 只给出差异类别
（结构、表集合、行数、内容、序列）和表名，不含行内容与摘要值。

## 5. 路径、权限与录像核对

根据 restore-map 将恢复组件安装到新机 shared 等实际位置。
组件 ID 与运行位置的对应关系如下；表中的私有单文件需取组件目录内的原文件名：

| 恢复位置 | 安装/配置位置 |
| --- | --- |
| `runtime/recordings` | 运行录像目录，主配置 replay_path 指向它的受控运行副本 |
| `runtime/host-config` | application/config 所指的 shared 配置目录 |
| `runtime/plugin-config` | shared/privatePluginConfigs，各插件 config.json 链接对应文件 |
| `runtime/service-env/server.env` | root 0600 的 /etc/srvprotianti/server.env；改成目标数据库名 |
| `runtime/engine`、`runtime/catalog` | 已验证的引擎/四语卡库运行副本；与本批 release 资源对照 |
| `runtime/tournament-decks`、`runtime/tournament-logs`、`runtime/deck-logs`、`runtime/auth-logs` | 对应 shared 数据目录或配置指定的路径 |

例如，将录像复制到一个不存在的新运行目录，保留原恢复证据：

```bash
test ! -e /srv/srvprotianti/shared/replays-restored-20261011
cp -a /private-restores/1103-check-20261011/runtime/recordings /srv/srvprotianti/shared/replays-restored-20261011
chown -R srvpro:srvpro /srv/srvprotianti/shared/replays-restored-20261011
chmod -R u=rwX,g=rX,o= /srv/srvprotianti/shared/replays-restored-20261011
```

先核对目标绝对路径和新目录条件；已有目录须停下来查明，不覆盖旧资产。
将新配置中的 replay_path 设为 `/srv/srvprotianti/shared/replays-restored-20261011/`。
其他组件同样复制到明确的新受控位置并配套链接/路径；私密文件设 0600，目录 0750，
运行需要写的资产归 srvpro，代码/资源只保留必要执行位和读取权限。
逐项替换旧 Windows盘符/反斜杠、旧 Linux路径，保留目录末尾 `/`、中文文件名、大小写与原始字节。
owner/group 使用本机 srvpro 身份，而不是照搬旧机 UID；Linux binary 单独恢复执行位。
恢复用的私有 root 0700目录不能直接让游戏服务读，应将所需配置/数据转入受控运行位置并设置属主。

录像分类核对的是与备份基线相同，而不是强制 1:1：

| 分类 | 意义 |
| --- | --- |
| linkedFiles | 文件存在且有持久化 DuelLog 引用 |
| unlinkedFiles | 历史文件存在但没有 DB 引用，仍需保存 |
| databaseWithoutFile | DB 有引用但备份时没有文件；可能原有禁发/保存失败，不能据此猜造 |
| nestedFiles / unsafeDatabaseFilenames | 原有子目录或异常名称，保留证据并按现有 API 规则处理 |

若旧库本身已经缺文件，恢复不会凭空产生录像。
若恢复后分类与基线不同，则作为漏件/内容变化失败，不能用重建关联掩盖问题。
核对账号、总/月积分、Match/G1–G3、连胜和 usage 事实；测试历史录像列表、原件下载和已支持的播放。

## 6. 新写入和切流

保持隔离端口、测试 origin、关闭真实机器人主动推送。
在新机启动完成真实对局验收，重启服务器再检查进程/路径/端口。
旧机在切换前维持停写，最后一次联合备份恢复完成后只保留一个正式写入端。
详细地址切换见 [迁址](server-move.md)，数据开始在新机写入后的回退见 [maintenance](maintenance.md)。

## 不能混用的捷径

不能先 init 再 restore；不能把 pg_dump 文件非空当作恢复成功；不能只复制录像和四张业务表；
不能复制运行中的 PostgreSQL data 目录；不能自动清零积分/连胜；不能将私有批次发布到文档仓库。
本机隔离演练使用显式 `srvpro_drill_*` 模式，其跳过 systemd 检查会在报告中标注，
正式备份不使用该模式。
