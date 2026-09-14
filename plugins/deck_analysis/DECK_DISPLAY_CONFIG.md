# 卡组胜率展示配置说明

`deck_display.json` 只控制卡组胜率页面展示哪些行列、显示顺序以及每组包含哪些卡组。
卡组类型定义仍保存在 `deck_analysis.json`，修改展示配置不会改变历史 Match 的卡组分类结果。

## 热更新

保存 `deck_display.json` 后不需要重启服务器。下一次请求
`GET /api/ladder-deck-stats?month=YYYYMM` 时会重新读取文件；展示分组发生变化时，即使该月份
仍处于 45 秒统计缓存期，也会按新分组重新聚合。已经打开的页面需要刷新数据或重新进入页面。

JSON 语法错误、文件缺失或配置路径错误会使统计接口返回 500，并在服务日志中留下错误。
建议先在临时文件中完成编辑和 JSON 校验，再原子替换正式文件。

## 顶层字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `version` | 否 | 配置版本，仅供维护记录 |
| `lastUpdated` | 否 | 最后修改日期，仅供维护记录 |
| `mode` | 否 | 当前保留字段，不参与聚合逻辑 |
| `groups` | 是 | 展示分组数组 |
| `defaultGroup` | 否 | 当前保留字段，不会自动生成未声明分组 |

## 分组字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 分组稳定 ID；用于接口中的 `<行 id>::<列 id>` 键，不能重复 |
| `name` | 是 | `zh`、`ja`、`en`、`ko` 四语言显示名 |
| `isDisplayed` | 否 | 只有明确为 `false` 时隐藏，其他值均展示 |
| `displayOrder` | 否 | 升序排列；缺失时按 0 处理 |
| `archetypeIds` | 否 | 精确指定卡组类型 ID；存在时优先于下面的 `type` 规则，推荐用于新配置 |
| `type` | 条件必填 | 未使用 `archetypeIds` 时可为 `single`、`family`、`custom` |
| `archetypeId` | 条件必填 | `single` 使用的单个卡组类型 ID |
| `familyId` | 条件必填 | `family`/`custom` 对应 `deck_analysis.json` 的家族 ID |
| `includeBranches` | 否 | 仅 `custom` 使用；按推导成员数组的索引选取成员，属于旧兼容写法 |

推荐使用显式 `archetypeIds`，避免卡组 `code` 命名和数组顺序影响成员推导。例如：

```json
{
  "id": "synchro_group",
  "name": {"zh": "同调均", "ja": "シンクロ", "en": "Synchro", "ko": "싱크로"},
  "archetypeIds": [1026, 1027],
  "displayOrder": 4,
  "isDisplayed": true
}
```

旧规则如下：

- `single`：只包含 `archetypeId`。
- `family`：查找对应 `familyId` 的家族代码，再包含卡组 `code` 等于家族代码或以
  `<家族代码>_` 开头的所有卡组。
- `custom`：先按 `family` 推导成员，再按 `includeBranches` 中的数组索引选择。

当前“同调均”仍沿用旧 `family` 配置，因此实际只能推导出 `SYNCHRO_SPEED`，不能推导
`JUNK_DOZER_PLANT`。若产品口径确认两者都应计入，按上例改用
`"archetypeIds": [1026, 1027]` 即可热更新生效。

## 统计口径注意事项

- 行代表左侧卡组视角，列代表上方对手卡组。
- `<分组 id>::all` 的“全部”包含所有隐藏和未展示对手，不能等于可见列之和。
- 同一个卡组类型可以配置进多个展示组；此时这些组会重复包含相同样本。这是允许行为，
  但配置者必须确认符合展示目的。
- 配置为空或所有组均设为不展示时，页面显示“暂无数据”，原始比赛数据不会被删除。
