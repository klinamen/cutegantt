import { z } from 'zod';
import parseDuration from 'parse-duration';
import { localizedError, canonicalDateLocale, translator } from './i18n.js';

const requiredText = z.string({ error: 'required' }).trim().min(1, { error: 'required' });
const scalar = z.union([z.string(), z.number()], { error: 'plan' }).optional();
const optionalText = z.preprocess(
  (value) => (typeof value === 'string' ? value : ''),
  z.string().trim(),
);
const object = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape, { error: 'plan' });
const nullableDefault = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess((value) => value ?? {}, schema);
const record = (value: unknown): Record<PropertyKey, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<PropertyKey, unknown>) : {};

export const dateSchema = z
  .string({ error: 'dateFormat' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'dateFormat' })
  .refine(
    (value) => {
      const stamp = Date.parse(`${value}T00:00:00Z`);
      return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
    },
    { error: 'dateInvalid' },
  );

export const holidaysFileSchema = object({
  holydays: z.array(
    object({ start: dateSchema, end: dateSchema, label: requiredText }).refine(
      (item) => item.end >= item.start,
      { error: 'holidayEnd', path: ['end'] },
    ),
    { error: 'plan' },
  ),
});

export const itemFieldsSchema = object({
  id: requiredText,
  name: requiredText,
  group: requiredText.nullish().transform((value) => value ?? null),
  owner: optionalText,
  note: optionalText,
});
export const taskSchema = itemFieldsSchema
  .extend({
    type: z.literal('task', { error: 'type' }).default('task'),
    start: dateSchema,
    end: dateSchema,
    progress: z.preprocess(
      (value) => value ?? 0,
      z.number({ error: 'progress' }).min(0, { error: 'progress' }).max(100, { error: 'progress' }),
    ),
  })
  .refine((item) => item.end >= item.start, { error: 'end', path: ['end'] });
export const milestoneSchema = itemFieldsSchema.extend({
  type: z.literal('milestone', { error: 'type' }),
  date: dateSchema,
  completed: z.boolean().default(false),
});
export const planItemSchema = z.preprocess(
  (value) => {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      record(value).type === undefined
    )
      return { ...value, type: 'task' };
    return value;
  },
  z.discriminatedUnion('type', [taskSchema, milestoneSchema], { error: 'type' }),
);
export function durationDays(value: unknown): number {
  if (
    typeof value !== 'string' ||
    value.length > 80 ||
    !/^(?:\d+(?:\.\d+)?\s*[dw]\s*)+$/i.test(value.trim())
  )
    return NaN;
  const days = parseDuration(value, 'd');
  return days !== null && Number.isInteger(days) && days >= 1 && days <= 3660 ? days : NaN;
}

export const timeUnitSchema = object({
  duration: z
    .string({ error: 'duration' })
    .trim()
    .refine((value) => Number.isFinite(durationDays(value)), { error: 'duration' })
    .default('2w'),
  name: z
    .string({ error: 'unitName' })
    .trim()
    .min(1, { error: 'unitName' })
    .max(80, { error: 'unitName' })
    .default('Sprint'),
});

function resolveEndpoint(
  value: unknown,
  origin: string,
  days: number,
  isEnd: boolean,
  context: z.RefinementCtx,
  path: (string | number)[],
  allowBeforeOrigin = false,
): string {
  const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value));
  let resolved = value;
  if (numeric) {
    const index = Number(value);
    if (!Number.isSafeInteger(index) || index < 1) {
      context.addIssue({ code: 'custom', message: 'unitIndex', path });
      return z.NEVER;
    }
    const stamp =
      Date.parse(`${origin}T00:00:00Z`) +
      ((index - (isEnd ? 0 : 1)) * days - (isEnd ? 1 : 0)) * 86400000;
    if (!Number.isSafeInteger(stamp) || stamp > Date.parse('9999-12-31T00:00:00Z')) {
      context.addIssue({ code: 'custom', message: 'range', path });
      return z.NEVER;
    }
    resolved = new Date(stamp).toISOString().slice(0, 10);
  }
  const parsed = dateSchema.safeParse(resolved);
  if (!parsed.success) {
    parsed.error.issues.forEach((issue) =>
      context.addIssue({ ...issue, path: [...path, ...issue.path] }),
    );
    return z.NEVER;
  }
  if (!allowBeforeOrigin && parsed.data < origin)
    context.addIssue({ code: 'custom', message: 'beforeOrigin', path });
  return parsed.data;
}

