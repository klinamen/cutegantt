import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import {
  dateFormatters,
  languages,
  ProjectPlan,
  planJsonSchema,
  renderSvgPages,
  renderMarkdown,
} from 'cutegantt';
import type { PlanError, PaginatedRenderOptions } from 'cutegantt';
import { loadPlan, findPrevious, planStem, loadHolidays } from './plan-files.js';
export { loadPlan, findPrevious, loadHolidays, planStem } from './plan-files.js';

interface CommandOptions {
  schema?: boolean;
  lang: string;
  mode: string;
  previous?: string;
  outDir: string;
  relativeTime?: boolean;
  groupSummary?: boolean;
  header: boolean;
  pageSize: number;
  pages: PaginatedRenderOptions['pages'];
  holidaysDir?: string;
  shadeWeekends?: boolean;
  holidayLabels?: boolean;
  width?: number;
  theme?: string;
  font?: string;
  notes?: string;
  force?: boolean;
}

function parsePageNumber(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed))
    throw new InvalidArgumentError('Expected a non-negative safe integer.');
  return parsed;
}

function parsePages(value: string): PaginatedRenderOptions['pages'] {
  if (/^\d+$/.test(value)) return parsePageNumber(value);
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match)
    throw new InvalidArgumentError('Expected 0, a page number, or an inclusive range p-q.');
  const from = parsePageNumber(match[1]);
  const to = parsePageNumber(match[2]);
  if (from < 1 || to < from)
    throw new InvalidArgumentError(
      'Page ranges must start at 1 or greater and end at or after their start.',
    );
  return { from, to };
}

function createCommand() {
  return new Command('cutegantt')
    .description('Generate beautiful SVG Gantt charts and change reports from JSON or YAML plans.')
    .exitOverride()
    .argument('[input]', 'Plan file (.json, .yaml or .yml); omit with --schema')
    .option('--schema', 'Print JSON Schema instead of rendering a plan')
    .addOption(
      new Option('--lang <language>', 'Language of generated charts, reports and schema')
        .choices(languages)
        .default('en'),
    )
    .addOption(
      new Option('--mode <mode>', 'Rendering mode')
        .choices(['clean', 'diff', 'both'])
        .default('clean'),
    )
    .option(
      '--previous <file>',
      'Baseline plan; otherwise find the lexical predecessor for the same project',
    )
    .option('--out-dir <directory>', 'Output directory', 'output')
    .option('--relative-time', 'Override the plan to show relative dates')
    .option('--no-relative-time', 'Override the plan to show absolute dates')
    .option('--group-summary', 'Show group spans and duration-weighted progress')
    .option('--no-group-summary', 'Hide group summaries')
    .option('--no-header', 'Hide SVG title, subtitle and summary metrics')
    .option(
      '--page-size <count>',
      'Maximum activities per SVG page; 0 disables pagination',
      parsePageNumber,
      0,
    )
    .option(
      '--pages <selection>',
      'Pages to render: 0 for all, p or inclusive p-q (numbered from 1)',
      parsePages,
      0,
    )
    .option('--holidays-dir <directory>', 'Directory of annual JSON/YAML holiday calendars')
    .option('--shade-weekends', 'Shade Saturdays and Sundays')
    .option('--holiday-labels', 'Show holiday labels')
    .option(
      '--width <pixels>',
      'Chart width, from 1000 to 8000 (otherwise use the plan setting)',
      (value) => {
        const width = Number(value);
        if (!Number.isFinite(width) || width < 1000 || width > 8000) {
          throw new InvalidArgumentError('Width must be between 1000 and 8000.');
        }
        return width;
      },
    )
    .addOption(new Option('--theme <theme>', 'Override chart colors').choices(['light', 'dark']))
    .option('--font <family>', 'Override chart font family')
    .addOption(
      new Option('--notes <placement>', 'Change-note placement')
        .choices(['separate', 'inline'])
        .default('separate'),
    )
    .option('--force', 'Overwrite existing output files');
}

