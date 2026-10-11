# 本会话累计部署文件（2026-10-10）

范围：天梯挂机/强退计次开关、旧处罚提示过滤、对手挂机时退出仍可能扣分的说明、四语进房错误、
四语默认欢迎和处罚提示，以及核心词典补齐和英文低 LP 文案。本清单覆盖前次和本次修改，
不将工作区其他功能的未提交文件作为本次修复的复制要求。

## 正式运行需复制的完整清单

路径相对于正式服务的启动根目录，与本地 `srvprotianti/` 对应。按相同相对路径覆盖以下六个文件后重启：

| 文件 | 用途 |
| --- | --- |
| `ygopro-server.js` | 通用挂机/强退及历史处罚钩子、避免重复计次、读取天梯提示策略、四语处罚提示 |
| `data/i18n.json` | 补齐核心翻译键，修正刷新失败键、处罚短文案和英文低 LP 提示 |
| `plugins/ladder-core/index.js` | 天梯处罚豁免策略、四语欢迎和进房拒绝、对手退出提示策略 |
| `plugins/ladder-core/i18n.json` | 天梯四语文案与仍可能扣分的说明 |
| `plugins/ladder-core/afk-policy.js` | 处罚计次开关的实时读取和边界校验；新增文件必须一起复制 |
| `plugins/ladder-core/config.default.json` | `countAfkPenalty: false` 和默认欢迎词入口 |

主目录 JS 已完成编译，按运行文件复制即可；只复制整个插件目录不能更新宿主逻辑。

保留服务器原有的主配置和插件本地 `config.json`。本地 `countAfkPenalty` 覆盖项优先于默认文件；
要关闭天梯挂机/强退计次，它应为布尔值 `false`，或删除该覆盖项采用默认值。开关后续修改可热更，
本次替换程序与词典文件需要重启。自定义欢迎词继续按原值显示；旧值“天梯比赛”自动采用四语。

本次挂机/文案修复没有新增依赖或数据库结构迁移。历史处罚不删除；关闭开关只在天梯匹配中
忽略纯挂机/强退记录，其他违规和其他模式仍按原规则处理。

## 可选同步的源码、测试与文档

以下文件用于在服务器保留完整维护材料，当前运行不依赖它们；本地已构建，无需为了本次部署修改 npm 脚本：

```text
ygopro-server.coffee
package.json
random-duel-afk.test.js
ladder-messages.test.js
plugins/README.md
plugins/ladder-core/README.md
plugins/ladder-core/LANGUAGE_AUDIT.md
plugins/ladder-core/DEPLOY_FILES.md
```

## 重启后的验收点

- 默认天梯欢迎显示中、英、日、韩；错误昵称/密码和三类拒绝进房同样返回四语。
- 对手挂机时提示含“不视为强退，但仍可能扣除天梯积分”。
- `countAfkPenalty: false` 下挂机/强退不计次，纯此类历史记录不显示处罚提示，原有积分结算继续生效。
- `/refresh`、录像发送、版本兼容等消息在切换语言后显示对应翻译，不显示 `${…}` 原始键。
- 其他违规处罚提示包含四语原因与各自语言的剩余时间。

断线重连语言保留和历史观战消息语言问题按用户要求保持原状。验证记录见 [语言核查](LANGUAGE_AUDIT.md)。
