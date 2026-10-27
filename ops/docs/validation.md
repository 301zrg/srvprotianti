# 验收、隔离演练与证据范围

这份表区分“实现”“本机自动验证”和“真实Linux/正式服务验收”。
工具通过不会自动使其他栏变为通过。正式环境尚未部署本批代码，也没有读取其私密配置或数据。

## 自动验证入口

服务端：

```bash
npm run build
npm test
node plugins/postgres-compat/deployment/schema.js check-contract
node plugins/postgres-compat/deployment/schema.test.js
```

网页：

```bash
npm run test:public-config
node node_modules/typescript/bin/tsc --noEmit
npm run lint
npm run build:static
```

数据库演练参数以各项目工具 README 为准。
自动/手工发布要实查产物而不是只检查源配置函数，例子使用合成域名，不能直接替代正式地址。

运维标准库测试与真实PG演练入口见 [scripts README](../scripts/README.md)。
PG使用单独测试cluster/角色/`srvpro_drill_*` 库和合成录像，真实账号、私有配置不参与。
全部验证报告先写私有报告目录，再摘录不含凭据/玩家数据的结论到公开文档。

## 两条演练路线

### A：全新安装

全新Linux或隔离VM → OS/Node/PG17 →release校验解包/引擎构建→新空库初始化→
runtime只读schema验证→systemd/Nginx→测试账号和完整TT/普通房→录像/统计→reboot。

结果要记录OS、CPU、Node/npm、PG客户端/服务端、代码dirty/制品SHA、引擎binarySHA、
Core/Lua/scripts/CDB/禁表指纹、域名/端口/Origin和每项失败定位。
不从开发机隐含node_modules、私有配置、原库和Windowsbinary借依赖。

### B：联合恢复

合成库产生账号/积分/Match/单局/使用率及三类录像样本 →自然排空并停所有writer→
联合backup与verify→异机复制后verify→不同名字新空库/新目录restore→
内容/序列/schema/角色/SHA/录像分类一致→路径映射→新写入→重启。

先在合成样本上证明工具，然后再由管理员在私有隔离目标上恢复一份真实批次。
全量数据体积、真实locale、现场新增表/扩展会影响耗时与兼容性；不能用几行合成样本估算正式恢复时间。

## 真实服务验收表

2026-10-11 本机已通过服务端完整构建和 `npm test`，以及 PostgreSQL 部署工具测试。
运维工具 17 项标准库测试和部署参数/实体/DDL 契约检查通过；
28 份交付文档的 336 个本地链接、JSON/示例 Python 与 39 个 Bash 块的语法检查通过。
隔离 Windows PostgreSQL 18.4 已完成空库初始化、真实 TypeORM 对 20 表写入、拒绝重复初始化、
权限/约束/历史结构/序列验收和真实 dump/restore。
联合恢复演练已核对全部表内容摘要、序列、原始文件 SHA、积分、连胜和三类录像关联；
新 runtime 写入成功，拒绝原库、非空目标和损坏文件。
网页已通过 7 项公开配置测试、5 项 Toy 打包测试、类型检查、lint、完整 Cloudflare 构建，
并实际检查 Edge 中 4 种配置场景、普通 ZIP 与 Toy ZIP 的公开参数和资源映射。
本次 ZIP/dist 使用合成示例域名，正式部署必须重新构建。

本地证据位于工作区 `.audit-tmp/pg18-stage2/drill/postgres-drill.json`、
`.audit-tmp/ops-pg18-drill-20261011b/drill-result.json` 和
`srvprotiantiweb/.audit-tmp/stage2-web-validation.json`；不随公开运维仓库提交。

| 项目 | 做法和预期结果 | 当前状态 |
| --- | --- | --- |
| 空库结构及权限 | 20表/约束/序列齐全，runtime无永久DDL/owner权限 | 以本次自动PG报告为准；PG17待真实执行 |
| 恢复完整性 | 每表内容/行数/序列与批次相同；没有自动重置连胜/积分 | 以本次联合演练报告为准 |
| Linux引擎 | ELF x86_64、SSE2、依赖可用、正确cwd、固定脚本/CDB | 尚未真实Linux执行 |
| TCP入房 | 两测试客户端、正确协议版本、普通房可完整结束 | 待Linux/真实协议 |
| TT账户/结算 | 注册与密码认证、G1–G3/换备、一场Match只结算一次 | 现有单元/集成验证与真实对战分开 |
| 重连/观战/恢复 | 中断、宽限、重连、后入观战和支持录像恢复 | 待真实客户端 |
| 卡池/双CDB | 环境内允许、超池TT拒绝、异画兼容、现有特殊房代码 | 文件指纹已核对；加载/行为待正式基线 |
| 四语/使用率 | 四语名称和中文metadata可用，Match投影正常 | 本地资源存在；目标Linux运行待核对 |
| 录像 | 新录像与DuelLog事实、历史列表/下载/支持播放一致 | 工具分类/字节验证与真实播放分开 |
| WSS/TLS/Origin/IP | 允许Origin101，错误Origin403，不信任玩家自带XFF | 本地回归与真实代理检查分开 |
| 自动+手工网页发布 | 三公开输入实际进入dist与ZIP，新官网入口正确 | 本次网页报告为准 |
| 维护 | 未established/deleting/排队/异步写不允许ready；stop权限鉴权 | 本地回归；真实systemd停机待执行 |
| systemd/reboot | 重启后正确版本、路径、权限、端口恢复，无孤儿进程 | 尚未真实Linux执行 |
| Bot/桌面迁址 | 不重复推送、保留本地状态，设置指向新服务器 | 文档已补；实际账号/桌面操作待执行 |

## 本机Linux验证限制

2026-10-10尝试启动本机WSL Ubuntu，系统返回 `HCS_E_HYPERV_NOT_INSTALLED`，
虚拟化运行条件不可用；Docker Linux daemon也未可用。
未修改BIOS/Windows虚拟化设置，未把Windows真实PG演练写成Linux成功。
本机PG18.4是另建cluster、仅127.0.0.1:55432；未连接原本机18服务或正式PG17。
这证明SQL/权限/联合dump恢复的实测范围，不能代替PG17/Linux/systemd/真实客户端验收。

运维仓库提供在有Linux条件后可执行的演练工具；部署/恢复工具与文档可以先交付，
后续 Linux/PG17 自动验证可走 [Codex 云端测试](codex-cloud-testing.md)。
第三阶段环境解耦仍需用户指示，尚未开始实施。

## 记录格式

每条验收记录包含：执行日期/操作者、版本/制品、隔离目标、命令、退出码、预期/实际结果、
报告位置、未通过项和解决方式。只保存脱敏结论到公开仓库。
“未执行”“失败”“通过但有限制”分别记录，不用一个含糊的已测试覆盖所有条件。
