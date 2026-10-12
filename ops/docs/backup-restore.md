# 数据库、录像与资源的联合备份和恢复

恢复需要同一停写批次的数据库和文件。`pg_dump` 自身的数据库一致性不能代替文件系统一致性。
本工具使用停机窗口，并在备份前后核对写入进程、数据库状态、文件字节，发现变化就失败。
自动数据库对比覆盖表内容/行数、关系字段、索引/约束和序列；
现场额外函数、触发器、view 定义、扩展版本、RLS 策略及 large object 内容仍须单独验收。
dump 会保存可支持的对象，但 `complete:true` 不表示任意现场扩展都经过逐项语义比较。
完整备份是私有资产，包含账号信息、卡组/录像、IP、配置和可能的机器人凭据；不进入公开 GitHub 仓库。

## 先确认备份边界

参照 [backup-plan.example.json](../templates/backup-plan.example.json) 填自己的私有计划：

- `database`：正在使用的完整应用库，包含宿主、天梯、八张使用率表及现场新增表。
- `releaseArchive`：审核并校验过的当前工作树与资源制品及其 sidecar manifest。
- `runtimeRole`：游戏服务运行数据库角色。
- `writerUnits`：所有可能写本批资产的真实 systemd units，不能只写游戏服务后漏掉更新任务或机器人。
- `components`：实际录像目录、config 目录、各插件私有配置、四语 CDB、原始引擎资源、
  tournament deck/log、deck_log、机器人 config/data、环境文件等独立路径。
- 认证日志 `shared/logs`、管理页面修改过的模板/分类/展示文件及现场其他可写资产也要列入计划。
- `replayComponent`：components 中实际 yrp 保存目录的 ID。

组件不允许路径重叠。例如完整 private tree 已包含 config，就不要另列 config 子目录。
可将不连续的私有文件逐个列为独立 component；单文件在恢复组件目录下保留原文件名。
符号链接不静默跟随：列实际目标路径，不把链接树误当数据已备份。
改系统配置、Nginx、systemd、证书续期和机器人路径时同步该计划。

维护的是“一份完整应用库”的逻辑备份，不是只导出四张天梯表。
archive 保留 schema、data、序列、索引、约束和数据库 large objects；角色与 tablespace 不在单库 dump 中。
本指南选择在新机显式重建 owner/runtime 角色并映射，额外 tablespace/扩展/全局角色另列交接项。
[PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)

## 1. 进入维护并等自然结束

先停止 cron/timer/后台改库、更新资源任务和会写备份范围的机器人。
在既有受权限保护的管理页面设置 `modules.stop` 为维护提示；该行为拒绝新入房，
允许现有对局自然结束，既有允许的重连继续工作。不要使用 kick all/reboot 代替自然排空。

新宿主提供只读 `GET /api/maintenance/status`：

```json
{
  "maintenanceEnabled": true,
  "rooms": 0,
  "pendingWork": {},
  "pendingPersistence": {},
  "pendingCount": 0,
  "readyToStop": true
}
```

状态计数包含未建立、正在删除的房间，既有客户端/后端协议处理，以及 yrp、DuelLog 和云录像任务。
请求使用 HTTP Basic，用户必须已有 `stop` 权限，不能通过查询参数传密码。
在本机端口访问，或通过管理者自己的 SSH 隧道访问；不要经公网无 TLS发送 Basic。
用 root 0600 curl 配置文件放凭据，避免 shell 历史和 URL 日志：

```bash
sudo curl --config /etc/srvprotianti/maintenance-curl.conf \
  --fail --silent --show-error http://127.0.0.1:7922/api/maintenance/status
```

本接口不改变动画顺序、队列容量或消息丢弃行为。
`readyToStop` 是此刻可以停服务的条件，不是整机停写证明；任意第三方插件/后台进程仍须列入停写范围。
房间不清零时检查等待房、重连宽限、卡住的后端和持久化告警，不能用固定 sleep 直接跳过。
确认条件成立后停止游戏服务及其他 writer units：

