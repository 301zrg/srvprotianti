# 从零搭建：只用公开仓库

本页面向没有维护者交付材料的人：只用公开 GitHub 仓库，自己备齐材料，用安装脚本装出与正式服规则一致的游戏服（路线 A，新空库）。各步骤只给命令链，细节链接到专题文档。

规则一致的依据见[从零复现：范围与停点](reproduce-scope.md)：引擎资源与正式服用同一套锁。差别只有二进制，它由你自己从固定源码编译。

## 1. 选版本与平台

- 服务端仓库 `301zrg/srvprotianti` 取 main 上的一个提交，下文记为 `COMMIT`；所有固定输入都由该提交的 [ops/versions.json](../versions.json) 决定。
- 平台：Ubuntu 24.04 x86_64（[Linux 安装](linux-install.md)，systemd）或 Windows Server 2022 x64（[Windows 脚本安装](windows-install-script.md)，普通账户加 PM2）。
- 网页客户端另有仓库 `301zrg/srvprotiantiweb`，见第 6 步。

## 2. 准备机器上要有的工具

- Git（含 Git LFS）、Python 3.12+、能访问 GitHub、nodejs.org 和 npm 源的网络。
- Windows 版还需要 Visual Studio 2022 的 C++ 桌面开发组件（MSBuild）。

**为 Linux 准备材料时，最好就在 Linux 上做。** 如果在 Windows 上做，克隆时要加 `-c core.autocrlf=false`，否则 Git 会把脚本的换行转成 CRLF。

## 3. 构建交付材料

### Linux（在一台 Ubuntu 准备机上，普通用户）

```bash
set -euo pipefail
sudo apt-get update && sudo apt-get install -y git git-lfs python3 curl xz-utils
git lfs install --skip-repo
git clone -c core.autocrlf=false https://github.com/301zrg/srvprotianti.git && cd srvprotianti
git checkout --detach "$COMMIT"
W=$HOME/srvpro-build; mkdir -p "$W/materials"
# 1. 引擎源码与构建依赖（固定提交，SHA 校验）
python3 ops/scripts/engine-source.py --platform linux --destination "$W/engine-source" --versions ops/versions.json
# 2. 引擎资产：卡池、组合 utility、完整禁表（srvprotianti-resources 的固定提交）
python3 ops/scripts/engine.py fetch-assets --destination "$W/engine-assets" --versions ops/versions.json
# 3. 旧裁定覆盖层：specials 的固定提交
OLD=$(python3 -c 'import json; print(json.load(open("ops/versions.json"))["engine"]["oldRulings"]["commit"])')
git init -q "$W/specials" && git -C "$W/specials" remote add origin https://github.com/301zrg/specials.git
git -C "$W/specials" fetch -q --depth=1 origin "$OLD" && git -C "$W/specials" checkout -q --detach "$OLD"
# 4. 组出正式布局的引擎目录（Linux 不含二进制，安装时 stage 22/23 编译）
python3 ops/scripts/engine.py assemble-production --platform linux --base "$W/engine-source/source" \
  --overlay "$W/specials/706" --assets "$W/engine-assets" --destination "$W/engine" --versions ops/versions.json
# 5. 四语查询库
python3 ops/scripts/ops.py catalog-fetch --destination "$W/catalog" --versions ops/versions.json
# 6. 发布包、离线源码包
python3 ops/scripts/ops.py release --source . --release-id linux-r4-1 --output "$W/materials/server-release.tar.gz" \
  --component engine="$W/engine" --component catalog="$W/catalog"
python3 ops/scripts/ops.py verify-release --archive "$W/materials/server-release.tar.gz"
python3 ops/scripts/pack-linux-source.py --source "$W/engine-source" --versions ops/versions.json --output "$W/materials/linux-build-input"
# 7. Node 24.15.0 与官方校验文件
( cd "$W/materials" && curl -fsSLO https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz \
  && curl -fsSLO https://nodejs.org/dist/v24.15.0/SHASUMS256.txt \
  && grep ' node-v24.15.0-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum -c - )
# 8. 主配置与参数页（按第 4 步修改后再生成交接目录）
cp ops/templates/server.config.example.json "$W/materials/linux.server.config.json"
cp ops/templates/linux-handover-a.example.json "$W/params.json"
python3 ops/scripts/handover.py --repo . --commit "$(git rev-parse HEAD)" --materials "$W/materials" \
  --params "$W/params.json" --output "$W/handover-a"
```

如果网络到不了 `www.lua.org`（2026-11-23 实测：经部分代理节点会在 TLS 握手时被断开），可以从其他途径取得同一个 `lua-5.4.8.tar.gz`，加上 `--lua-archive <文件>` 再运行 `engine-source.py`。工具仍会核对 `versions.json` 里锁定的 SHA，不一致就停止。

`handover.py` 最后打印一行 `字节数<TAB>SHA-256<TAB>handover.tsv`。把这一行通过另一条渠道交给安装的人，安装时第 10 阶段会要求输入它。

### Windows（在一台装有 VS2022 的 Windows 准备机上，PowerShell 5.1）

