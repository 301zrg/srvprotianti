# 四语言卡片目录

本模块把本地 CDB 转换为轻量的卡号、类型、异画归并及名称服务。修改 CDB 读取、
语言回退或卡片类型识别时从这里开始；卡组模板识别不属于本模块。
通用约束见 [AGENTS.md](../../AGENTS.md)；部署细节按需读文末配置手册。

## 职责与边界

- `index.js`：顺序装载四语言数据、构建目录，提供 `cardCatalog` 服务。
- `read-cdb.js`：短生命周期 Node 子进程，用 SQL.js 查询 CDB 后退出。
- `config.default.json`：数据库目录、语言文件名和回退语言。
- `databases/cards.{zh,ja,en,ko}.cdb`：本地部署输入，不提交 Git。
- manifest 无插件依赖。`ladder-analytics` 通过本服务拆分下载 YDK 的额外卡，
  `ladder-usage-analytics` 通过本服务归并异画并确定统计区域。
- 对外接口是 `get`、`canonicalize`、`classifyZone`、`size`、`fingerprint`、
  `metadataAvailable`。调用方不直接打开本模块 CDB，也不依赖内部 Map。

## 必须保持的行为

- 中文库是 `type` 和 `alias` 的权威来源；其他语言库只补名称。
  异画根据 alias 归并到原卡，同一张卡不能因不同画面重复统计。
- 名称按目标语言、配置回退语言、中文、卡号回退；返回卡号不能被当成完整目录已就绪。
- 类型区分主卡怪兽/魔法/陷阱与额外卡，未知卡的类型保持未知，不猜测。
  副卡属于牌组中的区域，由使用率插件按快照位置处理。
- CDB 必须逐份读取；SQLite/WASM 留在读取子进程，主进程不保存卡片描述或数据库句柄。
  Windows 子进程保持隐藏窗口，读取失败记录对应语言的告警。
- `fingerprint` 来自成功读取文件的哈希；更换 CDB 可能改变历史派生数据语义，
  不能把重启加载目录等同于历史统计已重建。
- 中文库不可用时 `metadataAvailable=false`；当前使用率插件会跳过整场新增投影，
  包括卡组和卡片样本。不能把缺库运行当成完整使用率数据。

## 配置与生效时机

`config.default.json` 提供安全默认值，本地 `config.json` 只覆盖必要字段。
路径相对本插件目录解析。替换 CDB、文件名或目录后重启游戏服务；本模块没有热加载。
缺少单个外语库可降级到已有名称，部署验收仍需确认四语言实际覆盖和中文元数据已加载。

## 验证

从 `srvprotianti` 根目录执行：

```text
node plugins/tests/plugin-tests.js
node plugins/tests/integration.test.js
```

第一项覆盖类型/异画及使用率卡片事实；改服务返回值或装载契约时再跑集成测试。
测试通过不证明部署 CDB 正确；更换本地卡库时另核对少量已知卡的名称、alias 和区域，
以及目录加载告警和内存占用。不要用正式配置内容或整份 CDB 输出代替验证结果。

## 仅在对应任务补读

- 部署/替换 CDB：[CARD_DATABASE_CONFIG.md](CARD_DATABASE_CONFIG.md)。
- 改投影分母或历史数据：[使用率开发入口](../ladder-usage-analytics/README.md)。
- 将服务器适配到另一卡池：[卡池适配指南](../../docs/CARD_POOL_PORTING_GUIDE.md)。
