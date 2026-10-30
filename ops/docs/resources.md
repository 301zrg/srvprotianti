# 引擎、两套卡库与资源版本

换机时需要的是“这套环境正在使用的完整资源”，而不是从上游下载最新 cards.cdb。
引擎必须能够识别玩家提交的卡，房间规则和禁限表再决定哪些卡能用。
数据库中有某张卡，不表示 TT/1103 房允许它。

## 三组资源分别保管

| 资源 | 作用 | 迁移方式 |
| --- | --- | --- |
| 服务端 ygopro 完整目录 | 在线 Core、Lua、卡效果、实体字段、禁限表与协议版本 | 封存源代码/脚本/资源，匹配 Linux binary；不能替换为网页资源 |
| card-catalog 四语完整 CDB | 名称、类型、alias、卡片使用率事实 | 从独立资源仓库 Git LFS 取得固定版本，zh/ja/en/ko 分别校验，默认中文 datas 权威 |
| 网页 resources-staging/1103 与 replay/706-v1 | 浏览器资源与离线录像播放 | 由网页自身 Git/锁/快照构建，不移入游戏进程 |

桌面玩家自身的 `game/replay/` 和网页 IndexedDB 录像属于客户端保存，服务器恢复包不能替玩家恢复它们。

## 从线上取得四语查询库

当前交付状态：四份 LFS 对象已发布，固定资源提交为
[`a6c3ec49f2856753b2d3c2bc13266dc98058e4fd`](https://github.com/301zrg/srvprotianti-resources/commit/a6c3ec49f2856753b2d3c2bc13266dc98058e4fd)。
2026-10-11 已在 Windows / Node 24.15.0 下使用独立临时仓库和 LFS 缓存、禁用 GitHub 登录凭据，
从线上执行 `catalog-fetch` 和 `catalog-check`：四库字节数与 SHA256 全部匹配，真实插件装载无告警，
`metadataAvailable=true`、卡片数量为 14,981。Linux/云端复测仍按测试指南单独执行。

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
本次线上资源只解决查询库交接；在线引擎、Lua/Core/scripts、禁限表和引擎 `cards.cdb` 仍需原有完整资源制品。

需手动核对下载过程时，在不存在的临时目录克隆资源仓库，使用 `catalogSource.commit` 的完整 SHA 执行
`git checkout --detach <完整SHA>`，再运行 `git lfs install --local`、
`git lfs pull --include='catalog/*.cdb' --exclude=''`、`git lfs fsck`，
用服务端 `catalog-check --catalog <资源工作区>/catalog --versions <服务端>/ops/versions.json` 核对结果。
不要直接使用资源仓库浮动 `main` 的内容覆盖旧 release；卡库变更必须连同版本指纹和使用率派生数据语义一起审查。

## 引擎卡库（2026-10-30 正式服核对）

正式服引擎 `C:\srvpro\ygopro\ygopro.exe`（3,064,832 字节，SHA256 `50bcf18e…`）只加载根目录的 `cards.cdb`，以及 `expansions/` 下的 CDB。核对依据：

- 可执行文件里只有 `cards.cdb`、`./expansions/%s`、`.cdb` 这类字符串，没有 `cards1`；
- 宿主启动引擎的参数里没有卡库路径；
- `expansions/` 下只有 `script/`，没有任何 CDB 或归档。

| 文件 | 大小 | 卡片数 | SHA-256 | 状态 |
| --- | ---: | ---: | --- | --- |
| `cards.cdb` | 1,695,744 | 5,267 | `a49f0652ad54a7f55c569284ca154f0ec435fc26ebdd728927052e57b9d816e5` | 正式服在用，已写入 [versions.json](../versions.json) |
| `cards1.cdb` | 8,026,112 | 14,949 | `70e9b45cef09dd079c8958a738d5561a302151e97b1cdeb213f13e76fe9e90b9` | 不在任何加载路径上，已不属于部署资源 |

- `cards1.cdb` 不再是部署前检查的必需文件，也不再列入版本指纹或部署模板。仓库外另存了一份带 SHA 的私有归档，以便将来需要更大卡池时追溯来源。正式服上的原文件暂时保留不动。
- 网站和统计使用的四语查询库（`plugins/card-catalog/databases/cards.{zh,en,ja,ko}.cdb`）是另一套文件，和引擎卡库分开记录身份。
- 早先本地记录说"较小的 cards1.cdb 是环境卡池"，与实际不符：正式服 `cards.cdb` 是小库，`cards1.cdb` 才是大库。
- 正式备份以实际服务器生成的 manifest 为准。

## 加载行为及验收

当前本地 `gframe/game.cpp` 的 server mode 明确加载 `cards.cdb`，随后加载 `expansions/` 中的 CDB；
编译开关还可能加载 `cdb/` 或扩展归档。
本地源码和正式服都没有按房间代码切换卡库的逻辑；特殊房间代码只改变 hostinfo 和禁限表，不更换卡库。
本仓库不新增切库逻辑。

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
