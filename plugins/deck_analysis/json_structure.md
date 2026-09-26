# 卡组元数据配置

本手册说明 `deck_analysis.json` 的现行结构。模块行为见 [README.md](README.md)，
胜率矩阵分组另见 [DECK_DISPLAY_CONFIG.md](DECK_DISPLAY_CONFIG.md)。
不要在多份文档维护完整卡组、家族和分组清单；实际 JSON 是清单的唯一来源。

## 字段与用途

| 字段 | 当前用途 |
| --- | --- |
| `archetypes` | 以十进制卡组 ID 字符串为键的细分类定义；运行时转为数字 ID |
| `archetypes.<ID>.code` | 稳定代码，用于搜索与旧 family 分组推导；缺失时回退到 ID 字符串 |
| `archetypes.<ID>.name` | `zh`、`ja`、`en`、`ko` 四语言名称；新建或修改类型应补全四语言 |
| `archetypes.<ID>.tier` | 现有维护标签；当前分类和展示服务不根据它计算 ID、排序或命中优先级 |
| `families` | 家族代码映射；只有使用旧 family/custom 分组时才参与成员推导 |
| `families.<代码>.id` | 与 `deck_display.json` 的 `familyId` 对应 |
| `families.<代码>.name` | 家族的多语言维护名称；当前展示组标题使用 `deck_display.json` 的组名 |
| `version`、`lastUpdated` | 人工维护信息；不参与热更新判定 |
| `meta` | 历史说明性元数据；当前运行时不读取其中的位布局、数量或公式 |

使用标准 JSON，不加注释。`name` 应是名称对象，不能改成字符串。
缺失整个 `name` 时服务仅生成中文回退名；不要依赖回退代替必要翻译。

```json
{
  "version": "1.0.0",
  "lastUpdated": "2026-09-26",
  "families": {
    "HERO": {"id": 4, "name": {"zh": "英雄", "ja": "HERO", "en": "HERO", "ko": "히어로"}}
  },
  "archetypes": {
    "578": {
      "code": "HERO_BUBBLE",
      "name": {"zh": "水泡英雄", "ja": "バブルマンヒーロー", "en": "Bubbleman Hero", "ko": "버블맨 히어로"},
      "tier": 1
    }
  }
}
```

## ID 与家族约束

- ID 是持久化的显式标识，不是运行时位段编码；现有 ID 包含 4866、5378 等大于 4095 的值。
  旧 `meta.bitLayout` 的“12 位、最大 4095”描述与实际配置不符，不能用作校验或生成公式。
- 当前代码按 `Number` 读 ID，没有 12 位上限。新增 ID 使用不重复的正十进制整数，
  保持在现有数据库 `int` 正数范围内（1～2147483647）；代码并未替配置者完整校验此范围。
  不使用前导零、小数、负数、指数写法或超出安全整数范围的键。
- 4095 是当前“其他”兜底类型，应保留。仅修改 `otherDeckTypeId` 不足以改变整个系统的兜底约定，
  其他插件和已有数据也使用此值；调整须作为跨模块契约变更处理。
- 同一类型的所有模板文件以相同 ID 开头。新增元数据不会自动生成模板；
  只有模板完整命中才得到该分类。已保存的 ID 不因改名而改变。
- 旧 family/custom 分组用 `code === 家族代码` 或 `code` 以 `家族代码 + '_'` 开头推导成员，
  不读取 `tier` 或 ID 位段。例如 `JUNK_DOZER_PLANT` 不会自动归入 `SYNCHRO`。
  需要精确成员时在展示文件使用 `archetypeIds`，避免用重命名代码修补显示关系。

## 生效与验证

元数据及展示分组按文件修改时间热读；改 JSON 后重新请求即可。
模板清单和匹配计数在注册时加载，改模板需要重启。改名称/分组不会重跑历史比赛分类。

从 `srvprotianti` 根目录验证：

```text
node -e "JSON.parse(require('fs').readFileSync('plugins/deck_analysis/deck_analysis.json','utf8')); console.log('JSON OK')"
node plugins/tests/plugin-tests.js
```

涉及历史 ID、模板或重分类时补读 [RECLASSIFY_DATABASE.md](RECLASSIFY_DATABASE.md)。
