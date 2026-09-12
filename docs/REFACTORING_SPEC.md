# SRVPro 天梯插件化重构规范

## 1. 目标

以 `F:\MyCardLibrary\srvpro\srvpro` 当前工作树为原项目行为基准，将 `srvprotianti` 中新增的天梯、卡组识别、统计页面、公开房间与录像接口、PostgreSQL 兼容等功能迁移为可选插件。

删除 `srvprotianti/plugins/` 中的全部内容后，项目应退化为基准 `srvpro` 的功能和安全行为；安装插件后才增加相应能力。

## 2. 不可违反的边界

- 禁止修改 `F:\MyCardLibrary\srvpro\srvpro` 中的任何文件。
- 所有代码修改只能发生在 `F:\MyCardLibrary\srvpro\srvprotianti`。
- 禁止修改 `config/admin_user.json` 和 `config/config.json`；它们包含部署账户和密码。
- 本轮重构忽略 `ygopro/`、`srvpro.dump` 和 `SimpleMonitor.ps1`。
- 迁移阶段不修复现有数据库历史数据；结构和逻辑稳定后再提供由维护者在正式服务器执行的 SQL 或脚本。
- 主项目不得包含 `TT`、`ladder`、卡组模板、天梯页面等业务判断。
- 新增代码必须对边界条件、事件时序、数据一致性和非显然算法添加必要注释。

## 3. 主项目允许的唯一扩展

主项目只允许增加通用插件宿主和通用钩子。插件宿主必须与具体业务无关，并在插件目录为空时保持基准行为。

宿主至少需要支持：

- 插件发现、依赖排序、启用和禁用。
- 数据库连接前修改通用连接选项。
- 数据库连接前注册插件实体。
- 注册随机模式。
- 房间加入前后事件。
- 精确断线重连目标解析。
- 单局结果完成事件。
- Match 结果完成事件或房间结束事件。
- HTTP API 路由注册。
- JSON 驱动的静态页面路由注册。
- 插件错误隔离和结构化日志。

插件异常不得阻止其他插件加载，也不得无提示地改变基准功能。

## 4. 插件目录约定

建议结构：

```text
plugins/<plugin-id>/
  plugin.json
  index.js
  config.default.json
  config.json
  README.md
  entities/
  migrations/
  web/
  data/
  tests/
```

- `plugin.json`：插件 ID、版本、入口、依赖和加载阶段。
- `config.default.json`：纳入版本控制的安全默认值。
- `config.json`：部署实际值，不纳入版本控制。
- 插件不得从主项目 `data/default_config.json` 增加自己的业务配置。
- 插件必须能在缺少 `config.json` 时使用默认配置启动。
- 配置解析失败时应明确记录插件名和字段，不能静默使用可能危险的值。

## 5. 计划中的插件

### `ladder-core`

负责 TT 模式、天梯账户、身份验证、精确断线重连、计分、月记录和 Match 结算。

默认策略：

- 允许相同 IP 的玩家连续匹配。
- 允许受限制玩家与正常玩家匹配。
- 以上两项必须放入插件配置，未来可修改而无需变更主代码。
- 断线者在有效重连期内不得因一次网络中断直接判负或失分。
- 只允许原断线玩家恢复原房间和原座位；普通新匹配玩家不得占用断线者的位置。

建议配置语义使用正向且不含歧义的字段，例如：

```json
{
  "preventSameIpRematch": false,
  "separateRestrictedPlayers": false
}
```

### `deck-classifier`

负责模板和实战卡组的规范化、完整包含匹配、卡组类型元数据及“其他卡组”回退。

### `ladder-analytics`

负责 `LadderMatch`、`LadderMatchGame`、卡组对阵聚合和统计缓存。依赖 `ladder-core` 与 `deck-classifier`。

### `ladder-web`

负责使用介绍、排行榜、卡组胜率页面及其 API。页面路由必须由 JSON 配置声明。

### `public-room-web`

负责免登录房间列表 API 和 `rooms.html`，不得修改原 `/api/getrooms`。

### `public-replay-web`

负责免登录录像列表、录像下载和卡组下载，不得修改原 `/api/replay` 的鉴权行为。

### `postgres-compat`

作为天梯部署使用的可选数据库适配插件，在数据库连接前应用 PostgreSQL 类型和 SQL 差异。删除该插件后恢复基准项目支持的数据库行为。

## 6. 源代码与生成文件

- CoffeeScript 和 TypeScript 是源文件，生成的 JavaScript 必须同步。
- 禁止只修改 `ygopro-server.js` 而不修改对应的 `ygopro-server.coffee`。
- 每次涉及源文件的提交前必须运行类型检查、编译和针对性测试。
- 重构过程中应恢复基准项目的 `duel-finalization` 实现与测试，不得继续使用天梯分支内联的旧胜负处理替代它。

## 7. 完成标准

- 空插件目录启动时不存在 TT 模式、天梯表注册、天梯 API 和新增公开页面。
- 空插件目录下原 `/api/getrooms` 和 `/api/replay` 行为与基准一致。
- 安装相应插件后功能按依赖顺序启用。
- 单个插件删除后只移除该插件负责的能力，不破坏其他无依赖功能。
- 不依赖录像保存成功完成天梯结算。
- 所有插件配置均位于各自目录。
- 自动化测试覆盖插件存在、缺失、禁用、配置无效和数据库失败场景。

