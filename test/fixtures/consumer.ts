import { ProjectPlan, renderSvg, renderSvgPages, comparePlans, renderMarkdown, projectPlanInputSchema, planJsonSchema } from 'cutegantt';
import type { ProjectPlanInput, RenderResult, PaginatedRenderOptions, PaginatedRenderResult, RenderPage, Change, Holiday } from 'cutegantt';

const input = {
  title: 'Consumer', project: 'consumer', timeline: { origin: '2026-09-01' },
  tasks: [{ id: 'build', name: 'Build', start: 1, end: 2 }],
} satisfies ProjectPlanInput;
const plan = new ProjectPlan(input);
const serialized = plan.toJSON();
const markerPosition: string | undefined = plan.timeline.markers?.[0].position;
const serializedNotes: Record<string, string> = serialized.changeNotes;
const changes: Change[] = comparePlans(plan, plan);
const holidays: Holiday[] = [{ start: '2026-09-01', end: '2026-09-02', label: 'Closure' }];
const result: RenderResult = renderSvg(plan, { holidays, lang: 'it', previous: plan, diff: true, header: false });
const svg: string = result.svg;
const pageOptions: PaginatedRenderOptions = { pageSize: 10, pages: { from: 1, to: 1 }, header: false };
const paginated: PaginatedRenderResult = renderSvgPages(plan, pageOptions);
const pages: RenderPage[] = paginated.pages;
const pageCount: number = paginated.pageCount;
const markdown: string = renderMarkdown(plan, plan, changes);
const parsed: unknown = projectPlanInputSchema.parse(input);
const schema: unknown = planJsonSchema();
for (const item of plan.tasks) {
  if (item.type === 'task') { const progress: number = item.progress; void progress; }
  else { const completed: boolean = item.completed; void completed; }
}
type Assert<Condition extends true> = Condition;
type RejectInvalidEndpoint = Assert<{
  title: string; project: string; timeline: { origin: string };
  tasks: { id: string; name: string; start: boolean; end: number }[];
} extends ProjectPlanInput ? false : true>;
type RejectInvalidResult = Assert<RenderResult['svg'] extends number ? false : true>;
void [svg, markdown, parsed, schema, markerPosition, serializedNotes, pages, pageCount];
export type { RejectInvalidEndpoint, RejectInvalidResult };