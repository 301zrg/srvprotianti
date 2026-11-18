# 设计：Linux 安装分阶段脚本（路线 A 与 B）

状态：草案，待 GPT 审查；未开工。日期 2026-11-18。基线：main `8fb0645` 的 `ops/docs/linux-install.md`（下文行号均指该版）。
用户已定（11-17/18）：只做 Linux；脚本放仓库 `ops/install/linux/`；A、B 同期；内部按手册节分阶段、对外一个总入口；
AI 在干净快照完整走 A/B 并做故障注入，用户再轻量走一遍并做 6.2 真实客户端验收；Windows 暂不脚本化。

## 1. 为什么做

2026-11-17 真人照手册走通路线 A（`r3walk/HUMAN-WALK-LINUX-A-LOG.md`）。手册内容本身被 AI 与真人各验证一遍；事故几乎都来自**逐行粘贴的执行方式**：
`read`/`sudo`/`apt-get` 吞掉后续粘贴行并静默漏执行（G2）、`set -e` 退出登录 shell 后剩余行落到本地 PowerShell（G4）、
`test` 失败与成功在屏幕上无法区分（G5）、身份/机器贴错（G11）。脚本化把“执行方式”从操作者手里拿走。

## 2. 目标与非目标

目标：
- 操作者在新机上只需：传入交接目录 → `sudo bash install.sh run` → 按提示输入口令/确认检查点 → 重启后 `sudo bash install.sh run` 续跑 → 做 6.2 客户端验收。
- 每一步做了什么与手册保持一一对应，手册改为“每个阶段做了什么、看到什么算成功、失败怎么办”的说明。
- 失败时明确报出阶段、原因和下一步；可续跑；危险步骤不可误重跑。

非目标：
- 不改变任何部署结果（路径、属主、权限、配置值、服务单元、数据库角色/授权）——与手册当前版本逐项一致。
- 不改 `ops.py`、`schema.js` 等工具本身；脚本只调用它们。
- 不做公网入口（Nginx/TLS/WSS，6.1 后置部分）、不做 Windows、不做跨机传输（交接目录仍由维护者传入）。
- 不引入 Ansible 等新框架；只用 Bash + 系统自带工具 + 已有 Python 工具。

## 3. 文件布局（仓库 `ops/install/linux/`）

```text
install.sh                入口：run | status | stage <id> | resume | maintenance on|off|status | check-config | help
lib/common.sh             日志、状态、检查点、口令读取、身份切换、错误处理（胶水层，GPT 重点审）
stages/10-handover.sh     1.1 交接目录落地与 SHA 核对
stages/12-system.sh       1.2 系统核对、APT、Node、PG17
stages/21-unpack.sh       2.1 解包 R4
stages/22-engine.sh       2.2 引擎源码校验与编译
stages/23-build.sh        2.3 组合资源、构建应用并安装
stages/31-roles.sh        3.1 四个数据库身份与运维凭据
stages/32-database-a.sh   3.2 路线 A 新库 + init
stages/33-restore-b.sh    3.3 路线 B 恢复（含 locale 检查与接受检查点）
stages/34-verify-runtime.sh 3.4 运行账号验证
stages/41-layout.sh       4.1 目录与服务账户（含 G6 配置等价核对）
stages/42-config-a.sh     4.2 路线 A 放置配置与维护账号
stages/43-config-b.sh     4.3 路线 B 路径表映射
stages/44-db-connection.sh 4.4 数据库连接
stages/45-permissions.sh  4.5 链接、最小权限与 replay
stages/46-preflight.sh    4.6 preflight 与原生冒烟
stages/51-systemd.sh      5.1 systemd 安装与首次启动
stages/52-maintenance.sh  5.2 维护工具与（可选）联合备份
stages/53-reboot.sh       5.3 重启前检查 → 提示重启；重启后取证
stages/61-firewall.sh     6.1 ufw（不含 Nginx/TLS）
tests/                    shellcheck + bats 单元测试（胶水层、状态机、口令处理）
MAPPING.md                手册行号 ↔ 阶段/函数对照表（审查与维护用）
```

阶段脚本**只被 `install.sh` source 调用**，不直接执行；每个阶段一个函数 `stage_main`，内部按手册块拆成小函数，函数注释写手册行号。