```bash
sudo systemctl stop srvprotianti.service
sudo systemctl is-active srvprotianti.service
```

is-active 的预期是 inactive；其退出码此时通常非 0，不应被解释为“停止失败”。
真正停止失败、状态 failed、unit 不存在或数据库仍有其他连接时，备份工具拒绝继续。
`KillMode=control-group` 清理子房间；不要在仍有活跃对局时执行 stop。

## 2. 做联合批次

操作者使用只供备份/恢复的数据库管理连接，密码放 0600 `.pgpass` / PGPASSFILE。
以下正式备份/恢复命令在管理员 `sudo -i` 打开的 root shell 中执行，
以便读取 0600 私有配置、环境文件与完整批次；SQL 身份仍是独立 srvpro_operator。
事先创建 root 0700 的 `/private-backups`、`/private-restores`，并私下安装 0600 的 ops.pgpass。
连接角色要能读取全部表/序列、进行需要的恢复授权；不能使用 runtime 角色做 DDL。
工具显式用 `--database` / plan.database，不依赖 PGDATABASE 的猜测。
源库、pg_dump 和新目标优先同为 17；客户端不能比源库旧。

```bash
export PATH=/opt/node24/bin:$PATH
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator
export PGPASSFILE=/etc/srvprotianti/ops.pgpass
python3 /srv/srvprotianti-ops/scripts/ops.py backup \
  --plan /etc/srvprotianti/backup-plan.json \
  --output /private-backups/1103-20261011T020000Z \
  --pg-bin /usr/lib/postgresql/17/bin
```

`srvpro_operator` 应由管理员事先配置为单独运维身份，具备 schema owner 的管理/读取权限。
不要把管理员连接凭据放进游戏 service.env；使用 TCP或 Unix socket 时按自己 pg_hba 的认证方式设置。
输出目录必须新建；源资产内不能出现备份输出目录。
工具检查全部 writer units 已 loaded+inactive，目标数据库没有其他会话。
执行 pg_dump 后再核对库内容/序列和所有源文件，任一变化/错误产生 FAILED.json，不作为可恢复批次。
备份期间不要恢复 writer、数据库管理编辑器或自动更新任务。

manifest 包含批次、数据库版本/编码/locale、dump 客户端大版本、owner 策略，
完整文件路径/大小/SHA、每表行数/内容 SHA、结构、序列状态与录像关联分类。
内容校验会扫描数据库，超大历史库的停机耗时需先演练，不承诺固定分钟数。

```bash
python3 /srv/srvprotianti-ops/scripts/ops.py verify --batch /private-backups/1103-20261011T020000Z
```

verify 退出 0 表示批次内部文件和 release archive 校验通过；它不等于已经在新机恢复成功。
备份完成后先启动仍保持 stop 的游戏服务，核对正常后按维护指南取消维护，再启动其他 writer；
保留这一批原始只读资产。

## 3. 异机保存和定期演练

将完整批次复制到另一台机器或私有备份存储，传输后再次运行 verify。
例子只演示私有 SSH 目标，实际用户名/路径由管理员填写：

```bash
rsync -a -- /private-backups/1103-20261011T020000Z/ backup-user@backup-host:/private/1103-20261011T020000Z/
```

使用受控传输和存储权限；需要加密时使用团队已经具备且交接了解密密钥的工具。
校验清单可以检测漏件/损坏，但不是针对不可信备份来源的数字签名。
设定自己的保留期、备份频率、可接受的数据丢失窗口和恢复时间目标；备份失败要有人接收并处理。
留在同一台游戏服务器的备份不满足换机/磁盘损坏恢复需求。

## 4. 恢复到全新隔离库和新目录

按 [Linux 安装](linux-install.md) 准备 OS/Node/PostgreSQL；按 [角色指南](database-init.md)
创建 schema owner、runtime、一个**不同名字的全新空库**，不要执行 init。
同一名字即使在别的主机上也会被当前工具拒绝，先用新的 staging 库名完成恢复/验收，再切运行配置。
source/target 不同名字、新路径和 confirm 参数是防覆盖约束。

