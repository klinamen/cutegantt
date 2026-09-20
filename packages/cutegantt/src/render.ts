import { translator, localizedError, dateFormatters } from './i18n.js';
import { ProjectPlan, dateValue } from './model.js';
import { timeUnitSchema, parseModel, durationDays } from './schemas.js';
import { calendarIntervals } from './calendar.js';
import type { Task, Milestone } from './model.js';
import type { TimelineData, Holiday } from './schemas.js';

type Item = Task | Milestone;
type Attributes = Record<string, string | number>;
type Dates = ReturnType<typeof dateFormatters>;
type Translate = ReturnType<typeof translator>;
export interface Change {
  number: number;
  id: string;
  name: string;
  kind: 'added' | 'removed' | 'changed';
  before?: Item;
  after?: Item;
  fields: string[];
  details: string[];
  note: string;
}
export interface RenderOptions {
  previous?: unknown;
  diff?: boolean;
  lang?: string;
  width?: string | number;
  theme?: string | number;
  font?: string | number;
  notes?: string;
  currentLabel?: string;
  previousLabel?: string;
  holidays?: Holiday[];
  shadeWeekends?: boolean;
  holidayLabels?: boolean;
}
export interface RenderResult {
  svg: string;
  notesSvg?: string;
  changes: Change[];
  width: number;
  height: number;
}
interface MarkerLane {
  markers: Marker[];
  height: number;
  offset: number;
}
interface Marker {
  stamp: number;
  lines: string[];
  center: number;
  left: number;
  right: number;
  lane?: MarkerLane;
}
interface LayoutBase {
  lines: string[];
  top: number;
  height: number;
  color: string;
}
type Layout = LayoutBase &
  (
    | { kind: 'group'; name: string; summary?: { start: number; end: number; progress?: number } }
    | { kind: 'task'; task: Item; metaLines: string[]; fullMeta: string }
  );
const fieldValue = (item: Item | undefined, field: string): unknown =>
  item ? Reflect.get(item, field) : undefined;

const DAY = 86400000;
const FIELDS = ['type', 'name', 'group', 'owner', 'start', 'end', 'date', 'progress', 'completed'];

export function validatePlan(input: unknown) {
  return ProjectPlan.from(input);
}

function planDates(current: ProjectPlan, lang: string) {
  const dates = dateFormatters(lang, current.dateLocale);
  if (!current.timeline.relativeTime) return dates;
  const origin = dateValue(current.timeline.origin);
  const full = (value: string | number) => {
    const days = Math.floor(
      ((typeof value === 'number' ? value : dateValue(value)) - origin) / DAY,
    );
    if (days < 0) return `${days}d`;
    return `w${Math.floor(days / 7) + 1}${days % 7 ? ` d${(days % 7) + 1}` : ''}`;
  };
  return { ...dates, full, short: full };
}

function relativeMonth(origin: number, stamp: number) {
  const anchor = new Date(origin);
  const date = new Date(stamp);
  const boundary = (offset: number) => {
    const result = new Date(origin);
    result.setUTCDate(1);
    result.setUTCMonth(anchor.getUTCMonth() + offset + 1);
    result.setUTCDate(0);
    result.setUTCDate(Math.min(anchor.getUTCDate(), result.getUTCDate()));
    return result.getTime();
  };
  let index =
    (date.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    date.getUTCMonth() -
    anchor.getUTCMonth();
  if (stamp < boundary(index)) index--;
  return { index, end: boundary(index + 1) };
}

function displayValue(value: unknown, field: string, translate: Translate, dates: Dates) {
  if (value === null && field === 'group') return translate('project');
  if (value === undefined || value === '') return translate('unset');
  if (field === 'progress') return `${value}%`;
  if (field === 'completed') return translate(value ? 'milestoneCompleted' : 'milestonePending');
  if (['start', 'end', 'date'].includes(field)) return dates.full(String(value));
  if (field === 'type') return translate(value === 'milestone' ? 'milestone' : 'task');
  return String(value);
}

export function comparePlans(currentInput: unknown, previousInput: unknown, lang = 'en'): Change[] {
  const current = ProjectPlan.from(currentInput);
  const previous = ProjectPlan.from(previousInput);
  const translate = translator(lang);
  const dates = planDates(current, lang);
  if (current.project !== previous.project) throw localizedError('project');
  const oldById = new Map(previous.tasks.map((task) => [task.id, task]));
  const newById = new Map(current.tasks.map((task) => [task.id, task]));
  const changes: Change[] = [];
  for (const task of [...current.tasks, ...previous.tasks.filter((old) => !newById.has(old.id))]) {
    const before = oldById.get(task.id);
    const after = newById.get(task.id);
    const kind = !before ? 'added' : !after ? 'removed' : 'changed';
    const fields =
      before && after
        ? FIELDS.filter((field) => fieldValue(before, field) !== fieldValue(after, field))
        : [];
    if (before && after && before.group === after.group) {
      const shared = (candidate: Item) =>
        candidate.group === task.group &&
        oldById.get(candidate.id)?.group === task.group &&
        newById.get(candidate.id)?.group === task.group;
      const oldOrder = previous.tasks.filter(shared).map((candidate) => candidate.id);
      const newOrder = current.tasks.filter(shared).map((candidate) => candidate.id);
      if (oldOrder.indexOf(task.id) !== newOrder.indexOf(task.id)) fields.push('order');
    }
    if (kind === 'changed' && fields.length === 0) continue;
    const details = fields.map((field) => {
      if (field === 'order') return translate('reordered');
      let text = translate('fieldChange', {
        field: translate(`fields.${field}`),
        before: displayValue(fieldValue(before, field), field, translate, dates),
        after: displayValue(fieldValue(after, field), field, translate, dates),
      });
      if (
        ['start', 'end', 'date'].includes(field) &&
        fieldValue(before, field) &&
        fieldValue(after, field)
      ) {
        const delta =
          (dateValue(fieldValue(after, field)) - dateValue(fieldValue(before, field))) / DAY;
        text += translate('dateDelta', { delta: `${delta > 0 ? '+' : ''}${delta}` });
      }
      return text;
    });
    if (kind !== 'changed') {
      details.push(translate(kind === 'added' ? 'addedDetail' : 'removedDetail'));
      details.push(
        task.type === 'milestone'
          ? translate('dateDetail', { date: dates.full(task.date) })
          : translate('periodDetail', { start: dates.full(task.start), end: dates.full(task.end) }),
      );
    }
    changes.push({
      number: changes.length + 1,
      id: task.id,
      name: task.name,
      kind,
      before,
      after,
      fields,
      details,
      note: current.changeNotes.get(task.id) ?? after?.note ?? '',
    });
  }
  return changes;
}

export function resolveTimeUnit(config: { timeUnit?: unknown } = {}) {
  const unit = parseModel(timeUnitSchema, config.timeUnit ?? {});
  return { days: durationDays(unit.duration), label: unit.name };
}

const PALETTE = ['#087F8C', '#4263C7', '#B66A34', '#7256A8', '#448264'];

function escapeXml(value: unknown) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      (
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&apos;',
        }) as Record<string, string>
      )[character],
  );
}