## 4. 执行模型

### 4.1 运行身份

- `install.sh` 必须以 root 运行（`sudo bash install.sh …`，检查 `EUID==0` 与 `SUDO_USER` 非空且非 root）；部署用户取自 `SUDO_USER`，与参数页核对。
- 手册中“部署用户（无 sudo）”的块，用 `runuser -u "$DEPLOY_USER" -- bash -c '…'`（或 `setpriv`）在**新进程**里执行，环境变量白名单传入；
  不在 root 环境泄漏到部署用户进程。`srvpro` 身份的块同理。
- 每次执行都检查机器：`hostnamectl`、`/etc/os-release`（Ubuntu 24.04）、`uname -m`（x86_64），与参数页的机器名一致才继续（解决 G11 的“贴错机器”）。

### 4.2 执行方式（解决 G2/G4/G5）

- 脚本文件执行，不粘贴；`set -Eeuo pipefail` + `trap ERR` 打印“阶段、函数、手册行号、退出码、最后命令”；`trap EXIT` 统一收尾。
- 每个阶段结束打印 `PASS <阶段号>`；失败打印 `FAIL <阶段号>: <原因>` 与下一步建议，退出码非 0。没有静默成功或静默失败。
- 不读 stdin 的命令一律 `</dev/null`，防止吞输入；交互只发生在 `lib/common.sh` 的 `ask_*` 函数里。

### 4.3 状态与续跑

- 状态目录 `/var/lib/srvprotianti-install/`（root 0700）：`state.json`（route、发布目录名、当前/已完成阶段、各阶段完成时间、关键产物 SHA）、
  `logs/<时间>-<阶段>.log`（root 0600）。
- `run`：从第一个未完成阶段继续；已完成阶段跳过并打印 `SKIP <阶段号>`。
- 每个阶段分类：
  - **幂等**（核对类、chmod/chown、写同一配置）：可重跑。
  - **一次性**（建库、init、restore、建角色、引擎构建目录）：完成后标记，重跑默认拒绝；如需重做，必须 `stage <id> --redo`，并要求先人工清理（脚本只打印清理方法，不自动删库删目录）。
  - **中断恢复**：阶段开始时写“进行中”标记；再次 `run` 遇到进行中的一次性阶段，先做只读核对判断已到哪一步，能确定安全才续，不能确定就停下请人判断（例如 restore 半途：保留现场，提示用新库名重来，与手册 3.3“失败保留目标、不复用”一致）。
- 路线在第一次 `run` 时选择（A/B），写入状态后不可更改。

### 4.4 人工检查点（停下等人）

| 检查点 | 阶段 | 内容 |
| --- | --- | --- |
| 参数页确认 | 10 | 打印参数页关键值（机器名、发布目录、端口、路线），操作者输入 `yes` |
| 口令输入 | 31、34、42、44、52 | 新建口令输两遍；`read -rs`，不回显、不落盘、不进日志；只存在于当前进程环境并在用后 `unset` |
| locale 差异接受（仅 B） | 33 | 打印 locale-check 摘要，操作者输入“排序差异已接受”原文才继续（与手册 3.3 回执一致） |
| 配置等价核对 | 41 | 自动比对（G6），有差异时列出并要求逐条 `yes`/退出 |
| 重启 | 53 | 打印重启前检查结果，提示“现在执行 reboot，等待至少 5 分钟后登录，再运行 `sudo bash install.sh run`”；脚本不自己 reboot |
| 客户端验收 | 最后 | 打印 6.2 清单与解除维护命令，脚本到此结束；6.2 由人完成 |

### 4.5 口令

- 只用 `read -rs` 读入；校验两次一致、非空、长度；不写文件、不进日志、不放命令行参数（`ps` 可见）。
- 需要交给 psql 的口令通过 `PGPASSWORD` 环境变量传入子进程，或按手册既有方式写 0600 `.pgpass`（手册已规定的文件除外，不新增落盘点）。
- 日志写入经过过滤函数：任何已知口令变量的值出现即替换为 `***`（兜底，主要靠不打印）。

### 4.6 重启拆分

