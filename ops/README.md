# srvprotianti-ops

三个项目的 Linux 部署、交接、备份恢复与迁址入口。主线为 Ubuntu 24.04 x86_64、
Node 24、PostgreSQL 17、原生引擎与 systemd；网页继续使用现有静态托管，
桌面助手继续在玩家 Windows 电脑运行。运维材料随 `srvprotianti` 仓库的 `ops/` 目录发布，
将本目录完整复制到 `/srv/srvprotianti-ops` 后可按指南操作；后续也可保留目录结构单独发布。

先选择任务，再沿对应手册执行；空库初始化与恢复已有数据是两条路线。

| 任务 | 入口 |
| --- | --- |
| 新 Linux 首次安装 | [Linux 安装](docs/linux-install.md)，[空库初始化](docs/database-init.md) |
| 保留完整数据库与服务器录像 | [联合备份与恢复](docs/backup-restore.md) |
| 换服务器／域名／WSS | [跨项目迁址](docs/server-move.md) |
| 升级、停机、日志、故障、回退 | [日常维护](docs/maintenance.md) |
| 两套卡库、引擎、脚本、禁限表与版本 | [资源交接](docs/resources.md)，[版本与指纹](versions.json) |
| 查看验证证据与尚待正式 Linux 验收的项 | [验证记录与演练](docs/validation.md) |
| 在 Codex 云端做 Linux/PG17 自动测试 | [云端测试步骤](docs/codex-cloud-testing.md)，[2026-10-11 云端报告](docs/cloud-validation-20261011.md) |
| 为其他怀旧环境复用三个项目 | [第三阶段解耦方案，待确认](docs/other-environments-plan.md) |

## 工具与模板

[ops.py](scripts/ops.py) 仅使用 Python 标准库；数据库操作调用本机 PostgreSQL 客户端，
凭据来自 `PGHOST/PGPORT/PGUSER/PGPASSFILE` 或私有 `PGPASSWORD`。它不读取本机生产配置，
不覆盖已有目录／数据库，不自动启动服务，不执行历史修复、连胜清零或统计回填。

```text
python scripts/ops.py --help
python scripts/ops.py release --help
python scripts/ops.py verify-release --help
python scripts/ops.py unpack-release --help
python scripts/ops.py catalog-fetch --help
python scripts/ops.py catalog-check --help
python scripts/ops.py preflight --help
python scripts/ops.py backup --help
python scripts/ops.py verify --help
python scripts/ops.py restore --help
python -m unittest discover -s tests -v
```

`release` 保存已跟踪文件的当前字节，包括未提交修改；未跟踪文件默认排除。
新增公共源码由维护者逐项审查后用 `--include-public 相对路径` 纳入。
完整引擎及查询卡库通过显式 `--component engine=路径 --component catalog=路径` 提供；
发布工具排除 `.git`、`node_modules`、运行配置、密钥、录像和日志。
四语查询 CDB 通过独立 [资源仓库](https://github.com/301zrg/srvprotianti-resources) 的 Git LFS 发布；
`catalog-fetch` 按 `versions.json` 的固定资源提交下载至新目录，`catalog-check` 验证结构和版本指纹。
发布工具将查询库仅存入 `catalog` 组件，不在 `application/` 重复保存；下载与插件装载检查见
[资源交接](docs/resources.md) 和 [查询库配置](../plugins/card-catalog/CARD_DATABASE_CONFIG.md)。
发布制品与私密恢复批次均不提交本仓库。备份清单包含文件名及数据库内容摘要，也应私有保存。

`backup` 默认检查每个写入服务确实为 systemd `loaded + inactive`，数据库无其他连接，
并比较拷贝／dump 前后的文件与数据库状态。所有实际写入者都须列入计划，
包括同库机器人、其他后台任务与另一个主服实例。维护端点 `readyToStop` 只证明可停止，
仍需停止进程并通过工具检查。

`restore` 先校验整个批次和发布包，再恢复到不同名字的全新空库、全新目录。
它映射到显式 owner，补当前运行角色权限，核对 schema／行数／表内容摘要／序列／文件 SHA／录像关系。
缺文件的历史 DB 记录和无关联旧录像与备份基线一致即可，不伪造一对一关系。

[templates](templates) 提供 systemd、Nginx、无凭据配置与备份计划示例。
这些是需要替换目录／域名／端口并验收的模板，不会自动覆盖现有正式配置。
`backup-plan` 的 `source` 必须是真实目录；解析并填写符号链接的目标路径，组件不得重叠。

## 验证边界

第二阶段按工具、详细指南与 Linux/PG17 隔离基础演练范围结项，云端证据来自用户提供的报告。
完整固定引擎包、真实 TCP/WSS/TT 对局、生产迁移与 systemd 重启尚未验收，不能宣称整服部署通过。
完成情况以验证手册及实际报告为准。
公开资料不包含真实密码、私有卡组、录像原件、dump、Token 或生产配置。

第三阶段已完成方案评估，等待用户确认实施范围；当前未修改运行代码或两套 `cards.cdb/cards1.cdb`。
