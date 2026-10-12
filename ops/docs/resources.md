# 引擎卡池、查询库与资源版本

换机时需要的是“这套环境正在使用的完整资源”，而不是从上游下载最新 cards.cdb。
引擎必须能够识别玩家提交的卡，房间规则和禁限表再决定哪些卡能用。
数据库中有某张卡，不表示 TT/1103 房允许它。

## 新维护者的部署输入清单

本节是资产/配置项目清单，不保存凭据内容；当前缺口和 A–F 状态统一归 [验证矩阵](validation.md)。

| 输入 | 获取方式 | 是否可公开 / 验收责任 |
| --- | --- | --- |
| 服务端源码、npm lock 与公共新增模块 | 固定审核提交；制品保留实际 HEAD/dirty 和全部成员 SHA | 公开源码；漏本地 require 文件必须失败，不能靠 npm install 补齐 |
| 网页源码 | 明确 deploy/cloudflare 完整 SHA，不能默认 clone main | 公开；三项发布输入及最终 dist/ZIP 均检查 |
| 桌面源码/EXE/页面快照 | 固定 main 来源，记录 Node/Rust/Windows、ZIP 和快照摘要 | 公开源码；受控新发行默认与玩家既有数据分离 |
| 在线引擎/Core/基础 Lua/依赖 | versions.json 固定公开候选来源，或维护者审核的私有完整制品 | 私有补丁/制品由维护者交付；来源不明、平台不符或缺 manifest 不放行 |
| 环境池、四语查询库 | 两个独立 LFS 提交与各自 SHA | 已公开；不能拿查询大库替代环境池，不要求 inactive cards1.cdb |
| 完整禁表、扩展资源和生产规则对应关系 | 审核封存实际文件和 HostInfo/协议/特殊房对照 | 本轮不连接生产取得；当前完整基准是否等价仍阻塞，纯 1103 禁表只供隔离测试 |
| 游戏 TCP、HTTPS API、WSS 和网页 origin | 维护者自己的域名/端口/精确 origin，不含凭据 | 公开参数；禁止默认回落到旧公网 HTTP 或通配 origin |
| 主/插件配置与管理账号 | 维护者在新实例私下准备；enabled、synchronize=false、stop、规则及路径明确 | 私有；只检测存在/类型/权限和是否符合审核配置，不把值写入公共报告 |
| PG owner/runtime/operator 身份与口令 | 分离 DDL、DML、运维角色，私有 env/PGPASSFILE | 私有；空库 init 与历史 restore 分开，正式密码不用于测试 |
| TLS、网关与防火墙权限 | 自己的证书/续期、Nginx/实际代理拓扑与系统管理权 | 私钥不入库；7922/7977/5432 不直接公网开放，正式网络另验 |
| 可写资产 | config、录像、日志、分类/展示/模板、示例卡组、赛事、Bot 状态 | 私有运行资产；明确 owner、shared 映射与备份范围，不整体给 release 写权限 |
| Linux/Windows/客户端验收环境 | 新隔离 VM/主机、测试账号与指定卡组；非原服 | Ubuntu24/PG17/systemd/重启、真实两端对局及移动端由对应环境留证 |

新空服不需要旧玩家数据；迁服必须另提供同批私有联合备份、角色/扩展清单、体积/耗时和隔离恢复证据。
缺少私有引擎补丁、真实域名/证书、规则基线或测试环境时记录 BLOCKED，不下载浮动上游替代。

## 三组资源分别保管

| 资源 | 作用 | 迁移方式 |
| --- | --- | --- |
| 服务端 ygopro 运行目录 | 在线 Core、Lua、环境卡池、禁限表与协议版本 | 固定来源后在目标 OS 编译/组装；环境 CDB 已独立 LFS 发布，基础与覆盖分层 |
| card-catalog 四语完整 CDB | 名称、类型、alias、卡片使用率事实 | 从独立资源仓库 Git LFS 取得固定版本，zh/ja/en/ko 分别校验，默认中文 datas 权威 |
| 网页 resources-staging/1103 与 replay/706-v1 | 浏览器资源与离线录像播放 | 由网页自身 Git/锁/快照构建，不移入游戏进程 |

桌面玩家自身的 `game/replay/` 和网页 IndexedDB 录像属于客户端保存，服务器恢复包不能替玩家恢复它们。

## 从线上取得四语查询库

