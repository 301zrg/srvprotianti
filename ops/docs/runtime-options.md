# 新机运行方式：原生安装、PM2 与 Docker

决策日期：2026-11-13。目标是操作者能从空白系统完成安装、导入、重启恢复和日常维护。
当前先验证 Windows Server 2022 x64 与 Ubuntu 24.04 x86_64 四条新装/恢复路线；
Mac ARM、容器化与生产切换分别验收，不混入首次安装的必需步骤。

## 当前选择

| 平台 | 本轮主线 | PM2 是否必需 |
| --- | --- | --- |
| Windows Server 2022 | 原生 Node/PG/引擎；专用普通账户；开机计划任务启动固定 PM2 | 本轮是：现有 Windows 备份守卫和发布协调器依赖 PM2 的精确应用身份与 stopped 状态 |
| Ubuntu 24.04 | 原生 Node/PG/引擎；systemd 直接启动 Node | 否：使用现有 service 模板和 systemd 停写检查 |
| 后续 Linux 容器路线 | 单独审核镜像、Compose、持久化、备份和网络 | 默认不用：容器运行时负责重启；游戏宿主仍正常管理每房子引擎 |

PM2 不是游戏业务依赖，但当前 Windows 运维工具把它当作运行合同的一部分。
不能在配置中简单关闭 PM2，然后跳过备份守卫或仍签署 Windows gate 通过。
若改成 WinSW/NSSM 直接托管 Node，需要先实现并验证 SCM 服务身份、子进程回收、
停写证明、开机恢复和发布协调接口，再增加一个明确的新部署 profile。

## Windows 开机选型

| 方式 | 优点 | 本轮处理 |
| --- | --- | --- |
| 计划任务 + 固定 PM2 | 系统自带；沿用已有发布/备份合同；易查看账户和触发器 | **选定**：专用非管理员账户、启动时触发、无需登录、固定 cwd/PATH/PM2_HOME；脚本见 `ops/scripts/windows-service/` |
| WinSW 或 NSSM 服务 | SCM 管理、可配置恢复；可直接托管 Node | 备选；不能直接套用旧分支 XML，须补现有 writer guard 和发布接口 |
| PM2 第三方 Windows 启动包 | 安装命令较短 | 本轮不引入；增加第三方依赖，仍需验证账户、版本及无人登录冷启动 |

2026-11-14 在 Windows Server 2022 测试 VM 上实测：普通账户运行 Save 任务返回 0；
无人登录重启后，Startup 任务 resurrect 返回 0，PM2 daemon 和游戏进程各只有一个，端口恢复监听，维护保持开启。
实测还暴露了两个 PS 5.1 陷阱，正式脚本已改正并有回归测试：
- `Start-Process` 重定向后 ExitCode 为空；`-Wait` 会等常驻 daemon；
- `ConvertFrom-Json` 无法解析 env 中大小写重复的 dump.pm2。

当时 VM 用的是同一机制的实验脚本。2026-11-15，R4 候选包在干净 VM 上由 AI 按本手册完成了“导入已有数据”路线（第 1–5.6 节及防火墙；批次来自一台打过真实对局的实例，经 `-RunTask Stop` 和联合备份产生）。项目所有者随后用真实客户端验证了旧账号登录、积分与历史继承、旧录像回放、新对局结算、掉线重连；把行为开关改成与正式服一致（含 `side_timeout=3`、数据库连接写在主配置）后复测通过。仍未完成：真人照手册从头复现、WSS/TLS/公网入口、Linux。AI 首走中的密码输入、psql 交互和记事本编辑由脚本替代。
任务使用普通权限运行，由管理员注册；任务身份必须能批处理登录，不能因权限失败改成 Administrator/SYSTEM。
只在登录后看到 online 不算通过，还要从另一台机器检查端口和真实对局。
游戏进程异常恢复、daemon 异常、PG 延迟启动、子引擎退出和关机仍需分别检查。

Windows PM2 的 `rpc.sock` 是机器级命名管道，换 PM2_HOME 不能隔离两个 daemon。
测试启动前核对机器名白名单、虚拟机身份、已有 Node/PM2 命令行和管道；发现任何既有 daemon 则停止。
此流程只用于独立新 VM/Runner，不在开发机或正式服启动测试 PM2。
备份守卫仅查询已运行 daemon，使用 Windows 管道服务端 PID、进程启动时间、PM2_HOME 和精确 writer 状态验证身份。
PM2 6.0.14 的 getReport 没有 pid 字段，不能从该字段推断身份。

## 为什么现在不必上 Docker

当前仓库 Dockerfile 自述是未适配的上游文件，依赖浮动镜像/Core/脚本；
`.dockerignore` 排除了本项目 plugins。直接 build 不能得到完整天梯服务器。
容器也不能替代本轮所需的 OS 安装、服务账户、整机开机恢复、真实网络和真人手册验收。
因此本轮不把 Docker 作为依赖，不为它改宿主虚拟化或安装 Docker Desktop。

后续如果希望统一 Linux 发行环境，容器有价值，但应单独交付：

1. 固定基础镜像 digest、Node/PG major、引擎架构和全部规则资源；源码许可随制品保留。
2. 游戏、PG、代理、各 Bot 分开管理持久数据和凭据；游戏子引擎留在同一游戏容器。
3. 验证 PID 1 信号转发/子进程回收、维护排空、整个 writer 停止和联合备份恢复。
4. 用运行时 restart policy 管理容器；避免额外 PM2/systemd 同时争抢同一进程。
5. 实测公开端口、代理信任边界、磁盘/日志限额、升级回退和宿主重启。
6. ARM64 镜像仍需要 ARM 原生引擎；标记 multi-arch 不会自动解决源码的 SSE2/x86 假设。

官方依据：[Docker 多进程边界](https://docs.docker.com/engine/containers/multi-service_container/)、
[重启策略](https://docs.docker.com/engine/containers/start-containers-automatically/)、
[Ubuntu 端口与防火墙限制](https://docs.docker.com/engine/install/ubuntu/)。
Docker Desktop 官方明确不支持 Windows Server 2022；不能把 Windows 桌面安装教程当作服务器路线。
[Windows 安装范围](https://docs.docker.com/desktop/setup/install/windows-install/)