const timelineFieldsSchema = object({
  origin: dateSchema,
  start: z.never({ error: 'legacyOrigin' }).optional(),
  end: z.never({ error: 'legacyEnd' }).optional(),
  granularity: z.never({ error: 'legacyTimeline' }).optional(),
  sprintWeeks: z.never({ error: 'legacyTimeline' }).optional(),
  timeUnit: timeUnitSchema.optional(),
  showWeekNumbers: z.boolean().optional(),
  truncateUnits: z.boolean().optional(),
  relativeTime: z.boolean().optional(),
  markers: z.array(object({ position: z.unknown(), label: requiredText })).optional(),
  visibleRange: object({ start: z.unknown().optional(), end: z.unknown().optional() }).optional(),
});
export type TimelineData = Omit<
  z.output<typeof timelineFieldsSchema>,
  'markers' | 'visibleRange'
> & {
  markers?: { position: string; label: string }[];
  visibleRange?: { start?: string; end?: string };
};
export const timelineSchema = timelineFieldsSchema.transform((timeline, context): TimelineData => {
  const days = durationDays(timeline.timeUnit?.duration ?? '2w');
  const markers = timeline.markers?.map((marker, index) => ({
    ...marker,
    position:
      marker.position === 'today'
        ? 'today'
        : resolveEndpoint(
            marker.position,
            timeline.origin,
            days,
            false,
            context,
            ['markers', index, 'position'],
            true,
          ),
  }));
  if (!timeline.visibleRange)
    return { ...timeline, ...(markers ? { markers } : {}) } as TimelineData;
  const visibleRange: { start?: string; end?: string } = {};
  for (const field of ['start', 'end'] as const) {
    if (timeline.visibleRange[field] !== undefined) {
      visibleRange[field] = resolveEndpoint(
        timeline.visibleRange[field],
        timeline.origin,
        days,
        field === 'end',
        context,
        ['visibleRange', field],
      );
    }
  }
  if (
    typeof visibleRange.start === 'string' &&
    typeof visibleRange.end === 'string' &&
    visibleRange.end < visibleRange.start
  ) {
    context.addIssue({ code: 'custom', message: 'timeline', path: ['visibleRange', 'end'] });
  }
  return { ...timeline, visibleRange, ...(markers ? { markers } : {}) } as TimelineData;
});
export const styleSchema = object({
  width: scalar,
  theme: scalar,
  font: scalar,
  groupSummary: z.boolean().optional(),
  leftSideScale: z
    .string({ error: 'leftSideScale' })
    .regex(/^(?:(?:1\d|[2-4]\d)(?:\.\d+)?|50(?:\.0+)?)%$/, { error: 'leftSideScale' })
    .optional(),
  fontScale: z
    .string({ error: 'fontScale' })
    .regex(/^(?:(?:[5-9]\d|1[0-4]\d)(?:\.\d+)?|150(?:\.0+)?)%$/, { error: 'fontScale' })
    .optional(),
  height: z.enum(['short', 'normal', 'tall'], { error: 'height' }).optional(),
});
export const changeNotesSchema = z.record(z.string(), z.string({ error: 'changeNotes' }), {
  error: 'changeNotes',
});
const canonicalProjectPlanSchema = object({
  dateLocale: z
    .string({ error: 'dateLocale' })
    .transform((value, context) => {
      try {
        return canonicalDateLocale(value);
      } catch {
        context.addIssue({ code: 'custom', message: 'dateLocale' });
        return z.NEVER;
      }
    })
    .optional(),
  title: requiredText,
  project: requiredText,
  subtitle: scalar,
  version: scalar,
  tasks: z
    .array(planItemSchema, { error: 'tasks' })
    .min(1, { error: 'tasks' })
    .superRefine((items, context) => {
      const ids = new Set();
      items.forEach((item, index) => {
        if (ids.has(item.id))
          context.addIssue({
            code: 'custom',
            message: 'duplicate',
            path: [index, 'id'],
            params: { id: item.id },
          });
        ids.add(item.id);
      });
    }),
  timeline: nullableDefault(timelineSchema),
  style: nullableDefault(styleSchema),
  today: z.never({ error: 'legacyToday' }).optional(),
  changeNotes: nullableDefault(changeNotesSchema),
});

const unitIndexSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const endpointInputSchema = z.union([
  dateSchema,
  unitIndexSchema,
  z.string().regex(/^0*[1-9]\d*$/),
]);
const itemInputFields = {
  ...itemFieldsSchema.shape,
  group: requiredText.nullish(),
  owner: z.unknown().optional(),
  note: z.unknown().optional(),
};
const taskInputSchema = object({
  ...taskSchema.shape,
  ...itemInputFields,
  start: endpointInputSchema,
  end: endpointInputSchema,
  progress: z.number({ error: 'progress' }).min(0).max(100).nullable().optional().default(0),
});
const milestoneInputSchema = object({
  ...milestoneSchema.shape,
  ...itemInputFields,
  date: endpointInputSchema,
});
const timelineInputSchema = timelineSchema.in.extend({
  markers: z
    .array(
      object({ position: z.union([endpointInputSchema, z.literal('today')]), label: requiredText }),
    )
    .optional(),
  visibleRange: object({
    start: endpointInputSchema.optional(),
    end: endpointInputSchema.optional(),
  }).optional(),
});
export const projectPlanInputSchema = object({
  ...canonicalProjectPlanSchema.shape,
  dateLocale: z.string({ error: 'dateLocale' }).optional(),
  tasks: z.array(z.union([taskInputSchema, milestoneInputSchema])).min(1),
  timeline: timelineInputSchema,
  style: styleSchema.nullable().optional(),
  changeNotes: changeNotesSchema.nullable().optional(),
});