5.3 拆成两段：重启前（53a：检查服务 enabled、游戏 inactive、准备取证、写状态“等待重启”）与重启后（53b：用 journal/systemd 时间判断游戏在首次登录前启动，G12 改用 `$PPID` 与 journal 时间源）。
取证不依赖 /tmp（G13），状态与证据都在状态目录。

## 5. 走查缺口如何处理

| 编号 | 处理 |
| --- | --- |
| G1 同名旧手册 | `install.sh` 与手册首行写明提交号；`help`/`status` 打印“本脚本来自提交 X，对应手册 ops/docs/linux-install.md” |
| G2/G4/G5 粘贴执行 | 脚本化本身解决；手册保留原块作为“脚本做了什么”的说明，不再要求逐块粘贴 |
| G3 交接清单格式 | 阶段 10 同时接受 `handover.tsv`（手册格式）与 `handover-files.sha256`（sha256sum 格式）；两者都没有则停。维护者生成交接目录的工具另行补 `handover.tsv`（交接包制作，不在本设计） |
| G6 配置等价 | 新增 `check-config`：按 `default_config` 递归合并交付配置，与参数页附带的机器可读期望值（维护者生成 `expected-config.json`）逐键比较，只打印差异；无期望文件时退化为打印全部布尔/数字开关供人看 |
| G7 中文转义 | 所有 JSON 显示用 `ensure_ascii=False` |
| G8 SSH 端口/测试网段 | 阶段 61 读取参数页新增字段；缺失时用 `ss -tlnp` 报出 sshd 实际端口作为默认值并要求确认；拒绝把宿主转发端口（如 2222）当成机内端口的明显误填（端口不在 sshd 监听列表即拒绝） |
| G9 维护开关改源码 | 新增 `install.sh maintenance on|off|status`：on 写回参数页的维护提示原文，off 写 `false`，内部调用 5.2 生成的工具；不再要求手改 `maintenance.py` |
| G10 备份计划未交付 | 阶段 52 按本机实际路径生成 `/etc/srvprotianti/backup-plan.json`（路线 A 的 releaseArchive 取交接目录发布归档；组件列表按 4.1/4.3 已建目录），打印给人确认；仍允许维护者提供的计划覆盖 |
| G11 机器标注 | 4.1 的机器核对；手册中留在“操作者电脑”上的步骤（传入交接目录）单列，写明 PowerShell 与 Bash 两种写法 |
| G12 `$$`/时间源 | 见 4.6 |
| G13 /tmp | 见 4.6 |

## 6. 路线 B 的特殊处理

- 输入：维护者传入的联合批次（例如 2026-11-18 的 `b3-20261118`，Windows 正式服生成，CRLF/中文 locale）。阶段 33 先 `ops.py verify`，再按手册 3.3 建新库（内置 C.UTF-8）、restore、locale-check，过检查点后继续。
- 4.3 路径表映射：按批次 `restore-map.json` 与参数页路径表，脚本生成映射计划并打印，人确认后执行；Windows 源路径不得残留在 Linux 配置（复用手册既有检查）。
- 失败处理与手册一致：保留失败的库和目录，不复用名字；脚本只给出“下一次用的新库名/目录名”建议。

## 7. 验证计划

1. 单元：`shellcheck`；bats 测胶水层（状态机跳过/拒绝重跑/中断标记、口令不落盘、身份切换环境白名单、日志过滤）。进 CI。
2. AI 完整走（Linux 实验机 `clean-os-20261115` 链接克隆，1 vCPU）：
   - 路线 A：一次走完，产物与 11-17 真人走查快照（`human-route-a-end`）比对（引擎 SHA、文件属主权限、配置、服务单元、库结构）。
   - 路线 B：用 `production-b3-20261118` 批次走完，含 locale 检查点、路径映射、起服、重启取证；数据核对沿用 B3 验收方式（三项标志、整库状态）。
   - 故障注入：阶段中途 Ctrl+C 后续跑；重跑已完成的一次性阶段（应拒绝）；口令两次不一致；错误口令（3.4 应失败且可重试）；断网时 APT（应清楚报错）；磁盘不足模拟；把脚本以非 root/错机器运行（应拒绝）。
3. 用户轻量走：只敲入口命令与回答检查点，最后 6.2 真实客户端验收。

## 8. 审查范围（给 GPT）

