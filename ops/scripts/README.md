# 运维工具入口

新增引擎和部署准备工具：

| 工具 | 边界 |
| --- | --- |
| `engine-source.py` | 固定 Git/子模块/依赖 SHA，写新目录；不编译 |
| `engine.py fetch-pool/check-pool/assemble/verify/smoke` | 校验引擎卡池、纯上游候选、完整清单；启动/TCP 与完整对局分开 |
| `deployment.py sources/inputs/layout/web-artifact` | 审核源码、显式私有输入、Linux 权限和实际网页构建资源 |
| `deployment.py lock/verify-lock/gate` | 绑定 archive、网页全部规则环境、桌面包、引擎和查询库；按 Windows/Linux 区分回执，不自动证明人工回执真实性 |
| `health.py` | loopback 公开 API、明确指定的 PG17、查询库文件、容量和联合备份；不证明运行插件装载或真实录像播放 |
| `windows-backup.cjs` | 保持既有全局锁，检查已停止的精确 PM2 应用；不停止/启动服务。见联合备份手册 |
| `validate-recovery.cmd` | Windows 独立合成数据演练入口；要求事先创建隔离 cluster，PGUSER 等由操作者显式提供 |
| `windows-service/srvpro-service.ps1` | 计划任务入口，以普通服务账户运行 Start/Save/Resurrect；等 PG 和游戏端口；可靠获取 PM2 CLI 退出码并有超时。配置为 [windows-service.example.json](../templates/windows-service.example.json) |
| `windows-service/register-tasks.ps1` / `grant-batch-logon.ps1` | 管理员注册三个任务、轮换密码（`-UpdatePassword`）；只添加批处理登录权限并核对其他权限不变 |
| `windows-service/check-service.ps1` | 管理员只读核查任务、唯一 daemon/游戏进程、身份、端口和 dump 摘要；不运行 PM2 CLI；`-RunTask Start/Save/Startup/Stop` 只启动一次对应任务 |
| `windows-service/pm2-dump-summary.cjs` | 只输出 dump.pm2 的白名单字段，不输出 env；规避 PS 5.1 `ConvertFrom-Json` 键大小写冲突 |
| `windows-service/pm2-apps-readonly.cjs` | Save/续做 Start 前查询运行中应用：复用 `windows-backup.cjs` 的直接 RPC（不加载 PM2 CLI，不会拉起 daemon），绑定管道 PID 与 PM2_HOME，只输出白名单字段 |

参数以 `--help` 为准。部署 profile 必须显式提供 public 地址、规则/HostInfo、资源环境和可写资产映射；旧 `deployment.example.json` 仍为人工计划表，不是工具 profile。无目标机器时不能虚填私有连接、签署现场回执或生成正式部署通过结论。

验收开始前将 [acceptance.example.json](../templates/acceptance.example.json) 复制到私有证据目录。
模板所有阶段均为 `NOT_RUN`，绑定实际 deployment lock 的 SHA 后逐项填操作人、带时区的时间和证据路径。
仅完成准备时不要改成 PASS；`pg17.tables` 是当前20张业务表的契约验收字段，另记源库实际表数，
不能为了填20而漏备份归档表。旧分支模板的 `linux-engine`/`systemdChildrenStopped` 已过时，
当前使用 `native-engine`/`writersAndChildrenStopped`，Windows 与 Linux 均须填写 processManager。
静态模板检查或 gate 读取成功不证明证据真实，也不代替人工验收。

CMD 参数顺序为 `PYTHON PG_BIN NEW_WORKDIR SUFFIX LOOPBACK_PORT`；它只操作新 `srvpro_drill_*` 库和合成文件，不做 PM2/整机恢复。实际进程恢复和整机重启另约窗口。所有报告和 dump 私有保存。

`ops.py` 与 `drill.py` 只依赖 Python 标准库。数据库操作调用 `psql`、`pg_dump`、
`pg_restore`，schema 验收调用服务端的 Node 工具；Node 依赖在服务端目录先执行 `npm ci`。
不读取操作者机器上的生产配置来猜连接参数。

