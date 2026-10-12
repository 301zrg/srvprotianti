# Windows Server 安装与原生验证

2026-10-12 第二阶段新增路线：Windows Server 2022 x64、Node 24、Python 3.12+、PostgreSQL 17。
现服虽然使用 Windows，本指南针对全新隔离实例；不在 `C:\srvpro` 或正式数据库内做测试。
Windows 真机/服务验收与 Linux 分开记录，具体证据见 [验证矩阵](validation.md)。

## 1. 新机依赖和目录

安装 Git/Git LFS、固定 Node、Python、PostgreSQL 17 server/client，核对 `node --version`、
`python --version`、`git lfs version`、`psql --version`；不要因缺 17 临时换成其他大版本。
需要本机构建引擎时另装 VS2022 C++ Build Tools/SDK，或取得带来源/编译记录/逐文件 manifest 的固定 Windows 引擎制品。
安装来源见 [Node](https://nodejs.org/en/download)、[PostgreSQL Windows](https://www.postgresql.org/download/windows/)。

建议新目录（名字由操作者确定，任何同名既有目录先停止核对）：

```text
C:\SrvProStage2\
  source\             审核的服务端 checkout；npm ci/build 在这里进行
  staging\            新源码构建、卡池下载、候选引擎
  releases\<id>\      application\ 与 components\engine\、catalog\
  shared\             私有 config、日志、录像、可写业务资源
  service\            私有服务包装器及配置
  reports\            本轮验证报告
```

代码分支和完整 commit 先固定。已有 release 使用 `ops.py verify-release/unpack-release` 校验并解包到新目录。
源码不等于可部署制品；必须纳入实际运行的公共新增文件，并保留相对路径和 package-lock。

## 2. 安装引擎、卡池、脚本与查询库

按 [YGOPro 安装/更新](ygopro-install.md) 执行 Windows 源码准备、原生编译与 assemble。
当前 706 流程启用固定旧裁定覆盖；只安装基础模式时省略 overlay，并另做规则验收。
四语查询库仍单独下载：

```powershell
Set-Location 'C:\SrvProStage2\source'
python ops\scripts\engine-source.py --platform windows --destination 'C:\SrvProStage2\staging\engine-build-v1' --versions ops\versions.json
python ops\scripts\engine.py fetch-pool --destination 'C:\SrvProStage2\staging\engine-pool-v1' --versions ops\versions.json
python ops\scripts\ops.py catalog-fetch --destination 'C:\SrvProStage2\staging\catalog-v1' --versions ops\versions.json
python ops\scripts\ops.py catalog-check --catalog 'C:\SrvProStage2\staging\catalog-v1' --versions ops\versions.json
```

执行每条 native command 后检查退出码，非零立即停止；已有目标只能检查，不能用覆盖下载消除差异。
引擎在新 application 的 `ygopro` 下必须有 Windows `ygopro.exe`、固定 cards.cdb、基础 script、禁表和选定覆盖。
将四语实体文件置于 application/plugins/card-catalog/databases。可以在新 release 创建经过核对的 junction，
但 preflight/备份工具传实际目录；制作跨平台制品前先 materialize 链接。

## 3. 应用、数据库与私有配置

在新 application 内执行 `npm ci`、`npm run build`、`npm test` 和 schema contract 检查。
不要使用别的 Windows/Linux 工作区的 node_modules。服务进程 cwd 必须是 application；
直接运行 Node，日志由包装器处理，不将 `npm start` 的管道当作 Windows 服务。

全新空库按 [数据库初始化](database-init.md) 创建 owner/runtime 角色并显式 init/grant/verify；
已有库按 [联合恢复](backup-restore.md) 走新空库恢复，不开 `synchronize`，不重复重置积分或连胜。
Windows PostgreSQL 认证文件由管理员私下管理，应用和维护账号分开。
`config/config.json`、`config/admin_user.json` 和本地插件 config 仍为私有输入；
端口、录像路径、PG17 连接与是否 stop 由本实例自己的配置决定，不能复制正式服密码作为测试默认值。

录像目录使用明确 Windows 路径，并按宿主拼接要求保留末尾分隔符，例如
`C:/SrvProStage2/shared/replays/`。确认运行账号只能写 shared、所需业务资源和日志，
不可写全部旧 release；Windows ACL 与 Linux mode 不互相替代。

## 4. 预检与独立引擎启动

```powershell
python ops\scripts\ops.py preflight --platform windows --application 'C:\SrvProStage2\releases\v1\application' --engine 'C:\SrvProStage2\releases\v1\components\engine' --catalog 'C:\SrvProStage2\releases\v1\components\catalog' --versions ops\versions.json
python ops\scripts\engine.py verify --platform windows --engine 'C:\SrvProStage2\releases\v1\components\engine' --versions ops\versions.json
python ops\scripts\engine.py smoke --platform windows --engine 'C:\SrvProStage2\releases\v1\components\engine' --versions ops\versions.json --report 'C:\SrvProStage2\reports\engine-smoke-v1.json'
```

预检检查原生 Windows/x64、Node、PE32+、卡池指纹及四库。smoke 检查实际加载/临时 TCP 并停止自己启动的引擎。
两者都不替代宿主启动、普通房/TT、旧裁定效果、恢复、结算或正式 TLS/WSS 验收。

## 5. 原生 PG17 空库与联合恢复演练

以下只用于新隔离 cluster，loopback 55432，不能指向现服。先确认该端口未被其他服务占用，
`C:\SrvProStage2\staging\pg17-v1` 不存在；Python/Node 依赖已准备。

```powershell
$pgBin = 'C:\Program Files\PostgreSQL\17\bin'
$cluster = 'C:\SrvProStage2\staging\pg17-v1'
if (Test-Path -LiteralPath $cluster) { throw 'Cluster must be new' }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 55432)
$listener.Start(); $listener.Stop()
& (Join-Path $pgBin 'initdb.exe') -D $cluster -U stage2_owner --auth=trust --encoding=UTF8 --locale=C
if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
$env:PGHOST = '127.0.0.1'; $env:PGPORT = '55432'; $env:PGUSER = 'stage2_owner'
$env:PGOPTIONS = $null; $env:PGPASSWORD = $null; $env:PGPASSFILE = $null; $env:PGDATABASE = $null
$env:SRVPRO_SCHEMA_TEST_CONFIRM = 'isolated'
& (Join-Path $pgBin 'pg_ctl.exe') -D $cluster -l ($cluster + '.log') -o '-h 127.0.0.1 -p 55432' -w start
if ($LASTEXITCODE -ne 0) { throw 'pg_ctl start failed' }
try {
    node plugins\postgres-compat\deployment\isolated-postgres.test.js --pg-bin $pgBin --report-dir 'C:\SrvProStage2\reports\schema-win17-v1'
    if ($LASTEXITCODE -ne 0) { throw 'Schema drill failed' }
    python ops\scripts\drill.py --server-source '.' --workdir 'C:\SrvProStage2\reports\joint-win17-v1' --suffix win17v1 --confirm-isolated-cluster 127.0.0.1:55432 --pg-bin $pgBin
    if ($LASTEXITCODE -ne 0) { throw 'Joint drill failed' }
} finally {
    & (Join-Path $pgBin 'pg_ctl.exe') -D $cluster -m fast -w stop
}
```

报告/后缀每次不同，结束停止本任务创建的 cluster。trust 只在该隔离 loopback 演练使用。
`drill.py` 的隔离模式不检查 Windows 服务停写，报告中的 systemd/完整引擎状态仍为 false。
正式 Windows 备份停写能力不能从这段演练推定：原 `ops.py backup` 的默认 writer 检查是 systemd，
本轮没有将其改为生产 Windows SCM 自动检查。正式 Windows 联合备份须单独审核停所有 writer 的方案，
或先在私有停写目录/新隔离目标验证工具；不能用 `--confirm-isolated` 绕过正式停写检查。

## 6. Windows 服务、重启和网络验收

正式运行选能托管 Node 的 Windows 服务包装器，例如经过审核的 WinSW；不要把普通 node.exe 直接注册成 SCM 服务。
本批提供 [无凭据 XML 模板](../templates/windows-service.example.xml)，包装器二进制由操作者从
[固定 WinSW v2.12.0 来源](https://github.com/winsw/winsw/releases/tag/v2.12.0) 另行审核/记录 SHA。
本轮未提供其制品 SHA，也未在服务器安装它；不把该模板写成已经验证的正式服务方案。
配置的 workingdirectory、Node 完整路径、日志路径与服务名称须按新实例修改。
WinSW 默认服务身份需显式检查，在首次启动前通过服务管理界面配置专用低权限运行账号，
PG 和管理凭据仅在该实例的私有设置中提供。[WinSW 配置依据](https://raw.githubusercontent.com/winsw/winsw/v2.12.0/doc/xmlConfigFile.md)

安装、启动、停止仅在获授权的新测试机管理员 PowerShell 执行；包装器和 XML 同名：

```powershell
& 'C:\SrvProStage2\service\SrvProTianti.exe' install
Get-Service -Name SrvProTianti
# 先配置服务运行账号、私有凭据、ACL 及 modules.stop=true，再启动。
& 'C:\SrvProStage2\service\SrvProTianti.exe' start
Get-Service -Name SrvProTianti
```

验收 stop 维护接口、自然排空、服务停止后所有本实例 YGOPro/Node writer 退出，无孤儿进程；
异常退出恢复与 Windows reboot 后的版本、工作目录、账号权限、PG 连接和端口分别留证。
服务 Running 不等于插件/四库/数据库已就绪，也不等于游戏验收通过。
包装器的停止信号/超时不能替代事先排空，停止子进程行为必须在原生 VM 实测。

游戏 TCP、原 HTTP/Neos、数据库和 TLS 的网络角色沿用 [迁址指南](server-move.md)，
Windows 使用自身防火墙/代理/证书步骤，不复制 systemctl 或 Linux Nginx 路径。
检查公网 Origin/WSS、可信代理 IP、正式证书、新客户端连接，最后完成
[完整业务验收矩阵](validation.md) 才解除维护。仅本机 TCP 或一次 101 不能证明整场稳定。

## Codex 云端与 Windows CI 的分工

Linux 云任务直接按 [Codex 云端指南](codex-cloud-testing.md) 做其真实 OS 上的检查。
Windows 原生流程使用 `windows-2022` GitHub Actions runner 或独立 Windows Server 测试 VM；
WSL、Wine、Linux 下只检查 PE 字节不能列为 Windows 部署通过。
本批 workflow 可验证双平台构建/资源/启动，PG17、服务/reboot 与真实对局按上述步骤另外补齐。
Actions 手动入口要求 workflow 文件在默认 `main` 分支；本轮 PR 目标为 `restructure2`，具体启用步骤见云端指南第 5 节。