```bash
python3 /srv/srvprotianti-ops/scripts/ops.py restore \
  --batch /private-backups/1103-20261011T020000Z \
  --destination /private-restores/1103-check-20261011 \
  --database srvpro_1103_restored \
  --confirm-new-database srvpro_1103_restored \
  --owner-role srvpro_schema --runtime-role srvpro_runtime \
  --schema-tool /srv/srvprotianti/current/plugins/postgres-compat/deployment/schema.js \
  --pg-bin /usr/lib/postgresql/17/bin
```

schema-tool 使用与该 release 配套的工具；新机尚无 current 时使用已安装 staging application 内的绝对路径。
操作者的连接角色必须能 SET ROLE 到 owner，建对象及授权；`--no-owner --no-acl --role` 将对象映射到目标 owner，
再显式授予 runtime。工具使用 `--exit-on-error --single-transaction`，检查每个进程退出码。
它不会自动启动游戏或套用历史初始化/连胜/修复脚本。
旧大版本 archive 不能用更旧目标恢复；本工具也拒绝目标大版本低于 dump 客户端，
同源/同客户端/同目标 17 是本阶段的优先路线。
[PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)

成功得到 `restore-result.json` 的 complete=true、schema-verification.json、restore-map.json。
文件校验、全库内容/序列、录像关系须与批次一致；Linux 引擎、权限与网络验收仍标记未验证。
失败时保留新库和新目录的失败证据，换一个全新目标重试；工具没有覆盖已有目标的开关。

## 5. 路径、权限与录像核对

根据 restore-map 将恢复组件安装到新机 shared 等实际位置。
组件 ID 与运行位置的对应关系如下；表中的私有单文件需取组件目录内的原文件名：

| 恢复位置 | 安装/配置位置 |
| --- | --- |
| `runtime/recordings` | 运行录像目录，主配置 replay_path 指向它的受控运行副本 |
| `runtime/host-config` | application/config 所指的 shared 配置目录 |
| `runtime/plugin-config` | shared/privatePluginConfigs，各插件 config.json 链接对应文件 |
| `runtime/service-env/server.env` | root 0600 的 /etc/srvprotianti/server.env；改成目标数据库名 |
| `runtime/engine`、`runtime/catalog` | 已验证的引擎/四语卡库运行副本；与本批 release 资源对照 |
| `runtime/tournament-decks`、`runtime/tournament-logs`、`runtime/deck-logs`、`runtime/auth-logs` | 对应 shared 数据目录或配置指定的路径 |
| `runtime/plugin-assets`（计划中启用时） | shared/plugin-assets 分类/展示/模板与示例卡组受控副本；链接按公共参数表恢复 |

例如，将录像复制到一个不存在的新运行目录，保留原恢复证据：

```bash
test ! -e /srv/srvprotianti/shared/replays-restored-20261011
cp -a /private-restores/1103-check-20261011/runtime/recordings /srv/srvprotianti/shared/replays-restored-20261011
chown -R srvpro:srvpro /srv/srvprotianti/shared/replays-restored-20261011
chmod -R u=rwX,g=rX,o= /srv/srvprotianti/shared/replays-restored-20261011
```

先核对目标绝对路径和新目录条件；已有目录须停下来查明，不覆盖旧资产。
将新配置中的 replay_path 设为 `/srv/srvprotianti/shared/replays-restored-20261011/`。
其他组件同样复制到明确的新受控位置并配套链接/路径；私密文件设 0600，目录 0750，
运行需要写的资产归 srvpro，代码/资源只保留必要执行位和读取权限。
逐项替换旧 Windows盘符/反斜杠、旧 Linux路径，保留目录末尾 `/`、中文文件名、大小写与原始字节。
owner/group 使用本机 srvpro 身份，而不是照搬旧机 UID；Linux binary 单独恢复执行位。
恢复用的私有 root 0700目录不能直接让游戏服务读，应将所需配置/数据转入受控运行位置并设置属主。

