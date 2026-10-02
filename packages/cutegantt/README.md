# cutegantt

Browser-safe ESM library for validated project plans, version comparisons and self-contained SVG Gantt charts. TypeScript declarations are included. Use a modern ESM bundler for browser applications; no Node polyfills or filesystem access are required. Runtime formatting uses the host's `Intl` locale support.

```ts
import { ProjectPlan, renderSvg, comparePlans, renderMarkdown } from 'cutegantt';
import type { ProjectPlanInput } from 'cutegantt';

const input = {
  project: 'atlas',
  title: 'Atlas',
  timeline: { origin: '2026-09-01', timeUnit: { duration: '2w', name: 'Sprint' } },
  tasks: [{ id: 'build', name: 'Build', start: 1, end: 2, progress: 50 }],
} satisfies ProjectPlanInput;

const current = new ProjectPlan(input);
const previous = new ProjectPlan({ ...input, tasks: [{ ...input.tasks[0], end: 1 }] });
const chart = renderSvg(current, { previous, diff: true, lang: 'it' });
const changes = comparePlans(current, previous, 'it');
const markdown = renderMarkdown(current, previous, changes, 'Current', 'Previous', 'it');
```

`renderSvg` returns `{ svg, notesSvg, changes, width, height }`. `notesSvg` is present for comparisons. `RenderOptions` includes width, theme, font, note placement, language, display labels, holidays and weekend shading. Models and rendering functions accept unknown input and validate at runtime; `ProjectPlanInput` provides optional compile-time checking for authored documents.

Pass `header: false` to `renderSvg` to omit the visible title, subtitle, summary metrics and header decorations, including their vertical space. The header is enabled by default. This applies to both the chart and separate notes SVG; axes, legends and accessibility metadata remain present. Markdown reports are unaffected.

```ts
const { svg } = renderSvg(current, { header: false });
```

Set `timeline.showMonths: false` in a JSON/YAML plan to hide month labels and separator bars in both absolute and relative time. Months are visible by default. The render option `months` overrides the plan: `renderSvg(current, { months: false })` hides months, while `months: true` shows them. This also applies to every page returned by `renderSvgPages`. Weeks, time units and chart geometry are unchanged.

Set `style.showProgress: false` to hide generated progress information in all chart pages and separate notes: task and group percentages and progress fills, header progress and completion counts, and milestone completion styling. Planned bars, group spans, dates and duration remain visible; milestones use hollow diamonds regardless of completion. The default is `true`.

Progress/completion change details are also hidden in SVG notes and Markdown reports. Changes affecting only those fields are omitted from the displayed register unless they have a user note; original reference numbers are retained. User-authored text is not filtered. Input data, `comparePlans`, returned `changes` and JSON reports remain complete. This is a presentation option, not data redaction.

## Paginated Rendering

`renderSvgPages` accepts `PaginatedRenderOptions`, which extends `RenderOptions` with `pageSize` and `pages`. Its `PaginatedRenderResult` contains `pages: RenderPage[]`, the total `pageCount` before selection, all `changes`, and a complete `notesSvg` for comparisons. Each page has `{ page, svg, width, height }`.

```ts
import { renderSvgPages } from 'cutegantt';

const output = renderSvgPages(current, {
  pageSize: 10,
  pages: 0,
  header: false,
});
```

`pageSize` defaults to `0` (one unpaginated chart); positive safe integers limit the number of activities per page. `pages` defaults to `0` (all pages), accepts a positive 1-based page number, or `{ from: 2, to: 4 }` for an inclusive range. Invalid sizes, reversed ranges and nonexistent pages throw before returning output. With pagination disabled only `0`, `1` and `{ from: 1, to: 1 }` select a valid page. Returned page numbers retain their original values.

Tasks, milestones and removed comparison rows each count as one activity. Group headings and baseline overlays do not count. Pages follow the existing group-first display order; groups may span pages and repeat their headings, colors and full-plan summaries. Every chart page retains the complete timeline, markers and overall metrics. Page height adapts to its content, not a fixed paper size.

Inline notes contain only changes for activities on that page, retaining global reference numbers. Separate notes and the returned changes always cover the complete comparison, even when selecting a subset of pages. `renderSvg` and its single-chart contract remain unchanged. Pagination is a runtime option, not a plan-schema field.

The public entrypoint exports model classes, validation schemas, `planJsonSchema`, comparison/rendering functions, calendar helpers and translation/date-formatting functions. `Task` and `Milestone` form a discriminated union. `ProjectPlan.toJSON()` returns normalized plan data; model instances remain mutable and `ProjectPlan.from(existingInstance)` retains identity. Validation failures preserve `translationKey`, `parameters`, `path`, `issues` and `cause`.

```ts
import { planJsonSchema, calendarIntervals } from 'cutegantt';

const schema = planJsonSchema('en');
const calendar = calendarIntervals(
  [{ start: '2026-09-01', end: '2026-09-02', label: 'Closure' }],
  { start: Date.parse('2026-09-01T00:00:00Z'), end: Date.parse('2026-10-01T00:00:00Z') },
  true,
);
```

Date endpoints in documents are inclusive. Numeric addresses start at 1 and use each plan's origin. Internal end timestamps are exclusive. Holiday intervals affect presentation, not scheduling. English and Italian translations are included; `dateLocale` is independent of text language. The explicit `today` marker uses the local calendar date at render time.

File loading, YAML, baseline discovery and CLI output are in the separate `cutegantt-cli` package. Deep package imports are intentionally not exported. Build this package from the workspace root with `npm run build -w cutegantt`.
