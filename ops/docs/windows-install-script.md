# Windows 脚本安装

[Windows 安装](windows-install.md)手册的分步脚本版。脚本在 `ops/install/windows/`，对应手册第 1–6 节；每一块对应手册哪一步见 [MAPPING.md](../install/windows/MAPPING.md)。手册仍是依据：脚本停下时，按手册对应小节查原因。

验收情况（2026-11-22）：

- AI 在干净 VM 上走通了“无旧数据”（A）和“导入已有数据”（B）两条路线，包括两次无人登录重启。
- 项目所有者本人用脚本走通了路线 B：口令自己设定、自己输入，两轮验收用真实客户端完成。

只走过默认根目录 `C:\srvpro-lab`。

## 前提

- 干净的 Windows Server 2022 x64，用管理员账户登录；机器上没有装过本项目，也没有 PostgreSQL 服务。
- 维护者把交接材料放进 `C:\srvpro-input`，**另外**把交接清单 `handover-sha256.txt` 的 SHA-256 交给操作者。这个值不能从同一目录里抄。
- 来宾能访问 npm 源（`npm ci`）。

交接目录内容（文件名固定，大小和 SHA 写在交接清单里）：

| 文件 | 说明 |
| --- | --- |
| `server-release.tar.gz` 与 `.manifest.json` | `ops.py release` 产出的发布包（含引擎与四语库组件） |
| `ops-input.zip` | 同一提交的 `ops/` 目录，操作者自己解压 |
| `install-params.json` | 安装参数，见下节 |
| `pm2-lock\package.json`、`pm2-lock\package-lock.json` | 固定版本的 PM2 |
| `node-v24.15.0-x64.msi`、`python-3.14.10-amd64.exe`、`Git-2.56.1-64-bit.exe`、`postgresql-17.12-1-windows-x64.exe` | 依赖安装包（脚本会核对签名） |
| `windows.server.config.json` | 路线 A 的主配置（保留维护状态） |
| 批次 ZIP（如 `joint-batch-a2.zip`） | 路线 B 的联合备份批次，见 [联合恢复](backup-restore.md) |
| `handover-sha256.txt` | 清单：每行 `相对路径<TAB>字节数<TAB>SHA-256` |

