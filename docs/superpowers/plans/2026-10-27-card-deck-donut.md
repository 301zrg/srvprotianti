# Card deck distribution donut implementation plan

> For agentic workers: use superpowers:executing-plans in the existing isolated server and desktop worktrees.

**Goal:** Complete the existing card distribution feature with a default donut dialog, list switching and safe mobile selection.

**Architecture:** Keep Claude's read-only API, cache and counting rules. The usage page owns the modal and SVG chart; existing shared CSS owns responsive presentation. Synchronize the same source into the desktop page snapshot without changing native permissions or release queues.

**Tech Stack:** Existing vanilla JavaScript, native dialog, SVG and Playwright/Edge.

**Spec:** The approved design in this conversation: donut default, list switch, sector selection followed by an explicit detail link; all deck types remain accessible. This request authorizes implementation without another design gate.

## Global constraints

- Retain four languages, region/period/month parameters, 100% card-user denominator and unlinked unclassified types.
- Show at most six named large slices (at least 3% each); merge the remaining named types for the chart only. Tiny aggregate/unclassified slices retain their true proportions and use large text controls for selection.
- Sector clicks never navigate. The selected known type has an explicit detail link; a grouped slice exposes its constituent types.
- Mobile controls have at least 44px hit areas, no horizontal overflow and accessible full classification rows; native dialog closes by its close button/Escape and restores focus.
- No database/schema work, production connection, deployment, queue mutation or new native desktop permissions.

## Review focus

- One dominant category with many tiny types: no inaccurate enlarged wedges or missing classifications.
- A single 100% category: valid complete ring and usable selection.
- Async response after close/scope change: cannot reopen stale content.
- Storage unavailable: default chart and mode switching continue to work.
- Mobile selection and grouped/unclassified types: never navigate to an aggregate or invalid detail page.

## Tasks

- [x] 1. Adapt the existing Playwright suite to assert default dialog/chart, selected detail links, large legend controls and switching without requests. Watch the new assertion fail against the list-only baseline.
- [x] 2. Complete the page and CSS. Preserve error/retry, cache, image loading and four languages; cover tiny categories, 100%/empty responses, stale requests, focus, mode persistence and narrow/landscape layouts. Run UI and existing related regressions.
- [ ] 3. Update the page contract, commit the verified website changes locally, sync desktop from that exact source commit, run desktop checks and the same UI suite against generated desktop pages. Record review and validation locally; leave publishing for a separate user instruction.
