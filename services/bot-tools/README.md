# 机器人部署包构建

本目录只负责打包，不启动机器人、不读取私有配置、不修改 Discord/QQ 目标或游戏数据库。
服务入口见 [services](../README.md)。

在项目根目录执行：

```text
node services/bot-tools/build-release.mjs
```

生成 `services/releases/qq-bot/` 和 `services/releases/discord-bot/`。
每个目录含自己的适配器、`src/core/` 共享源码副本、平台测试、package/lockfile、默认配置和部署 README，
复制整个目录后无需依赖另一平台或 `../bot-core`。共享代码修改后要重新构建。

## 输入与维护位置

- 适配器、测试、package 和默认配置来自对应服务源码目录。
- 共享代码来自 `bot-core/src/`，打包时将适配器的共享 import 改为 `./core/`。
- 递归复制共享素材目录，字体等二进制按原始字节复制；import 改写只作用于 `.mjs`。
  月报字体及其许可证、固定来源说明一起进入 `src/core/assets/fonts/`，不能用 UTF-8 文本读取字体。
- 包内 README 来自对应服务的 `DEPLOYMENT.md`；不要直接编辑产物说明。
- QQ 包另复制 `LANGUAGE_AND_DELIVERY.md`，保存语言、命令与结果不明投递的模块契约。
- lockfile 从 `community-bot/package-lock.json` 的已锁定依赖图提取，并同步到三个源码包。
  改动依赖时需先让该依赖图包含所需版本，再检查锁文件和 `npm ci`；不在此隐式升级依赖。

构建只替换两个指定产物目录，拒绝覆盖符号链接/目录联接，发现 `config.json`、`data/`、`logs/`、
`node_modules/` 等非生成内容时会停止。产物目录不能直接作为正式运行目录；先复制到独立部署位置。
跨操作系统复制后在目标机执行 `npm ci`，不要带 Windows 的 node_modules 到 Linux/macOS，`sharp` 含原生依赖。

源码验证分别在 `bot-core`、`qq-bot`、`discord-bot` 执行 `npm test`。
产物验证在对应 `releases/<平台>` 执行 `npm test`；依赖解析需要先安装或存在可用的上级依赖。
正式部署步骤归 [QQ](../qq-bot/DEPLOYMENT.md) 和 [Discord](../discord-bot/DEPLOYMENT.md)。
