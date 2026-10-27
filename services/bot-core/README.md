# Bot core

服务导航见 [services](../README.md)，平台配置归 [QQ](../qq-bot/README.md) 和 [Discord](../discord-bot/README.md)。

QQ and Discord share the public game API client, TT waiting-room monitor, 04:00 Asia/Shanghai scheduler, response formatting and chart rendering here. Platform adapters live in `../qq-bot` and `../discord-bot` and run as separate processes.

Both adapters call only public HTTP endpoints. `roomStatus()` uses the same `rooms[].users.length` sum as `rooms.html`; this is room occupancy, not a unique account count. The monitor's first successful poll after startup or an API failure establishes a baseline and does not send old waiting-room alerts.

Discord `/meta` 与 QQ `月报`/`卡组`/`卡片` 支持上月、指定月份的卡组使用率、总体/对阵 Match 胜率和五类卡片使用率。
共享月报数据规则见 [月报设计](MONTHLY_REPORT_DESIGN.md)，QQ 语言和投递规则见
[QQ 专题](../qq-bot/LANGUAGE_AND_DELIVERY.md)。Discord 另提供手动发推素材导出。
自动推送默认关闭；新 `MonthlyReportScheduler` 在每月 1 日北京时间 10:00 发布上月数据，
不改变原有每日 04:00 玩家榜。月报数据只通过公开 HTTP 接口取得。

Discord 每日榜使用 `DailyRankingScheduler`：04:00 起到当日午夜恢复漏发，失败每分钟重试，
按频道/日期持久化排名快照与成功消息 ID；旧 `lastAttempt` 仅表示尝试，升级后通过频道历史确认。
发送前后保存状态，未知结果先查历史，稳定 nonce 辅助去重；历史读取失败不视为消息不存在。
QQ 使用 `QqScheduler` 分别管理每日榜和月报：同样当日补漏/一分钟重试和月报72小时恢复，
逐部分保存消息回执；没有历史回读，结果不明时暂停而不盲目重发。原 `MonthlyScheduler` 仅保留历史兼容。
Discord 管理员手动月报补发进入同一月报状态机，失败请求可在自动窗口外继续重试；
管理员测试频道直接展示内容，不改变正式投递状态或已发布版本。

## Shared win streak contract

QQ and Discord both enable `WinStreakMonitor` through `winStreaks.enabled` (default false). It consumes public `GET /api/ladder/streaks`, keeps only fresh latest wins of at least 5 M matches, and stores attempts before sending to avoid restart spam. Each subsequent observed win can post; losses remove the player from the feed. Missed, failed or expired posts are not queued for replay. Server-relative age handles different host clocks. QQ formats the group's configured languages in order; Discord retains all four languages. Both include current streak and monthly rating, wins, win-loss difference and win rate.

`pollSeconds` defaults to 5 (range 1–60); `stateFile` defaults to `data/win-streak-state.json` and must remain within that service folder. Each platform uses its own state file and process. Preserve it during upgrades. Config validation requires a selected channel/group when announcements are enabled. Adapters implement `canNotifyWinStreak()` and `notifyWinStreak(row, deadline)`; an unavailable connection, unresolved QQ `temp` group or denied QQ group is not ready. A false readiness check avoids consuming events. Each send checks the deadline again and limits its HTTP request to the remaining window. Platform permissions and target-specific switches stay in the adapters.

The API window is 60 seconds. Offline wins 5–7 followed by a fresh win 8 produce only the latest win 8. Two wins by the same player between polls also coalesce to the newest result. Sending attempts are best effort: a persisted attempt may be lost if the send fails, as explicitly accepted for this feature. This service does not initialize historical streaks or infer winners from rooms; game-side counting starts at zero after the [migration](../../plugins/ladder-core/migrations/202610-win-streaks/README.md).

| Responsibility | Source |
| --- | --- |
| Both platform runtimes and configuration | `src/runtime.mjs`, `src/config.mjs` |
| Public HTTP client and response validation | `src/api.mjs` |
| Fresh streak selection and persisted attempts | `src/win-streaks.mjs` |
| Configurable streak message and other text | `src/i18n.mjs` (`formatWinStreak`) |
| Commands, waiting alerts, daily ranking and charts | `src/service.mjs`, `src/monitor.mjs`, `src/scheduler.mjs`, `src/daily-ranking-scheduler.mjs`, `src/chart.mjs` |
| Platform worker lock and QQ supervisor | `src/instance-lock.mjs`, `src/worker-supervisor.mjs` |
| Monthly report model, immutable artifacts and ZIP export | `src/monthly-report.mjs`, `src/monthly-report-zip.mjs` |
| Four report images, localized single-zone images and bundled font | `src/monthly-report-render.mjs`, `src/assets/fonts/` |
| Four-language introduction and X caption | `src/monthly-report-text.mjs` |
| Monthly delivery, persisted attempts and recovery | `src/monthly-report-scheduler.mjs` |
| QQ per-group daily/monthly receipts, part recovery and uncertain-send hold | `src/qq-scheduler.mjs` |
| Ordered image languages, shared font renderer and QQ localized reports | `src/languages.mjs`, `src/figure.mjs`, `src/localized-report-render.mjs` |

Run `npm test` in this directory for shared logic, configuration gates, expiration/deduplication and both runtime integrations. Generate independent deployment folders through [bot-tools](../bot-tools/README.md). The generated folders contain copies of this source, so changes here require a new build.

Monthly report tests cover denominators, fine classification IDs, outside opponents, directional cells,
cache/request limits, archived exports and uncertain-send recovery; they also render real PNGs with the packaged font.
`test/all.test.mjs` loads the suites directly, including daily recovery, acknowledgement loss, save failures and configuration/instance guards, so the Node.js 20+ test entry does not require spawning child processes.
