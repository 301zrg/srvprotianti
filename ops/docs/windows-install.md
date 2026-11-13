# 新 Windows 服务器安装与恢复

本路线优先于 Linux 验收。目标为 Windows Server 2022 x64、Node 24、PG17、原生引擎。
当前是等待干净 VM 首走的操作稿，尚不表示普通人已能无补充完成上线。
正式库已只读核实为 PG17.9；本机 PG18 子集另恢复到 PG18，不做默认降级。
开机方案选普通服务账户 + 计划任务 + 固定 PM2，理由及 Docker/非 PM2 备选见 [运行方式](runtime-options.md)。

## 安装前固定输入

从已审核的服务端提交取得 `ops/` 和源码，执行 `npm ci`、`npm run build`。依据 [资源锁](../versions.json) 核对完整引擎运行包、四语查询库、禁限表和规则快照。引擎准备见 [引擎安装](ygopro-install.md)。不要直接复用开发机任意 `ygopro/`：本地二进制可能与正式 EXE 不同。

新机路径、PM2 安装程序、PM2_HOME、应用名、工作目录、TCP/HTTP/WSS 端口、公开域名和 Origin 必须逐项填写。配置从 [无凭据模板](../templates) 创建私有副本，保留维护状态；数据库配置可显式使用主配置 `modules.mysql`，也可使用已启用的 postgres-compat 插件，不能依赖宿主自动迁移环境变量。普通启动保持 `synchronize:false`。

## 两条数据路线

- 无旧数据：按 [数据库初始化](database-init.md) 创建新角色和空库，运行 `check-contract`、`init` 和 `verify`。
- 保留旧账号和录像：按 [联合恢复](backup-restore.md) 校验私有批次，恢复到不同名字的新空库和新目录；不先执行 `init`，不执行历史修复或重置积分。

备份范围按实际写入资产划分。游戏服务、会改库或录像的后台工具属于同一停写边界；QQ/Discord 的配置和去重状态另作服务自身备份，不因为它们调用公开 API 就把它们认成游戏数据库 writer。共享 PostgreSQL/nginx 和其他硬拷贝实例不属于本项目的自动停止范围。

## 现场验收顺序

先在隔离端口启动游戏应用，核对 PM2 的精确脚本路径、cwd、运行用户和版本；维护保持到明确开放授权。验证普通房完整对局、TT 三局换备/一次结算、重连观战、录像播放、四语统计，再验证 WSS/TLS/Origin/玩家 IP。地址变更按 [跨项目迁址](server-move.md) 核对官网、网页构建和桌面默认配置；保留玩家自定义设置。

本项目进程恢复与整机恢复分别记录。前者核对应用与子引擎退出、重新启动后配置/权限/新写入；后者必须另约窗口，确认全部受影响实例均空闲，并检查共享组件、PM2 开机启动和孤儿进程。任何一步失败保持维护，保留回执；不把旧发布 CMD 当恢复工具重跑。

本机合成数据演练入口为 `ops/scripts/validate-recovery.cmd`，参数见 [工具说明](../scripts/README.md)。它不连接正式服务，也不停止 PM2。

## 从新 VM 开始的操作稿

下面的命令只在独立测试 VM 内执行，PowerShell 指 Windows PowerShell 5.1。
每块报错就停止，保存错误；不要跳过检查。尚未完成 VM 首走的步骤须记录为待验收。

### 1. 取得材料并安装依赖

维护者先交付 `C:\srvpro-input\server-release.tar.gz`、配套 manifest、同版本 `ops/`，
以及私有参数页（机器名、域名/Origin、端口、全部规则参数、文件 SHA、恢复分支）。
制品必须包含 application、完整 engine 和四语 catalog 组件；缺材料就在此处停止。
恢复路线另交付完整联合批次及角色/目录映射。不要让操作者自己从开发机挑文件。

