# 新 Windows 服务器安装与恢复

本路线优先于 Linux 验收。目标为 Windows Server 2022 x64、Node 24、PG17、原生引擎。
当前是测试 VM 上 AI 预演过的操作稿（2026-11-14：安装、建库、合成恢复、Save 任务、无人登录重启恢复）；
第 5 节的正式脚本仍需在干净 VM 上重走，也尚不表示普通人已能无补充完成上线。
正式库已只读核实为 PG17.9；本机 PG18 子集另恢复到 PG18，不做默认降级。
开机方案为普通服务账户 + 计划任务 + 固定 PM2，由仓库脚本 `ops/scripts/windows-service/` 执行（第 5 节）；理由及 Docker/非 PM2 备选见 [运行方式](runtime-options.md)。

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

文件复制完成后，在新机上核对交接页记录的大小和 SHA-256。复制工具返回成功不代表文件完整；
零字节文件、大小或 SHA 不匹配时停止，重新取得该文件，不能继续安装或解包。
例如在 PowerShell 执行下面两行，将结果与交接页逐项比较；依赖安装包也这样核对。

```powershell
Get-Item -LiteralPath C:\srvpro-input\server-release.tar.gz | Select-Object Name,Length
Get-FileHash -LiteralPath C:\srvpro-input\server-release.tar.gz -Algorithm SHA256
```

依赖由维护者随发布一起交付到 `C:\srvpro-input`，操作者不自己从官网下载。共四个安装包：

- `node-v24.15.0-x64.msi`（Node 24.15.0）；
- `python-3.14.10-amd64.exe`（Python 3.14.10 amd64）；
- `Git-2.56.1-64-bit.exe`（Git 2.56.1，含 Git LFS）；
- `postgresql-17.12-1-windows-x64.exe`（PostgreSQL 17.12）。