| 工具命令 | 作用与边界 |
| --- | --- |
| `ops.py release` | 保存当前已跟踪源码字节及显式公共新增文件、引擎和查询卡库，输出 archive 与 sidecar manifest |
| `ops.py verify-release` / `unpack-release` | 校验制品；只能解包到不存在的新目录 |
| `ops.py catalog-fetch` | 根据 versions.json 固定的独立资源仓库/提交/目录下载 LFS 四库，校验后写入不存在的新目录；不覆盖运行资源 |
| `ops.py catalog-check` | 只读验证四语查询库为真实 SQLite、结构/记录有效，并可按 versions.json 校验字节和 SHA；不依赖引擎或 PostgreSQL |
| `ops.py preflight` | 检查 Linux x86_64、Node、ELF/动态库、必需资源和可选指纹；不启动游戏 |
| `ops.py backup` | 检查已停写的服务/数据库，联合保存 dump、录像、资源与私有配置及一致性清单 |
| `ops.py verify` | 重新校验备份批次 SHA、成员与制品，不连接数据库 |
| `ops.py restore` | 只向不同名全新空库及新目录恢复，映射 owner、授权、核对数据/序列/文件/录像关系 |
| `drill.py` | 在明确隔离的 PostgreSQL 上生成合成数据，执行空库和联合恢复演练，保留证据 |

完整生产步骤按 [安装](../docs/linux-install.md)、[数据库](../docs/database-init.md)、
[联合备份恢复](../docs/backup-restore.md) 执行。参数可逐项用 `--help` 查看。
数据库连接来自 `PGHOST/PGPORT/PGUSER/PGPASSFILE` 等标准变量；管理员凭据与 runtime 凭据分开。
批次/报告含数据库摘要与文件名，应私有保存，不提交公开仓库。

安装 Git LFS 后，从服务端根目录下载并检查固定版本查询库：

```bash
python3 ops/scripts/ops.py catalog-fetch \
  --destination plugins/card-catalog/databases --versions ops/versions.json
python3 ops/scripts/ops.py catalog-check \
  --catalog plugins/card-catalog/databases --versions ops/versions.json
```

下载目标必须不存在，已有目录先检查且不会被自动覆盖。缺文件、LFS 指针和无效数据库不能作为验收成功；随后仍执行
[实际插件装载验收](../../plugins/card-catalog/CARD_DATABASE_CONFIG.md#验证实际插件装载)。
`release` 通过显式 `--component catalog=路径` 保存四库，不在 `application/` 重复打包。

从 `srvprotianti/ops` 目录运行不连库的测试：

```bash
python3 -m unittest discover -s tests -v
```

Windows 服务脚本的定向测试（Windows PowerShell 5.1，用假 PM2 CLI 和临时目录，不访问真实 PM2 或 rpc.sock）在服务端根目录运行 `npm run test:windows-service`。

下面要求已经有独立测试 cluster，**不能指向正式服务或复用正式实例**：

```bash
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=stage2_owner
unset PGOPTIONS
python3 scripts/drill.py \
  --server-source .. \
  --workdir /private-test/ops-drill-20261011 \
  --suffix oct11 \
  --confirm-isolated-cluster 127.0.0.1:55432 \
  --pg-bin /usr/lib/postgresql/17/bin
```

`workdir` 不得存在，suffix 每次不同。管理角色必须能创建合成测试库/角色。
工具拒绝同名目标、已有数据目标及损坏文件，不做 DROP 或清理。
检查 `drill-result.json` 的 `complete:true` 和各项结果，结束后停止自己创建的测试 cluster。
保留结果的 `linuxSystemdValidated:false` 与 `engineAndNetworkValidated:false`：
该演练没有启动真实引擎、代理或 systemd。
云端环境与测试 cluster 准备方式见 [Codex 云端测试](../docs/codex-cloud-testing.md)。
