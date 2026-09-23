import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import {
  dateFormatters,
  languages,
  ProjectPlan,
  planJsonSchema,
  renderSvg,
  renderMarkdown,
} from 'cutegantt';
import type { PlanError } from 'cutegantt';
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
  holidaysDir?: string;
  shadeWeekends?: boolean;
  holidayLabels?: boolean;
  width?: number;
  theme?: string;
  font?: string;
  notes?: string;
  force?: boolean;
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
  if (values.mode !== 'diff') files.push([`${stem}.svg`, renderSvg(current, options).svg]);
  if (needsDiff) {
    const result = renderSvg(current, { ...options, diff: true });
    if ((values.notes ?? 'separate') === 'separate' && result.notesSvg !== undefined)
      files.push([`${stem}.notes.svg`, result.notesSvg]);
    files.push(
      [`${stem}.diff.svg`, result.svg],
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