```powershell
$ErrorActionPreference = 'Stop'
git clone https://github.com/301zrg/srvprotianti.git; Set-Location srvprotianti
git checkout --detach $COMMIT
$W = "$HOME\srvpro-build"; New-Item -ItemType Directory -Force "$W\materials" | Out-Null
python ops/scripts/engine-source.py --platform windows --destination "$W\engine-source" --versions ops/versions.json
# 编译 ygopro.exe：与 .github/workflows/stage2-engine-validation.yml 的 Windows 步骤相同
Push-Location "$W\engine-source\source"
Copy-Item -Path 'premake/*','resource/*' -Destination . -Recurse -Force
Copy-Item 'premake/event/msvc-event-config.h' 'event/include/event2/event-config.h'
Copy-Item 'event/WIN32-Code/nmake/evconfig-private.h' 'event/include/evconfig-private.h'
& .\premake5.exe vs2022 --use-simd=sse2
& MSBuild.exe build\YGOPro.sln /m /p:Configuration=Release /p:Platform=x64
Pop-Location
python ops/scripts/engine.py fetch-assets --destination "$W\engine-assets" --versions ops/versions.json
$OLD = (Get-Content ops/versions.json -Raw | ConvertFrom-Json).engine.oldRulings.commit
git init -q "$W\specials"; git -C "$W\specials" remote add origin https://github.com/301zrg/specials.git
git -C "$W\specials" fetch -q --depth=1 origin $OLD; git -C "$W\specials" checkout -q --detach $OLD
python ops/scripts/engine.py assemble-production --platform windows --base "$W\engine-source\source" `
  --overlay "$W\specials\706" --assets "$W\engine-assets" --binary "$W\engine-source\source\bin\release\x64\ygopro.exe" `
  --destination "$W\engine" --versions ops/versions.json
python ops/scripts/engine.py smoke-production --platform windows --engine "$W\engine" --versions ops/versions.json
python ops/scripts/ops.py catalog-fetch --destination "$W\catalog" --versions ops/versions.json
python ops/scripts/ops.py release --source . --release-id windows-public --output "$W\materials\server-release.tar.gz" `
  --component engine="$W\engine" --component catalog="$W\catalog"
```

**没有本地 C++ 编译环境时**：在你自己 fork 的仓库里手动运行 Actions 工作流 `Stage 2 native engine validation`。它在 GitHub 的 `windows-2022` 机器上用同一套固定源码编译，按本页命令组装并做原生冒烟，把 `ygopro.exe`、DLL 和 `SHA256SUMS` 作为产物 `stage2-windows-binary` 上传（保留 30 天）。下载后把 `--binary` 指向其中的 `ygopro.exe`，并确认 DLL 与它放在同一个目录。

之后：
1. 把 `ops/versions.json` 里 `windowsInstallers` 列出的四个安装包，从各自的官方地址下载到 `$W\materials`。
2. 准备 `install-params.json`（见 [脚本安装](windows-install-script.md#参数文件-install-paramsjson)）。
3. 把 [A 主配置模板](../templates/server.config.example.json) 的路径改成 `C:/srvpro-lab/shared/`，保存为 `windows.server.config.json`。
4. 运行下面的命令，它会核对安装包、生成 `ops-input.zip`、`pm2-lock\` 和交接清单，并打印清单的 SHA-256：

```powershell
python ops/scripts/windows-handover.py --repo . --materials "$W\materials"
```

每个原生命令之后都要检查 `$LASTEXITCODE`，不是 0 就停止。

## 4. 填参数与主配置

- 参数页样例：[Linux](../templates/linux-handover-a.example.json)；Windows 的字段见[脚本安装](windows-install-script.md)。至少改机器名、中转目录、测试来源网段。
- 主配置：模板各字段与正式服的差异，见[从零复现：A 主配置](reproduce-scope.md#路线-a-主配置模板)。端口改了，要同时改参数页。

## 5. 安装

- **Linux**：把 `handover-a` 拷到新机部署用户的家目录，运行 `sudo bash ~/handover-a/ops/install/linux/install.sh run --staging ~/handover-a`，按 [Linux 安装](linux-install.md) 走完 CP1、重启、CP2。
- **Windows**：把 `materials` 拷成新机的 `C:\srvpro-input`，按[脚本安装](windows-install-script.md)运行。

## 6. 公网入口与网页客户端

- 原生 TCP 7911 直接开放；官网与 WSS 走路线 D（Nginx/TLS）或 T（Cloudflare 隧道），见[迁址](server-move.md)。
- 网页客户端：按网页仓库 `srvprotiantiweb` 的 README 构建静态站，托管在你自己的 HTTPS 站点；把 `duel-config.js` 指向你的 `wss://…/neos`，`deckImportOrigins` 和 `websiteBaseUrl` 指向你的官网。

## 7. 验收

按 [验证记录](validation.md) 的真实服务验收表：普通房、TT 三局换备只结算一次、重连、观战、录像、官网四语页面、重启后新写入。确认禁表生效时，可以拿一套含 1103 禁卡的卡组，看是否被拒。

## 8. 可选

旧数据迁移（[联合备份与恢复](backup-restore.md)）、日常维护（[维护](maintenance.md)）、机器人（`services/`）。这些都不是首装必需的。