重点：`lib/common.sh` 与 `install.sh`（身份切换、状态与续跑、禁止重跑、报错与日志、口令处理、重启拆分），以及第 5 节 G3/G6/G9/G10 带来的新逻辑。
一致性：`MAPPING.md` 手册行号 ↔ 脚本函数逐条对照，确认搬运忠实（命令、参数、路径、属主权限、判据不变）。已由 AI 与真人跑通的块，内容不再整体重提意见。

## 9. 需要决定 / 待确认

1. 维护者生成交接目录（含 `handover.tsv`、`expected-config.json`、参数页新字段）的工具是否同期做：建议同期，放 `ops/scripts/` 的现有交接生成处，否则 G3/G6/G8 只能靠退化路径。
2. 状态目录位置 `/var/lib/srvprotianti-install/` 是否可以（重启不清空、与运行数据分开）。
3. 手册改写方式：保留原命令块作为附录“脚本做了什么”，正文改为阶段说明；还是正文直接指向脚本函数。建议前者，便于脚本出错时人工逐块补救。

---

## 10. v2：第一轮审查后的执行契约（覆盖前文冲突处）

依据 `r3walk/REPORT-LINUX-SCRIPTS-DESIGN-REVIEW.md`（无 P0、13 项 P1、1 项 P2）。本节与前文冲突时以本节为准。第一版留档 `r3walk/DESIGN-LINUX-INSTALL-SCRIPTS.v1.md`。

### 10.1 流程顺序（P1-1）

`run` 的完整流程（A/B 共用，B 多 33/43）：

```text
10 → 12 → 21 → 22 → 23 → 31 → 32|33 → 34 → 41 → 42|43 → 44 → 45 → 46 → 51
→ 52a 维护工具准备（提取工具、维护状态查询可用）
→ 61  ufw + 新 SSH 连接验证检查点（另开窗口登录成功后输入 yes）
→ CP1 首轮真实客户端验收检查点（maintenance off → 人工 6.2 第一轮 → maintenance on）
→ 52b 维护排空：maintenance on，等 readyToStop=true（不踢人、不固定等待）
→ 52c 停全部 writer（游戏 unit + backup-plan.writerUnits 中其它 unit）
→ 52d 可选联合备份 + verify（无计划或操作者选择跳过则记“未备份”）
→ 53a 重启前检查（全部 writer inactive、enabled、记录 boot_id）→ 提示人工 reboot
→ 53b 重启后取证 + 间隔复核
→ CP2 重启后真实客户端复测检查点（off → 人工复测注册/结算/录像新写入 → on）
→ 结束（维护保持开启，等用户决定正式开放）
```

两轮客户端验收分别记录检查人与时间；脚本只记录人工输入，不自动判通过。52d 之后不再自动启动游戏（与 53 要求 inactive 一致）；若操作者跳过重启，需显式 `stage 51 --restart-only` 才能再起服。

### 10.2 重启证明（P1-2）

- 53a 记录 `/proc/sys/kernel/random/boot_id`、`systemctl show` 的 ExecMainStartTimestamp。
- 53b：boot_id 与 53a 相同则拒绝（“尚未重启”）。证据：journal 本次 boot 的内核、PostgreSQL、游戏 ExecMainStart 时间，与本次 boot **首条 sshd `Accepted`** 时间比较，要求游戏启动早于首次登录且两者间隔 ≥5 分钟（时间源统一 journal）；登录 shell 的进程信息只作参考不作判据。
- 证据缺失（如 journal 被清）则停，不手动 start 补证。53b 再等待 ≥60 秒做间隔复核：MainPID 不变、NRestarts=0，才标完成。

### 10.3 身份与环境（P1-3）

- 手册中“部署用户（有 sudo）”的块拆为：**root 动作**（apt、安装到 /srv、chown、systemctl）直接在 root 进程执行；**部署用户动作**（解包到 HOME、引擎编译、`npm ci`/build/test）用
  `runuser -u "$DEPLOY_USER" -- env -i HOME="$DEPLOY_HOME" USER=… LOGNAME=… PATH=/opt/node24/bin:/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 bash --noprofile --norc -c "$block"`，
  cwd 显式 `cd`。构建与 npm 永远以普通用户执行；降权子进程内不调用 sudo，也不交互。