export function main(args = process.argv.slice(2)) {
  const command = createCommand();
  try {
    command.parse(args, { from: 'user' });
    const values = command.opts<CommandOptions>();
    if (values.schema) {
      if (
        command.args.length ||
        command.options.some(
          (option) =>
            !['schema', 'lang'].includes(option.attributeName()) &&
            command.getOptionValueSource(option.attributeName()) === 'cli',
        )
      ) {
        throw new Error(
          '--schema accepts only --lang and --help, with no input plan or rendering options.',
        );
      }
      console.log(JSON.stringify(planJsonSchema(values.lang), null, 2));
      return;
    }
    const [input] = command.args;
    if (!input) command.error("error: missing required argument 'input'");
    return generateFiles(values, input);
  } catch (caught) {
    if (caught instanceof CommanderError) {
      if (caught.exitCode === 0) return;
      throw caught;
    }
    const error: PlanError = caught instanceof Error ? caught : new Error(String(caught));
    let message = error.message;
    if (error.path?.length) {
      const field = error.path.reduce<string>(
        (text, part) =>
          typeof part === 'number'
            ? `${text}[${part}]`
            : `${text ? `${text}.` : ''}${String(part)}`,
        '',
      );
      message = `${field}: ${message}`;
    }
    if (error.file) message = `${error.file}: ${message}`;
    command.error(`error: ${message}`, { code: 'cutegantt.error' });
  }
}

function generateFiles(values: CommandOptions, inputFile: string) {
  const input = resolve(inputFile);
  let current = loadPlan(input);
  if (values.groupSummary !== undefined) {
    current = ProjectPlan.from({
      ...current.toJSON(),
      style: { ...current.style, groupSummary: values.groupSummary },
    });
  }
  if (values.relativeTime !== undefined) {
    current = ProjectPlan.from({
      ...current.toJSON(),
      timeline: { ...current.timeline, relativeTime: values.relativeTime },
    });
  }
  const holidays = values.holidaysDir ? loadHolidays(resolve(values.holidaysDir)) : [];
  const needsDiff = values.mode !== 'clean';
  const previousFile = needsDiff
    ? values.previous
      ? resolve(values.previous)
      : findPrevious(input, current)
    : undefined;
  if (previousFile === input) throw new Error('The previous version must be a different file.');
  const previous = previousFile ? loadPlan(previousFile) : undefined;
  const options = {
    header: values.header,
    pageSize: values.pageSize,
    pages: values.pages,
    holidays,
    shadeWeekends: values.shadeWeekends,
    holidayLabels: values.holidayLabels,
    previous,
    width: values.width,
    theme: values.theme,
    font: values.font,
    notes: values.notes,
    lang: values.lang,
    currentLabel: planStem(input),
    previousLabel: previousFile ? planStem(previousFile) : undefined,
  };
  const outputDirectory = resolve(values.outDir);
  const stem = planStem(input);
  const files: [string, string][] = [];
  const pageStem = (page: number) => (values.pageSize ? `${stem}_${page}` : stem);
  if (values.mode !== 'diff') {
    const result = renderSvgPages(current, options);
    for (const page of result.pages) files.push([`${pageStem(page.page)}.svg`, page.svg]);
  }
  if (needsDiff) {
    const result = renderSvgPages(current, { ...options, diff: true });
    if ((values.notes ?? 'separate') === 'separate' && result.notesSvg !== undefined)
      files.push([`${stem}.notes.svg`, result.notesSvg]);
    for (const page of result.pages) files.push([`${pageStem(page.page)}.diff.svg`, page.svg]);
    files.push(
      [
        `${stem}.changes.md`,
        renderMarkdown(
          current,
          previous,
          result.changes,
          options.currentLabel,
          options.previousLabel,
          values.lang,
        ),
      ],
      [
        `${stem}.changes.json`,
        `${JSON.stringify({ language: values.lang, dateLocale: dateFormatters(values.lang, current.dateLocale).locale, project: current.project, current: basename(input), previous: basename(previousFile ?? ''), changes: result.changes }, null, 2)}\n`,
      ],
    );
  }
  for (const [name] of files) {
    if (existsSync(join(outputDirectory, name)) && !values.force)
      throw new Error(`Output already exists: ${name}. Use --force to overwrite.`);
  }
  mkdirSync(outputDirectory, { recursive: true });
  for (const [name, contents] of files) {
    const output = join(outputDirectory, name);
    writeFileSync(output, contents, 'utf8');
    console.log(output);
  }
  if (previousFile) console.log(`Baseline: ${previousFile}`);
}
