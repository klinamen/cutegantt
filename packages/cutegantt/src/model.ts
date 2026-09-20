import {
  dateSchema,
  itemFieldsSchema,
  taskSchema,
  milestoneSchema,
  planItemSchema,
  timelineSchema,
  styleSchema,
  changeNotesSchema,
  projectPlanSchema,
  parseModel,
} from './schemas.js';
import type { z } from 'zod';
import type { NormalizedItem, TimelineData, StyleData, NormalizedPlan } from './schemas.js';

const DAY = 86400000;
const VALIDATED = Symbol('validated model data');
const data = <Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  token?: typeof VALIDATED,
): z.output<Schema> =>
  token === VALIDATED ? (input as z.output<Schema>) : parseModel(schema, input);

export function dateValue(value: unknown, label = 'date') {
  return Date.parse(`${parseModel(dateSchema, value, label)}T00:00:00Z`);
}

export interface PlanItem {
  readonly startTime: number;
  readonly endTime: number;
}
export class PlanItem {
  declare id: string;
  declare name: string;
  declare group: string | null;
  declare owner: string;
  declare note: string;
  declare type: 'task' | 'milestone';

  constructor(input: unknown, token?: typeof VALIDATED) {
    Object.assign(this, data(itemFieldsSchema, input, token));
  }

  static from(input: unknown) {
    return createItem(parseModel(planItemSchema, input));
  }

  hasSameFootprint(other: PlanItem) {
    return (
      this.type === other.type &&
      this.startTime === other.startTime &&
      this.endTime === other.endTime
    );
  }
}

export class Task extends PlanItem {
  declare type: 'task';
  declare start: string;
  declare end: string;
  declare progress: number;
  constructor(input: unknown, token?: typeof VALIDATED) {
    super(data(taskSchema, input, token), VALIDATED);
  }

  get startTime() {
    return dateValue(this.start);
  }
  get endTime() {
    return dateValue(this.end) + DAY;
  }
}

export class Milestone extends PlanItem {
  declare type: 'milestone';
  declare date: string;
  declare completed: boolean;
  constructor(input: unknown, token?: typeof VALIDATED) {
    super(data(milestoneSchema, input, token), VALIDATED);
  }

  get startTime() {
    return dateValue(this.date);
  }
  get endTime() {
    return this.startTime + DAY;
  }
}

function createItem(input: NormalizedItem) {
  return input.type === 'milestone' ? new Milestone(input, VALIDATED) : new Task(input, VALIDATED);
}

export interface TimelineConfig extends TimelineData {}
export class TimelineConfig {
  constructor(input: unknown = {}, token?: typeof VALIDATED) {
    Object.assign(this, data(timelineSchema, input, token));
  }
}

export interface StyleConfig extends StyleData {}
export class StyleConfig {
  constructor(input: unknown = {}, token?: typeof VALIDATED) {
    Object.assign(this, data(styleSchema, input, token));
  }
}

export class ChangeNotes {
  #entries;

  constructor(input: unknown = {}, token?: typeof VALIDATED) {
    if (input instanceof ChangeNotes) input = input.toJSON();
    this.#entries = new Map(Object.entries(data(changeNotesSchema, input, token)));
  }

  get(id: string) {
    return this.#entries.get(id);
  }
  toJSON() {
    return Object.fromEntries(this.#entries);
  }
}

export interface ProjectPlan extends Omit<
  NormalizedPlan,
  'tasks' | 'changeNotes' | 'timeline' | 'style'
> {}
export class ProjectPlan {
  declare tasks: (Task | Milestone)[];
  declare changeNotes: ChangeNotes;
  declare timeline: TimelineConfig;
  declare style: StyleConfig;
  constructor(input: unknown) {
    const source = input instanceof ProjectPlan ? input.toJSON() : input;
    const { tasks, changeNotes, timeline, style, ...metadata } = parseModel(
      projectPlanSchema,
      source,
    );
    Object.assign(this, metadata);
    this.tasks = tasks.map(createItem);
    this.changeNotes = new ChangeNotes(changeNotes, VALIDATED);
    this.timeline = new TimelineConfig(timeline, VALIDATED);
    this.style = new StyleConfig(style, VALIDATED);
  }

  toJSON(): NormalizedPlan {
    return { ...this, changeNotes: this.changeNotes.toJSON() };
  }
  static from(input: unknown) {
    return input instanceof ProjectPlan ? input : new ProjectPlan(input);
  }
}