- `srvpro` 身份的验证同样用 `runuser -u srvpro` + 白名单环境，由 root 直接派发。
- `DEPLOY_USER/HOME/UID` 取自 `getent passwd "$SUDO_USER"`，与状态绑定（10.5）。

### 10.4 错误语义（P1-4）

- 阶段由 `install.sh` 直接调用（不放在 `if`、`&&`、`||` 或管道里），失败即非零退出；每个降权子 shell 的脚本首行显式 `set -Eeuo pipefail`，并带“块 ID + 手册行号”的 ERR trap。
- trap 由 `lib/common.sh` 统一设置；搬来的块禁止设置 trap/`set +e`（shellcheck 自定义检查 + 测试）。
- 测试覆盖：子进程中途失败、管道前段失败、`test` 守卫失败三种情形，断言后续写入未执行、状态未写完成。

### 10.5 状态、锁、绑定（P1-5、P1-6）

- 全部修改性命令先 `flock -n /var/lib/srvprotianti-install/lock`，拿不到即退出。目录 root 0700，文件 0600，进程 `umask 077`；状态版本号字段。
- 状态写入：同目录临时文件 → `fsync` → `rename`。每个“首次动作”执行前先持久化 `pending: <块ID>`；INT/TERM/HUP/断电后再次运行看到 pending，先跑该块的**只读后置验证**：
  已完成则补记完成，未开始则清 pending 重做（仅限幂等块），部分完成或无法判断则停下交人。
- 状态缺失或损坏而目标已有内容（/srv/srvprotianti 存在、库存在等）时停止，不当作全新安装；不提供“删状态重来”的路径。
- 状态绑定：机器名、部署 UID/HOME、脚本提交号、交接清单摘要、路线、发布目录名、数据库名、恢复目录名、参数页摘要。任一变化立即停。
- `stage <id>` 与 `run` 走同一状态机：检查路线与前置阶段已完成、不能跳过检查点。`--redo <id>` 只对标为可重做的块开放，并列出使哪些下游阶段失效（失效即回到未完成）。
  `resume` 即 `run`。

### 10.6 块级记账（P1-7）

阶段不再是记账单位。`MAPPING.md` 为手册每个代码块登记：块 ID、手册行号、类型（只读核对 / 幂等写入 / 首次动作）、执行身份、后置验证函数、可否重做、影响的下游。
首次动作（建角色、设密码与 pgpass、建库、init、restore、文件复制、建链接、安装 unit 等）各自定义“部分成功”的判据与处理；阶段 PASS = 其全部块完成的聚合。

### 10.7 路线 B 失败处理（P1-8）

- B 的一次性块失败后**不提供删库/清空后复用**：保留原库与目录，操作者用 `retarget --database <新名> --restore-dir <新目录> [--shared <新目标>]` 显式选新目标；脚本更新状态中全部依赖路径，相关下游失效重跑。
- A 的 init：先只读 verify 判断是否已完成；init 报告失败按手册保留现场。无法辨认的目标一律停下交人。

### 10.8 交接清单（P1-9）与交接生成（待定项 1）

- 阶段 10 把两种格式（`handover.tsv`、`handover-files.sha256`）解析成同一清单模型：规范相对路径（去掉前导 `./`）、拒绝绝对路径/`..`/重复/链接/特殊文件，完整文件集合比对、逐文件 SHA、非空规则（保留 joint-batch 既有空文件例外）。
  清单文件自身的大小与 SHA 必须与操作者从**独立渠道**拿到的值一致（参数页之外，例如交接消息），由检查点输入。两种清单并存时要求内容一致。B 的中转删除块按已验证清单执行，保留原路径守卫。
- **同期做交接生成器**：把现有 AI 脚本 `r3walk/l0-assemble-handover.py` / `l10-assemble-handover.py` 的逻辑收进仓库 `ops/scripts/handover.py`，输出 `handover.tsv`、`handover.md`（参数页，新增 SSH 端口/测试 CIDR/管理用户名/HTTP 端口字段）、`handover-params.json`（机器可读参数）、`expected-config.json`，以及供独立渠道发送的“清单大小 + SHA”一行。

### 10.9 配置等价（P1-10）