录像分类核对的是与备份基线相同，而不是强制 1:1：

| 分类 | 意义 |
| --- | --- |
| linkedFiles | 文件存在且有持久化 DuelLog 引用 |
| unlinkedFiles | 历史文件存在但没有 DB 引用，仍需保存 |
| databaseWithoutFile | DB 有引用但备份时没有文件；可能原有禁发/保存失败，不能据此猜造 |
| nestedFiles / unsafeDatabaseFilenames | 原有子目录或异常名称，保留证据并按现有 API 规则处理 |

若旧库本身已经缺文件，恢复不会凭空产生录像。
若恢复后分类与基线不同，则作为漏件/内容变化失败，不能用重建关联掩盖问题。
核对账号、总/月积分、Match/G1–G3、连胜和 usage 事实；测试历史录像列表、原件下载和已支持的播放。

## 6. 新写入和切流

保持隔离端口、测试 origin、关闭真实机器人主动推送。
在新机启动完成真实对局验收，重启服务器再检查进程/路径/端口。
旧机在切换前维持停写，最后一次联合备份恢复完成后只保留一个正式写入端。
详细地址切换见 [迁址](server-move.md)，数据开始在新机写入后的回退见 [maintenance](maintenance.md)。

## 不能混用的捷径

不能先 init 再 restore；不能把 pg_dump 文件非空当作恢复成功；不能只复制录像和四张业务表；
不能复制运行中的 PostgreSQL data 目录；不能自动清零积分/连胜；不能将私有批次发布到文档仓库。
本机隔离演练使用显式 `srvpro_drill_*` 模式，其跳过 systemd 检查会在报告中标注，
正式备份不使用该模式。

## 在线持续备份方案（提案，待负责人审查）

当前工具仍只执行停写联合批次，不放松 writer/连接/前后状态检查。
以下设计未上线，不是已经获得异地恢复能力的证明；实施前由数据库、存储和告警负责人批准。

| 范围 | 拟议做法与验收证据 |
| --- | --- |
| PG17 在线恢复点 | 使用一致物理 base backup 加连续 WAL 归档；不能把 pg_dump 当作物理 PITR 基础。记录 system identifier、timeline、起止 LSN、版本及实际恢复点 |
| 录像增量 | 仅同步已完成关闭的文件；暂存后 SHA 校验再提交批次目录。保存 DB 引用、相同恢复点的录像清单和 linked/orphan/missing 分类；数据库快照与文件拷贝不天然原子一致 |
| 可写配置/模板/Bot 状态 | 显式列出全部 writer 和映射；停写联合批次仍是迁服/切流基准。运行中变更通过审核版本记录与一致拷贝，不能用旧模板掩盖新配置 |
| 异地 | 加密复制到独立故障域/账户，最小权限与独立解密交接；远端重新检查 SHA 并实际从远端取回演练。同盘 copy 只证明传输校验，不能标 offHostCopyVerified |
| 保留和容量 | 负责人明确 RPO/RTO、日/周/月保留、存储预算、归档最大滞后、最小空闲空间及最近成功恢复点；没有审核值时保持 BLOCKED，不填通用数字冒充服务策略 |
| 告警 | 归档失败/积压、录像同步失败、异地确认缺失、最近成功批次过期、磁盘空间阈值和周期恢复失败都必须通知指定接收人；执行故障注入验证收到并可恢复 |
| 恢复验收 | 对全新隔离主机/空目标，恢复 PG17 与同批文件；核对全表内容、序列、账号/积分/连胜、Match/G1–G3/usage、录像分类与原件，再完成真实播放、RPO/RTO 测量 |

PG 配置、认证和密钥本身也需要独立备份；WAL 归档不能代替它们。
参考 [PostgreSQL 17 连续归档与 PITR](https://www.postgresql.org/docs/17/continuous-archiving.html)。
批准方案后另行实施调度、归档与存储权限；本轮不修改 PostgreSQL 运行参数或创建后台备份任务。
