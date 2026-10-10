# 引擎、两套卡库与资源版本

换机时需要的是“这套环境正在使用的完整资源”，而不是从上游下载最新 cards.cdb。
引擎必须能够识别玩家提交的卡，房间规则和禁限表再决定哪些卡能用。
数据库中有某张卡，不表示 TT/1103 房允许它。

## 三组资源分别保管

| 资源 | 作用 | 迁移方式 |
| --- | --- | --- |
| 服务端 ygopro 完整目录 | 在线 Core、Lua、卡效果、实体字段、禁限表与协议版本 | 封存源代码/脚本/资源，匹配 Linux binary；不能替换为网页资源 |
| card-catalog 四语完整 CDB | 名称、类型、alias、卡片使用率事实 | zh/ja/en/ko 分别校验，默认中文 datas 权威 |
| 网页 resources-staging/1103 与 replay/706-v1 | 浏览器资源与离线录像播放 | 由网页自身 Git/锁/快照构建，不移入游戏进程 |

桌面玩家自身的 `game/replay/` 和网页 IndexedDB 录像属于客户端保存，服务器恢复包不能替玩家恢复它们。

## 两套 CDB 的已确认信息

操作者确认当前是 `ygopro/cards.cdb`、`ygopro/cards1.cdb`，较小的 `cards1.cdb` 是环境卡池。
大库用于兼容可能的异画以及特殊房间代码允许的超环境卡。
两份都保留原文件名和字节，不合并、删卡、互相覆盖或重新下载。

本地 2026-10-10 的只读检查：

| 文件 | 大小 | datas/texts 行数 | SHA-256 |
| --- | ---: | ---: | --- |
| cards.cdb | 8,050,688 | 14,981 / 14,981 | `5f13245de4e665450858f66ef2f736a3d2f48cc7f0036961373a96a650cb6797` |
| cards1.cdb | 8,026,112 | 14,949 / 14,949 | `70e9b45cef09dd079c8958a738d5561a302151e97b1cdeb213f13e76fe9e90b9` |

大库比小库多 32 个 ID；这不是完整卡池差异的定义，datas、alias、禁限表和房间规则都需要验收。
fingerprint 是此刻本地文件证据，不自动等于正式服务器的文件证据。
正式备份以实际服务器生成的 manifest 为准。

## 加载行为及验收

当前本地 `gframe/game.cpp` 的 server mode 明确加载 `cards.cdb`，随后加载 `expansions/` 中的 CDB；
编译开关还可能加载 `cdb/` 或扩展归档。
没有找到直接引用 `cards1.cdb` 或按房间代码在二者间切换的本地源码。
本批**不新增切库逻辑**。小库可能是资源来源/备用文件；特殊房间也可能只是放宽 hostinfo/禁限表，
这些可能性不能代替正式服务器证据。

迁移前记录实际 Linux 引擎 SHA、来源 commit/dirty patch、构建开关、expansions/cdb/归档内容，
以及房间代码最终映射到的 hostinfo。若正式服务器有独有 wrapper 或补丁，必须加入制品。
用操作者已知的合法测试卡组验证：

1. 常规 1103/TT 房允许环境内卡，拒绝操作者指定的一张环境外卡。
2. 已支持异画的卡组按当前正式行为入房、识别、查询并归并 alias。
3. 使用现有特定房间代码，验证指定超池卡的当前允许行为及效果。
4. 恢复同一组资源后重复三项，结果与旧机相同。

不要凭“两个文件存在”勾选这四项，也不要凭文件名断言引擎正在切换小库。

## 固定构建输入

本地源树 engine HEAD=`5e63f18fb6b9a6ddc651bc2e8847eec9689ccbff`，
Core HEAD=`e04144d62499c17d0cfa8313f9742434ef99c3a7`。
`gframe/config.h` 的 PRO_VERSION 为 `0x1362`。HEAD 之外的修改必须随资源快照保留。
Lua、13,541 份 script 文件、premake 配置、lflist、header 和实际生成 binary 都需登记版本/校验。
完整 release manifest 比只记 script 文件数量更有约束力。

Linux 构建默认选择 SSE2，使用封存的 C++ Lua 源码及当前 Core。
构建步骤见 [Linux 安装](linux-install.md#4-取得兼容的-linux-引擎)。
使用 `ldd` 排除缺库，用 `file` 排除 Windows/其他 CPU binary，最后用真实协议与对战检验。
当前 Dockerfile 的 plugins 排除、浮动 Core/script/base image 不符合这份固定资源主线，
本阶段不把它作为可直接上线的替代路径。

## 替换资源与回退

CDB/脚本变更单独做新 release 和 manifest；不修改已有备份批次。
查询 CDB 更新后需重启服务，中文元数据缺失会令使用率投影跳过新增 Match，
详见服务端 card-catalog 和 usage-analytics 的 README/回填契约。
资源回退需要同时回退对应 binary、Core/Lua、脚本、卡库及禁限表，
不能只回退一份 cards.cdb 后假定历史录像或所有效果仍一致。