function wrapText(value: unknown, width: number, size: number) {
  const capacity = Math.max(1, Math.floor(width / (size * 0.65)));
  const words = String(value)
    .trim()
    .split(/\s+/)
    .flatMap((word) => {
      const chunks = [];
      for (let offset = 0; offset < word.length; offset += capacity)
        chunks.push(word.slice(offset, offset + capacity));
      return chunks;
    });
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > capacity) {
      lines.push(line);
      line = '';
    }
    line += `${line ? ' ' : ''}${word}`;
  }
  if (line) lines.push(line);
  return lines;
}

function taskStart(task: Item) {
  return task.startTime;
}
function taskEnd(task: Item) {
  return task.endTime;
}
function nextMonth(stamp: number) {
  const date = new Date(stamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}
function localToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function makeTimeline(tasks: Item[], config: Partial<TimelineData> = {}) {
  const timeUnit = resolveTimeUnit(config);
  const origin = dateValue(config.origin, 'timeline.origin');
  const duration = timeUnit.days * DAY;
  const automaticStart = Math.min(origin, ...tasks.map(taskStart));
  const projectEnd = Math.max(...tasks.map(taskEnd));
  const automaticEnd = origin + Math.max(1, Math.ceil((projectEnd - origin) / duration)) * duration;
  const start =
    config.visibleRange?.start === undefined
      ? automaticStart
      : dateValue(config.visibleRange.start);
  const end =
    config.visibleRange?.end === undefined
      ? automaticEnd
      : dateValue(config.visibleRange.end) + DAY;
  if (end <= start) throw localizedError('timeline');
  if (end > dateValue('9999-12-31') + DAY) throw localizedError('range');
  const ticks = [start];
  const segments = [];
  while (ticks[ticks.length - 1] < end) {
    if (ticks.length > 1000) throw localizedError('ticks');
    const stamp = ticks[ticks.length - 1];
    const unitIndex = Math.floor((stamp - origin) / duration);
    const next = Math.min(end, origin + (unitIndex + 1) * duration);
    segments.push({
      start: stamp,
      end: next,
      unit: stamp < origin ? null : unitIndex + 1,
      hidden: !!config.truncateUnits && origin + unitIndex * duration >= projectEnd,
    });
    ticks.push(next);
  }
  return { start, end, ticks, segments, timeUnit, origin };
}

export type Timeline = ReturnType<typeof makeTimeline>;

export function renderSvg(
  currentInput: unknown,
  { previous: previousInput, diff = false, ...options }: RenderOptions = {},
): RenderResult {
  const current = ProjectPlan.from(currentInput);
  const previous = previousInput ? ProjectPlan.from(previousInput) : undefined;
  const lang = options.lang ?? 'en';
  const translate = translator(lang);
  const dates = planDates(current, lang);
  if (diff && !previous) throw localizedError('diff');
  const config = current.timeline ?? {};
  const outputWidth = Number(options.width ?? current.style?.width ?? 1600);
  if (!Number.isFinite(outputWidth) || outputWidth < 1000 || outputWidth > 8000)
    throw localizedError('width');
  const fontScale = Number((current.style?.fontScale ?? '100%').slice(0, -1)) / 100;
  const width = outputWidth / fontScale;
  const theme = options.theme ?? current.style?.theme ?? 'light';
  if (typeof theme !== 'string' || !['light', 'dark'].includes(theme))
    throw localizedError('theme');
  const ink = theme === 'dark' ? '#EDF3F5' : '#192D37';
  const muted = theme === 'dark' ? '#AABAC3' : '#637780';
  const rule = theme === 'dark' ? '#61727C' : '#B6C6CB';
  const orange = theme === 'dark' ? '#FFAA70' : '#BD592E';
  const green = theme === 'dark' ? '#70D6B1' : '#147E62';
  const font = options.font ?? current.style?.font ?? 'Aptos, Segoe UI, sans-serif';
  const allTasks = diff ? [...current.tasks, ...(previous?.tasks ?? [])] : current.tasks;
  const timeline = makeTimeline(allTasks, config);
  const calendar = calendarIntervals(
    options.holidays ?? [],
    timeline,
    options.shadeWeekends ?? false,
  );
  const { timeUnit } = timeline;
  const margin = 48;
  const spacing = {
    short: {
      row: 44,
      padding: 8,
      group: 24,
      groupPadding: 8,
      gap: 4,
      axis: 40,
      legend: 18,
      bottom: 32,
    },
    normal: {
      row: 60,
      padding: 20,
      group: 36,
      groupPadding: 16,
      gap: 12,
      axis: 58,
      legend: 22,
      bottom: 60,
    },
    tall: {
      row: 84,
      padding: 40,
      group: 52,
      groupPadding: 32,
      gap: 20,
      axis: 76,
      legend: 30,
      bottom: 76,
    },
  }[current.style?.height ?? 'normal'];
  const customLeftSide = current.style?.leftSideScale !== undefined;
  const labelWidth =
    current.style.leftSideScale !== undefined
      ? (width * Number(current.style.leftSideScale.slice(0, -1))) / 100
      : Math.min(330, width * 0.25);
  const leftLines = wrapText;
  const plotLeft = margin + labelWidth + 28;
  const plotRight = width - 92;
  const plotWidth = plotRight - plotLeft;
  const minTickWidth = Math.min(
    plotWidth,
    ((timeUnit.days * DAY) / (timeline.end - timeline.start)) * plotWidth,
  );
  if (minTickWidth < 44) throw localizedError('density');
  const mapDate = (stamp: number) =>
    plotLeft + ((stamp - timeline.start) / (timeline.end - timeline.start)) * plotWidth;
  const changes = diff ? comparePlans(current, previous, lang) : [];
  const notesMode = options.notes ?? 'separate';
  if (!['inline', 'separate'].includes(notesMode)) throw localizedError('notes');
  const inlineNotes = diff && notesMode === 'inline';
  const changeById = new Map(changes.map((change) => [change.id, change]));
  const rows = [
    ...current.tasks,
    ...changes.flatMap((change) =>
      change.kind === 'removed' && change.before ? [change.before] : [],
    ),
  ];
  const groups = [...new Set(rows.map((task) => task.group))];
  const titleLines = wrapText(current.title, width - 530, 32);
  const subtitle = diff
    ? `${options.previousLabel ?? previous?.version ?? translate('baseline')}  /  ${options.currentLabel ?? current.version ?? translate('current')}`
    : (current.subtitle ??
      `${translate('roadmap')}  /  ${options.currentLabel ?? current.version ?? current.project}`);
  const displaySubtitle = config.relativeTime
    ? diff
      ? `${translate('baseline')}  /  ${translate('current')}`
      : (current.subtitle ?? translate('roadmap'))
    : subtitle;
  const subtitleLines = wrapText(displaySubtitle, width - 530, 14);
  const dividerY = Math.max(144, 83 + titleLines.length * 37 + subtitleLines.length * 19);
  const today = localToday();
  const markerGroups = new Map<number, Marker>();
  for (const marker of config.markers ?? []) {
    const position = marker.position === 'today' ? today : marker.position;
    const stamp = dateValue(position);
    if (stamp < timeline.start || stamp >= timeline.end) continue;
    const label = marker.label.replaceAll('$position', dates.full(stamp));
    const lines = wrapText(label, (plotWidth - 16) * 0.65, 12);
    const group = markerGroups.get(stamp) ?? { stamp, lines: [], center: 0, left: 0, right: 0 };
    group.lines.push(...lines);
    markerGroups.set(stamp, group);
  }
  const markers = [...markerGroups.values()].sort((first, second) => first.stamp - second.stamp);
  const markerLanes: MarkerLane[] = [];
  for (const marker of markers) {
    const labelWidth = Math.max(...marker.lines.map((value) => Array.from(value).length * 12));
    marker.center = Math.max(
      plotLeft + 8 + labelWidth / 2,
      Math.min(plotRight - 8 - labelWidth / 2, mapDate(marker.stamp)),
    );
    marker.left = marker.center - labelWidth / 2;
    marker.right = marker.center + labelWidth / 2;
    let lane = markerLanes.find((candidate) =>
      candidate.markers.every(
        (other) => marker.left >= other.right + 12 || marker.right + 12 <= other.left,
      ),
    );
    if (!lane) {
      lane = { markers: [], height: 0, offset: 0 };
      markerLanes.push(lane);
    }
    lane.markers.push(marker);
    lane.height = Math.max(lane.height, marker.lines.length * 18 + 10);
    marker.lane = lane;
  }
  let markerHeight = 0;
  for (const lane of markerLanes) {
    lane.offset = markerHeight;
    markerHeight += lane.height;
  }
  const axisY = dividerY + spacing.axis + markerHeight;
  const unitAxisY = axisY + (config.showWeekNumbers ? 24 : 0);
  const axisLabels = timeline.segments.map((segment) => {
    const available = mapDate(segment.end) - mapDate(segment.start);
    return segment.hidden || available < 44 || segment.unit === null
      ? []
      : wrapText(`${timeUnit.label} ${segment.unit}`, available - 12, 12);
  });
  const unitLabelLines = Math.max(1, ...axisLabels.map((lines) => lines.length));
  const unitExtraHeight = (unitLabelLines - 1) * 14;
  const headerLabel = translate('workstream');
  const headerDates = `${dates.full(timeline.start)}  /  ${dates.full(timeline.end - DAY)}`;
  const headerLines = customLeftSide ? wrapText(headerLabel, labelWidth - 10, 11) : [headerLabel];
  const headerDateLines = customLeftSide
    ? wrapText(headerDates, labelWidth - 10, 11)
    : [headerDates];
  const calendarTop =
    unitAxisY +
    64 +
    Math.max(unitExtraHeight, (headerLines.length + headerDateLines.length - 2) * 14);
  let cursorY = calendarTop + (options.holidayLabels ? 24 : 0);
  const layouts: Layout[] = [];
  groups.forEach((group, groupIndex) => {
    if (group !== null) {
      const members = current.style?.groupSummary
        ? current.tasks.filter((task) => task.group === group)
        : [];
      const work = members.filter((task) => task.type !== 'milestone');
      const totalDuration = work.reduce(
        (total, task) => total + taskEnd(task) - taskStart(task),
        0,
      );
      const progress = totalDuration
        ? work.reduce(
            (total, task) => total + (taskEnd(task) - taskStart(task)) * task.progress,
            0,
          ) / totalDuration
        : undefined;
      const summary = members.length
        ? {
            start: Math.min(...members.map(taskStart)),
            end: Math.max(...members.map(taskEnd)),
            progress,
          }
        : undefined;
      const groupLines = leftLines(
        group.toUpperCase(),
        labelWidth - 22 - (progress === undefined ? 0 : 56),
        12,
      );
      const groupHeight = Math.max(spacing.group, groupLines.length * 16 + spacing.groupPadding);
      layouts.push({
        kind: 'group',
        name: group,
        summary,
        lines: groupLines,
        top: cursorY,
        height: groupHeight,
        color: PALETTE[groupIndex % PALETTE.length],
      });
      cursorY += groupHeight;
    }
    for (const task of rows.filter((candidate) => candidate.group === group)) {
      const lines = leftLines(task.name, labelWidth - 10, 16);
      const durationDays = (taskEnd(task) - taskStart(task)) / DAY;
      const duration = durationDays % 7 === 0 ? `${durationDays / 7}w` : `${durationDays}d`;
      const meta =
        task.type === 'milestone'
          ? dates.full(task.date)
          : `${dates.short(task.start)} - ${dates.short(task.end)} (${duration})  /  ${task.progress}%`;
      const fullMeta = `${task.owner ? `${task.owner}  /  ` : ''}${meta}`;
      const metaLines = leftLines(fullMeta, labelWidth - 10, 12);
      const height = Math.max(
        spacing.row,
        task.type === 'milestone' || diff ? 52 : 0,
        lines.length * 20 + metaLines.length * 16 + spacing.padding,
      );
      layouts.push({
        kind: 'task',
        task,
        lines,
        metaLines,
        fullMeta,
        top: cursorY,
        height,
        color: PALETTE[groupIndex % PALETTE.length],
      });
      cursorY += height;
    }
    cursorY += spacing.gap;
  });
  const plotBottom = cursorY - spacing.gap;
  const legendY = cursorY + spacing.legend;
  const notesTop = legendY + 66;
  const noteWidth = (width - margin * 2 - 48) / 2;
  const noteLayouts = [];
  let noteY = notesTop + 48;
  for (let index = 0; index < changes.length; index += 2) {
    let rowHeight = 0;
    for (let column = 0; column < 2 && index + column < changes.length; column++) {
      const change = changes[index + column];
      const nameLines = wrapText(change.name, noteWidth - 52, 16);
      const detailLines = change.details.flatMap((detail) => wrapText(detail, noteWidth - 52, 13));
      const noteLines = change.note ? wrapText(change.note, noteWidth - 52, 14) : [];
      const height =
        27 +
        nameLines.length * 20 +
        detailLines.length * 19 +
        (noteLines.length ? 12 + noteLines.length * 20 : 0) +
        24;
      noteLayouts.push({
        change,
        nameLines,
        detailLines,
        noteLines,
        left: margin + column * (noteWidth + 48),
        top: noteY,
        height,
      });
      rowHeight = Math.max(rowHeight, height);
    }
    noteY += rowHeight;
  }
  const height = inlineNotes
    ? changes.length
      ? noteY + 42
      : notesTop + 85
    : legendY + Math.max(spacing.bottom, diff ? 44 : 0);
  const elements: string[] = [];
  const number = (value: number) => Number(value.toFixed(2));
  const attrs = (properties: Attributes) =>
    Object.entries(properties)
      .map(
        ([key, value]) =>
          `${key}="${escapeXml(typeof value === 'number' ? number(value) : value)}"`,
      )
      .join(' ');
  const shape = (tag: string, properties: Attributes) =>
    elements.push(`<${tag} ${attrs(properties)}/>`);
  const text = (
    value: unknown,
    left: number,
    top: number,
    size = 14,
    fill = ink,
    extra: Attributes = {},
  ) => {
    elements.push(
      `<text ${attrs({ x: left, y: top, 'font-size': size, fill, ...extra })}>${escapeXml(value)}</text>`,
    );
  };
  let leftTextIndex = 0;
  const leftText = (
    value: unknown,
    left: number,
    top: number,
    size: number,
    fill: string,
    extra: Attributes = {},
    available = labelWidth - 10,
    full = value,
  ) => {
    if (!customLeftSide) return text(value, left, top, size, fill, extra);
    const id = `left-text-${leftTextIndex++}`;
    const clipLeft = extra['text-anchor'] === 'end' ? left - available : left;
    elements.push(
      `<defs><clipPath id="${id}"><rect ${attrs({ x: clipLeft, y: top - size, width: Math.max(0, available), height: size * 1.4 })}/></clipPath></defs>`,
    );
    elements.push(`<g clip-path="url(#${id})"><title>${escapeXml(full)}</title>`);
    text(value, left, top, size, fill, extra);
    elements.push('</g>');
  };
  const line = (
    left: number,
    top: number,
    right: number,
    bottom: number,
    color = rule,
    extra: Attributes = {},
  ) =>
    shape('line', {
      x1: left,
      y1: top,
      x2: right,
      y2: bottom,
      stroke: color,
      'stroke-width': 1,
      ...extra,
    });
  const badge = (change: Change, left: number, top: number) => {
    const color = change.kind === 'added' ? green : change.kind === 'removed' ? muted : orange;
    shape('circle', {
      cx: left,
      cy: top,
      r: 15,
      fill: color,
      'fill-opacity': 0.12,
      stroke: color,
      'stroke-width': 1,
    });
    text(
      String(change.number).padStart(2, '0'),
      left,
      top + 4,
      change.number > 99 ? 10 : 12,
      color,
      { 'text-anchor': 'middle', 'font-weight': 700 },
    );
  };

  shape('rect', { x: margin, y: 34, width: 28, height: 4, rx: 2, fill: PALETTE[0] });
  text(translate(diff ? 'reviewHeading' : 'roadmapHeading'), margin + 40, 41, 11, muted, {
    'font-weight': 700,
  });
  titleLines.forEach((value, index) =>
    text(value, margin, 88 + index * 37, 32, ink, { 'font-weight': 700 }),
  );
  subtitleLines.forEach((value, index) =>
    text(value, margin, 114 + (titleLines.length - 1) * 37 + index * 19, 14, muted),
  );
  const milestoneCount = current.tasks.filter((task) => task.type === 'milestone').length;
  const taskCount = current.tasks.length - milestoneCount;
  const completedCount = current.tasks.filter(
    (task) => task.type !== 'milestone' && task.progress === 100,
  ).length;
  const completedMilestones = current.tasks.filter(
    (task) => task.type === 'milestone' && task.completed,
  ).length;
  const work = current.tasks.filter((task) => task.type !== 'milestone');
  const totalDuration = work.reduce((total, task) => total + taskEnd(task) - taskStart(task), 0);
  const progress = totalDuration
    ? work.reduce((total, task) => total + (taskEnd(task) - taskStart(task)) * task.progress, 0) /
      totalDuration
    : undefined;
  const roundedProgress = Math.round(progress ?? 0);
  const progressLabel =
    progress === undefined
      ? 'N/A'
      : progress > 0 && roundedProgress === 0
        ? '<1%'
        : progress < 100 && roundedProgress === 100
          ? '>99%'
          : `${roundedProgress}%`;
  const planEnd = Math.max(...current.tasks.map(taskEnd));
  const planDays = (planEnd - dateValue(config.origin)) / DAY;
  const durationText = (days: number) => (days % 7 === 0 ? `${days / 7}w` : `${days}d`);
  const endDelta = diff ? (planEnd - Math.max(...(previous?.tasks ?? []).map(taskEnd))) / DAY : 0;
  const summaryLeft = width - 395;
  const summary = [
    { key: 'progress', value: progressLabel, label: translate('overallProgress') },
    {
      key: 'completed',
      value: `${completedCount}/${taskCount}`,
      label: translate('completedTasks'),
    },
    {
      key: 'milestones',
      value: `${completedMilestones}/${milestoneCount}`,
      label: translate('milestones'),
    },
    { key: 'duration', value: durationText(planDays), label: translate('planDuration') },
    ...(diff
      ? [
          {
            key: 'endDelta',
            value: `${endDelta > 0 ? '+' : endDelta < 0 ? '-' : ''}${durationText(Math.abs(endDelta))}`,
            label: translate('endDelta'),
            color: endDelta > 0 ? orange : endDelta < 0 ? green : ink,
          },
        ]
      : []),
  ];
  const summaryStep = 360 / summary.length;
  summary.forEach((item, index) => {
    const left = summaryLeft + index * summaryStep;
    if (index) line(left - 12, 56, left - 12, 127, rule, { 'stroke-opacity': 0.5 });
    const valueSize = Math.min(30, (summaryStep - 20) / item.value.length);
    text(item.value, left, 83, valueSize, item.color ?? ink, {
      'font-weight': 600,
      'data-summary': item.key,
    });
    wrapText(item.label, summaryStep - 20, 10).forEach((value, lineIndex) =>
      text(value, left, 103 + lineIndex * 12, 10, muted, { 'font-weight': 700 }),
    );
  });
  line(margin, dividerY, width - margin, dividerY);
  const headerElements = elements.slice();
  elements.push(
    `<defs><clipPath id="timeline-clip"><rect x="${plotLeft}" y="${unitAxisY + 24}" width="${plotWidth}" height="${plotBottom - unitAxisY - 24}"/></clipPath></defs>`,
  );
  headerLines.forEach((value, index) =>
    leftText(value, margin, unitAxisY + 38 + index * 14, 11, muted, { 'font-weight': 700 }),
  );
  headerDateLines.forEach((value, index) =>
    leftText(value, margin, unitAxisY + 56 + (headerLines.length - 1 + index) * 14, 11, muted),
  );
  if (diff)
    text(translate('reference'), width - margin, unitAxisY + 38, 10, muted, {
      'text-anchor': 'middle',
    });

  timeline.ticks.slice(0, -1).forEach((stamp, index) => {
    if (timeline.segments[index].hidden) return;
    const left = mapDate(stamp);
    const right = mapDate(timeline.ticks[index + 1]);
    if (index % 2 === 0)
      shape('rect', {
        x: left,
        y: unitAxisY + 24,
        width: right - left,
        height: plotBottom - unitAxisY - 24,
        fill: PALETTE[0],
        'fill-opacity': theme === 'dark' ? 0.07 : 0.035,
      });
  });
  if (calendar.shading.length) {
    elements.push(
      `<defs><pattern id="nonworking-hatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="${theme === 'dark' ? '#E2E5E8' : '#58616A'}" stroke-width="1" stroke-opacity="${theme === 'dark' ? 0.38 : 0.3}"/></pattern></defs>`,
    );
  }
  for (const interval of calendar.shading) {
    shape('rect', {
      'data-calendar': 'nonworking',
      x: mapDate(interval.start),
      y: unitAxisY + 24,
      width: mapDate(interval.end) - mapDate(interval.start),
      height: plotBottom - unitAxisY - 24,
      fill: 'url(#nonworking-hatch)',
    });
  }
  if (options.holidayLabels) {
    calendar.labels.forEach((interval, index) => {
      const left = mapDate(interval.start) + 4;
      const available = mapDate(interval.end) - mapDate(interval.start) - 8;
      const capacity = Math.floor(available / 11);
      const characters = Array.from(interval.labels.join('; '));
      if (capacity < 4) return;
      const label =
        characters.length <= capacity
          ? characters.join('')
          : `${characters.slice(0, capacity - 3).join('')}...`;
      elements.push(
        `<defs><clipPath id="holiday-label-${index}"><rect x="${number(left)}" y="${calendarTop}" width="${number(available)}" height="24"/></clipPath></defs>`,
      );
      text(label, left, calendarTop + 16, 11, muted, {
        'data-calendar': 'label',
        'clip-path': `url(#holiday-label-${index})`,
      });
    });
  }
  timeline.ticks.slice(0, -1).forEach((stamp, index) => {
    if (timeline.segments[index].hidden) return;
    const left = mapDate(stamp);
    const right = mapDate(timeline.ticks[index + 1]);
    line(left, unitAxisY + 26, left, plotBottom, rule, { 'stroke-opacity': 0.35 });
    const labelLines = axisLabels[index];
    labelLines.forEach((value, lineIndex) =>
      text(
        value,
        (left + right) / 2,
        unitAxisY + 39 + lineIndex * 14,
        minTickWidth < 65 ? 10 : 12,
        ink,
        { 'text-anchor': 'middle', 'font-weight': 600 },
      ),
    );
    if (right - left >= Math.max(44, dates.short(stamp).length * 6 + 12))
      text(dates.short(stamp), (left + right) / 2, unitAxisY + 56 + unitExtraHeight, 10, muted, {
        'text-anchor': 'middle',
      });
  });
  const lastVisibleUnit = timeline.segments.filter((segment) => !segment.hidden).at(-1);
  if (lastVisibleUnit) {
    const right = mapDate(lastVisibleUnit.end);
    line(right, unitAxisY + 26, right, plotBottom, rule, { 'stroke-opacity': 0.35 });
  }
  let monthStart = timeline.start;
  while (monthStart < timeline.end) {
    const relative = config.relativeTime ? relativeMonth(timeline.origin, monthStart) : undefined;
    const end = Math.min(relative ? relative.end : nextMonth(monthStart), timeline.end);
    const left = mapDate(monthStart);
    const right = mapDate(end);
    const monthLabel = relative
      ? relative.index < 0
        ? `${dates.full(monthStart)} / ${dates.full(end - DAY)}`
        : `M${relative.index + 1}`
      : dates.month(monthStart).toLocaleUpperCase(dates.locale);
    if (right - left >= Math.max(65, monthLabel.length * 7 + 16))
      text(monthLabel, left + 8, axisY + 9, 11, muted, { 'font-weight': 700 });
    if (right - left > 8)
      line(left + 4, axisY + 17, right - 4, axisY + 17, rule, {
        'stroke-opacity': 0.6,
        'stroke-width': 4,
      });
    monthStart = end;
  }

  if (config.showWeekNumbers) {
    const weekDuration = 7 * DAY;
    const weekWidth = (weekDuration / (timeline.end - timeline.start)) * plotWidth;
    const stride = Math.max(1, Math.ceil(32 / weekWidth));
    const firstMonday = config.relativeTime
      ? timeline.origin +
        Math.floor((timeline.start - timeline.origin) / weekDuration) * weekDuration
      : timeline.start - ((new Date(timeline.start).getUTCDay() + 6) % 7) * DAY;
    for (let monday = firstMonday; monday < timeline.end; monday += stride * weekDuration) {
      const left = mapDate(Math.max(monday, timeline.start));
      const right = mapDate(Math.min(monday + weekDuration, timeline.end));
      const thursday = new Date(monday + 3 * DAY);
      const year = thursday.getUTCFullYear();
      const yearStart = new Date(thursday);
      yearStart.setUTCMonth(0, 1);
      const week = 1 + Math.floor((thursday.getTime() - yearStart.getTime()) / weekDuration);
      const label = config.relativeTime ? dates.full(monday) : `W${String(week).padStart(2, '0')}`;
      const center = (left + right) / 2;
      const halfWidth = Math.max(12, label.length * 3);
      if (center - halfWidth >= plotLeft && center + halfWidth <= plotRight) {
        text(label, center, axisY + 35, 10, muted, {
          'text-anchor': 'middle',
          'data-calendar': 'week',
          ...(config.relativeTime ? {} : { 'data-week-year': year, 'data-week': week }),
        });
      }
      line(left, axisY + 22, left, axisY + 40, rule, { 'stroke-opacity': 0.35 });
    }
    line(plotLeft, axisY + 43, plotRight, axisY + 43, rule, { 'stroke-opacity': 0.35 });
  }

  const drawTask = (task: Item, center: number, color: string, ghost = false) => {
    if (task.type === 'milestone') {
      if (taskStart(task) < timeline.start || taskStart(task) >= timeline.end) return;
      const left = mapDate(taskStart(task));
      const radius = ghost ? 10 : 8;
      shape('polygon', {
        points: `${left},${center - radius} ${left + radius},${center} ${left},${center + radius} ${left - radius},${center}`,
        fill: ghost || !task.completed ? 'none' : color,
        stroke: ghost ? muted : color,
        'stroke-width': 1.6,
        ...(ghost ? { 'stroke-dasharray': '3 2', 'stroke-opacity': 0.6 } : {}),
      });
      const label = dates.short(task.date);
      const inset = label.length * 3.5 + 4;
      if (!ghost)
        text(
          label,
          Math.max(plotLeft + inset, Math.min(plotRight - inset, left)),
          center - 15,
          11,
          color,
          { 'text-anchor': 'middle', 'font-weight': 600 },
        );
    } else {
      const left = mapDate(taskStart(task));
      const barWidth = mapDate(taskEnd(task)) - left;
      const barHeight = ghost ? 23 : 19;
      shape('rect', {
        x: left,
        y: center - barHeight / 2,
        width: barWidth,
        height: barHeight,
        rx: ghost ? 2 : 4,
        fill: ghost ? 'none' : color,
        'fill-opacity': ghost ? 1 : 0.2,
        stroke: ghost ? muted : color,
        'stroke-width': ghost ? 1.2 : 0.6,
        ...(ghost ? { 'stroke-dasharray': '5 4', 'stroke-opacity': 0.6 } : {}),
      });
      if (!ghost && task.progress > 0)
        shape('rect', {
          x: left,
          y: center - barHeight / 2,
          width: (barWidth * task.progress) / 100,
          height: barHeight,
          rx: Math.min(4, (barWidth * task.progress) / 200),
          fill: color,
        });
    }
  };

  for (const layout of layouts) {
    if (layout.kind === 'group') {
      const groupInset = spacing.groupPadding / 2 + 2;
      const groupBaseline = layout.top + spacing.groupPadding / 2 + 15;
      shape('rect', {
        x: margin,
        y: layout.top + groupInset,
        width: 4,
        height: layout.height - groupInset * 2,
        rx: 2,
        fill: layout.color,
      });
      layout.lines.forEach((value, index) =>
        leftText(
          value,
          margin + 14,
          groupBaseline + index * 16,
          12,
          layout.color,
          { 'font-weight': 700 },
          labelWidth - 22 - (layout.summary?.progress === undefined ? 0 : 56),
          layout.name,
        ),
      );
      const center = layout.top + layout.height / 2;
      if (layout.summary) {
        const { start, end, progress } = layout.summary;
        const left = mapDate(start);
        const right = mapDate(end);
        elements.push('<g clip-path="url(#timeline-clip)">');
        line(left, center, right, center, layout.color, {
          'stroke-width': 4,
          'stroke-opacity': 0.2,
          'data-group-summary': 'span',
        });
        if (progress !== undefined && progress > 0)
          line(left, center, left + ((right - left) * progress) / 100, center, layout.color, {
            'stroke-width': 4,
            'data-group-summary': 'progress',
          });
        elements.push('</g>');
        if (progress !== undefined) {
          const rounded = Math.round(progress);
          const label =
            progress > 0 && rounded === 0
              ? '<1%'
              : progress < 100 && rounded === 100
                ? '>99%'
                : `${rounded}%`;
          leftText(
            label,
            margin + labelWidth - 8,
            groupBaseline,
            12,
            layout.color,
            { 'text-anchor': 'end', 'font-weight': 700, 'data-group-summary': 'label' },
            Math.min(56, labelWidth - 8),
          );
        }
      } else {
        line(
          plotLeft,
          center,
          plotRight,
          center,
          current.style?.groupSummary ? muted : layout.color,
          { 'stroke-opacity': 0.25 },
        );
      }
      continue;
    }
    const { task, top, height: rowHeight, color } = layout;
    const change = changeById.get(task.id);
    const removed = change?.kind === 'removed';
    const textTop =
      top + (rowHeight - layout.lines.length * 20 - layout.metaLines.length * 16) / 2 + 15;
    layout.lines.forEach((value, index) =>
      leftText(
        value,
        margin,
        textTop + index * 20,
        16,
        removed ? muted : ink,
        { 'font-weight': 600, ...(removed ? { 'text-decoration': 'line-through' } : {}) },
        labelWidth - 10,
        task.name,
      ),
    );
    layout.metaLines.forEach((value, index) =>
      leftText(
        value,
        margin,
        textTop + layout.lines.length * 20 + index * 16,
        12,
        muted,
        {},
        labelWidth - 10,
        layout.fullMeta,
      ),
    );
    const center = top + rowHeight / 2;
    const footprintChanged =
      change?.before && change?.after && !change.before.hasSameFootprint(task);
    elements.push('<g clip-path="url(#timeline-clip)">');
    drawTask(task, center, color, removed);
    if (footprintChanged && change?.before) {
      drawTask(change.before, center, muted, true);
      const oldEnd = mapDate(
        change.before.type === 'milestone' ? taskStart(change.before) : taskEnd(change.before),
      );
      const newEnd = mapDate(task.type === 'milestone' ? taskStart(task) : taskEnd(task));
      if (Math.abs(newEnd - oldEnd) > 8) {
        const arrowY = center + 19;
        line(oldEnd, arrowY, newEnd, arrowY, orange, { 'stroke-width': 1.3 });
        const direction = newEnd > oldEnd ? 1 : -1;
        shape('polyline', {
          points: `${newEnd - direction * 5},${arrowY - 3} ${newEnd},${arrowY} ${newEnd - direction * 5},${arrowY + 3}`,
          fill: 'none',
          stroke: orange,
          'stroke-width': 1.3,
        });
      }
    }
    elements.push('</g>');
    if (change) badge(change, width - margin, center);
    line(margin, top + rowHeight, width - margin, top + rowHeight, rule, { 'stroke-opacity': 0.2 });
  }

  for (const marker of markers) {
    const left = mapDate(marker.stamp);
    const color = '#D04F43';
    const offset = marker.lane?.offset ?? 0;
    const bottom = axisY - 26 - offset;
    if (offset)
      line(left, bottom + 4, left, axisY - 16, color, {
        'stroke-opacity': 0.5,
        'data-marker': 'connector',
      });
    marker.lines.forEach((value, index) =>
      text(value, marker.center, bottom - (marker.lines.length - 1 - index) * 18, 12, color, {
        'font-weight': 700,
        'text-anchor': 'middle',
        'data-marker': 'label',
      }),
    );
    shape('polygon', {
      points: `${left - 6},${axisY - 16} ${left + 6},${axisY - 16} ${left},${axisY - 7}`,
      fill: color,
      'data-marker': 'arrow',
    });
    line(left, axisY - 5, left, plotBottom, color, {
      'stroke-width': 1.4,
      'stroke-dasharray': '4 5',
      'stroke-opacity': 0.8,
      'data-marker': 'line',
    });
  }
  shape('rect', {
    x: margin,
    y: legendY - 9,
    width: 26,
    height: 10,
    rx: 2,
    fill: PALETTE[0],
    'fill-opacity': 0.2,
  });
  shape('rect', { x: margin, y: legendY - 9, width: 13, height: 10, rx: 2, fill: PALETTE[0] });
  text(translate('planProgress'), margin + 36, legendY, 12, muted);
  shape('polygon', {
    points: `${margin + 221},${legendY - 10} ${margin + 227},${legendY - 4} ${margin + 221},${legendY + 2} ${margin + 215},${legendY - 4}`,
    fill: ink,
  });
  text(translate('milestone'), margin + 238, legendY, 12, muted);
  if (diff) {
    shape('rect', {
      x: margin + 345,
      y: legendY - 9,
      width: 28,
      height: 10,
      rx: 2,
      fill: 'none',
      stroke: muted,
      'stroke-dasharray': '4 3',
    });
    text(translate('previous'), margin + 383, legendY, 12, muted);
    if (!inlineNotes)
      text(
        changes.length
          ? translate('changeReferences', { count: changes.length })
          : translate('noChanges'),
        width - margin,
        legendY + 26,
        12,
        muted,
        { 'text-anchor': 'end' },
      );
  }
  const notesElementStart = elements.length;
  if (diff) {
    line(margin, notesTop - 20, width - margin, notesTop - 20);
    text(translate('register'), margin, notesTop + 8, 15, ink, { 'font-weight': 700 });
    text(
      translate('references', { count: changes.length }),
      width - margin,
      notesTop + 8,
      12,
      muted,
      { 'text-anchor': 'end' },
    );
    if (!changes.length) text(translate('noChangesDetail'), margin, notesTop + 45, 14, muted);
    for (const note of noteLayouts) {
      const { change, left, top } = note;
      badge(change, left + 15, top + 8);
      const contentLeft = left + 45;
      text(translate(`kind.${change.kind}`), contentLeft, top + 2, 10, muted, {
        'font-weight': 700,
      });
      let baseline = top + 25;
      note.nameLines.forEach((value) => {
        text(value, contentLeft, baseline, 16, ink, { 'font-weight': 600 });
        baseline += 20;
      });
      note.detailLines.forEach((value) => {
        text(value, contentLeft, baseline, 13, muted);
        baseline += 19;
      });
      if (note.noteLines.length) baseline += 10;
      note.noteLines.forEach((value) => {
        text(value, contentLeft, baseline, 14, ink);
        baseline += 20;
      });
      line(contentLeft, top + note.height - 14, left + noteWidth, top + note.height - 14, rule, {
        'stroke-opacity': 0.3,
      });
    }
  }
  const noteElements = elements.splice(notesElementStart);
  if (inlineNotes) elements.push(...noteElements);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" lang="${lang}" xml:lang="${lang}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title chart-description">\n<title id="chart-title">${escapeXml(current.title)}${diff ? ` - ${escapeXml(translate('comparisonTitle'))}` : ''}</title>\n<desc id="chart-description">${escapeXml(translate('chartDescription', { items: current.tasks.length, changes: changes.length, start: dates.full(timeline.start), end: dates.full(timeline.end - DAY) }))}</desc>\n<g font-family="${escapeXml(font)}" letter-spacing="0">\n${elements.join('\n')}\n</g>\n</svg>\n`;
  const notesOffset = dividerY + 48 - notesTop;
  const notesHeight = (changes.length ? noteY + 42 : notesTop + 85) + notesOffset;
  const notesSvg = diff
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" lang="${lang}" xml:lang="${lang}" width="${width}" height="${notesHeight}" viewBox="0 0 ${width} ${notesHeight}" role="img" aria-labelledby="notes-title notes-description">\n<title id="notes-title">${escapeXml(current.title)} - ${escapeXml(translate('registerTitle'))}</title>\n<desc id="notes-description">${escapeXml(translate('notesDescription', { count: changes.length }))}</desc>\n<g font-family="${escapeXml(font)}" letter-spacing="0">\n${headerElements.join('\n')}\n<g transform="translate(0 ${notesOffset})">\n${noteElements.join('\n')}\n</g>\n</g>\n</svg>\n`
    : undefined;
  const scaleViewport = (source: string) =>
    source.replace(
      /(<svg\b[^>]*\bwidth=")[^"]+(" height=")([^"]+)(")/,
      (_, prefix, middle, sourceHeight, suffix) =>
        `${prefix}${outputWidth}${middle}${Number(sourceHeight) * fontScale}${suffix}`,
    );
  return {
    svg: fontScale === 1 ? svg : scaleViewport(svg),
    notesSvg: fontScale === 1 || notesSvg === undefined ? notesSvg : scaleViewport(notesSvg),
    changes,
    width: outputWidth,
    height: height * fontScale,
  };
}

function markdownText(value: unknown) {
  return String(value)
    .replace(/[\\`*_{}[\]<>#|]/g, '\\$&')
    .replace(/\r?\n/g, ' ');
}

export function renderMarkdown(
  currentInput: unknown,
  previousInput: unknown,
  changes: Change[],
  currentLabel?: string,
  previousLabel?: string,
  lang = 'en',
) {
  const current = ProjectPlan.from(currentInput);
  const previous = ProjectPlan.from(previousInput);
  const translate = translator(lang);
  if (current.timeline.relativeTime) {
    currentLabel = translate('current');
    previousLabel = translate('previous');
  }
  const lines = [
    `# ${markdownText(current.title)}: ${translate('registerTitle')}`,
    '',
    `${translate('project')}: ${markdownText(current.project)}`,
    '',
    `${translate('comparison')}: ${markdownText(previousLabel ?? previous.version ?? translate('previous'))} -> ${markdownText(currentLabel ?? current.version ?? translate('current'))}`,
    '',
  ];
  if (!changes.length) lines.push(translate('noChangesDetail'), '');
  for (const change of changes) {
    lines.push(
      `## ${String(change.number).padStart(2, '0')} - ${markdownText(change.name)}`,
      '',
      `ID: ${markdownText(change.id)} | ${translate(`kind.${change.kind}`)}`,
      '',
      ...change.details.map((detail) => `- ${markdownText(detail)}`),
      '',
    );
    if (change.note) lines.push(`**${translate('note')}:** ${markdownText(change.note)}`, '');
  }
  return lines.join('\n');
}