依次安装官方 [Node](https://nodejs.org/en/download) 24、
[Python](https://www.python.org/downloads/windows/) 3.12+、[Git](https://git-scm.com/downloads/win) 与 Git LFS、
[PostgreSQL](https://www.postgresql.org/download/windows/) 17。
Node/Python 选择加入 PATH；PG 选 Server 和 Command Line Tools，端口 5432，
新数据目录，独立 postgres 密码。仅合成新装使用 C locale，恢复库后续按源清单创建。
安装后重新开管理员 PowerShell。Node 本地复现版本为 24.15.0，正式服观察为 24.14.1，分别记录。
维护者须将实际下载 URL/精确版本/SHA 写交接页，不能用“最新版”代替版本锁。

```powershell
$ExpectedHost='SRVPRO-LAB-WIN'
if ($env:COMPUTERNAME -ne $ExpectedHost) { throw 'Wrong test host' }
if ((Get-CimInstance Win32_ComputerSystem).Model -notmatch 'Virtual|VMware|KVM') { throw 'Review VM identity' }
$existing=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'pm2|Daemon.js' }
if ($existing) { throw 'Existing PM2: do not run this test here' }
if ([IO.Directory]::GetFiles('\\.\pipe\') -contains '\\.\pipe\rpc.sock') { throw 'Existing PM2 pipe' }
$App='C:\srvpro-lab\release\application'
$PG='C:\Program Files\PostgreSQL\17\bin'
node --version
python --version
git lfs version
& "$PG\psql.exe" --version
Get-Service postgresql-x64-17
```

`ExpectedHost` 只改为私有参数页写明的测试 VM 名称，不填宿主/正式机名称。
应为 Node24、Python3.12+、PG17，PG 服务 Running；有同名旧目录/服务先核实，不覆盖。
测试 PM2 不得在开发机或正式服启动，改 PM2_HOME 不能隔离全机命名管道。

### 2. 校验、解包和构建

```powershell
python C:\srvpro-input\ops\scripts\ops.py verify-release --archive C:\srvpro-input\server-release.tar.gz
if ($LASTEXITCODE -ne 0) { throw 'Release verification failed' }
python C:\srvpro-input\ops\scripts\ops.py unpack-release --archive C:\srvpro-input\server-release.tar.gz --destination C:\srvpro-lab\release
if ($LASTEXITCODE -ne 0) { throw 'Unpack failed' }
if ((Test-Path "$App\ygopro") -or (Test-Path "$App\plugins\card-catalog\databases")) { throw 'Existing resource target' }
Copy-Item -LiteralPath C:\srvpro-lab\release\components\engine -Destination "$App\ygopro" -Recurse
Copy-Item -LiteralPath C:\srvpro-lab\release\components\catalog -Destination "$App\plugins\card-catalog\databases" -Recurse
Set-Location -LiteralPath $App
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
python ops/scripts/ops.py catalog-check --catalog plugins/card-catalog/databases --versions ops/versions.json
if ($LASTEXITCODE -ne 0) { throw 'Catalog verification failed' }
npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
python ops/scripts/ops.py preflight --platform windows --application . --engine ygopro --catalog plugins/card-catalog/databases --versions ops/versions.json
if ($LASTEXITCODE -ne 0) { throw 'Preflight failed' }
```

如果维护者交付的是纯源码检出，必须先下载查询库再测试；运行目录不存在时执行：
`python ops/scripts/ops.py catalog-fetch --destination plugins/card-catalog/databases --versions ops/versions.json`。
此命令不能代替引擎交接。`/rooms.html` 断言失败时先查上游 card-catalog/deck-classifier 的初始化日志，
包括中文 CDB 和 Python 子进程；不能关闭插件绕过测试。

### 3. 建角色、新库与恢复分支

```powershell
& "$PG\psql.exe" -X -W -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1
```

输入 PG 安装时的密码，在 `postgres=#` 后执行 [建角色和空库 SQL](database-init.md#角色与空库)，
`\password` 依次设置运行和运维密码，最后 `\q` 回到 PowerShell。
新装合成库使用该 SQL 的 C locale；Windows 中文源恢复优先匹配
`Chinese (Simplified)_China.936`。目标版本不识别时停止，不默默换成 C。
恢复库改成源库以外的新名称，并同步 SQL 中所有数据库名。

私下新建 `C:\srvpro-private\ops.pgpass`，一行内容为
`127.0.0.1:5432:*:srvpro_operator:你的运维密码`；密码中的冒号/反斜杠按 PG passfile 规则转义。
该目录只允许 Administrators、SYSTEM 和运维操作者访问，不授予游戏账户，不上传。

```powershell
$env:PGHOST='127.0.0.1'
$env:PGPORT='5432'
$env:PGUSER='srvpro_operator'
$env:PGPASSFILE='C:\srvpro-private\ops.pgpass'
New-Item -ItemType Directory -Path C:\srvpro-private\reports -ErrorAction Stop
node plugins/postgres-compat/deployment/schema.js check-contract
if ($LASTEXITCODE -ne 0) { throw 'Schema contract failed' }
```

**A：没有旧数据。** 只对刚创建的空库执行：

```powershell
$env:PGOPTIONS='-c role=srvpro_schema'
node plugins/postgres-compat/deployment/schema.js init --database srvpro_1103 --runtime-role srvpro_runtime --confirm-empty srvpro_1103 --report C:\srvpro-private\reports\schema-init.json
if ($LASTEXITCODE -ne 0) { throw 'Initialization failed' }
Remove-Item Env:PGOPTIONS
```

**B：导入已有数据。** 跳过 A，不执行 init。先按第 3 节建立 `srvpro_restore_1103` 新空库，
源批次放 `C:\srvpro-input\joint-batch`：

```powershell
python ops/scripts/ops.py verify --batch C:\srvpro-input\joint-batch
if ($LASTEXITCODE -ne 0) { throw 'Batch verification failed' }
python ops/scripts/ops.py restore --batch C:\srvpro-input\joint-batch --destination C:\srvpro-restores\batch1 --database srvpro_restore_1103 --confirm-new-database srvpro_restore_1103 --owner-role srvpro_schema --runtime-role srvpro_runtime --schema-tool plugins/postgres-compat/deployment/schema.js --pg-bin "$PG"
if ($LASTEXITCODE -ne 0) { throw 'Restore failed; keep this target for diagnosis' }
```

按 [状态清单](backup-restore.md#逐项状态清单) 和本批路径表映射恢复的配置、录像及资源；
维护者必须提前填好每个源组件/目标路径。源批次保持不动，失败保留目标证据，不清库重试。
合成/子集/全量分别记录，不能用部分数据成功宣称全量已恢复。

### 4. 配置与普通服务账户

通过“计算机管理 → 本地用户和组”创建 `srvprosvc`，设置独立密码，仅加入 Users，不加入 Administrators。
管理员创建 `C:\srvpro-pm2` 和 `C:\srvpro-tools\pm2`。
在私有参数页列明并配置 NTFS：svc 只读代码/引擎/查询库，只可修改 PM2 home、config、logs、shared、
实际管理页面可写的卡组模板和分类/展示文件；配置去掉普通 Users 的读取权限。
不要对盘符根目录递归授权。账户密码变更时更新开机任务，不能用永不过期管理员身份代替。

新装把两个无凭据模板复制到 `config/config.json` 和 `plugins/postgres-compat/config.json`；
恢复时保留原文件，不覆盖模板。用记事本按私有参数页填写完整规则和数据库运行密码，
adapter `enabled:true`、`synchronize:false`，连接运行角色而非 postgres/operator。
模板中的 Linux 路径改为本机 `C:/srvpro-lab/shared/.../`，创建对应目录，保留末尾 `/`。
保留维护提示和关闭外发 webhook/update_util。主配置覆盖片段不能替操作者猜 hostinfo/禁表/协议版本。
首次新装另创建只有 stop 权限的 maintenance 管理账号，JSON 格式见 [维护账号](maintenance.md#维护管理账号和操作)；
Windows 文件位置为 `$App\config\admin_user.json`，不要在 Windows 运行其中的 Linux chown 示例。

固定 PM2 安装只写文件，不启动 daemon：

```powershell
npm.cmd install --prefix C:\srvpro-tools\pm2 --save-exact pm2@6.0.14
if ($LASTEXITCODE -ne 0) { throw 'PM2 install failed' }
```

保存生成的 package-lock.json，重装按同一锁执行 npm ci。
管理员不要执行 pm2 status/jlist/start；CLI 即使只查状态也可能启动 daemon。

### 5. 首次启动与开机恢复

管理员执行 `runas /user:.\srvprosvc powershell.exe`，输入 svc 密码。
在新窗口 `whoami` 确认 srvprosvc 后执行：

```powershell
$App='C:\srvpro-lab\release\application'
$env:PM2_HOME='C:\srvpro-pm2'
$Pm2='C:\srvpro-tools\pm2\node_modules\pm2\bin\pm2'
Set-Location -LiteralPath $App
node $Pm2 start ygopro-server.js --name srvpro-lab --cwd "$App" --time
node $Pm2 describe srvpro-lab
node $Pm2 save
```

核对 online、脚本/cwd、fork、watch=false，以及日志中数据库、全部必需插件和四语卡库正常。
不启动 Bot，不另起 npm start，不复制正式机 dump.pm2，不操作其他 PM2 应用。

管理员在任务计划程序“创建任务”：名称 `SRVPro-Lab-Startup`；身份 srvprosvc；
选择“不管用户是否登录都运行”，不勾最高权限；触发器“启动时”延迟 30 秒；
取消仅交流电源条件；任务已运行时不新开实例；失败一分钟后重试三次。
操作选择由管理员拥有、svc 只读的 ASCII/CRLF 启动 CMD，内容如下，Node 路径按安装位置填写：

```bat
@echo off
set "PM2_HOME=C:\srvpro-pm2"
cd /d C:\srvpro-lab\release\application
"C:\Program Files\nodejs\node.exe" "C:\srvpro-tools\pm2\node_modules\pm2\bin\pm2" resurrect
```

保存任务时私下输入 svc 密码，核对“作为批处理作业登录”权限及 PG 服务自动启动。
没有该权限时修正策略，不改用 Administrator/SYSTEM。此方案仍需 VM 实测：
所有登录退出后服务存活、PG 慢启动、daemon 异常、子引擎回收，以及维护排空后 reboot 的恢复。
只重启测试 VM，不重启宿主/正式服。任务返回 0 不代替真实客户端验收。

### 6. 网络和交付

先只在 VM 私网验证。按 [迁址](server-move.md) 配 Nginx/WSS/TLS/Origin，
默认公网仅游戏 TCP 7911 与 HTTPS/WSS 443，管理端口限制来源；7922/7977/5432 不开放公网。
云安全组与 Windows 防火墙都要核对。原始 TCP 的域名用 DNS-only，普通 Cloudflare HTTP 代理不承载游戏 TCP。
网页、Bot、证书、备份与日常发布按 [上线后的交接](maintenance.md#上线后的交接与每日检查) 单独验证。

开始真实对局前，先确认测试 VM 仍处在隔离网络，只有测试客户端可访问。
按 [维护开关操作](maintenance.md#维护开关操作) 保存 Python 文件，把 stop_value 设为字符串 `'false'`，
在 VM 内运行并确认 maintenanceEnabled=false，然后才开始测试入房。
每轮测试结束把 stop_value 改回维护提示，运行后等待 readyToStop=true，再停服务、备份或重启测试 VM。
重启后先核实维护状态/版本/插件/端口，再重复上述解除维护步骤测试新写入。
这里仅开放测试机；真实公网发布和生产切换是另一项明确授权与验收。
记录操作者、材料版本、每次提问、补充命令、卡住时长和绕过次数；文档外操作先补回手册，
用干净快照重跑受影响步骤。AI 首走为预验收，用户随后按同一材料亲自复现才填写真人结果。
