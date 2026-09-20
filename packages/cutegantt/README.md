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