**生成交接目录**：把发布包、参数文件、主配置（或批次 ZIP）和四个安装包放进一个新目录，在同一提交的干净检出里运行 `python ops/scripts/windows-handover.py --repo . --materials <目录>`。它会：
- 按 `ops/versions.json` 的 `windowsInstallers` 核对四个安装包的字节数和 SHA；
- 校验发布包；
- 生成 `ops-input.zip`、`pm2-lock\`（来自仓库 `ops/windows/pm2-lock/`）和 `handover-sha256.txt`；
- 打印清单自身的 SHA-256。

没有维护者的话，全部材料怎么备齐见[从零搭建](from-scratch.md)。

四个安装包的官方地址、字节数与 SHA 都记在 `windowsInstallers` 里。PostgreSQL 官方不公布安装包的 SHA，那一行的值是本项目实际验证过的安装包，同时核对厂商签名。官方链接失效，或下载到的文件 SHA 不符时，不要换用别的文件：可以到该项目的官方归档页找同一版本，或者升级到新版本，实测通过后再更新 `windowsInstallers`。

## 参数文件 `install-params.json`

位置固定为 `C:\srvpro-input\install-params.json`，并且必须列在交接清单里。不认识的字段会被拒绝。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `expectedHost` | 是 | 机器名，和 `$env:COMPUTERNAME` 不一致就停 |
| `route` | 是 | `A`（新空库）或 `B`（导入批次） |
| `labVm` | 是 | `true` 只允许在虚拟机上；`false` 是真实服务器：要手动输入 `REAL SERVER` 确认，防火墙必须指定 `firewallRemoteAddress` |
| `root` | 否 | 安装根目录，默认 `C:\srvpro-lab`；每一级只能用字母、数字、`-`、`_`，60 字符以内，不能和 `C:\srvpro-*`、系统目录重叠 |
| `database` | 是 | 库名，小写字母开头；路线 B 不能和批次里的源库同名 |
| `httpPort`、`listenPorts` | 是 | 整数端口；`listenPorts` 必须包含 `httpPort`，不能重复；防火墙只开这些端口 |
| `maintenanceMessage` | 是 | 维护提示，首次启动保持维护 |
| `managementUsername` | 路线 A | 维护（HTTP 管理）账号名；路线 B 沿用恢复出的 `admin_user.json` |
| `batch` | 路线 B | `{"zip": "批次文件名.zip", "top": "ZIP 里的顶层目录名"}` |
| `restoreDir` | 路线 B | `C:\srvpro-restores\<新名字>`，必须是新目录 |
| `firewallRemoteAddress` | 真实服务器 | 允许访问的远端地址，写法同 `New-NetFirewallRule -RemoteAddress` |

路线 B 示例：

```json
{
  "expectedHost": "SRVPRO-LAB-WIN",
  "route": "B",
  "labVm": true,
  "root": "C:\\srvpro-lab",
  "database": "srvpro_restore_1103",
  "httpPort": 7922,
  "listenPorts": [7911, 7922, 7977],
  "maintenanceMessage": "服务器维护中，请稍后重试。",
  "restoreDir": "C:\\srvpro-restores\\batch1",
  "batch": { "zip": "joint-batch-a2.zip", "top": "batch-a2" }
}
```

## 运行

用管理员 PowerShell：

```powershell
Expand-Archive C:\srvpro-input\ops-input.zip -DestinationPath C:\srvpro-input
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\srvpro-input\ops\install\windows\install.ps1 run
```

其他子命令：`status`（已完成和待办的步骤）、`maintenance on|off|status`、`verify-block <ID>`（手动修好后补记下一块，前提是它的只读检查能通过）、`help`。状态和日志在 `C:\ProgramData\srvprotianti-install`，只有管理员能读。

脚本运行期间会关掉控制台的“快速编辑”，结束时恢复。旧版本没有这一步：在窗口里点一下就会进入选择状态，安装会被挂起，按 Esc 才能继续。

## 会提示操作者的地方

| 阶段 | 提示 | 规则 |
| --- | --- | --- |
| 10 | 粘贴交接清单的 SHA-256；核对参数页并输入 `yes` | 清单里的每一项都必须 `OK` |
| 12 | postgres 口令（输两次） | 至少 12 位，只能用字母、数字和 `! _ -` |
| 31 | srvpro_runtime、srvpro_operator 口令（各输两次） | 至少 12 位可见 ASCII 字符，不含空格；由客户端算出 SCRAM 验证值后再设置 |
| 41 | srvprosvc 的 Windows 口令（输两次） | 至少 8 位；大写、小写、数字、符号四类中至少三类；不能含账户名中任意连续 3 个字符 |
| 42（A） | 维护口令 | 写进 `admin_user.json` |
| 42 / 43 | 主配置核对页，输入 `yes` | 未设置的键显示为 `(not set: default)` |
| 51 | 再输一次 srvprosvc 口令 | 注册计划任务用 |
| CP1 | 维护已关闭，按清单用真实客户端验收后输入 `PASS` 和检查人 | 结束后自动重新开启维护并等房间清空 |
| 53a | 提示重启 | 在登录界面停留 5 分钟以上再登录，然后再运行 `run` |
| CP2 | 重启后第二轮验收 | 结束时维护保持开启 |

新开的进程需要口令时会重新询问，口令不会写进状态文件或日志。

## 中断与续跑

再次运行 `run` 时：已完成的块显示 `SKIP`；可以重复执行的块显示 `RETRY`；一次性动作先用只读检查判断它“已完成 / 确实没开始 / 只做了一半”，只做了一半就停下，交给维护者。中途不能改参数文件或脚本：脚本会核对状态里记下的机器、路线、根目录、库名、参数摘要和脚本摘要，任何一项对不上就停。

## 已知限制

见 [MAPPING.md 已知限制](../install/windows/MAPPING.md#已知限制2026-11-第二阶段收尾时的停点)：

- 没有 `stage`、`redo`、`retarget` 命令；
- 只走过默认根目录；
- 故障组合（锁竞争、断电、恢复写到一半）没有测试；
- 路线 B 只认识已知的恢复组件。

脚本不负责 5.5 及以后的日常运维、备份和公网入口，这些按手册做。
