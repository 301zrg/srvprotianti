# 引擎来源、候选构建与生产快照

安装需要完整运行资源；源码提交本身不是可部署包。固定输入见 [versions.json](../versions.json)：Core、基础脚本、依赖归档 SHA、5,267 卡的引擎 CDB 和允许的禁限表。查询用的四语 CDB 是另一套资源。

## 当前生产环境的迁移

当前 `706-20261112` 的完整生效 Lua 树有 13,530 文件，摘要为 `fa2f656b229622fe4568edd28ad2e2a79eb5e150961041de66597511a8fe7cd4`。基础层是生产快照和既有差异，`5864b6f` 只是最近的上游提交。复制时保留脚本优先级 `specials/ > expansions/script/ > script/`，同时固定 EXE、卡数据、禁限表、组合 utility 和各层文件清单；不能仅更新 706 覆盖层就声称完整一致。

正式 Windows EXE 的记录 SHA 为 `50bcf18e8cd58ddc0d6157c02924268c1fea3c0a56b77f0cf18b5c027ba2c0f6`。静态散列一致、原生启动成功、真实对局一致是三个不同结论。`gframe/config.h` 属于编译来源指纹，不是运行包必需文件。

## 从纯上游构建候选

从服务端根目录执行；下载和输出目录均必须不存在，Python 3.12+、Git/Git LFS 必须可用：

```text
python ops/scripts/engine-source.py --platform windows --destination NEW_BUILD --versions ops/versions.json
python ops/scripts/engine.py fetch-pool --destination NEW_POOL --versions ops/versions.json
python ops/scripts/engine.py check-pool --pool NEW_POOL/cards.cdb --versions ops/versions.json
```

下载工具固定主仓和子模块提交，验证归档 SHA 后安全解包；只准备输入，不编译。Lua 下载受限时可显式提供相同原始归档 `--lua-archive FILE`，仍须通过 SHA。失败保留半产物，不能覆盖后重试。

在目标 OS 原生构建。Windows 使用 Visual Studio 2022 的 x64 工具链：将源码 `premake/*`、`resource/*` 复制到源码根，按固定源码工作流准备 libevent 的 Windows 配置头，执行 `premake5.exe vs2022 --use-simd=sse2`，再用 MSBuild 编译 `build/YGOPro.sln` 的 Release/x64。Linux 安装本机 C++/libevent/SQLite/liblzma 开发包，执行 `premake5 gmake --use-simd=sse2` 和 `make -C build -j2 config=release`。记录完整编译日志、工具链版本和二进制 SHA；不能用 PE 代替 ELF。

编译后用 `engine.py assemble --help` 指定基础源码、二进制、已审核卡池/禁表、可选的干净固定 706 覆盖和新目标目录；之后执行 `verify`、`smoke`。报告放在运行目录之外。manifest format 2 会重新校验完整文件、来源和规则策略。

此工具明确输出 `upstream-base-candidate`、`productionEquivalentProven:false`；不是上述生产快照的重建器。`smoke` 只证明目标 OS 原生进程启动和临时 TCP 端口可连接，不证明召唤规则或完整对局。候选禁表与生产指纹不同，必须单独使用经审核的候选版本清单，不能修改正式锁让检查通过。

双系统原生构建的手动 CI 入口为 `.github/workflows/stage2-engine-validation.yml`。工作流存在不表示已执行；本地隔离和现场验收分别见 [验证记录](validation.md)。
