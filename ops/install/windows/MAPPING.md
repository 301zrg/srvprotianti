# Windows 安装脚本 ↔ 手册对照

手册：[`ops/docs/windows-install.md`](../../docs/windows-install.md)。设计与执行契约见审计工作区的设计稿。
类型：`read` 只读核对（每次可重跑）；`idempotent` 可重复的写入；`first` 一次性动作（有只读验证器：0 完成、10 已证明未开始、20 部分或无法判断即停）。

| 块 | 阶段 | 类型 | 手册 | 说明 |
| --- | --- | --- | --- | --- |
| R10-MACHINE | 10 | read | 1 检查块 | 机器名、VM（`labVm`）、已有 PM2；每次 `run` 也先执行 |
| R10-HANDOVER | 10 | read | 1 交接核对 | 清单自身 SHA 由操作者从独立渠道输入；逐项大小/SHA；拒绝绝对路径、`..`、重复、链接 |
| R10-CONFIRM | 10 | read | 1 参数页 | 打印参数，输入 yes |
| R12-BOOTDIR | 12 | first | 1 安装块 | `C:\srvpro-bootstrap-private`，仅 SYSTEM/管理员 |
| R12-SIGNATURES | 12 | read | 1 安装块 | 四个安装包 Authenticode |
| R12-NODE / PYTHON / GIT | 12 | first | 1 安装块 | 参数与手册相同 |
| R12-POSTGRES | 12 | first | 1 安装块 | 口令两次输入并校验后才安装；选项文件装完即删 |
| R12-ENV | 12 | read | 1 检查块 | 本进程刷新 PATH 后核对版本与 PG 服务 |
| R21-VERIFY / UNPACK / RESOURCES | 21 | read/first/first | 2 | verify-release、unpack-release、复制 engine/catalog |
| R23-NPMCI / BUILD | 23 | idempotent | 2 | `npm ci`、`npm run build` |
| R23-CATALOG / TEST / PREFLIGHT | 23 | read | 2 | catalog-check、`npm test`、preflight |
| R31-PRIVATE | 31 | first | 3 私有目录 | |
| R31-ROLES | 31 | first | 3 建角色 SQL | 非交互 psql，SQL 经 stdin |
| R31-PASSWORDS | 31 | first | 3 `\password` + passfile | 同 `\password`：客户端算 SCRAM-SHA-256 验证值，两角色在一个事务里 `ALTER ROLE`，服务器和日志看不到明文；中断后重跑会重设两个口令并重写 passfile；passfile 转义同手册 |
| R31-CONTRACT | 31 | read | 3 check-contract | |
| R32-CREATEDB / GRANTS / INIT | 32 (A) | first/idempotent/first | 3 建库、授权、A init | 授权在新库的独立连接中执行（替代 `\connect`） |
| R33-RESTORES / BATCH / CREATEDB / GRANTS / VERIFY / RESTORE | 33 (B) | | 3 B | 恢复库 locale 取批次 manifest 的源库值；Defender 临时排除在 finally 移除 |
| R34-RUNTIME | 34 | read | 3 运行账号验证 | runtime 口令只进子进程环境 |
| R41-ACCOUNT / DIRS | 41 | first | 4 服务账户与目录 | 口令先按 Windows 复杂度预检，被拒可重输 |
| R42-CONFIG / REVIEW / ADMIN | 42 (A) | first/read/first | 4 新装配置、参数页核对、维护账号 | 适配器口令用 `lib/json-edit.cjs` 结构化写入，替代记事本 |
| R43-MAP / CONNECTION / REVIEW | 43 (B) | first/idempotent/read | 4 B 路径表与连接 | 只改实际生效的一处连接 |
| R45-ACL / PM2 | 45 | idempotent/first | 4 权限块、PM2 安装 | |
| R51-SVCCFG / BATCHLOGON / TASKS / START | 51 | | 5.1–5.4 | 调用仓库 `windows-service` 脚本；任务注册口令错误且未建任何任务时可重试 |
| R52-MAINT | 52 | read | 5.6 维护开关 | B 从恢复的 `admin_user.json` 选定账号 |
| R61-FIREWALL | 61 | first | 6 防火墙 | 真实服务器必须给 `firewallRemoteAddress` |
| CP1-CLIENT | CP1 | read | 现场验收 | off → 人工第一轮 → on 并排空 |
| R53A-BEFORE | 53a | read | 5.6 重启前 | 自动登录拒绝；维护开且排空；记录开机时间 |
| R53B-AFTER | 53b | read | 5.6 重启后 | 开机晚于记录、首个交互登录距开机 ≥5 分钟、进程早于登录、resurrect、维护仍开、60 秒后 PID 不变 |
| CP2-CLIENT | CP2 | read | 现场验收 | 重启后新写入，再恢复维护 |

范围外（保留手册手工步骤）：5.5 保存进程列表、5.7 故障处理、5.8 密码轮换、5.9 停服备份与旧三任务机器升级、公网入口。

## 已知限制（2026-11 第二阶段收尾时的停点）

- 没有 `stage`（只跑某一阶段）、`redo`（重做已完成的块）和 `retarget`（改参数后继续）。安装中途不能改 install-params.json 或脚本；要换参数，请从干净系统重来，或找维护者按手册手工收尾。
- 续跑时核对机器、路线、根目录、库名、参数文件摘要和脚本摘要；不会重新校验交接清单里的大文件（第 10 阶段已校验过一次）。
- 只在默认根目录 `C:\srvpro-lab` 上完整走过（AI 走 A、B）。非默认根目录只有参数校验和路径改写的单测。
- 单测覆盖参数、引号、JSON 编辑、状态机基础路径；没有覆盖锁竞争、硬断电、恢复写到一半、Defender 清理失败等故障组合。这些情况下脚本会停在失败处，按提示找维护者。
- 路线 B 只认识已知的恢复组件（recordings、host-config、adapter-config、tournament-decks、tournament-logs、deck-logs、service-config）；有别的组件就停下，按手册 4 B 手工映射。