- `expected-config.json` 为交付必需项；缺失则阶段 41/44 停。合并语义与宿主一致：对象递归合并、数组整体替换、键名含点按字面对象层次处理（与 `ygopro-server` 的 `merge` 实现对照测试）。
- A 在 42 后比对交付配置；B 在 43 后比对恢复出的配置；44 后再核对最终连接方式与路径及有效开关。
- 差异必须逐条给出理由，记录键、理由、操作者输入的批准人与时间；输出只显示键与非敏感值，凭据类键显示 `<redacted>`。未解释差异不算通过。

### 10.10 维护开关（P1-11）

- `maintenance status`：只做认证查询（`/api/maintenance/status`），不改任何东西。
- `maintenance on|off`：从 `handover-params.json` 取本机 HTTP 端口、管理用户名、维护提示原文，作为**结构化参数**传给一个仓库内的维护模块（由 `maintenance.md` 代码段整理成 `ops/scripts/maintenance.py`，不再从文档提取、不拼源码）；off 发送字符串 `'false'`。
- on 后要求 `maintenanceEnabled=true`；52b 要求 `readyToStop=true` 前不得停服/备份；off 后核对 `maintenanceEnabled=false` 才提示可入房。B 用旧账号与非默认端口时由参数页给出。

### 10.11 备份计划生成（P1-12）

- 按 `backup-restore.md` 逐项状态清单生成完整组件表：数据库、发布归档、Linux runtime（含新编译 ELF 所在目录）、shared 下全部可变目录、服务配置、参数页列出的额外可变资产；真实路径、互不重叠、清单漏项即停。
- writerUnits 显式列出；52c 逐一停写并核对 inactive 后才进入 52d。
- A 的 releaseArchive 用交接目录中的发布归档；B 按手册 L1151–1167 先建新私有目录并复制归档与 sidecar。
- 外供计划同样校验；已有计划文件不静默覆盖（存在即比较，不同则停）。

### 10.12 路线 B 硬门槛（P1-13）

- 33 的通过条件：`verify` 退出 0；restore 三项标志 true；摘要算法与匹配行尾符合批次（旧格式 crlf/lf、或新格式严格匹配）；release 与独立运行组件核对（手册 L563–580）；五条 locale 查询（L626–640）输出写入回执。
- locale 接受检查点要求输入原文“排序差异已接受”并记录检查人、时间、批次 ID、库名；页面排序/分页留到 CP1 人工验收。
- 43 对批次中全部实际组件逐项归类：必需/可选，复制/重建/仅留证据；未知组件即停。遵守：adapter-config 与 plugin-config 互斥、空组件目录预建、sidecar 不进运行目录、Windows EXE 不覆盖 ELF、只改已声明的运行路径、原始对照文件保留。

### 10.13 口令与敏感内容（P1-14）

- 允许持久化的敏感文件只限手册已规定的：`/etc/srvprotianti/ops.pgpass`、运行连接配置、`admin_user.json`（属主与 0600 按手册）。其余一律不落盘。
- 交互一律从 `/dev/tty` 读，新口令输两次，拒绝空、CR、LF、NUL。
- 敏感块关闭命令回显与 ERR trap 的“最后命令”字段，只记块 ID；配置差异与日志不输出认证值。口令只通过子进程环境传给需要它的那一个进程，用后 `unset`，信号退出也清理。
- 测试：含特殊字符口令、B 批次中旧凭据样本，断言 stdout/stderr/状态/日志均不出现。

### 10.14 覆盖范围标注（P2）

`MAPPING.md` 对每个块标“自动 / 人工检查点 / 范围外（原因）”：1.1 维护者导出块（L41–56）为范围外（由 `handover.py` 在维护者侧完成）；3.3 隔离恢复验证分支（L587–609）范围外；5.4 故障恢复块（L1312–1371）保留为文档指引，脚本只提供只读诊断 `install.sh diagnose`，不自动 reset-failed/start；公网入口范围外。

### 10.15 待定项结论

1. 交接生成器同期做（10.8）。2. 状态目录 `/var/lib/srvprotianti-install/`（10.5）。3. 手册正文改为阶段说明，原命令块移附录并注明身份、机器、前置与禁重跑；人工补救后用 `install.sh verify-block <ID>` 的只读后置验证纳入状态，不编辑 state.json、不原样重跑整段。