export function planJsonSchema(lang = 'en') {
  const translate = translator(lang);
  const schema = z.toJSONSchema(projectPlanInputSchema, { io: 'input', target: 'draft-2020-12' });
  const describe = (
    node: z.core.JSONSchema.JSONSchema | boolean | (z.core.JSONSchema.JSONSchema | boolean)[],
    path: string[] = [],
  ) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      const key =
        ['start', 'end', 'granularity', 'sprintWeeks'].includes(name) && path.at(-1) === 'timeline'
          ? 'legacyTimeline'
          : name;
      if (typeof property === 'object') property.description = translate(`schema.${key}`);
      describe(property, [...path, name]);
    }
    for (const branch of node.anyOf ?? node.oneOf ?? []) describe(branch, path);
    if (node.items) describe(node.items, path);
    if (node.additionalProperties && typeof node.additionalProperties === 'object')
      describe(node.additionalProperties, path);
  };
  describe(schema);
  schema.title = translate('schema.schemaTitle');
  schema.description = translate('schema.schemaDescription');
  schema.examples = [
    {
      project: 'atlas',
      title: 'Atlas',
      timeline: {
        origin: '2026-08-31',
        timeUnit: { duration: '2w', name: 'Sprint' },
        markers: [{ position: 'today', label: 'Review / $position' }],
      },
      tasks: [
        { id: 'build', name: 'Build', start: 1, end: 2, progress: 50 },
        { id: 'release', name: 'Release', type: 'milestone', date: 3, completed: false },
      ],
    },
  ];
  return schema;
}

export const projectPlanSchema = z.preprocess((input, context) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const source = record(input);
  const parsed = timelineSchema.safeParse(source.timeline ?? {});
  if (!parsed.success) {
    parsed.error.issues.forEach((issue) =>
      context.addIssue({ ...issue, path: ['timeline', ...issue.path] }),
    );
    return z.NEVER;
  }
  if (!Array.isArray(source.tasks)) return input;
  const timeline = parsed.data;
  const days = durationDays(timeline.timeUnit?.duration ?? '2w');
  const tasks = source.tasks.map((item: unknown, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const fields = record(item);
    if (fields.type === 'milestone') {
      return {
        ...item,
        date: resolveEndpoint(fields.date, timeline.origin, days, false, context, [
          'tasks',
          index,
          'date',
        ]),
      };
    }
    if (fields.type !== undefined && fields.type !== 'task') return item;
    return {
      ...item,
      start: resolveEndpoint(fields.start, timeline.origin, days, false, context, [
        'tasks',
        index,
        'start',
      ]),
      end: resolveEndpoint(fields.end, timeline.origin, days, true, context, [
        'tasks',
        index,
        'end',
      ]),
    };
  });
  const normalized = { ...input, timeline, tasks };
  const checked = canonicalProjectPlanSchema.safeParse(normalized);
  if (!checked.success) {
    checked.error.issues.forEach((issue) => context.addIssue({ ...issue }));
    return z.NEVER;
  }
  const structural = projectPlanInputSchema.safeParse(input);
  if (!structural.success) {
    structural.error.issues.forEach((issue) => context.addIssue({ ...issue }));
    return z.NEVER;
  }
  return normalized;
}, canonicalProjectPlanSchema);

export type ProjectPlanInput = z.input<typeof projectPlanInputSchema>;
export type NormalizedPlan = z.output<typeof projectPlanSchema>;
export type NormalizedItem = z.output<typeof planItemSchema>;
export type StyleData = z.output<typeof styleSchema>;
export type Holiday = z.output<typeof holidaysFileSchema>['holydays'][number];

export function parseModel<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  label?: string,
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue.path;
  const field = path.reduce<string>(
    (text, part) =>
      typeof part === 'number' ? `${text}[${part}]` : `${text ? `${text}.` : ''}${String(part)}`,
    '',
  );
  const parent = path.slice(0, -1).reduce<unknown>((value, part) => record(value)[part], input);
  const value = path.reduce<unknown>((value, part) => record(value)[part], input);
  const error = localizedError(issue.message, {
    label: label ?? field,
    value,
    id: record(parent).id ?? record(input).id,
    ...('params' in issue ? issue.params : {}),
  });
  error.path = path;
  error.issues = result.error.issues;
  error.cause = result.error;
  throw error;
}
