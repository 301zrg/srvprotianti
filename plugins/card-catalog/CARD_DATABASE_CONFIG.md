# 卡片数据库配置

本插件为卡片/卡组使用率页面提供卡片密码、类型、异画归一化关系和四语言名称。

把以下四个文件放入本目录的 `databases` 子目录：

- `cards.zh.cdb`：中文卡片库，同时作为 `type` 与 `alias` 的权威来源；
- `cards.ja.cdb`：日文名称；
- `cards.en.cdb`：英文名称；
- `cards.ko.cdb`：韩文名称。

文件不会提交到 Git。服务启动时由短生命周期的辅助 Node 进程逐个打开数据库，主进程只接收
查询所需的小型字段；辅助进程随后退出并回收 SQLite/WASM 内存，卡片描述不会进入主进程。
异画卡根据中文库的 `alias` 归并到原画卡。

替换 CDB 后需要重启 Node 服务使卡片目录重新加载；这与网页筛选参数、排名配置等可热读取配置
不同。缺少单个外语库时，该语言名称回退到中文；中文库缺失时
`cardCatalog.metadataAvailable=false`，当前 `ladder-usage-analytics` 会跳过整场 Match 的新增投影，
卡组和卡片样本都不会增加。恢复中文库并重启后，应按
[使用率回填手册](../ladder-usage-analytics/BACKFILL.md) 检查并补齐这段时间的缺口。
