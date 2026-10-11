# 2026-10-11 隔离云端验证记录

本记录摘录用户提供的云端测试报告。本轮没有接入该云端环境或直接复阅原始命令日志，
下列结果均按用户报告登记，不应当作为本机重新执行测试的声明。
报告中的云端任务没有访问生产数据库、推送测试分支、发布网站或正式开服。

第二阶段按先前确认的“先交付工具和详细指南”范围完成，并补齐了 Linux/PG17 隔离基础验证证据。
完整在线引擎制品、完整对局、生产系统验收与真实数据迁移仍有未执行项；
本记录不声明仅克隆 GitHub 源码即可直接完整开服，也不声明真实迁服已验证。

## 固定源码与环境

| 项目 | 报告记录 |
| --- | --- |
| 服务端 | `codex/catalog-lfs-20261011`，提交 `4d15b5369f7674c9fac5e87c01ec28aae2750632` |
| 网页 | `deploy/cloudflare`，提交 `7e3a37db20714581cbdd7e5bde4b6bf2664c9a9d` |
| 查询资源 | 提交 `a6c3ec49f2856753b2d3c2bc13266dc98058e4fd`，指纹匹配所测服务端 `ops/versions.json` |
| 系统 | Debian 13.6、x86_64；PID 1=`tail`，用户=`agent` |
| Node / npm | 24.15.0 / 11.12.1 |
| Python / SQLite | 3.12.14 / 3.53.1；`python`、`python3` 均可用 |
| Git LFS | 3.6.1 |
| PostgreSQL | 服务端和客户端均为 17.11；独立临时 loopback cluster |

这是 Debian 隔离容器中的验证结果。部署主线仍为 [Ubuntu 24.04 Linux 安装](linux-install.md)，
不能把本次环境当作已执行 Ubuntu、systemd 或服务器重启验收。

## 报告结果

| 状态 | 检查与证据范围 |
| --- | --- |
| 通过 | 四语 Git LFS 下载；四份真实 SQLite 的必需字段、字节数、SHA 均与固定清单匹配。中文/英文各 14,981 条名称，日文/韩文各 14,968 条。 |
| 通过 | 只读真实 `cardCatalog` 装载：warnings=0、metadataAvailable=true、size=14,981、四份 fingerprint 齐全。报告引用 `catalog-load.log`、`install-final.log`。 |
| 通过 | 服务端锁定依赖安装、原始 build、`npm test` 全部 15 个入口、schema contract 与 `schema.test.js`；运维 unittest 33 项。 |
| 通过 | PG17 临时 cluster 的 20 表、真实 TypeORM `synchronize=false` DML、运行角色 DDL 拒绝、CHECK/unique/cascade、只读统计保持、历史兼容、错误索引/权限/序列拒绝及真实 dump/restore；两批报告均 ok=true。 |
| 通过 | 合成数据库和中文文件名录像联合恢复：内容哈希、schema/序列、文件字节 SHA、积分/历史/连胜、关联/孤立/缺失录像分类、权限与新写入一致；拒绝源库、非空目标及损坏录像，两批 complete=true。 |
| 通过 | 网页 `npm ci`、7 项 public-config 测试、tsc、lint、`build:cloudflare`、普通包及 BiliToy 包。dist/普通包各 16 项资源 SHA；Toy 15 项 SHA、`current.json` 语义及 13 项改名映射一致；三项合成公开配置和源码提交一致。 |
| 失败后修复 | 首次 install 在执行过程中修改辅助脚本，Bash 后续读取位置错位而退出 2；原始日志保留。完整重跑的 `install-final` 退出 0，并重新对所选源码副本执行 PG17 演练通过。最终报告没有未解决的仓库测试失败。 |
| 未执行 | 固定在线引擎构建、ELF/ldd/SHA preflight、原生 TCP/WSS 和完整对局：未提供完整审核封存资源包，缺 `ygopro/ygopro`、`cards1.cdb` 和封存 Lua。旧上游 Core/scripts/CDB 不能证明与固定版本匹配。 |
| 未执行 | 生产 systemd/reboot、正式 DNS/TLS/Origin/IP、Windows/手机真机、真实普通房/TT/重连/结算及机器人平台权限。 |

四语查询库已经取得并真实装载通过，不再列为缺项。它们不替代在线引擎所需的两套 CDB、
Core/Lua、脚本、禁限表及匹配的 Linux binary。
合成录像验证了分类和原始字节保存，不能证明真实游戏录像可播放；合成库恢复不能推定正式全量恢复耗时。

## 源码、配置与证据保存

网页使用三项合成公开参数：

```text
VITE_DUEL_WS_URL=wss://game.example.invalid/neos
VITE_DECK_IMPORT_ORIGINS=["https://ladder.example.invalid"]
VITE_WEBSITE_BASE_URL=https://ladder.example.invalid/
```

这些产物只供检查，正式部署应使用实际域名重新构建并验收。
报告说明构建在外部服务端源码副本及网页忽略输出执行，原始源码、测试、版本清单和锁文件均未改。
外部服务端副本仅将不可用 npm 镜像下载 URL 改为官方 registry，完整性哈希保留；
因此不能将安装过程描述为对原锁文件下载地址未经任何调整的原样验证。

报告给出的两批 PG17 证据位置是云端任务相对路径：

- `../runs/pg17.QojliFXB`
- `../runs/pg17.P8OkfJoq`

这些路径没有被复制到当前本地工作区，不是公开下载链接。
报告称已保留合成 dump、录像、恢复报告及完整命令/退出码日志，退出 trap 已停止本任务全部 cluster，
并确认 55432 空闲。需要长期留存时，由操作者另行导出和校验这些云端材料，避免依赖任务临时存储。

## 后续部署与测试前置项

完整上线前仍需要审核过的固定 706 引擎发布包与指纹、实际在线资源加载行为确认，
自己的私有数据库/运行/管理配置、DNS/证书/网关 Origin 与可信 IP 设置，
并按 [验收表](validation.md) 执行生产 systemd/reboot、真实客户端和完整对局、录像播放及机器人验收。
真实备份的恢复应另在私有隔离目标演练，保持原始批次及全量数据证据。

该次环境安装脚本和启动指南将保存为配置草稿；尚未保存并发布可复用环境快照。
未来任务需要完成保存与发布，并在新任务中验证环境恢复，不能据本次成功报告宣称这一点已经通过。
复测步骤仍见 [云端测试指南](codex-cloud-testing.md)。