交接页写明每个文件的大小和 SHA-256。操作者先用上面的 Get-FileHash 方法逐个核对，不一致就停止，不要运行下面的安装块。
官方下载页只是维护者取得安装包的来源：
[Node](https://nodejs.org/en/download)、[Python](https://www.python.org/downloads/windows/)、
[Git](https://git-scm.com/downloads/win)、[PostgreSQL](https://www.postgresql.org/download/windows/)。
维护者须将实际下载 URL/精确版本/SHA 写交接页，不能用“最新版”代替版本锁。Node 本地复现版本为 24.15.0，正式服观察为 24.14.1，分别记录。

Python 必须为所有用户安装：游戏以普通服务账户运行，用不了只装给某个用户的 Python。
Node 和 Python 都必须在机器级 PATH 中，所以下面 Python 使用 `InstallAllUsers=1 PrependPath=1`。
下面一块用静默方式依次安装，任何一个安装程序的退出码不是 0 就报错停止。
PG 只装 Server 和 Command Line Tools，端口 5432，新数据目录，C locale（恢复库后续按源清单创建）。
postgres 超级用户密码在运行时输入（不显示），至少 12 位，只用字母、数字和 `!`、`_`、`-`（安装程序的选项文件对其他符号的处理没有验证过）；请记在自己的密码管理器里，第 3 节要用。
密码只写进一个临时选项文件，装完立刻删除。该文件和各安装日志放在新建的 `C:\srvpro-bootstrap-private`，只有 SYSTEM 和管理员能读。
该目录已存在就停止核对，不要接着覆盖。

```powershell
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root='C:\srvpro-input'
$boot='C:\srvpro-bootstrap-private'
if (Test-Path -LiteralPath $boot) { throw 'Bootstrap directory already exists; inspect it first' }
New-Item -ItemType Directory -Path $boot | Out-Null
$acl=New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
  $identity=New-Object System.Security.Principal.SecurityIdentifier($sid)
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
}
Set-Acl -LiteralPath $boot -AclObject $acl
foreach ($f in @('node-v24.15.0-x64.msi','python-3.14.10-amd64.exe','Git-2.56.1-64-bit.exe','postgresql-17.12-1-windows-x64.exe')) {
  if (-not (Test-Path -LiteralPath "$root\$f")) { throw "Missing installer: $f" }
  if ((Get-AuthenticodeSignature -LiteralPath "$root\$f").Status -ne 'Valid') { throw "Invalid signature: $f" }
}
function Invoke-Installer([string]$Exe,[string]$Arguments,[string]$Name) {
  $p=Start-Process -FilePath $Exe -ArgumentList $Arguments -WindowStyle Hidden -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw ($Name+' installer exit '+$p.ExitCode) }
  Write-Output ($Name+' installed')
}
Invoke-Installer "$env:WINDIR\System32\msiexec.exe" "/i $root\node-v24.15.0-x64.msi /qn /norestart /l*v $boot\node-install.log" 'Node'
Invoke-Installer "$root\python-3.14.10-amd64.exe" "/quiet InstallAllUsers=1 PrependPath=1 Include_test=0 Include_doc=0 TargetDir=C:\Python314 /log $boot\python-install.log" 'Python'
Invoke-Installer "$root\Git-2.56.1-64-bit.exe" "/VERYSILENT /NORESTART /SP- /LOG=$boot\git-install.log" 'Git'
$secret=Read-Host 'New PostgreSQL postgres password' -AsSecureString
$credential=New-Object System.Management.Automation.PSCredential('postgres',$secret)
$password=$credential.GetNetworkCredential().Password
if ($password -notmatch '^[A-Za-z0-9!_-]{12,}$') { throw 'Use at least 12 characters from letters, digits and ! _ -' }
$optionFile="$boot\pg-options.txt"
try {
  $options=@('mode=unattended','unattendedmodeui=none','prefix=C:\Program Files\PostgreSQL\17',
    'datadir=C:\Program Files\PostgreSQL\17\data','serverport=5432','servicename=postgresql-x64-17',
    'enable-components=server,commandlinetools','disable-components=pgAdmin,stackbuilder',
    'locale=C',('superpassword='+$password),'debuglevel=0')
  [IO.File]::WriteAllLines($optionFile,$options,(New-Object Text.UTF8Encoding $false))
  Invoke-Installer "$root\postgresql-17.12-1-windows-x64.exe" "--optionfile $optionFile" 'PostgreSQL'
} finally {
  Remove-Item -LiteralPath $optionFile -Force -ErrorAction SilentlyContinue
  Remove-Variable secret,credential,password,options -ErrorAction SilentlyContinue
}
```

装完后**重新开一个管理员 PowerShell**，让新的机器 PATH 生效，再运行下面的检查块；在旧窗口里 `node`、`python` 可能找不到。

```powershell
$ExpectedHost='SRVPRO-LAB-WIN'
$ErrorActionPreference='Stop'
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

仍在管理员 PowerShell 中，先创建本次专用私有目录。目录存在就停止核对，不能接着覆盖：

```powershell
$Private='C:\srvpro-private'
if (Test-Path -LiteralPath $Private) { throw 'Private directory already exists' }
New-Item -ItemType Directory -Path $Private | Out-Null
$acl=New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
  $identity=New-Object System.Security.Principal.SecurityIdentifier($sid)
  $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $Private -AclObject $acl
New-Item -ItemType Directory -Path "$Private\reports" | Out-Null
```

这里用 SID 标识 SYSTEM 和 Administrators，中文 Windows 不需要猜英文组名。
私有目录只允许这两个身份，游戏账户没有读取运维密码的权限。

```powershell
& "$PG\psql.exe" -X -W -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1
```

输入 PG 安装时的密码，在 `postgres=#` 后执行 [建角色和空库 SQL](database-init.md#角色与空库)，
`\password` 依次设置运行和运维密码，最后 `\q` 回到 PowerShell。
新装合成库使用该 SQL 的 C locale；Windows 中文源恢复优先匹配
`Chinese (Simplified)_China.936`。目标版本不识别时停止，不默默换成 C。
恢复库改成源库以外的新名称，并同步 SQL 中所有数据库名。

回到 PowerShell 后执行下面一块，再输入刚设置的 operator 密码。命令自动转义 passfile 特殊字符，
不会把密码打印到屏幕或放入命令历史；输入内容保存在刚限制权限的目录，不上传。

```powershell
$secret=Read-Host 'PostgreSQL operator password' -AsSecureString
$credential=New-Object System.Management.Automation.PSCredential('srvpro_operator',$secret)
$password=$credential.GetNetworkCredential().Password
if (-not $password -or $password -match '[\r\n\x00]') { throw 'Invalid password' }
$escaped=$password.Replace('\','\\').Replace(':','\:')
$file=New-Object IO.FileStream('C:\srvpro-private\ops.pgpass',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
try {
  $bytes=[Text.Encoding]::UTF8.GetBytes("127.0.0.1:5432:*:srvpro_operator:$escaped`r`n")
  $file.Write($bytes,0,$bytes.Length)
} finally { $file.Dispose() }
Remove-Variable secret,credential,password,escaped,bytes
```

```powershell
$env:PGHOST='127.0.0.1'
$env:PGPORT='5432'
$env:PGUSER='srvpro_operator'
$env:PGPASSFILE='C:\srvpro-private\ops.pgpass'
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

**A、B 都要做：验证游戏账号能连接、结构和权限正确。** 留在管理员 PowerShell，
下方 `$Database` 在 A 路线保持原值，B 路线改为 `srvpro_restore_1103`。
输入的是数据库 `srvpro_runtime` 密码，不是 operator 或 Windows 用户密码。
密码只在本次进程临时使用，结束后清除；报告仍放管理员私有目录。

```powershell
$Database='srvpro_1103'
$secret=Read-Host 'PostgreSQL runtime password' -AsSecureString
$credential=New-Object System.Management.Automation.PSCredential('srvpro_runtime',$secret)
try {
  $env:PGUSER='srvpro_runtime'
  $env:PGPASSWORD=$credential.GetNetworkCredential().Password
  if (-not $env:PGPASSWORD) { throw 'Empty runtime password' }
  node plugins/postgres-compat/deployment/schema.js verify --database $Database --runtime-role srvpro_runtime --report C:\srvpro-private\reports\schema-runtime.json
  if ($LASTEXITCODE -ne 0) { throw 'Runtime schema verification failed' }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  $env:PGUSER='srvpro_operator'
  Remove-Variable secret,credential
}
```

退出码为 0 且报告 `ok:true` 才继续；报告中的 warning 交维护者核对。
这一步不启动游戏，也不能代替后面的真实注册、对局、结算和新录像验收。

### 4. 配置与普通服务账户

仍在管理员 PowerShell，创建普通账户。密码输入时不显示；记在自己的密码管理器里，
第 5 节注册计划任务时需要同一个密码。不得加入 Administrators。

```powershell
if (Get-LocalUser -Name srvprosvc -ErrorAction SilentlyContinue) { throw 'Service user already exists' }
$ServicePassword=Read-Host 'New srvprosvc password' -AsSecureString
$ServiceUser=New-LocalUser -Name srvprosvc -Password $ServicePassword -Description 'SRVPro test VM service'
Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $ServiceUser
Remove-Variable ServicePassword
$SvcSid=$ServiceUser.SID.Value
foreach ($path in @('C:\srvpro-pm2','C:\srvpro-tools\pm2','C:\srvpro-lab\shared')) {
  if (Test-Path -LiteralPath $path) { throw "Target already exists: $path" }
  New-Item -ItemType Directory -Path $path | Out-Null
}
foreach ($name in @('logs','replays','tournament-decks','tournament-logs','deck_log')) {
  New-Item -ItemType Directory -Path "C:\srvpro-lab\shared\$name" | Out-Null
}
```

新装把两个无凭据模板复制到下列位置；这些命令拒绝覆盖已有配置。
恢复路线跳过这一块，将已验证恢复文件按本批路径表放到相同目标，再核对目标数据库名和路径。

```powershell
foreach ($name in @('config\config.json','plugins\postgres-compat\config.json')) {
  if (Test-Path -LiteralPath "$App\$name") { throw "Config already exists: $name" }
}
if (-not (Test-Path -LiteralPath "$App\config")) { New-Item -ItemType Directory -Path "$App\config" | Out-Null }
Copy-Item -LiteralPath C:\srvpro-input\windows.server.config.json -Destination "$App\config\config.json"
Copy-Item -LiteralPath "$App\ops\templates\postgres-compat.config.example.json" -Destination "$App\plugins\postgres-compat\config.json"
notepad.exe "$App\config\config.json"
notepad.exe "$App\plugins\postgres-compat\config.json"
```

第一份由维护者按模板和完整规则提前生成，材料名固定为 `windows.server.config.json`；不含密码。
用记事本按私有参数页填写完整规则和数据库运行密码，
adapter `enabled:true`、`synchronize:false`，连接运行角色而非 postgres/operator。
模板中的 Linux 路径改为本机 `C:/srvpro-lab/shared/.../`，创建对应目录，保留末尾 `/`。
保留维护提示和关闭外发 webhook/update_util。主配置覆盖片段不能替操作者猜 hostinfo/禁表/协议版本。
首次新装另创建只有 stop 权限的 maintenance 管理账号，JSON 格式见 [维护账号](maintenance.md#维护管理账号和操作)；
Windows 可以在管理员 PowerShell 直接创建，不运行 Linux chown 示例：

```powershell
$target="$App\config\admin_user.json"
if (Test-Path -LiteralPath $target) { throw 'Admin configuration already exists' }
$secret=Read-Host 'New maintenance password' -AsSecureString
$credential=New-Object System.Management.Automation.PSCredential('maintenance',$secret)
$password=$credential.GetNetworkCredential().Password
if (-not $password -or $password -match '[\r\n\x00]') { throw 'Invalid password' }
$payload=@{file='./config/admin_user.json';permission_examples=@{};users=@{maintenance=@{password=$password;enabled=$true;permissions=@{stop=$true}}}}
[IO.File]::WriteAllText($target,($payload | ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding $false))
Remove-Variable secret,credential,password,payload
```

最后限制目录权限。下面只作用于新建的测试目录；代码、引擎、查询库只读；
PM2 home、config、日志和 shared 可写。不要改成盘符根目录，不要对正式目录照抄。

```powershell
function Set-LabDirectoryAcl([string]$Path,[string]$ServiceRights) {
  $acl=New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true,$false)
  foreach ($entry in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($SvcSid,$ServiceRights))) {
    $identity=New-Object System.Security.Principal.SecurityIdentifier($entry[0])
    $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,$entry[1],'ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
Set-LabDirectoryAcl $App 'ReadAndExecute'
Set-LabDirectoryAcl 'C:\srvpro-tools\pm2' 'ReadAndExecute'
Set-LabDirectoryAcl 'C:\srvpro-pm2' 'Modify'
Set-LabDirectoryAcl 'C:\srvpro-lab\shared' 'Modify'
Set-LabDirectoryAcl "$App\config" 'Modify'
if (-not (Test-Path -LiteralPath "$App\logs")) { New-Item -ItemType Directory -Path "$App\logs" | Out-Null }
Set-LabDirectoryAcl "$App\logs" 'Modify'
Set-LabDirectoryAcl "$App\plugins\postgres-compat" 'ReadAndExecute'
```

游戏启动不需要写代码。管理页面另外会改卡组模板、分类和展示文件，
按 [部署参数表](../templates/deployment-profile.example.json) 的 `mutablePluginAssets`
逐项映射 shared 后再验证页面保存；初次只做普通对局时不因此授予整个 plugins 写权限。
`ops.pgpass` 只在 `C:\srvpro-private`，不能放进 svc 可读的游戏 config。
账户密码过期或轮换后按 [5.8](#58-服务账户密码到期与轮换) 更新计划任务；不改成管理员或免密账户。

固定 PM2 安装只写文件，不启动 daemon：

```powershell
npm.cmd install --prefix C:\srvpro-tools\pm2 --save-exact pm2@6.0.14
if ($LASTEXITCODE -ne 0) { throw 'PM2 install failed' }
```

保存生成的 package-lock.json，重装按同一锁执行 npm ci。
管理员不要执行 pm2 status/jlist/start；CLI 即使只查状态也可能启动 daemon。

### 5. 服务配置、首次启动与开机恢复

游戏服务由三个计划任务以 srvprosvc 身份运行仓库脚本 `ops/scripts/windows-service/srvpro-service.ps1`：

| 任务 | 触发 | 作用 |
| --- | --- | --- |
| `<前缀>-Start` | 手动，仅首次 | 等 PG 可连接 → `pm2 start` → 等游戏端口可连接 → `pm2 save` |
| `<前缀>-Save` | 手动，按需 | 只在本机自己的 PM2 daemon 运行时 `pm2 save` |
| `<前缀>-Startup` | 开机后 30 秒，不需要登录（也可用 `-RunTask Startup` 手动跑一次，见 5.7） | 等 PG → 核对 dump.pm2 → `pm2 resurrect` → 等游戏端口 |

管理员和操作者都**不直接运行 PM2 命令**。以管理员身份运行任何 pm2 命令（包括 status、jlist）都可能拉起第二个属于管理员的 daemon。
查看状态一律用只读的 `check-service.ps1`；它的 `-RunTask` 可取 Start、Save 或 Startup，只启动对应任务一次。
这套流程已在 Windows Server 2022 测试 VM 上通过 Save 任务和无人登录重启恢复的实测（2026-11-14）；Start 任务和三个脚本的正式版本仍需在干净 VM 上重新走一遍。

下面每块都在**管理员 PowerShell**（右键“以管理员身份运行” Windows PowerShell 5.1）中执行；不需要 runas 切换账户。
某块报错就停止，保存屏幕输出和 `C:\srvpro-lab\shared\logs` 中最新的 `service-*.log`。

#### 5.1 服务配置

维护者在私有参数页写明以下各项；与模板不同的项才需要修改。模板值已与本手册的路径一致，通常什么都不用改，只需对照私有参数页核对：

| 字段 | 含义 | 模板值 |
| --- | --- | --- |
| `appName` | PM2 应用名，只能用字母、数字、`.`、`_`、`-` | `srvpro-lab` |
| `taskPrefix` | 三个计划任务的名称前缀 | `SRVPro-Lab` |
| `serviceAccount` | 第 4 节创建的普通本地账户名 | `srvprosvc` |
| `applicationDir` / `startScript` | 游戏程序目录与入口文件 | `C:\srvpro-lab\release\application` / `ygopro-server.js` |
| `nodeExe` / `pm2Cli` | Node 与第 4 节固定安装的 PM2 | `C:\Program Files\nodejs\node.exe` / `C:\srvpro-tools\pm2\node_modules\pm2\bin\pm2` |
| `pm2Home` / `logDir` | PM2 数据目录与启动日志目录（svc 可写） | `C:\srvpro-pm2` / `C:\srvpro-lab\shared\logs` |
| `postgres` | 本机 PG 地址、端口、最长等待秒数、Windows 服务名 | `127.0.0.1`、`5432`、`180`、`postgresql-x64-17` |
| `listenPorts` / `listenWaitSeconds` | 游戏启动后必须能连上的端口和最长等待秒数 | `7911,7922,7977` / `180` |
| `cliTimeoutSeconds` | 每次 PM2 命令的最长秒数 | `180` |

路径必须是 `C:\...` 形式的绝对路径，不能以 `\` 结尾，也不能包含 `"`、`&`、`|`、`<`、`>`、`^`、`%`、`!`。脚本遇到这些字符会直接拒绝，不会转义后继续执行。
配置文件放在只有管理员能修改、svc 只能读取的独立目录 `C:\srvpro-service`。不能放进 svc 可写的游戏 `config` 目录：管理员运行的核查脚本会使用配置里的 Node 路径。
下面第一块如果中途停下，而 `C:\srvpro-service` 已经存在，不要直接删除：先检查里面是否只有这一步创建的内容（可能有 `windows-service.json`），然后从出错的那一行起手工继续，或找维护者。

```powershell
$App='C:\srvpro-lab\release\application'
$Svc='C:\srvpro-service'
$Cfg="$Svc\windows-service.json"
if (Test-Path -LiteralPath $Svc) { throw 'C:\srvpro-service already exists; inspect it first' }
New-Item -ItemType Directory -Path $Svc | Out-Null
$SvcSid=(Get-LocalUser -Name srvprosvc).SID.Value
$acl=New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
foreach ($entry in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($SvcSid,'ReadAndExecute'))) {
  $identity=New-Object System.Security.Principal.SecurityIdentifier($entry[0])
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity,$entry[1],'ContainerInherit,ObjectInherit','None','Allow')))
}
Set-Acl -LiteralPath $Svc -AclObject $acl
Copy-Item -LiteralPath "$App\ops\templates\windows-service.example.json" -Destination $Cfg
notepad.exe $Cfg
```

保存记事本后检查配置。输出各项路径就是通过；报错时按提示修改配置，再重新运行这一块：

```powershell
. "$App\ops\scripts\windows-service\srvpro-service.lib.ps1"
$c=Read-SrvproServiceConfig $Cfg
Assert-SrvproConfigFilesExist $c
$c | Format-List appName,taskPrefix,serviceAccount,scriptPath,pm2Home,logDir,listenPorts
```

#### 5.2 “作为批处理作业登录”权限

计划任务在无人登录时运行，需要这项权限。脚本只给 srvprosvc 加这一项，并核对其他用户权限没有变化。证据目录必须是新目录：

```powershell
$App='C:\srvpro-lab\release\application'; $Cfg='C:\srvpro-service\windows-service.json'
& "$App\ops\scripts\windows-service\grant-batch-logon.ps1" -ConfigPath $Cfg -EvidenceDir ('C:\srvpro-private\reports\batch-logon-'+(Get-Date -Format yyyyMMddHHmmss))
```

成功输出 `Granted SeBatchLogonRight ... other user rights unchanged` 或 `Already granted`。
如果提示账户在“拒绝作为批处理作业登录”中，或组策略由域控制，交维护者处理；不能改用 Administrator 或 SYSTEM 运行。

#### 5.3 注册计划任务

```powershell
$App='C:\srvpro-lab\release\application'; $Cfg='C:\srvpro-service\windows-service.json'
& "$App\ops\scripts\windows-service\register-tasks.ps1" -ConfigPath $Cfg
```

按提示输入 srvprosvc 的 Windows 密码（不显示）。脚本先检查以下各项，任一不满足就停止，什么都不注册：
- 当前为管理员；
- srvprosvc 存在、已启用、不在 Administrators 中；
- 已有批处理登录权限；
- PG 服务为自动启动；
- 配置、脚本、Node、PM2 目录都不能被 svc 或 Users 修改。

成功时列出三个任务，均为 `runlevel=Limited logon=Password`，最后显示 `Nothing was started`。
已存在同名任务时脚本拒绝覆盖；不要手工删除任务后重注册正在运行的服务，先找维护者。

**注册中途失败后的清理。** 如果 register-tasks.ps1 中途失败，或提示 `Tasks already exist` 但服务其实从未启动过，可以删掉残留任务后重新执行本节。
**只有服务从未启动过时才能这样做。** 下面的块先核对这一点，任何一个 `throw` 触发就停止，找维护者：

```powershell
$App='C:\srvpro-lab\release\application'; $Cfg='C:\srvpro-service\windows-service.json'
. "$App\ops\scripts\windows-service\srvpro-service.lib.ps1"
$c=Read-SrvproServiceConfig $Cfg
if (Test-Path -LiteralPath ($c.pm2Home + '\dump.pm2')) { throw 'dump.pm2 exists: the service was started before; ask the maintainer' }
if ([IO.Directory]::GetFiles('\\.\pipe\') -contains '\\.\pipe\rpc.sock') { throw 'A PM2 daemon is running; ask the maintainer' }
$n=Get-SrvproTaskNames $c
foreach ($t in $n.Start,$n.Save,$n.Startup) {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $t -Confirm:$false; "removed $t" }
}
```

注册时 srvprosvc 密码输错，通常在第一个任务就失败，不会留下任何东西；这时直接重新运行本节即可。

#### 5.4 首次启动

确认这台机器上没有任何 PM2 daemon（第 1 节的检查块），然后：

```powershell
$App='C:\srvpro-lab\release\application'; $Cfg='C:\srvpro-service\windows-service.json'
& "$App\ops\scripts\windows-service\check-service.ps1" -ConfigPath $Cfg -RunTask Start
```

脚本只启动一次 Start 任务，等它结束后做全部检查。它不靠任务的“上次运行时间”判断结束（那个时间可能与实际差十几秒，校时后还可能倒退），而是认这次运行新写出的 `service-start-*.log`：日志里有 `result=0/1`、且任务不再是 Running，才算结束；日志结果和任务结果不一致也判失败。最多等 15 分钟；超时时输出提示并以退出码 2 结束，任务保持原样，**不要再启动一次**，先看最新的 `service-start-*.log`。成功判据：
- 有 `CHECK task-Start PASS` 一行，最后是 `FAILED=` 且后面为空；
- `single-pm2-daemon`、`daemon-identity`、`single-game-process`、各 `port`、`dump` 都是 PASS。

Startup 任务此时还没运行过，会被跳过，不算失败。输出里的 `INFO task-last-result` 行（Start、Save 的上次结果）只是提示，旧的被拒绝的运行不算失败；任务结果里算检查项的只有 `task-Start` 和 Startup 任务的 `task-result`，其余 `CHECK` 行照常都要 PASS。
接着打开 `C:\srvpro-lab\shared\logs\service-start-*.log`，应以 `result=0` 结尾。
再查看 `C:\srvpro-pm2\logs\srvpro-lab-out.log`：数据库连接、全部必需插件、四语卡库加载应正常，并出现 `server started 7911`；维护状态下还会提示服务器维护中。

“PG 可以连接”和“游戏已经监听”是两件事。游戏进程启动后，还要连库、加载卡库和插件，约 20–30 秒才开始监听。
脚本会等到 `listenPorts` 全部能连上；超过 `listenWaitSeconds` 仍不行，就判失败，并且**不会执行 save**。
这时 PM2 daemon 和游戏进程会留着运行，方便查看日志，处理方法见 5.7 的“Start 没有完成”。
再次运行 Start 时，如果发现自己的 daemon 正在运行、但还没有 dump.pm2，会接着完成上次的启动：不再执行 pm2 start，只等端口，然后保存。

不启动 Bot，不另起 npm start，不复制正式机 dump.pm2，不操作其他 PM2 应用。

#### 5.5 以后保存进程列表

只有维护者改变了 PM2 应用定义后才需要保存：

```powershell
$App='C:\srvpro-lab\release\application'; $Cfg='C:\srvpro-service\windows-service.json'
& "$App\ops\scripts\windows-service\check-service.ps1" -ConfigPath $Cfg -RunTask Save
```

Save 只在“rpc.sock 管道的服务端就是 pm2.pid 记录的、srvprosvc 运行的这份 PM2”时执行。没有 daemon 时拒绝执行，以免保存一份空列表覆盖 dump.pm2。

`pm2 save` 会用 daemon 当前持有的列表直接覆盖 dump.pm2，所以写入前后各有一道保护：
- **写入前**：通过只读 RPC 查询正在运行的应用（不用 PM2 命令，不会拉起 daemon）。必须正好一个，名称、脚本、cwd 与配置一致，fork 模式，watch=false，状态 online；任何一项不符就不执行 save，dump.pm2 不变。
- **写入时**：先把原 dump 复制为 `C:\srvpro-pm2\dump.pm2.before-save-<时间>`。
- **写入后**：新 dump 不符合要求时，自动把原 dump 复制回来；如果原来没有 dump，就把这份不合格的改名为 `dump.pm2.rejected-<时间>` 留着。

这些副本含 PM2 环境变量，只留在 svc 和管理员可读的 PM2 目录，不要拷出或上传；确认无用后由维护者删除。

#### 5.6 开机恢复与无人登录验收

只重启测试 VM，不重启宿主或正式服。先按 [维护开关操作](maintenance.md#维护开关操作) 确认 `maintenanceEnabled=true`、`rooms=0`、`readyToStop=true`，再注销所有交互登录并重启。
**重启后先不要登录。** 在另一台机器上执行 `Test-NetConnection <VM 地址> -Port 7911`（可连通即可）；或者至少等 5 分钟后再登录。登录后运行：

```powershell
$App='C:\srvpro-lab\release\application'; $Cfg='C:\srvpro-service\windows-service.json'
& "$App\ops\scripts\windows-service\check-service.ps1" -ConfigPath $Cfg
```

成功判据：
- 全部 PASS，`task-result <前缀>-Startup` 为 0（`INFO task-last-result` 行只是提示，不算检查）；
- `daemon ... afterBoot=True`，游戏进程的 created 时间晚于开机时间；
- daemon 和游戏进程的创建时间都早于你这次登录。这说明服务是在无人登录时起来的；
- `C:\srvpro-lab\shared\logs\service-resurrect-*.log` 以 `result=0` 结尾，`resurrect-*.stderr.log` 为空；
- 维护状态仍为开启。

隔几分钟再运行一次，daemon 和游戏进程的 PID 应保持不变。
端口监听只证明服务起来了，不能代替第 6 节的真实客户端对局验收。

#### 5.7 常见失败与处理

任务失败时，先看对应的 `service-<模式>-*.log` 中 `result=1 error=` 一行：

| 现象 | 原因与处理 |
| --- | --- |
| `Must run as ...` / `must not be an administrator` | 任务身份不对，或 svc 被加入了管理员组。不要放宽检查，按 5.3 核对账户 |
| `PostgreSQL ... not reachable` | PG 服务没启动或端口不对；检查 PG 服务和配置中的 `postgres` |
| `A foreign PM2 daemon serves rpc.sock` | 有不属于 srvprosvc 的 PM2 占用了管道，可能是有人以管理员身份运行过 pm2，或者装了其他 PM2；Start、Resurrect 都会拒绝。不要 kill，保持现场，找维护者 |
| `dump.pm2 already exists, so the first start is complete` | Start 只用于首次启动。服务在运行时用 Save；服务没在运行时见下面“服务没在运行，但 dump.pm2 已存在” |
| `Save requires the running own PM2 daemon` | 服务没在运行，或 daemon 不属于 srvprosvc；先用 check-service 查看 |
| `PM2 must manage exactly one application` / `PM2 application ... mismatch` / `status is ...`，并带 `pm2 save not run` | 运行中的应用和配置不一致，或不是 online；dump.pm2 没有被改动。看应用日志，找维护者 |
| `... previous dump.pm2 restored from ...` / `... moved to ...` | pm2 save 写出的 dump 不合格，已还原原来的 dump（或把这份移到一边）；找维护者 |
| `dump.pm2 ... mismatch` / `exactly one application`（Startup 时） | dump 与配置不一致，Startup 不恢复；不要手工编辑 dump，找维护者 |
| `Application ports not listening within`（Start） | 见下面“Start 没有完成” |
| `Application ports not listening within`（Startup） | 游戏启动失败或启动太慢；看 `C:\srvpro-pm2\logs\<应用名>-error.log` 与 `-out.log` |
| `check-service` 显示 `task ended without writing a service log` | 读取配置或检查身份时就失败了，所以没写出日志；在管理员窗口重新做 5.1 的配置检查 |
| `check-service` 退出码 2 | 任务在等待时间内没结束。不要再启动一次；看最新的 `service-<模式>-*.log` 和任务计划程序中的任务状态 |
| `pm2 ... failed with exit code N` | PM2 命令本身失败；看同一时间戳的 `<命令>-*.stderr.log` |
| 任务结果 `267011` | 任务从未运行（例如 Startup 在第一次重启前），不是失败 |
| 任务结果 `2147943726`（0x8007052E） | 账户名或密码错误，通常是密码已修改或过期；按 5.8 更新 |
| 任务结果 `2147943785`（0x80070569） | 没有批处理登录权限；重新执行 5.2 |
| `check-service` 显示 `single-pm2-daemon FAIL` | 机器上有多个 PM2 daemon；不要用 pm2 命令处理，保持维护并找维护者 |
| `Cannot identify the PM2 rpc.sock server process` | rpc.sock 管道存在，但服务账户查不到它的服务端进程，通常是别的用户或管理员启动的 PM2 daemon；按上面 `A foreign PM2 daemon` 一行处理：不要 kill，保持现场，找维护者 |
| `Read-only PM2 query failed with exit code N: ...` | 读取运行中应用列表失败。看这条消息和日志目录里的 `liveapps-*.stderr.log` 找原因；`pm2 save` 没有执行 |
| `PM2 daemon changed during save` | 保存期间 daemon 退出或被换掉了。dump.pm2 已还原；可能有一个新的空 daemon 在运行。先运行 check-service，再找维护者 |
| `PM2 must manage exactly one application, found 0`（重新运行 Start 时） | daemon 在运行但没有游戏应用。用下面“Start 没有完成”里的手工停止步骤停掉，再重新运行 5.4 |
| `check-service` 显示 `service log has no result line` | 任务被中断（例如超过 15 分钟限制），日志里没有写出结果。先看日志和任务状态，再决定是否重试 |
| `INFO task-last-result` 行（Start、Save） | 只是提示：旧的被拒绝的运行不算失败。任务结果里算检查项的只有 `task-<RunTask>` 和 Startup 任务的结果 |

失败后保持维护状态，保留日志，不要反复重启或重试；Startup 任务失败后自己会在 1 分钟后重试，最多 3 次。

**Start 没有完成**（日志里有 `Application ports not listening ... left running ... run the Start task again`）：
这时 daemon 和游戏进程还在运行，但还没有保存 dump.pm2。先看 `C:\srvpro-pm2\logs\<应用名>-out.log` 和 `-error.log`，然后分两种情况处理：

1. **游戏只是启动慢，或者已经修好了外部原因**（比如 PG 数据、端口占用）：再运行一次 `check-service.ps1 -ConfigPath $Cfg -RunTask Start`。它会接着完成：不再执行 pm2 start，等端口后保存；日志里能看到 `resuming an unfinished Start`。
2. **游戏本身启动失败**（日志报错，或者再次运行 Start 时报 `status is errored` 这类“不是 online”的错误）：要先停掉这次启动的 daemon，修正问题后再重新 Start。只在 check-service 显示 `daemon-identity PASS`（daemon 属于 srvprosvc）时才这样做。在管理员 PowerShell 中执行：

```powershell
$App='C:\srvpro-lab\release\application'; $Cfg='C:\srvpro-service\windows-service.json'
& "$App\ops\scripts\windows-service\check-service.ps1" -ConfigPath $Cfg
# 从输出抄下 "daemon pid=" 和 "single-game-process ... pid=" 后面的数字，填到下面两个变量；没有游戏进程就保持 $GamePid=0
$DaemonPid=0; $GamePid=0
if ($DaemonPid -le 0) { throw 'Fill in the daemon pid from check-service' }
Stop-Process -Id $DaemonPid -Force
if ($GamePid -gt 0 -and (Get-Process -Id $GamePid -ErrorAction SilentlyContinue)) { Stop-Process -Id $GamePid -Force }
Start-Sleep -Seconds 3
if ([IO.Directory]::GetFiles('\\.\pipe\') -contains '\\.\pipe\rpc.sock') { throw 'rpc.sock still exists; stop here and ask the maintainer' }
$left=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'ProcessContainerFork\.js' })
if ($left) { $left | Format-Table ProcessId,ParentProcessId,CreationDate; throw 'A PM2-started node process is still running; stop here and ask the maintainer' }
$busy=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { 7911,7922,7977 -contains $_.LocalPort })
if ($busy) { $busy | Format-Table LocalPort,OwningProcess; throw 'A game port is still in use; stop here and ask the maintainer' }
Get-Process -Name ygopro -ErrorAction SilentlyContinue | Format-Table Id,StartTime
```

必须先停 daemon，再停游戏进程：daemon 还活着时，游戏一被杀它就会立刻把游戏重新拉起来。
两个都要加 `-Force`，否则 PowerShell 会对属于其他用户（srvprosvc）的进程逐个询问确认，重新拉起的游戏就会变成没人管的孤儿进程，继续占着端口。
`Get-NetTCPConnection` 那一行写的是模板端口 `7911,7922,7977`；如果配置里的 `listenPorts` 改过，请换成配置里的端口。
最后一行列出的 ygopro 引擎进程，在维护状态下应当没有；如果有，交维护者处理。
这是“Start 没有完成”的情形：确认 `C:\srvpro-pm2\dump.pm2` 不存在（Start 失败时不会生成），修正问题后重新运行 5.4。dump.pm2 已经存在时不适用，见下一部分。
不要用 `pm2 kill`、`pm2 delete` 或删除 `C:\srvpro-pm2` 来代替上面的步骤。

**服务没在运行，但 dump.pm2 已存在**（首次启动已经完成之后）：这时 Start 会拒绝（dump 已存在），Save 也会拒绝（没有 daemon）。
不重启整台机器就把服务拉回来（例如 Startup 任务失败，或者 daemon/游戏退出且原因已排除），按顺序做：

1. 先运行不带 `-RunTask` 的 check-service，看现状：`& "$App\ops\scripts\windows-service\check-service.ps1" -ConfigPath $Cfg`。
2. 如果 srvprosvc 的 PM2 daemon 还在运行、但游戏不正常，先用上面“Start 没有完成”里的手工停止步骤把它停掉。这里**不要删除** dump.pm2。
3. 运行下面一行。它把 Startup 任务手动启动一次（和开机时同一条 resurrect 路径），然后做全部检查：

```powershell
$App='C:\srvpro-lab\release\application'; $Cfg='C:\srvpro-service\windows-service.json'
& "$App\ops\scripts\windows-service\check-service.ps1" -ConfigPath $Cfg -RunTask Startup
```

Startup 任务失败后会自己在 1 分钟后重试，最多 3 次。所以如果这次结果是 FAIL，先等大约 5 分钟，再不带 `-RunTask` 运行一次 check-service，之后才决定怎么办。整个过程保持维护状态开启。

#### 5.8 服务账户密码到期与轮换

`Get-LocalUser srvprosvc | Select-Object PasswordExpires` 可以查看到期时间。到期后计划任务会以 0x8007052E 失败，所以要按组织策略定期轮换（或由维护者决定设置永不过期）。轮换在维护窗口进行：

```powershell
$App='C:\srvpro-lab\release\application'; $Cfg='C:\srvpro-service\windows-service.json'
Set-LocalUser -Name srvprosvc -Password (Read-Host 'New srvprosvc password' -AsSecureString)
& "$App\ops\scripts\windows-service\register-tasks.ps1" -ConfigPath $Cfg -UpdatePassword
& "$App\ops\scripts\windows-service\check-service.ps1" -ConfigPath $Cfg -RunTask Save
```

最后一步借一次 Save 任务验证新密码可以登录；它不重启游戏。

`register-tasks.ps1 -UpdatePassword` 只修改三个任务里保存的密码，其他设置不动。

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