### 10.16 第二轮审查补充（`r3walk/REPORT-LINUX-SCRIPTS-DESIGN-REVIEW2.md`）

- **CP2 收尾**：复测后 `maintenance on`，并按手册 L1291 等到 `readyToStop=true` 才算流程完成；未排空则停在“等待排空”，可重跑 `run` 继续等。
- **状态持久化**：临时文件写入并 `fsync` → `rename` → 对状态目录 `fsync`；三步全部成功后才执行对应首次动作。任何一步失败即停，不执行动作。
- **N1 写入者清单独立于备份**：`writers.json`（游戏 unit + 其它写库/录像/资产的 unit，来自参数页并经 41 阶段在本机核对 unit 存在）在 52a 生成并经检查点确认。
  52c 一律按 `writers.json` 逐一停写并核对 inactive，无清单即停；52d 跳过备份只跳过归档与 verify，不影响停写。backup-plan 的 writerUnits 由 `writers.json` 生成，二者必须一致。

### 10.17 第 2 批实现中发现的时序冲突（2026-11-18，主 Agent 裁定）

§10.16 写“writers.json 经 41 阶段在本机核对 unit 存在”，但游戏 unit 在 51 才首次安装（手册 L1015–1016 要求安装前不存在），二者冲突。裁定：
- 41 只核对参数页列出的**非游戏** writer unit（若有）已存在；游戏 unit 在 41 不检查。
- writers.json 在 **52a** 生成：此时 51 已安装游戏 unit，52a 对清单中**全部** unit（含游戏 unit）逐一核对存在且已加载，再进检查点由人确认。
- 52c 仍按 writers.json 逐一停写；判据与 §10.16 其余部分不变，不放宽“unit 必须真实存在”的要求。

### 10.18 交付配置、维护账号与续跑输出

- `expected-config.json` 必须含 `delivered` 与 `final`，每段为 `host`（对象）及 `adapter`（对象或 null）。42/43 比对 `delivered`，44 的连接块完成后比对 `final`。连接模式、synchronize、适配器环境映射、`modules.stop`、四个 shared 路径及显式 `pathMappings` 由生成器按 44 的写入规则推导。这些计划内的变化无需批准。B retarget 后，最终比较使用绑定的新库和 shared，对覆盖中与初始目标不同的值仍按差异处理。
- 生成器从发布归档的 `application/data/default_config.json` 合并 A 的交付主配置或 B 批次的 host-config，适配器取 A 导出提交的模板或 B 批次适配组件。维护者可通过 `--expected-config` 覆盖两段。两个阶段都脱敏凭据。两边适配插件均启用时，接受宿主把 `modules.mysql.enabled` 由 `false` 写回 `true`。
- A 的账号为 `maintenance`。B 的参数页省略 `managementUsername`。43 完成后的 52a 在新机从已恢复的 `admin_user.json` 选定第一个启用且有 stop 权限的账号，顺序和权限解析与发布监控一致。无符合条件的账号则停。状态只保存选定标记与账号名 SHA-256 前 12 位。维护调用在新机进程内读取凭据，并核对账号摘要，账号名和口令均不进入安装器日志、状态或屏幕。游戏宿主的应用日志仍按既有行为记录认证账号名。
- 只读后置探测未完成时输出 `PROBE <块ID>: not complete` 或 `PROBE <块ID>: partial`。真正停止时输出 FAIL。入口的机器名仅作单行展示。

### 10.19 首次动作在证实未开始后续跑

本节更新 §10.5 的首次动作续跑规则及 §10.18 的探测输出。判据以保留中断现场为前提。

- 首次动作的只读验证器只有在能证明该块没有留下任何副作用、应新建的目标均不存在时才可返回 10。判据必须覆盖该块的全部持久写入，包括目标外的文件、父目录、权限、数据库和角色。悬空链接、探测失败或只确认部分目标不存在，均不足以证明未开始。
- 遇到 pending 首次动作，返回 10 时输出 `PROBE <块ID>: not started (proven)`，清除 pending，由 `run` 或 `resume` 按正常顺序执行该块，动手前重新持久化 pending。返回 0 时按已完成登记。存在部分结果或无法证明时返回 20，保留 pending，等待人工处理。