当前交付状态：四份 LFS 对象已发布，固定资源提交为
[`a6c3ec49f2856753b2d3c2bc13266dc98058e4fd`](https://github.com/301zrg/srvprotianti-resources/commit/a6c3ec49f2856753b2d3c2bc13266dc98058e4fd)。
2026-10-11 已在 Windows / Node 24.15.0 下使用独立临时仓库和 LFS 缓存、禁用 GitHub 登录凭据，
从线上执行 `catalog-fetch` 和 `catalog-check`：四库字节数与 SHA256 全部匹配，真实插件装载无告警，
`metadataAvailable=true`、卡片数量为 14,981。
2026-10-11 用户提供的 [隔离云端验证报告](cloud-validation-20261011.md) 进一步报告：
Debian 13.6 / Node 24.15.0 下固定资源提交的四库下载、SQLite 必需字段、字节数和 SHA 校验均通过，
真实 `cardCatalog` 装载无告警，`metadataAvailable=true`、size=14,981、四份 fingerprint 齐全。
此项 Linux 结果来自用户报告，本轮没有直接复阅云端原始日志；完整在线引擎仍未验收。

服务端源码仓库继续忽略 `plugins/card-catalog/databases/cards.{zh,ja,en,ko}.cdb`；
这四份文件的发布位置是独立的 [srvprotianti-resources](https://github.com/301zrg/srvprotianti-resources) 仓库 `catalog/`，使用 Git LFS。
`ops/versions.json` 的 `catalogSource` 固定资源仓库 URL、完整 commit 和目录，`resourceFingerprints` 固定四库字节数和 SHA-256。
安装 Git LFS 后，在服务端根目录执行：

```bash
python3 ops/scripts/ops.py catalog-fetch \
  --destination plugins/card-catalog/databases --versions ops/versions.json
python3 ops/scripts/ops.py catalog-check \
  --catalog plugins/card-catalog/databases --versions ops/versions.json
```

下载目标必须不存在；已有目录先校验，匹配即可复用，不匹配时下载到新的目录，不覆盖现有运行资源。
下载工具在临时工作区取固定资源提交、拉取 LFS 内容并校验，成功后交付四个真实文件。
安装命令见 [Linux 安装](linux-install.md)，真实插件装载验收见
[查询库配置](../../plugins/card-catalog/CARD_DATABASE_CONFIG.md)。

GitHub raw 文件和未包含 LFS 内容的源码下载可能只有指针，不能直接作为 CDB 使用。
发布包仍显式保存 `catalog` 组件，四库不在 `application/` 重复打包；联合备份继续保存当时实际使用的卡库字节。
恢复旧批次时使用该批次组件和 manifest，不用当前分支的查询库覆盖旧资源。
查询库与引擎卡池分开固定；引擎程序、基础/覆盖 Lua 和禁限表仍需按下一节组装并验收。

需手动核对下载过程时，在不存在的临时目录克隆资源仓库，使用 `catalogSource.commit` 的完整 SHA 执行
`git checkout --detach <完整SHA>`，再运行 `git lfs install --local`、
`git lfs pull --include='catalog/*.cdb' --exclude=''`、`git lfs fsck`，
用服务端 `catalog-check --catalog <资源工作区>/catalog --versions <服务端>/ops/versions.json` 核对结果。
不要直接使用资源仓库浮动 `main` 的内容覆盖旧 release；卡库变更必须连同版本指纹和使用率派生数据语义一起审查。

## 正式引擎卡池与本机同名文件

2026-10-12 正式 Windows EXE 静态分析、线上目录检查和用户实测确认：
现用 `ygopro/cards.cdb` 是 5,267 卡小库，`cards1.cdb` 是 14,949 卡大库且未加载。
后续又只读下载现用小库并复核字节、SHA、SQLite 完整性和两表行数。
新安装使用这个固定小库，不合并两库、不新增按房切库；原服和历史私有备份继续保留原件。

用户明确批准后，已将小库发布到资源仓库 `codex/engine-pool-20261012` 分支的 Git LFS：
完整提交 `7b29eb288411b64531e4a7c41642fb4beecf8709`，路径 `engine/1103-706/cards.cdb`，
1,695,744 字节，SHA-256 `a49f0652ad54a7f55c569284ca154f0ec435fc26ebdd728927052e57b9d816e5`。
分支未合入 main，但固定 SHA 和 LFS 对象已能回下载并校验；`enginePoolSource` 是维护入口。

```bash
python3 ops/scripts/engine.py fetch-pool --destination /private-staging/engine-pool-v1 --versions ops/versions.json
python3 ops/scripts/engine.py check-pool --pool /private-staging/engine-pool-v1/cards.cdb --versions ops/versions.json
```

以下仅为 2026-10-10 本机历史快照，同名大库**不是现服小库**，不能拿旧 SHA 代替新安装卡池：

| 文件 | 大小 | datas/texts 行数 | SHA-256 |
| --- | ---: | ---: | --- |
| cards.cdb | 8,050,688 | 14,981 / 14,981 | `5f13245de4e665450858f66ef2f736a3d2f48cc7f0036961373a96a650cb6797` |
| cards1.cdb | 8,026,112 | 14,949 / 14,949 | `70e9b45cef09dd079c8958a738d5561a302151e97b1cdeb213f13e76fe9e90b9` |

本机两大库相差 32 个 ID；这不是线上小卡池差异的定义，datas、alias、禁限表和房间规则都需要验收。
fingerprint 是此刻本地文件证据，不自动等于正式服务器的文件证据。
正式备份以实际服务器生成的 manifest 为准。

## 加载行为及验收

当前本地 `gframe/game.cpp` 的 server mode 明确加载 `cards.cdb`，随后加载 `expansions/` 中的 CDB；
编译开关还可能加载 `cdb/` 或扩展归档。
没有找到直接引用 `cards1.cdb` 或按房间代码在二者间切换的本地源码。
现服加载小库已确认；仅放宽 hostinfo/禁限表不会让未加载的大库自动生效。
新目录不携带未知 expansions/cdb/归档，也不把 cards1.cdb 或构建 header 作为运行必需文件。

迁移前记录实际 Linux 引擎 SHA、来源 commit/dirty patch、构建开关、expansions/cdb/归档内容，
以及房间代码最终映射到的 hostinfo。若正式服务器有独有 wrapper 或补丁，必须加入制品。
用操作者已知的合法测试卡组验证：

1. 常规 1103/TT 房允许环境内卡，拒绝操作者指定的一张环境外卡。
2. 已支持异画的卡组按当前正式行为入房、识别、查询并归并 alias。
3. 对照旧服记录特殊房实际允许/拒绝的卡和禁表，不预设能够使用未加载的大库卡。
4. 恢复同一组资源后重复三项，结果与旧机相同。

不要凭“两个文件存在”勾选这四项，也不要凭文件名断言引擎正在切换小库。

## 固定构建输入

本地源树 engine HEAD=`5e63f18fb6b9a6ddc651bc2e8847eec9689ccbff`，
Core HEAD=`e04144d62499c17d0cfa8313f9742434ef99c3a7`，
基础脚本提交 `5864b6f6e58d49738e0996b94e96655b51f420bf`。
`gframe/config.h` 的 PRO_VERSION 为 `0x1362`。HEAD 之外的修改必须随资源快照保留。
Lua、13,541 份 script 文件、premake 配置、lflist、header 和实际生成 binary 都需登记版本/校验。
完整 release manifest 比只记 script 文件数量更有约束力。

Linux 构建默认选择 SSE2，使用封存的 C++ Lua 源码及当前 Core。
双系统源码准备、编译、旧裁定的全局 utility 接入、逐文件 manifest 与更新回退见
[YGOPro 安装/更新](ygopro-install.md)。完整本机禁表与纯 1103 测试禁表具有不同验证范围，不能互相冒充。
使用 `ldd` 排除缺库，用 `file` 排除 Windows/其他 CPU binary，最后用真实协议与对战检验。
当前 Dockerfile 的 plugins 排除、浮动 Core/script/base image 不符合这份固定资源主线，
本阶段不把它作为可直接上线的替代路径。

## 替换资源与回退

更新流程归属 [共用引擎指南](ygopro-install.md#更新和回退)，安装归属
[Linux](linux-install.md) / [Windows](windows-install.md)；此处只维护资源身份与历史区别。

CDB/脚本变更单独做新 release 和 manifest；不修改已有备份批次。
查询 CDB 更新后需重启服务，中文元数据缺失会令使用率投影跳过新增 Match，
详见服务端 card-catalog 和 usage-analytics 的 README/回填契约。
资源回退需要同时回退对应 binary、Core/Lua、脚本、卡库及禁限表，
不能只回退一份 cards.cdb 后假定历史录像或所有效果仍一致。
