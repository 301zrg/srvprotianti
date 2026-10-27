# Deck card adoption implementation plan

> Execute the approved work locally using the superpowers execution and verification workflows. Preserve the existing dirty worktrees. No commit, release-queue mutation, server change or deployment is authorized in this implementation stage.

**Goal:** Add an on-demand card adoption section to deck-detail.html, with an independent API and XLSX/CSV export, and synchronize the desktop assistant.

**Architecture:** ladder-usage-analytics aggregates existing sample/card facts without new tables or indexes. ladder-web adapts the public API and lazy UI. The desktop embeds the same UI/export code and explicitly permits the new API route.

**Tech stack:** Existing CommonJS/TypeORM/PostgreSQL and SQL.js, native browser JavaScript, ExcelJS, Tauri/Rust.

**Approved spec:** Conversation approval on 2026-10-25: section between win-rate table and top players, initially collapsed; independent API on expansion; inherit deck/period/language; five zone tabs, 50 rows/page and top 200 per zone; independent card export; preserve existing win-rate export and clarify its label. Local review precedes any release queue work.

## Contract and constraints

- GET /api/ladder/deck-detail?view=card-usage?deckTypeId=578&period=month&month=202610&lang=ja.
- Response: {available:true,selected:{id,names},period,month,startDay,endDay,coverage:{allDecks,validCardDecks},cardLimit:200,pageSize:50,cards:{monster:[],spell:[],trap:[],extra:[],side:[]},generatedAt}.
- Card row: {rank,cardId,name,deckCount,usageRate,copies1,copies2,copies3}. Names use the existing catalog language/fallback rules.
- Denominator: valid G1 samples for the selected fine deck type and period; missing samples remain visible in allDecks.
- PostgreSQL uses parameter binding, a read-only repeatable-read transaction, 3s statement/500ms lock timeouts, no parallel workers, existing sampleId index, and two queries (denominator plus all zones).
- Cache numeric aggregates for 30s, <=16 keys and <=2MiB serialized content; coalesce identical requests; <=2 distinct queries in flight; invalidate after successful projection and prevent obsolete in-flight cache writes.
- Reject invalid/unknown/Other deck detail IDs with 400; return 429 when busy, 503 when aggregation times out; no private data in public responses.
- No new dependencies, database schema, production writes, queue changes, or builds that publish releases.

## Review focus

Missing/invalid snapshots must not dilute adoption; stale responses must not overwrite a changed deck/month; card loading failure must not break win rates; exports must use one captured scope and all pages; desktop API permissions must be narrowly extended.

## Tasks

- [x] Backend: add deck-card-usage.js and real SQL/count/cache/failure tests; integrate service invalidation and HTTP route; add an integration assertion for route/serialization.
- [x] Frontend: add deck-card-usage.js browser module and behavioral UI/export tests; mount between win rates/top players; reuse existing export format/save/workbook capabilities; support four languages, no-sample/loading/retry states and scope changes.
- [x] Desktop: synchronize only reviewed page/assets, add asset preparation and exact Rust GET route permission; run build/check and relevant Rust tests.
- [x] Documentation and review: update owning API/page/architecture documentation, provide local review preview and evidence, inspect diff against saved pre-task baseline, obtain fresh review, fix material findings and verify.

## Verification

- node --test plugins/ladder-usage-analytics/deck-card-usage.test.js
- node plugins/tests/plugin-tests.js; node plugins/tests/integration.test.js
- Browser test against web and prepared desktop, four languages and desktop/mobile widths, including expand/load, retry, stale response, pagination and actual XLSX/CSV contents.
- Desktop npm run check and targeted cargo tests for API permission.
- Local PostgreSQL read-only query of existing local data validates production SQL syntax; use a separate process/loopback preview with no connection to production.

Progress and this task's original-file manifest live in ../.audit-tmp/deck-card-implementation-20261025/ (workspace root).
