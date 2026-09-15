# Ladder Web 可热更新内容配置

## 示例卡组

使用介绍页的示例卡组分类和下载文件由 `example-decks.json` 控制。保存后无需重启服务器，
重新进入或刷新介绍页即可通过 `GET /api/example-decks` 取得新配置。

每个 `groups` 项包含稳定 `id`、四语言 `name` 和 `decks`；每个卡组包含实际文件名 `file`
和四语言下载显示名 `name`：

```json
{
  "groups": [
    {
      "id": "tier1",
      "name": {"zh": "一线卡组", "ja": "一線級デッキ", "en": "Tier 1 Decks", "ko": "1티어 덱"},
      "decks": [
        {
          "file": "八杰-hb.ydk",
          "name": {"zh": "八杰-HB", "ja": "一線級-HB", "en": "Tier 1 - HB", "ko": "1티어-HB"}
        }
      ]
    }
  ]
}
```

- `file` 必须是 basename，不能含目录，扩展名必须为 `.ydk`。
- 对应文件必须放在 `web/example_decks/`；配置存在但文件缺失时，链接仍会展示，下载返回 404。
- 分组和卡组按 JSON 数组顺序显示。
- 新增可见名称时必须同时填写中文、日语、英语和韩语。
- 示例卡组译名应与 `../deck_analysis/deck_analysis.json` 中对应细分类保持一致；使用率页修改
  卡组译名后，应同时检查这里的下载显示名。
- JSON 无效时接口返回 500，页面显示本地化的配置加载失败信息。

## 默认排名依据

默认排名依据仍配置在 `../ladder-analytics/config.default.json`，部署覆盖写在同目录的
`config.json`：

```json
{
  "rankingBasis": "points"
}
```

允许值为 `points`、`wins`、`diff`、`winRate`。排行榜请求未显式传 `rankingBasis` 时以及使用介绍页
读取排序说明时，服务会实时重读这两个配置文件，因此保存后无需重启；已打开页面点击刷新
或重新进入即可看到新默认值。显式 URL 参数始终优先于默认配置。

## 公共页面结构

八个公开页面都位于 `web/`，并由 `routes.json` 声明访问路径。公共资源位于：

- `web/assets/site-shell.js`：页面标题、顶部导航、语言菜单、规范语言参数和公共翻译入口。
- `web/assets/common.css`：背景、字体、导航、语言菜单、按钮、表格及移动端基础样式。

页面用 `<div data-site-shell></div>` 作为外壳挂载点，加载上述 CSS/JS 后调用
`SrvproWeb.init(...)` 注册页面标题、页面专属翻译和语言变化回调。新增公开页面时需要同时：

1. 在 `web/` 添加 HTML，并在 `routes.json` 登记路由。
2. 在 `site-shell.js` 的 `NAVIGATION` 和 `NAV_TEXT` 增加导航项及四语言名称。
3. 复用 `common.css`，页面内只保留专属布局和视觉规则。
4. 更新 `docs/WEB_PAGE_DEVELOPMENT_SPEC.md` 中的页面参数、内容、按钮和状态契约。

`/assets/<filename>` 只提供 `web/assets/` 下的单层 `.css`、`.js` 文件，不支持子目录或其他
扩展名。不要把业务数据、配置或下载文件放入该路由。
