# 卡片数据库配置

本插件为卡片/卡组使用率页面提供卡片密码、类型、异画归一化关系和四语言名称。

以下四个固定文件的 Git LFS 发布位置是独立的 [srvprotianti-resources](https://github.com/301zrg/srvprotianti-resources)
仓库，取回后位于本目录的 `databases` 子目录；执行下载前确认 [资源发布状态](../../ops/docs/resources.md#从线上取得四语查询库)：

- `cards.zh.cdb`：中文卡片库，同时作为 `type` 与 `alias` 的权威来源；
- `cards.ja.cdb`：日文名称；
- `cards.en.cdb`：英文名称；
- `cards.ko.cdb`：韩文名称。

服务端源码仓库继续忽略这些 CDB。资源仓库的普通 Git 对象保存的是 LFS 指针；部署和云端测试必须取回真实 CDB，不能把 GitHub raw 指针或源码 ZIP
当作完整资源。只发布这四份查询库，不包含私有配置、玩家录像，也不替代 `ygopro/` 引擎、效果脚本和两套在线卡库。

## 从 GitHub 取回并校验

先安装 Git LFS（Ubuntu 可执行 `sudo apt-get install -y git git-lfs python3`），从已审核的分支/完整 commit 取得服务端源码；
在服务端仓库根目录执行，目标 `plugins/card-catalog/databases` 必须尚不存在：

```bash
python3 ops/scripts/ops.py catalog-fetch \
  --destination plugins/card-catalog/databases --versions ops/versions.json
python3 ops/scripts/ops.py catalog-check \
  --catalog plugins/card-catalog/databases --versions ops/versions.json
```

`catalog-fetch` 从 `ops/versions.json` 的 `catalogSource` 取得固定仓库、完整提交 SHA 和目录，
在临时工作区通过 Git LFS 下载并校验，只把通过检查的四库写入新目标目录，不保留资源仓库 `.git`。
它拒绝覆盖已有目录；已有四库先运行 `catalog-check`，匹配固定版本即可复用，否则下载到另一个新目录后再安排资源切换。
`catalog-check` 逐份检查真实 SQLite 文件、必需字段、有效记录，以及 `ops/versions.json` 固定的字节数和 SHA-256。
它只读取查询库，不连接 PostgreSQL，也不依赖在线引擎。缺库、只有 LFS 指针、文件损坏或指纹不符均应停止部署。
新服务器直接按 [Linux 安装](../../ops/docs/linux-install.md) 的固定提交下载流程操作，无需手动搬这四个文件。
发布工具仍通过 `--component catalog=plugins/card-catalog/databases` 保存完整文件，解包后使用组件链接。
正常工作区已下载真实 `databases/` 目录时直接使用，不再对同名目录创建符号链接。

## 验证实际插件装载

从仓库根目录先运行 `npm ci`，再执行以下只读验收。它使用公共默认配置加载真实四库，
不启动游戏宿主、不访问生产配置或 PostgreSQL：

```bash
node - <<'JS'
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const plugin = require('./plugins/card-catalog');
(async () => {
  let catalog;
  let warnings = 0;
  await plugin.init({
    rootDir: path.resolve('plugins/card-catalog'),
    config: require('./plugins/card-catalog/config.default.json'),
    provide(name, service) {
      assert.equal(name, 'cardCatalog');
      catalog = service;
    },
    log: {
      warn() { warnings += 1; },
      info() {}
    }
  });
  assert.equal(warnings, 0, 'Every language database must load without warnings');
  assert.equal(catalog.metadataAvailable, true);
  assert.ok(catalog.size > 0, 'Card catalog must not be empty');
  assert.equal(catalog.fingerprint.split('|').length, 4);
  console.log(JSON.stringify({metadataAvailable: catalog.metadataAvailable,
    cards: catalog.size, fingerprint: catalog.fingerprint}));
})().catch(error => { console.error(error); process.exitCode = 1; });
JS
```

构建或合成备份恢复测试通过，不替代这项真实查询库验收。正式启动时还要确认服务用户能读取实际配置路径下的四库，
没有 `Card catalog database could not be loaded` 告警；自定义路径不能由默认路径的验收代替。

## 装载和替换行为

服务启动时由短生命周期的辅助 Node 进程逐个打开数据库，主进程只接收
查询所需的小型字段；辅助进程随后退出并回收 SQLite/WASM 内存，卡片描述不会进入主进程。
异画卡根据中文库的 `alias` 归并到原画卡。

替换 CDB 后需要重启 Node 服务使卡片目录重新加载；这与网页筛选参数、排名配置等可热读取配置
不同。缺少单个外语库时，该语言名称回退到中文；中文库缺失时
`cardCatalog.metadataAvailable=false`，当前 `ladder-usage-analytics` 会跳过整场 Match 的新增投影，
卡组和卡片样本都不会增加。恢复中文库并重启后，应按
[使用率回填手册](../ladder-usage-analytics/BACKFILL.md) 检查并补齐这段时间的缺口。
