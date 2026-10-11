# 运维工具入口

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
