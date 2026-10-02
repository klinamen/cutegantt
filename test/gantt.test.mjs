import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { translator, dateFormatters } from 'cutegantt';
import { stringify } from 'yaml';
import { ProjectPlan, Task, Milestone, TimelineConfig, StyleConfig, ChangeNotes } from 'cutegantt';
import { main, loadPlan, loadHolidays, findPrevious } from 'cutegantt-cli';
import { mergeIntervals, calendarIntervals } from 'cutegantt';
import {
  projectPlanSchema,
  projectPlanInputSchema,
  planJsonSchema,
  taskSchema,
  planItemSchema,
} from 'cutegantt';
import { timeUnitSchema, durationDays } from 'cutegantt';
import { resolveTimeUnit } from 'cutegantt';
import {
  dateValue,
  validatePlan,
  comparePlans,
  makeTimeline,
  renderSvg,
  renderSvgPages,
  renderMarkdown,
} from 'cutegantt';

const task = { id: 'build', name: 'Build', start: '2026-09-01', end: '2026-09-30' };
test('CLI version reports its package version without rendering or exiting the caller', (context) => {
  const { version } = JSON.parse(
    readFileSync(new URL('../packages/cutegantt-cli/package.json', import.meta.url), 'utf8'),
  );
  const output = context.mock.method(process.stdout, 'write', () => true);
  assert.equal(main(['--version']), undefined);
  assert.equal(output.mock.calls.map((call) => call.arguments[0]).join(''), `${version}\n`);
  output.mock.restore();
  const directory = mkdtempSync(join(tmpdir(), 'cutegantt-version-'));
  const cli = fileURLToPath(new URL('../packages/cutegantt-cli/dist/cli.js', import.meta.url));
  try {
    for (const args of [['--version'], ['-V'], ['--lang=it', '--version']]) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: directory,
        encoding: 'utf8',
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${version}\n`);
      assert.equal(result.stderr, '');
      assert.deepEqual(readdirSync(directory), []);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Commander provides English help, validates choices and throws without exiting the caller', (context) => {
  const diagnostics = context.mock.method(process.stderr, 'write', () => true);
  for (const [args, code] of [
    [['--unknown'], 'commander.unknownOption'],
    [['--lang'], 'commander.optionMissingArgument'],
    [['--mode'], 'commander.optionMissingArgument'],
    [['--force=true'], 'commander.unknownOption'],
    [['--mode=invalid'], 'commander.invalidArgument'],
    [['--width=NaN'], 'commander.invalidArgument'],
    [['--theme=invalid'], 'commander.invalidArgument'],
    [['--notes=invalid'], 'commander.invalidArgument'],
    [['first.json', 'second.json'], 'commander.excessArguments'],
  ])
    assert.throws(() => main(args), { code });
  assert.throws(() => main(['--schema', '--mode=clean']), { code: 'cutegantt.error' });
  assert.throws(() => main(['--schema', '--no-header']), { code: 'cutegantt.error' });
  assert.throws(() => main(['--schema', '--page-size=0']), { code: 'cutegantt.error' });
  assert.throws(() => main(['--schema', '--pages=0']), { code: 'cutegantt.error' });
  for (const value of ['-1', '1.5', '1e2', '', '9007199254740992']) {
    assert.throws(() => main([`--page-size=${value}`]), { code: 'commander.invalidArgument' });
    assert.throws(() => main([`--pages=${value}`]), { code: 'commander.invalidArgument' });
  }
  for (const value of ['0-0', '0-2', '2-1', '1-', '1,2', '1-2-3'])
    assert.throws(() => main([`--pages=${value}`]), { code: 'commander.invalidArgument' });
  assert.throws(() => main(['--schema', '--no-relative-time']), { code: 'cutegantt.error' });
  assert.throws(() => main(['--schema', '--no-group-summary', '--group-summary']), {
    code: 'cutegantt.error',
  });
  diagnostics.mock.restore();
  const directory = mkdtempSync(join(tmpdir(), 'cutegantt-commander-'));
  const cli = fileURLToPath(new URL('../packages/cutegantt-cli/dist/cli.js', import.meta.url));
  const run = (args) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.ifError(result.error);
    return result;
  };
  try {
    const schema = run(['--schema', '--lang=en', '--lang=it']);
    assert.equal(schema.status, 0, schema.stderr);
    assert.equal(schema.stderr, '');
    assert.deepEqual(JSON.parse(schema.stdout), planJsonSchema('it'));
    const help = run([
      '--help',
      '--schema',
      '--mode=clean',
      '--relative-time',
      '--no-relative-time',
    ]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
    assert.match(help.stdout, /-h, --help/);
    assert.match(help.stdout, /-V, --version/);
    assert.match(help.stdout, /--no-header/);
    assert.match(help.stdout, /--page-size/);
    assert.match(help.stdout, /--pages/);
    assert.match(help.stdout, /choices: "clean", "diff", "both"/);
    assert.equal(run(['-h', '--lang=it']).stdout, run(['--help', '--lang=en']).stdout);
    assert.equal(help.stderr, '');
    assert.equal(run(['--help', '--mode=invalid']).status, 1);
    writeFileSync(
      join(directory, '--plan.json'),
      readFileSync(new URL('./fixtures/atlas-2026-09-18.json', import.meta.url)),
    );
    const rendered = run(['--out-dir=results', '--', '--plan.json']);
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.ok(existsSync(join(directory, 'results/--plan.svg')));
    const invalid = run(['--unknown']);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
    assert.equal(invalid.stderr.trim().split('\n').length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const plan = (tasks, origin = '2026-08-01') =>
  validatePlan({ title: 'Atlas', project: 'atlas', timeline: { origin }, tasks });
const withMarker = (current, label = 'Review / $position', position = '2026-09-18') =>
  validatePlan({
    ...current.toJSON(),
    timeline: { ...current.timeline, markers: [{ position, label }] },
  });

test('left panel wraps long labels and grows rows instead of adding ellipsis', () => {
  const raw = {
    title: 'Panel',
    project: 'panel',
    timeline: { origin: '2026-09-01' },
    style: { leftSideScale: '20%' },
    tasks: [{ ...task, name: 'Implementation' }],
  };
  const result = renderSvg(raw, { width: 1000 });
  assert.match(result.svg, />Implementation<\/text>/);
  const long = renderSvg(
    { ...raw, tasks: [{ ...task, name: 'Implementation and integration' }] },
    { width: 1000 },
  );
  assert.match(long.svg, />Implementation and<\/text>/);
  assert.match(long.svg, />integration<\/text>/);
  assert.doesNotMatch(long.svg, /\.\.\.<\/text>/);
  assert.ok(long.height > result.height);
  assert.match(long.svg, /clip-path="url\(#left-text-/);
});

test('leftSideScale controls panel width independently of font scale and clips wrapped labels', () => {
  const raw = {
    title: 'Panel',
    project: 'panel',
    timeline: { origin: '2026-09-01' },
    tasks: [
      {
        ...task,
        end: '2026-09-07',
        name: 'A very long task name '.repeat(8),
        owner: 'Long owner '.repeat(8),
        group: 'A very long group name '.repeat(8),
      },
      { id: 'release', type: 'milestone', name: 'Release '.repeat(20), date: '2026-09-07' },
    ],
  };
  for (const width of [1000, 1600]) {
    for (const fontScale of ['50%', '100%', '150%']) {
      for (const leftSideScale of ['10%', '22.5%', '50%']) {
        const result = renderSvg(
          { ...raw, style: { leftSideScale, fontScale, height: 'short', groupSummary: true } },
          { width },
        );
        const scale = Number(fontScale.slice(0, -1)) / 100;
        const plotLeft = Number(
          result.svg.match(/<clipPath id="timeline-clip"><rect x="([^"]+)"/)[1],
        );
        assert.ok(
          Math.abs((plotLeft - 76) * scale - (width * Number(leftSideScale.slice(0, -1))) / 100) <
            0.001,
        );
        assert.doesNotMatch(result.svg, /\.\.\.<\/text>/);
        assert.ok(result.svg.includes(`<title>${raw.tasks[0].name.trim()}</title>`));
        assert.match(result.svg, /clip-path="url\(#left-text-/);
        assert.doesNotMatch(result.svg, /NaN|width="-/);
        assert.equal(result.width, width);
        const clips = [
          ...result.svg.matchAll(
            /<clipPath id="left-text-\d+"><rect x="([^"]+)"[^>]*width="([^"]+)"/g,
          ),
        ];
        assert.ok(clips.length > 0);
        for (const clip of clips) assert.ok(Number(clip[1]) + Number(clip[2]) <= plotLeft);
      }
    }
  }
  const base = renderSvg(raw).svg;
  assert.doesNotMatch(base, /left-text-/);
  assert.equal(base, renderSvg({ ...raw, style: {} }).svg);
  for (const leftSideScale of [null, 20, '9%', '51%', '20', 'abc']) {
    assert.throws(
      () => validatePlan({ ...raw, style: { leftSideScale } }),
      (error) => error.path.join('.') === 'style.leftSideScale',
    );
  }
  const parsed = validatePlan({ ...raw, style: { leftSideScale: '22.5%' } });
  assert.equal(validatePlan(JSON.parse(JSON.stringify(parsed))).style.leftSideScale, '22.5%');
  assert.equal(planJsonSchema().properties.style.anyOf[0].properties.leftSideScale.type, 'string');
});

test('truncateUnits hides only units beyond project extent without changing the viewport', () => {
  const current = plan([{ ...task, end: '2026-09-17' }], '2026-09-01');
  const truncated = validatePlan({
    ...current.toJSON(),
    timeline: { ...current.timeline, truncateUnits: true },
  });
  const timeline = makeTimeline(truncated.tasks, truncated.timeline);
  assert.equal(timeline.end, dateValue('2026-09-29'));
  assert.equal(timeline.segments.at(-1).unit, 2);
  assert.equal(timeline.segments.at(-1).end, timeline.end);
  assert.equal(makeTimeline(current.tasks, current.timeline).end, dateValue('2026-09-29'));
  assert.equal(
    renderSvg(current).svg,
    renderSvg({ ...current.toJSON(), timeline: { ...current.timeline, truncateUnits: false } }).svg,
  );
  assert.equal(
    makeTimeline(truncated.tasks, { ...truncated.timeline, visibleRange: { end: '2026-10-05' } })
      .end,
    dateValue('2026-10-06'),
  );
  for (const end of ['2026-09-01', '2026-09-14']) {
    const single = plan([{ ...task, end }], '2026-09-01');
    assert.equal(
      makeTimeline(single.tasks, { ...single.timeline, truncateUnits: true }).end,
      dateValue('2026-09-15'),
    );
  }
  const milestone = plan(
    [{ id: 'release', name: 'Release', type: 'milestone', date: '2026-09-20' }],
    '2026-09-01',
  );
  const previous = plan([{ ...task, end: '2026-09-24' }], '2026-09-01');
  assert.equal(
    makeTimeline([...truncated.tasks, ...milestone.tasks], truncated.timeline).end,
    dateValue('2026-09-29'),
  );
  assert.equal(
    makeTimeline([...truncated.tasks, ...previous.tasks], truncated.timeline).end,
    dateValue('2026-09-29'),
  );
  const extended = validatePlan({
    ...truncated.toJSON(),
    timeline: { ...truncated.timeline, visibleRange: { end: 4 } },
  });
  const extendedTimeline = makeTimeline(extended.tasks, extended.timeline);
  assert.equal(extendedTimeline.end, dateValue('2026-10-27'));
  assert.deepEqual(
    extendedTimeline.segments.map((segment) => segment.hidden),
    [false, false, true, true],
  );
  const svg = renderSvg(extended).svg;
  assert.match(svg, />Sprint 2</);
  assert.doesNotMatch(svg, />Sprint [34]</);
  const untruncated = validatePlan({
    ...extended.toJSON(),
    timeline: { ...extended.timeline, truncateUnits: false },
  });
  assert.match(renderSvg(untruncated).svg, />Sprint 4</);
  assert.equal(makeTimeline(untruncated.tasks, untruncated.timeline).end, extendedTimeline.end);
  const afterProject = makeTimeline(extended.tasks, {
    ...extended.timeline,
    visibleRange: { start: '2026-10-01', end: '2026-10-10' },
  });
  assert.ok(afterProject.segments.every((segment) => segment.hidden));
  assert.doesNotThrow(() => renderSvg(truncated, { previous, diff: true }));
  assert.equal(validatePlan(JSON.parse(JSON.stringify(truncated))).timeline.truncateUnits, true);
  assert.equal(planJsonSchema().properties.timeline.properties.truncateUnits.type, 'boolean');
  for (const truncateUnits of [null, 'true', 1]) {
    assert.throws(
      () => validatePlan({ ...current.toJSON(), timeline: { ...current.timeline, truncateUnits } }),
      (error) => error.path.join('.') === 'timeline.truncateUnits',
    );
  }
});

test('pagination preserves grouped row order, global timeline and metrics', () => {
  const items = [
    { ...task, id: 'alpha', name: 'Activity Alpha', group: 'First' },
    { ...task, id: 'beta', name: 'Activity Beta', group: 'Second' },
    {
      id: 'release',
      type: 'milestone',
      name: 'Activity Release',
      date: '2026-10-15',
      group: 'First',
    },
    { ...task, id: 'gamma', name: 'Activity Gamma', group: 'First' },
  ];
  const current = plan(items);
  const previous = plan([
    ...items,
    { ...task, id: 'removed', name: 'Activity Removed', group: 'Second' },
  ]);
  const options = { previous, diff: true };
  const whole = renderSvg(current, options);
  const result = renderSvgPages(current, { ...options, pageSize: 2 });
  assert.equal(result.pageCount, 3);
  assert.deepEqual(result.changes, whole.changes);
  assert.deepEqual(
    result.pages.map((page) =>
      [...page.svg.matchAll(/>(Activity [^<]+)<\/text>/g)].map((match) => match[1]),
    ),
    [
      ['Activity Alpha', 'Activity Release'],
      ['Activity Gamma', 'Activity Beta'],
      ['Activity Removed'],
    ],
  );
  const summary = (svg) =>
    [...svg.matchAll(/<text[^>]*data-summary="[^"]+"[^>]*>[^<]*<\/text>/g)].map(
      (match) => match[0],
    );
  for (const page of result.pages) {
    assert.deepEqual(summary(page.svg), summary(whole.svg));
    assert.equal(
      page.svg.match(/<desc[^>]*>(.*?)<\/desc>/)[1],
      whole.svg.match(/<desc[^>]*>(.*?)<\/desc>/)[1],
    );
    assert.ok(page.height < whole.height);
  }
  assert.equal(renderSvgPages(current, options).pages[0].svg, whole.svg);
  assert.deepEqual(
    renderSvgPages(current, { ...options, pageSize: 2, pages: { from: 2, to: 3 } }).pages,
    result.pages.slice(1),
  );
  assert.deepEqual(
    renderSvgPages(current, { ...options, pageSize: 2, pages: 3 }).pages,
    result.pages.slice(2),
  );
});

test('pagination validates sizes and ranges and preserves unpaginated output', () => {
  const current = plan([
    task,
    { ...task, id: 'second', name: 'Second' },
    { ...task, id: 'third', name: 'Third' },
  ]);
  for (const pageSize of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null])
    assert.throws(() => renderSvgPages(current, { pageSize }), /pageSize/);
  for (const pages of [
    -1,
    1.5,
    NaN,
    Infinity,
    4,
    '2',
    null,
    {},
    { from: 0, to: 1 },
    { from: 2, to: 1 },
    { from: 1, to: 4 },
    { from: 1, to: 1.5 },
  ])
    assert.throws(() => renderSvgPages(current, { pageSize: 1, pages }), /pages/);
  assert.throws(() => renderSvgPages(current, { pages: 2 }), /pages/);
  for (const pages of [0, 1, { from: 1, to: 1 }]) {
    const result = renderSvgPages(current, { pages });
    const expected = renderSvg(current);
    assert.equal(result.pageCount, 1);
    assert.deepEqual(result.pages, [
      { page: 1, svg: expected.svg, width: expected.width, height: expected.height },
    ]);
  }
  for (const [pageSize, count] of [
    [1, 3],
    [2, 2],
    [3, 1],
    [100, 1],
    [Number.MAX_SAFE_INTEGER, 1],
  ])
    assert.equal(renderSvgPages(current, { pageSize }).pageCount, count);
});

test('pagination inline notes stay local while the separate register and references stay global', () => {
  const items = Array.from({ length: 3 }, (_, index) => ({
    ...task,
    id: `task-${index}`,
    name: `Work ${index}`,
  }));
  const current = plan(items);
  const previous = plan(
    items.map((item, index) => (index === 1 ? item : { ...item, end: '2026-09-20' })),
  );
  for (const lang of ['en', 'it']) {
    const result = renderSvgPages(current, {
      previous,
      diff: true,
      notes: 'inline',
      pageSize: 1,
      lang,
    });
    assert.deepEqual(
      result.changes.map((change) => change.number),
      [1, 2],
    );
    assert.match(result.pages[0].svg, />01<\/text>/);
    assert.doesNotMatch(result.pages[0].svg, />02<\/text>|>Work 2<\/text>/);
    assert.match(result.pages[2].svg, />02<\/text>/);
    assert.doesNotMatch(result.pages[2].svg, />01<\/text>|>Work 0<\/text>/);
    assert.match(result.pages[1].svg, new RegExp(translator(lang)('noPageChanges')));
    for (const name of ['Work 0', 'Work 2']) assert.ok(result.notesSvg.includes(`>${name}</text>`));
    const selected = renderSvgPages(current, {
      previous,
      diff: true,
      notes: 'inline',
      pageSize: 1,
      pages: 2,
      lang,
    });
    assert.equal(selected.pages[0].svg, result.pages[1].svg);
    for (const name of ['Work 0', 'Work 2'])
      assert.ok(selected.notesSvg.includes(`>${name}</text>`));
    const unchanged = renderSvgPages(current, {
      previous: current,
      diff: true,
      notes: 'inline',
      pageSize: 1,
      lang,
    });
    for (const page of unchanged.pages)
      assert.ok(page.svg.includes(translator(lang)('noChangesDetail')));
  }
});

test('CLI pagination selects original page numbers, preserves reports and validates before writing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cutegantt-pagination-'));
  const cli = fileURLToPath(new URL('../packages/cutegantt-cli/dist/cli.js', import.meta.url));
  const items = Array.from({ length: 4 }, (_, index) => ({
    ...task,
    id: `task-${index}`,
    name: `Work ${index}`,
  }));
  const current = plan(items).toJSON();
  const previous = join(directory, 'previous.json');
  const run = (input, output, args = []) => {
    const result = spawnSync(
      process.execPath,
      [cli, input, '--previous', previous, '--out-dir', output, ...args],
      { encoding: 'utf8' },
    );
    assert.ifError(result.error);
    return result;
  };
  try {
    writeFileSync(
      previous,
      JSON.stringify(
        plan([
          ...items.map((item) => ({ ...item, end: '2026-09-20' })),
          { ...task, id: 'removed', name: 'Removed' },
        ]).toJSON(),
      ),
    );
    for (const extension of ['json', 'yaml']) {
      const input = join(directory, `current.${extension}`);
      const source = extension === 'json' ? JSON.stringify(current) : stringify(current);
      writeFileSync(input, source);
      for (const mode of ['clean', 'diff', 'both']) {
        for (const notes of ['inline', 'separate']) {
          const base = join(directory, `${extension}-${mode}-${notes}`);
          const args = ['--mode', mode, '--notes', notes, '--no-header'];
          const baseline = run(input, base, args);
          assert.equal(baseline.status, 0, baseline.stderr);
          const output = `${base}-paged`;
          const result = run(input, output, [...args, '--page-size', '02', '--pages', '1-2']);
          assert.equal(result.status, 0, result.stderr);
          const expected = [
            ...(mode !== 'diff' ? ['current_1.svg', 'current_2.svg'] : []),
            ...(mode !== 'clean'
              ? [
                  'current_1.diff.svg',
                  'current_2.diff.svg',
                  'current.changes.md',
                  'current.changes.json',
                  ...(notes === 'separate' ? ['current.notes.svg'] : []),
                ]
              : []),
          ];
          assert.deepEqual(readdirSync(output).sort(), expected.sort());
          for (const name of expected.filter((name) => name.endsWith('.svg')))
            assert.doesNotMatch(readFileSync(join(output, name), 'utf8'), /data-summary=/);
          if (mode !== 'clean') {
            for (const suffix of ['changes.md', 'changes.json'])
              assert.equal(
                readFileSync(join(output, `current.${suffix}`), 'utf8'),
                readFileSync(join(base, `current.${suffix}`), 'utf8'),
              );
            if (notes === 'separate')
              assert.match(
                readFileSync(join(output, 'current.notes.svg'), 'utf8'),
                />Removed<\/text>/,
              );
          }
          const second = `${base}-second`;
          assert.equal(run(input, second, [...args, '--page-size=2', '--pages=2']).status, 0);
          assert.ok(
            !existsSync(join(second, 'current_1.svg')) &&
              !existsSync(join(second, 'current_1.diff.svg')),
          );
        }
      }
      assert.equal(readFileSync(input, 'utf8'), source);
      for (const args of [
        ['--pages=2'],
        ['--page-size=1', '--pages=9'],
        ['--mode=both', '--page-size=2', '--pages=3'],
        ['--mode=both', '--page-size=2', '--pages=1-3'],
      ]) {
        const output = join(directory, 'invalid');
        const result = run(input, output, args);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /pages/);
        assert.equal(existsSync(output), false);
      }
      const all = join(directory, `${extension}-all`);
      assert.equal(run(input, all, ['--mode=both', '--page-size=2', '--pages=0']).status, 0);
      assert.ok(existsSync(join(all, 'current_3.diff.svg')));
      assert.equal(existsSync(join(all, 'current_3.svg')), false);
      const single = join(directory, `${extension}-single`);
      assert.equal(run(input, single, ['--page-size=100']).status, 0);
      assert.deepEqual(readdirSync(single), ['current_1.svg']);
      const disabled = join(directory, `${extension}-disabled`);
      assert.equal(run(input, disabled, ['--page-size=0', '--pages=1-1']).status, 0);
      assert.deepEqual(readdirSync(disabled), ['current.svg']);
      const collision = join(directory, `${extension}-collision`);
      mkdirSync(collision);
      writeFileSync(join(collision, 'current_2.svg'), 'existing');
      writeFileSync(join(collision, 'current_9.svg'), 'keep');
      assert.equal(run(input, collision, ['--page-size=2']).status, 1);
      assert.equal(existsSync(join(collision, 'current_1.svg')), false);
      assert.equal(readFileSync(join(collision, 'current_2.svg'), 'utf8'), 'existing');
      assert.equal(run(input, collision, ['--page-size=2', '--pages=2', '--force']).status, 0);
      assert.equal(existsSync(join(collision, 'current_1.svg')), false);
      assert.equal(readFileSync(join(collision, 'current_9.svg'), 'utf8'), 'keep');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('header defaults to enabled and can be removed without losing chart content or accessibility', () => {
  const current = plan([task]);
  const previous = plan([{ ...task, end: '2026-09-20' }]);
  for (const diff of [false, true]) {
    for (const notes of ['inline', 'separate']) {
      const options = { previous, diff, notes };
      const enabled = renderSvg(current, options);
      const hidden = renderSvg(current, { ...options, header: false });
      assert.deepEqual(renderSvg(current, { ...options, header: true }), enabled);
      assert.equal(enabled.height - hidden.height, 144);
      assert.deepEqual(hidden.changes, enabled.changes);
      assert.match(hidden.svg, />Build<\/text>/);
      for (const svg of [hidden.svg, hidden.notesSvg].filter(Boolean)) {
        assert.doesNotMatch(svg, /data-summary=|>Atlas<\/text>/);
        assert.match(svg, /<title id="(?:chart|notes)-title">Atlas/);
        assert.match(svg, /<desc id="(?:chart|notes)-description">/);
        assert.match(svg, /role="img" aria-labelledby=/);
        assert.doesNotMatch(svg, /NaN|undefined/);
      }
      if (diff) {
        const notesHeight = (svg) => Number(svg.match(/viewBox="0 0 [^ ]+ ([^"]+)"/)[1]);
        assert.equal(notesHeight(enabled.notesSvg) - notesHeight(hidden.notesSvg), 144);
      }
    }
  }
});

test('hidden header removes wrapped title space while preserving markers and font scaling', () => {
  for (const fontScale of ['50%', '100%', '150%']) {
    for (const changed of [false, true]) {
      const current = {
        ...withMarker(plan([task])).toJSON(),
        title: 'A long project title '.repeat(10),
        subtitle: 'A long project subtitle '.repeat(5),
        style: { fontScale },
      };
      const previous = { ...current, tasks: [{ ...task, end: changed ? '2026-09-20' : task.end }] };
      for (const notes of ['inline', 'separate']) {
        const options = { previous, diff: true, notes, width: 1000 };
        const enabled = renderSvg(current, options);
        const hidden = renderSvg(current, { ...options, header: false });
        const shortTitle = renderSvg(
          { ...current, title: 'Short', subtitle: 'Short' },
          { ...options, header: false },
        );
        assert.equal(hidden.height, shortTitle.height);
        assert.deepEqual(renderSvg(current, { ...options, header: true }), enabled);
        assert.deepEqual(hidden.changes, enabled.changes);
        assert.match(hidden.svg, /data-marker="label"/);
        const firstMarkerY = (svg) =>
          Number(svg.match(/<text[^>]*y="([^"]+)"[^>]*data-marker="label"/)[1]);
        const removedSpace = firstMarkerY(enabled.svg) - firstMarkerY(hidden.svg);
        assert.ok(removedSpace > 144);
        assert.equal(enabled.height - hidden.height, (removedSpace * parseFloat(fontScale)) / 100);
        const height = (svg) => Number(svg.match(/<svg[^>]*height="([^"]+)"/)[1]);
        assert.equal(
          height(enabled.notesSvg) - height(hidden.notesSvg),
          enabled.height - hidden.height,
        );
        assert.equal(height(hidden.notesSvg), height(shortTitle.notesSvg));
        for (const svg of [hidden.svg, hidden.notesSvg]) {
          assert.doesNotMatch(svg, /data-summary=|>A long project[^<]*<\/text>/);
          assert.doesNotMatch(svg, /NaN|undefined/);
        }
      }
    }
  }
});

test('CLI no-header applies to all SVG outputs and preserves reports and input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cutegantt-header-'));
  const cli = fileURLToPath(new URL('../packages/cutegantt-cli/dist/cli.js', import.meta.url));
  try {
    const previous = join(directory, 'previous.json');
    writeFileSync(previous, JSON.stringify(plan([{ ...task, end: '2026-09-20' }]).toJSON()));
    for (const extension of ['json', 'yaml']) {
      const input = join(directory, `current.${extension}`);
      const raw = plan([task]).toJSON();
      const source = extension === 'json' ? JSON.stringify(raw) : stringify(raw);
      writeFileSync(input, source);
      for (const mode of ['clean', 'diff', 'both']) {
        for (const notes of ['inline', 'separate']) {
          const outputs = [true, false].map((header) => {
            const output = join(directory, `${extension}-${mode}-${notes}-${header}`);
            const result = spawnSync(
              process.execPath,
              [
                cli,
                input,
                '--previous',
                previous,
                '--mode',
                mode,
                '--notes',
                notes,
                '--out-dir',
                output,
                ...(header ? [] : ['--no-header']),
              ],
              { encoding: 'utf8' },
            );
            assert.ifError(result.error);
            assert.equal(result.status, 0, result.stderr);
            const suffixes = [
              ...(mode !== 'diff' ? ['svg'] : []),
              ...(mode !== 'clean'
                ? ['diff.svg', ...(notes === 'separate' ? ['notes.svg'] : [])]
                : []),
            ];
            for (const suffix of suffixes) {
              const svg = readFileSync(join(output, `current.${suffix}`), 'utf8');
              assert.equal(svg.includes('data-summary='), header);
              assert.equal(svg.includes('>Atlas</text>'), header);
              assert.match(svg, /<title id="(?:chart|notes)-title">Atlas/);
            }
            return output;
          });
          if (mode !== 'clean') {
            for (const suffix of ['changes.md', 'changes.json']) {
              assert.equal(
                readFileSync(join(outputs[0], `current.${suffix}`), 'utf8'),
                readFileSync(join(outputs[1], `current.${suffix}`), 'utf8'),
              );
            }
          }
          assert.equal(readFileSync(input, 'utf8'), source);
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('percentage typography preserves defaults and scales chart and notes at fixed width', () => {
  const current = plan([task]);
  const previous = plan([{ ...task, end: '2026-09-20' }]);
  const base = renderSvg(current, { previous, diff: true });
  assert.equal(
    base.svg,
    renderSvg({ ...current.toJSON(), style: { fontScale: '100%' } }, { previous, diff: true }).svg,
  );
  for (const fontScale of ['50%', '90%', '112.5%', '150%']) {
    for (const height of ['short', 'normal', 'tall']) {
      const result = renderSvg(
        { ...current.toJSON(), style: { fontScale, height } },
        { previous, diff: true },
      );
      const scale = Number(fontScale.slice(0, -1)) / 100;
      assert.equal(result.width, 1600);
      for (const svg of [result.svg, result.notesSvg]) {
        const dimensions = svg.match(
          /width="([^"]+)" height="([^"]+)" viewBox="0 0 ([^ ]+) ([^"]+)"/,
        );
        assert.equal(Number(dimensions[1]), 1600);
        assert.ok(Math.abs(Number(dimensions[1]) / Number(dimensions[3]) - scale) < 1e-10);
        assert.ok(Math.abs(Number(dimensions[2]) / Number(dimensions[4]) - scale) < 1e-10);
        assert.doesNotMatch(svg, /NaN|undefined/);
      }
      assert.deepEqual(result.changes, base.changes);
    }
  }
  for (const fontScale of [null, 100, 'small', '0%', '49%', '151%', '100', '-90%']) {
    assert.throws(
      () => ProjectPlan.from({ ...current.toJSON(), style: { fontScale } }),
      (error) => error.path.join('.') === 'style.fontScale',
    );
  }
});

test('vertical density preserves normal layout and adapts to wrapped content and diffs', () => {
  const raw = {
    title: 'Density',
    project: 'density',
    timeline: {
      origin: '2026-09-01',
      markers: [{ position: 1, label: 'Review' }],
      showWeekNumbers: true,
    },
    tasks: [
      { ...task, group: 'Delivery' },
      { id: 'release', name: 'Release', type: 'milestone', date: '2026-09-30', group: 'Delivery' },
    ],
  };
  assert.equal(renderSvg(raw).svg, renderSvg({ ...raw, style: { height: 'normal' } }).svg);
  for (const width of [1000, 1600]) {
    for (const diff of [false, true]) {
      for (const notes of ['inline', 'separate']) {
        const previous = { ...raw, tasks: [{ ...raw.tasks[0], end: '2026-09-20' }] };
        const outputs = ['short', 'normal', 'tall'].map((height) =>
          renderSvg(
            { ...raw, style: { height, groupSummary: true } },
            { width, diff, previous, notes },
          ),
        );
        assert.ok(outputs[0].height < outputs[1].height);
        assert.ok(outputs[1].height < outputs[2].height);
        assert.deepEqual(outputs[0].changes, outputs[2].changes);
        if (diff && notes === 'separate') {
          assert.equal(
            outputs[0].notesSvg.match(/viewBox="([^"]+)"/)[1],
            outputs[2].notesSvg.match(/viewBox="([^"]+)"/)[1],
          );
          assert.deepEqual(
            [...outputs[0].notesSvg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((match) => match[1]),
            [...outputs[2].notesSvg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((match) => match[1]),
          );
        }
        for (const output of outputs) {
          assert.doesNotMatch(output.svg, /NaN|undefined/);
          assert.match(output.svg, /font-size="16"/);
          assert.match(output.svg, /data-marker="label"/);
        }
      }
    }
  }
  const compact = { ...raw, style: { height: 'short' } };
  assert.ok(
    renderSvg({
      ...compact,
      tasks: [{ ...task, name: 'Very long task name '.repeat(15), owner: 'Owner '.repeat(20) }],
    }).height > renderSvg(compact).height,
  );
  for (const height of ['short', 'normal', 'tall']) {
    assert.equal(ProjectPlan.from({ ...raw, style: { height } }).toJSON().style.height, height);
    assert.equal(new StyleConfig({ height }).height, height);
  }
  for (const height of [null, 0, true, 'compact', 'SHORT', '']) {
    assert.throws(
      () => ProjectPlan.from({ ...raw, style: { height } }),
      (error) => error.path.join('.') === 'style.height',
    );
  }
  const style = planJsonSchema().properties.style.anyOf[0];
  assert.deepEqual(style.properties.height.enum, ['short', 'normal', 'tall']);
  assert.match(style.properties.height.description, /density/);
});

test('JSON Schema documents raw inputs, defaults and runtime-only constraints in both languages', () => {
  const english = planJsonSchema();
  const italian = planJsonSchema('it');
  assert.deepEqual(planJsonSchema(), english);
  assert.notEqual(english.description, italian.description);
  assert.equal(english.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual([...english.required].sort(), ['project', 'tasks', 'timeline', 'title']);
  const properties = english.properties;
  const [taskInput, milestoneInput] = properties.tasks.items.anyOf;
  assert.equal(taskInput.properties.type.default, 'task');
  assert.ok(!taskInput.required.includes('type'));
  assert.equal(taskInput.properties.progress.default, 0);
  assert.equal(milestoneInput.properties.completed.default, false);
  assert.ok(milestoneInput.required.includes('type'));
  assert.equal(taskInput.properties.start.anyOf[1].minimum, 1);
  assert.equal(taskInput.properties.start.anyOf[1].maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(properties.timeline.properties.timeUnit.properties.duration.default, '2w');
  assert.equal(properties.timeline.properties.relativeTime.type, 'boolean');
  assert.match(JSON.stringify(properties.timeline.properties.markers), /"const":"today"/);
  assert.deepEqual(properties.today.not, {});
  assert.deepEqual(properties.timeline.properties.start.not, {});
  const inspect = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const property of Object.values(node.properties ?? {})) {
      assert.equal(typeof property.description, 'string');
      assert.ok(property.description.length > 10);
      assert.ok(!property.description.startsWith('schema.'));
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(inspect);
      else if (value && typeof value === 'object') inspect(value);
    }
  };
  inspect(english);
  inspect(italian);
  for (const example of english.examples) {
    assert.ok(projectPlanInputSchema.safeParse(example).success);
    assert.ok(ProjectPlan.from(example));
  }
  const raw = {
    ...english.examples[0],
    style: null,
    changeNotes: null,
    tasks: [
      {
        id: ' build ',
        name: ' Build ',
        start: '01',
        end: 2,
        progress: null,
        owner: 4,
        note: false,
      },
    ],
  };
  const normalized = ProjectPlan.from(raw);
  assert.equal(normalized.tasks[0].start, '2026-08-31');
  assert.equal(normalized.tasks[0].end, '2026-09-27');
  assert.equal(normalized.tasks[0].progress, 0);
  assert.equal(normalized.tasks[0].owner, '');
  assert.equal(normalized.tasks[0].id, 'build');
  for (const start of [0, -1, 1.5, '0', '-1', '1.5']) {
    const invalid = { ...raw, tasks: [{ ...raw.tasks[0], start }] };
    assert.equal(projectPlanInputSchema.safeParse(invalid).success, false);
    assert.equal(projectPlanSchema.safeParse(invalid).success, false);
  }
});

test('CLI JSON Schema is pure JSON without input or filesystem side effects', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-schema-'));
  const cli = fileURLToPath(new URL('../packages/cutegantt-cli/dist/cli.js', import.meta.url));
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8' });
  try {
    for (const lang of ['en', 'it']) {
      const result = run(['--schema', '--lang', lang]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), planJsonSchema(lang));
      assert.ok(result.stdout.endsWith('\n'));
    }
    for (const args of [
      ['missing.json'],
      ['--mode', 'clean'],
      ['--out-dir', 'output'],
      ['--force'],
      ['--relative-time'],
    ]) {
      const result = run(['--schema', '--lang', 'it', ...args]);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /--schema accepts only/);
    }
    assert.notEqual(run(['--schema', '--format', 'yaml']).status, 0);
    assert.notEqual(run(['--schema', '--lang', 'fr']).status, 0);
    const help = run(['--schema', '--help', 'missing.json']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--schema/);
    assert.equal(existsSync(join(directory, 'output')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('showProgress hides generated chart indicators without changing plan data', () => {
  const current = {
    title: 'Visibility',
    project: 'visibility',
    timeline: { origin: '2026-09-01' },
    style: { groupSummary: true },
    tasks: [
      { ...task, group: 'Delivery', progress: 50 },
      { id: 'done', name: 'Release', type: 'milestone', date: '2026-09-30', completed: true },
    ],
  };
  const shown = renderSvg(current).svg;
  assert.equal(
    renderSvg({ ...current, style: { ...current.style, showProgress: true } }).svg,
    shown,
  );
  const hidden = { ...current, style: { ...current.style, showProgress: false } };
  const snapshot = JSON.stringify(hidden);
  const svg = renderSvg(hidden).svg;
  assert.doesNotMatch(
    svg,
    /\d+%|data-summary="(?:progress|completed|milestones)"|Plan \/ progress/,
  );
  assert.doesNotMatch(svg, /data-group-summary="(?:progress|label)"/);
  assert.match(svg, /data-group-summary="span"/);
  assert.match(svg, /data-summary="duration"/);
  assert.match(svg, /<polygon[^>]*fill="none"[^>]*stroke-width="1.6"/);
  assert.doesNotMatch(svg, /<rect[^>]*height="19"[^>]*fill="[^"]+"\/>/);
  assert.equal(JSON.stringify(hidden), snapshot);
  assert.equal(validatePlan(hidden).tasks[0].progress, 50);
  assert.equal(validatePlan(hidden).tasks[1].completed, true);
  for (const showProgress of [null, 'false', 0]) {
    assert.throws(
      () => validatePlan({ ...current, style: { showProgress } }),
      (error) => error.path.join('.') === 'style.showProgress',
    );
  }
});

test('showProgress hides comparison details on every page and preserves raw changes', () => {
  const previous = {
    project: 'visibility',
    title: 'Visibility',
    timeline: { origin: '2026-09-01' },
    tasks: [
      { ...task, progress: 10 },
      { ...task, id: 'only-progress', progress: 10 },
      { id: 'done', name: 'Release', type: 'milestone', date: '2026-09-30', completed: false },
    ],
  };
  const current = {
    ...previous,
    style: { showProgress: false, groupSummary: true },
    tasks: [
      { ...previous.tasks[0], progress: 50, end: '2026-10-07' },
      { ...previous.tasks[1], progress: 100 },
      { ...previous.tasks[2], completed: true },
    ],
  };
  const changes = comparePlans(current, previous);
  assert.equal(changes.length, 3);
  for (const notes of ['inline', 'separate']) {
    for (const header of [true, false]) {
      const result = renderSvgPages(current, { previous, diff: true, pageSize: 1, notes, header });
      assert.deepEqual(result.changes, changes);
      for (const content of [...result.pages.map((page) => page.svg), result.notesSvg]) {
        assert.doesNotMatch(content, /\d+%|Progress:|Completed:|Plan \/ progress/);
        assert.doesNotMatch(content, /data-summary="(?:progress|completed|milestones)"/);
      }
      assert.match(result.notesSvg, /End:/);
      assert.doesNotMatch(result.notesSvg, />Release</);
    }
  }
  const markdown = renderMarkdown(current, previous, changes);
  assert.match(markdown, /End:/);
  assert.doesNotMatch(markdown, /\d+%|Progress:|Completed:|only-progress|Release/);
  const progressOnly = {
    ...current,
    tasks: previous.tasks.map((item) =>
      item.type === 'milestone' ? { ...item, completed: true } : { ...item, progress: 90 },
    ),
  };
  const result = renderSvg(progressOnly, { previous, diff: true });
  assert.equal(result.changes.length, 3);
  assert.match(result.notesSvg, /No changes/);
  assert.match(renderMarkdown(progressOnly, previous, result.changes), /No changes/);
  const annotated = { ...progressOnly, changeNotes: { build: 'User note retained' } };
  assert.match(renderSvg(annotated, { previous, diff: true }).notesSvg, /User note retained/);
});

test('CLI loads showProgress from YAML and JSON while preserving raw reports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-progress-'));
  const cli = fileURLToPath(new URL('../packages/cutegantt-cli/dist/cli.js', import.meta.url));
  try {
    for (const extension of ['yaml', 'json']) {
      const encode = extension === 'json' ? JSON.stringify : stringify;
      const input = join(directory, `current.${extension}`);
      const baseline = join(directory, `previous.${extension}`);
      const previous = {
        title: 'Visibility',
        project: 'visibility',
        timeline: { origin: '2026-09-01', relativeTime: extension === 'yaml' },
        tasks: [{ ...task, progress: 10 }],
      };
      const current = {
        ...previous,
        style: { showProgress: false },
        tasks: [{ ...task, progress: 60, end: '2026-10-07' }],
      };
      writeFileSync(input, encode(current));
      writeFileSync(baseline, encode(previous));
      const output = join(directory, extension);
      const run = spawnSync(
        process.execPath,
        [cli, input, '--previous', baseline, '--mode', 'both', '--out-dir', output],
        { encoding: 'utf8' },
      );
      assert.equal(run.status, 0, run.stderr);
      for (const suffix of ['svg', 'diff.svg', 'notes.svg', 'changes.md']) {
        const content = readFileSync(join(output, `current.${suffix}`), 'utf8');
        assert.doesNotMatch(content, /\d+%|Progress:|Plan \/ progress/);
        assert.doesNotMatch(content, /data-summary="(?:progress|completed|milestones)"/);
      }
      const report = JSON.parse(readFileSync(join(output, 'current.changes.json'), 'utf8'));
      assert.equal(report.changes[0].after.progress, 60);
      assert.ok(report.changes[0].fields.includes('progress'));
      assert.equal(loadPlan(input).style.showProgress, false);
      assert.equal(readFileSync(input, 'utf8'), encode(current));
    }
    for (const lang of ['en', 'it']) {
      const schema = planJsonSchema(lang).properties.style;
      const fields =
        schema.properties ?? schema.anyOf.find((branch) => branch.properties).properties;
      assert.equal(fields.showProgress.type, 'boolean');
      assert.ok(!fields.showProgress.description.startsWith('schema.'));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('optional group summary uses current duration-weighted progress and full clipped span', () => {
  const raw = {
    title: 'Groups',
    project: 'groups',
    timeline: { origin: '2026-09-01' },
    tasks: [
      { ...task, group: 'Delivery', end: '2026-09-02', progress: 100 },
      {
        ...task,
        id: 'second',
        group: 'Delivery',
        start: '2026-09-03',
        end: '2026-09-08',
        progress: 50,
      },
      { id: 'release', name: 'Release', type: 'milestone', group: 'Delivery', date: '2026-09-10' },
    ],
  };
  const enabled = { ...raw, style: { groupSummary: true } };
  const snapshot = JSON.stringify(enabled);
  assert.equal(renderSvg(raw).svg, renderSvg({ ...raw, style: { groupSummary: false } }).svg);
  for (const theme of ['light', 'dark']) {
    for (const width of [1000, 1600]) {
      const svg = renderSvg(
        {
          ...enabled,
          timeline: {
            ...raw.timeline,
            relativeTime: true,
            visibleRange: { start: '2026-09-05', end: '2026-09-08' },
          },
        },
        { width, theme },
      ).svg;
      assert.match(svg, /data-group-summary="label">63%/);
      const geometry = (kind) => {
        const match = svg.match(
          new RegExp(`<line x1="([\\d.-]+)"[^>]*x2="([\\d.-]+)"[^>]*data-group-summary="${kind}"`),
        );
        return [Number(match[1]), Number(match[2])];
      };
      const [start, end] = geometry('span');
      const [progressStart, progressEnd] = geometry('progress');
      assert.equal(start, progressStart);
      assert.ok(Math.abs((progressEnd - start) / (end - start) - 0.625) < 0.0001);
      assert.ok(start < 48 + Math.min(330, width * 0.25) + 28);
      assert.match(
        svg,
        /<g clip-path="url\(#timeline-clip\)">\n<line[^>]*data-group-summary="span"/,
      );
    }
  }
  for (const [progress, label] of [
    [0, '0%'],
    [100, '100%'],
    [0.1, '&lt;1%'],
    [99.9, '&gt;99%'],
  ]) {
    const svg = renderSvg({ ...enabled, tasks: [{ ...raw.tasks[0], progress }] }).svg;
    assert.ok(svg.includes(`data-group-summary="label">${label}`));
  }
  const milestones = renderSvg({ ...enabled, tasks: [raw.tasks[2]] }).svg;
  assert.match(milestones, /data-group-summary="span"/);
  assert.doesNotMatch(milestones, /data-group-summary="(?:label|progress)"/);
  const previous = { ...raw, tasks: raw.tasks.map((item) => ({ ...item, group: 'Old' })) };
  const diff = renderSvg(enabled, { previous, diff: true });
  assert.equal((diff.svg.match(/data-group-summary="span"/g) ?? []).length, 1);
  assert.match(diff.svg, /data-group-summary="label">63%/);
  assert.doesNotMatch(renderSvg({ ...enabled, tasks: [{ ...task }] }).svg, /data-group-summary/);
  assert.equal(JSON.stringify(enabled), snapshot);
  assert.equal(
    validatePlan(JSON.parse(JSON.stringify(validatePlan(enabled)))).style.groupSummary,
    true,
  );
  for (const groupSummary of [null, 1, 'true'])
    assert.throws(
      () => validatePlan({ ...raw, style: { groupSummary } }),
      (error) => error.path.join('.') === 'style.groupSummary',
    );
});

test('CLI group summary respects JSON and YAML config and the last override', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-group-'));
  const cli = fileURLToPath(new URL('../packages/cutegantt-cli/dist/cli.js', import.meta.url));
  try {
    for (const extension of ['json', 'yaml']) {
      const input = join(directory, `plan.${extension}`);
      for (const [flag, configured, expected] of [
        [null, true, true],
        ['--group-summary', false, true],
        ['--no-group-summary', true, false],
      ]) {
        const raw = {
          title: 'Groups',
          project: 'groups',
          timeline: { origin: '2026-09-01' },
          style: { groupSummary: configured },
          tasks: [{ ...task, group: 'Delivery', progress: 50 }],
        };
        const source = extension === 'json' ? JSON.stringify(raw) : stringify(raw);
        writeFileSync(input, source);
        const output = join(directory, `${extension}-${flag ?? 'default'}`);
        const result = spawnSync(
          process.execPath,
          [cli, input, '--out-dir', output, ...(flag ? [flag] : [])],
          { encoding: 'utf8' },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          readFileSync(join(output, 'plan.svg'), 'utf8').includes('data-group-summary="span"'),
          expected,
        );
        assert.equal(readFileSync(input, 'utf8'), source);
      }
    }
    for (const expected of [false, true]) {
      const flags = expected
        ? ['--no-group-summary', '--group-summary']
        : ['--group-summary', '--no-group-summary'];
      const output = join(directory, `last-${expected}`);
      const result = spawnSync(
        process.execPath,
        [cli, join(directory, 'plan.yaml'), ...flags, '--out-dir', output],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        readFileSync(join(output, 'plan.svg'), 'utf8').includes('data-group-summary="span"'),
        expected,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('milestone diamonds are hollow when pending and filled when completed', () => {
  const milestone = { id: 'release', name: 'Release', type: 'milestone', date: '2026-09-15' };
  const previous = plan([{ ...milestone, date: '2026-09-10', completed: true }]);
  for (const theme of ['light', 'dark']) {
    for (const completed of [undefined, false, true]) {
      for (const diff of [false, true]) {
        const current = plan([{ ...milestone, ...(completed === undefined ? {} : { completed }) }]);
        const svg = renderSvg(current, { theme, previous, diff }).svg;
        const diamonds = [...svg.matchAll(/<polygon[^>]*stroke-width="1\.6"[^>]*\/>/g)].map(
          (match) => match[0],
        );
        assert.equal(diamonds.length, diff ? 2 : 1);
        const fill = diamonds[0].match(/fill="([^"]+)"/)[1];
        const stroke = diamonds[0].match(/stroke="([^"]+)"/)[1];
        assert.equal(fill, completed ? stroke : 'none');
        if (diff) {
          assert.match(diamonds[1], /fill="none"/);
          assert.match(diamonds[1], /stroke-dasharray="3 2"/);
        }
      }
    }
  }
});

test('project progress is duration weighted and milestone completion is explicit', () => {
  const raw = {
    title: 'Summary',
    project: 'summary',
    timeline: { origin: '2026-09-01' },
    tasks: [
      { ...task, end: '2026-09-02', progress: 100 },
      { ...task, id: 'second', start: '2026-09-03', end: '2026-09-08', progress: 50 },
      { id: 'future', name: 'Future', type: 'milestone', date: '2026-10-01', completed: true },
      { id: 'past', name: 'Past', type: 'milestone', date: '2026-09-01' },
    ],
  };
  const current = validatePlan(raw);
  assert.equal(current.tasks[3].completed, false);
  assert.equal(validatePlan(JSON.parse(JSON.stringify(current))).tasks[2].completed, true);
  const previous = validatePlan({
    ...raw,
    tasks: raw.tasks.map((item) => (item.id === 'future' ? { ...item, completed: false } : item)),
  });
  const result = renderSvg(current, { previous, diff: true, lang: 'it', width: 1000 });
  for (const svg of [result.svg, result.notesSvg]) {
    assert.match(svg, /data-summary="progress">63%/);
    assert.match(svg, /data-summary="milestones">1\/2/);
  }
  assert.deepEqual(result.changes[0].fields, ['completed']);
  assert.match(result.changes[0].details[0], /Non completata.*Completata/);
  assert.doesNotMatch(result.svg, /stroke-dasharray="3 2"/);
  for (const completed of [null, 'true', 1])
    assert.throws(
      () => validatePlan({ ...raw, tasks: [{ ...raw.tasks[2], completed }] }),
      (error) => error.path.join('.') === 'tasks.0.completed',
    );
  assert.match(renderSvg({ ...raw, tasks: [raw.tasks[0]] }).svg, /data-summary="milestones">0\/0/);
});

test('summary measures complete plan and signed end shift independently of viewport', () => {
  const current = plan(
    [
      { ...task, start: '2026-09-01', end: '2026-09-07', progress: 100 },
      { ...task, id: 'second', start: '2026-09-08', end: '2026-09-14', progress: 99 },
      { id: 'release', type: 'milestone', name: 'Release', date: '2026-09-21' },
    ],
    '2026-09-01',
  );
  const values = (svg) =>
    Object.fromEntries(
      [...svg.matchAll(/data-summary="([^"]+)">([^<]+)<\/text>/g)].map((match) => [
        match[1],
        match[2],
      ]),
    );
  const expected = { progress: '&gt;99%', completed: '1/2', milestones: '0/1', duration: '3w' };
  assert.deepEqual(values(renderSvg(current).svg), expected);
  for (const theme of ['light', 'dark']) {
    for (const relativeTime of [true, false]) {
      const clipped = validatePlan({
        ...current.toJSON(),
        timeline: {
          ...current.timeline,
          relativeTime,
          visibleRange: { start: '2026-09-03', end: '2026-09-05' },
        },
      });
      assert.deepEqual(
        values(renderSvg(clipped, { theme, width: 1000, lang: 'it' }).svg),
        expected,
      );
    }
  }
  for (const [date, endDelta] of [
    ['2026-09-14', '+1w'],
    ['2026-09-21', '0w'],
    ['2026-09-24', '-3d'],
  ]) {
    const previous = plan([{ id: 'old', type: 'milestone', name: 'Old', date }], '2026-08-01');
    const result = renderSvg(current, { previous, diff: true });
    assert.deepEqual(values(result.svg), { ...expected, endDelta });
    assert.deepEqual(values(result.notesSvg), { ...expected, endDelta });
  }
  const milestoneOnly = plan(
    [{ id: 'only', type: 'milestone', name: 'Only', date: '2026-09-01' }],
    '2026-09-01',
  );
  assert.deepEqual(values(renderSvg(milestoneOnly).svg), {
    progress: 'N/A',
    completed: '0/0',
    milestones: '0/1',
    duration: '1d',
  });
});

test('relative time covers generated dates, anniversary months and pre-origin diffs', () => {
  const raw = {
    title: 'Relative',
    project: 'relative',
    version: '2024-01-31',
    timeline: {
      origin: '2024-01-31',
      relativeTime: true,
      showWeekNumbers: true,
      markers: [{ position: '2024-02-09', label: 'Review $position' }],
    },
    tasks: [
      { id: 'work', name: 'Work', start: 1, end: 6 },
      { id: 'release', name: 'Release', type: 'milestone', date: '2024-02-09' },
    ],
  };
  const current = validatePlan(raw);
  const svg = renderSvg(current, { currentLabel: 'relative-2024-01-31' }).svg;
  assert.match(svg, />M1</);
  assert.match(svg, />M2</);
  assert.match(svg, />M3</);
  assert.match(svg, /Review w2 d3/);
  assert.doesNotMatch(svg, /2024|data-week-year|\d{2}\/\d{2}\//);
  assert.equal(current.tasks[1].date, '2024-02-09');
  for (const [start, end, expected] of [
    ['2024-02-29', '2024-03-30', 'M2'],
    ['2024-03-31', '2024-04-29', 'M3'],
  ]) {
    const clipped = renderSvg({
      ...raw,
      timeline: { ...raw.timeline, visibleRange: { start, end } },
    }).svg;
    assert.match(clipped, new RegExp(`>${expected}<`));
    assert.equal((clipped.match(/>M\d+</g) ?? []).length, 1);
  }
  const previous = validatePlan({
    ...raw,
    timeline: { origin: '2024-01-01' },
    tasks: [{ id: 'work', name: 'Work', start: '2024-01-28', end: '2024-03-01' }],
  });
  const result = renderSvg(current, { previous, diff: true });
  assert.match(result.notesSvg, /-3d/);
  for (const content of [
    result.svg,
    result.notesSvg,
    renderMarkdown(current, previous, result.changes, '2024-02-01', '2024-01-01'),
  ]) {
    assert.doesNotMatch(content, /2024|\d{2}\/\d{2}\//);
  }
  assert.equal(result.changes[0].before.start, '2024-01-28');
  const absolute = { ...raw, timeline: { ...raw.timeline, relativeTime: false } };
  const omitted = { ...absolute, timeline: { ...absolute.timeline } };
  delete omitted.timeline.relativeTime;
  assert.equal(renderSvg(absolute).svg, renderSvg(omitted).svg);
  assert.equal(validatePlan(JSON.parse(JSON.stringify(current))).timeline.relativeTime, true);
  for (const relativeTime of [null, 'true', 1]) {
    assert.throws(
      () => validatePlan({ ...raw, timeline: { ...raw.timeline, relativeTime } }),
      (error) => error.path.join('.') === 'timeline.relativeTime',
    );
  }
});

test('CLI relative time overrides plan for charts and reports without changing ISO data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-relative-'));
  const cli = fileURLToPath(new URL('../packages/cutegantt-cli/dist/cli.js', import.meta.url));
  try {
    for (const extension of ['json', 'yaml']) {
      const input = join(directory, `current-2026-09-19.${extension}`);
      const previous = join(directory, `previous.${extension}`);
      const raw = {
        title: 'Example',
        project: 'example',
        timeline: { origin: '2026-09-01', relativeTime: true },
        tasks: [task],
      };
      const encode = extension === 'json' ? JSON.stringify : stringify;
      writeFileSync(previous, encode({ ...raw, tasks: [{ ...task, end: '2026-09-20' }] }));
      for (const [flag, configured, expected] of [
        [null, true, true],
        ['--relative-time', false, true],
        ['--no-relative-time', true, false],
      ]) {
        writeFileSync(
          input,
          encode({ ...raw, timeline: { ...raw.timeline, relativeTime: configured } }),
        );
        const output = join(directory, `${extension}-${flag ?? 'default'}`);
        const run = spawnSync(
          process.execPath,
          [
            cli,
            input,
            '--mode',
            'both',
            '--previous',
            previous,
            '--out-dir',
            output,
            ...(flag ? [flag] : []),
          ],
          { encoding: 'utf8' },
        );
        assert.equal(run.status, 0, run.stderr);
        for (const suffix of ['svg', 'diff.svg', 'notes.svg', 'changes.md']) {
          const content = readFileSync(join(output, `current-2026-09-19.${suffix}`), 'utf8');
          if (expected) assert.doesNotMatch(content, /2026|\d{2}\/\d{2}\//);
          else assert.match(content, /2026/);
        }
        const report = JSON.parse(
          readFileSync(join(output, 'current-2026-09-19.changes.json'), 'utf8'),
        );
        assert.equal(report.changes[0].after.end, task.end);
      }
    }
    for (const expected of [false, true]) {
      const flags = expected
        ? ['--no-relative-time', '--relative-time']
        : ['--relative-time', '--no-relative-time'];
      const output = join(directory, `last-${expected}`);
      const result = spawnSync(
        process.execPath,
        [cli, join(directory, 'current-2026-09-19.yaml'), ...flags, '--out-dir', output],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      const svg = readFileSync(join(output, 'current-2026-09-19.svg'), 'utf8');
      if (expected) assert.doesNotMatch(svg, /2026/);
      else assert.match(svg, /2026/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('optional ISO week scale preserves defaults and handles year boundaries and clipping', () => {
  const raw = {
    title: 'Weeks',
    project: 'weeks',
    timeline: { origin: '2020-12-28' },
    tasks: [{ id: 'work', name: 'Work', start: 1, end: 2 }],
  };
  const plain = renderSvg(raw);
  assert.doesNotMatch(plain.svg, /data-calendar="week"/);
  assert.equal(
    renderSvg({ ...raw, timeline: { ...raw.timeline, showWeekNumbers: false } }).svg,
    plain.svg,
  );
  const enabled = { ...raw, timeline: { ...raw.timeline, showWeekNumbers: true } };
  for (const theme of ['light', 'dark']) {
    const result = renderSvg(enabled, { theme, width: 1000 });
    assert.match(result.svg, /data-week-year="2020" data-week="53">W53/);
    assert.match(result.svg, /data-week-year="2021" data-week="1">W01/);
    assert.equal(result.height, renderSvg(raw, { theme, width: 1000 }).height + 24);
  }
  const clipped = renderSvg({
    ...enabled,
    timeline: { ...enabled.timeline, visibleRange: { start: '2021-01-01', end: '2021-01-10' } },
  });
  assert.match(clipped.svg, /data-week-year="2020" data-week="53">W53/);
  assert.match(clipped.svg, /data-week-year="2021" data-week="1">W01/);
  const leap = renderSvg({ ...enabled, timeline: { origin: '2024-02-26', showWeekNumbers: true } });
  assert.match(leap.svg, /data-week-year="2024" data-week="9">W09/);
  assert.match(leap.svg, /data-week-year="2024" data-week="10">W10/);
  const custom = renderSvg({
    ...enabled,
    timeline: { ...enabled.timeline, timeUnit: { duration: '5d', name: 'Cycle' } },
  });
  assert.match(custom.svg, /data-week-year="2021" data-week="1">W01/);
  assert.match(custom.svg, /Cycle 1/);
  const diff = renderSvg(enabled, { previous: raw, diff: true });
  assert.deepEqual(diff.changes, []);
  assert.equal(
    diff.notesSvg.match(/viewBox="[^"]+"/)[0],
    renderSvg(raw, { previous: raw, diff: true }).notesSvg.match(/viewBox="[^"]+"/)[0],
  );
  assert.equal(
    validatePlan(JSON.parse(JSON.stringify(validatePlan(enabled)))).timeline.showWeekNumbers,
    true,
  );
  for (const value of ['true', 1, null]) {
    assert.throws(
      () => validatePlan({ ...raw, timeline: { ...raw.timeline, showWeekNumbers: value } }),
      (error) => error.path.join('.') === 'timeline.showWeekNumbers',
    );
  }
  const dense = renderSvg({
    ...enabled,
    timeline: { ...enabled.timeline, timeUnit: { duration: '52w' } },
  });
  const centers = [...dense.svg.matchAll(/<text x="([\d.]+)"[^>]*data-calendar="week"/g)].map(
    (match) => Number(match[1]),
  );
  assert.ok(centers.length > 0 && centers.length < 104);
  centers.slice(1).forEach((center, index) => assert.ok(center - centers[index] >= 31.99));
});

test('milestone unit addresses and marker templates normalize without mutating input', () => {
  const raw = {
    title: 'Atlas',
    project: 'atlas',
    timeline: {
      origin: '2024-02-15',
      markers: [
        { position: '02', label: '$position / $position' },
        { position: 'today', label: 'Now' },
      ],
    },
    tasks: [{ id: 'release', type: 'milestone', name: 'Release', date: 2 }],
  };
  const snapshot = JSON.stringify(raw);
  const current = validatePlan(raw);
  assert.equal(current.tasks[0].date, '2024-02-29');
  assert.equal(current.timeline.markers[0].position, '2024-02-29');
  assert.equal(current.timeline.markers[1].position, 'today');
  assert.equal(current.timeline.markers[0].label, '$position / $position');
  assert.equal(JSON.stringify(raw), snapshot);
  assert.deepEqual(validatePlan(JSON.parse(JSON.stringify(current))).toJSON(), current.toJSON());
  const absolute = validatePlan({ ...raw, tasks: [{ ...raw.tasks[0], date: '2024-02-29' }] });
  assert.deepEqual(comparePlans(current, absolute), []);
  assert.equal(
    validatePlan({ ...raw, tasks: [{ ...raw.tasks[0], date: '02' }] }).tasks[0].date,
    '2024-02-29',
  );
  for (const value of [0, -1, 1.5, null, 'today', ' 2', '2024-02-14', Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => validatePlan({ ...raw, tasks: [{ ...raw.tasks[0], date: value }] }),
      (error) => error.path.join('.') === 'tasks.0.date',
    );
  }
  for (const position of [
    undefined,
    null,
    0,
    -1,
    1.5,
    'tomorrow',
    '2024-02-30',
    Number.MAX_SAFE_INTEGER,
  ]) {
    assert.throws(
      () =>
        validatePlan({
          ...raw,
          timeline: { ...raw.timeline, markers: [{ position, label: 'X' }] },
        }),
      (error) => error.path.join('.') === 'timeline.markers.0.position',
    );
  }
  assert.throws(
    () =>
      validatePlan({
        ...raw,
        timeline: { ...raw.timeline, markers: [{ position: 1, label: '' }] },
      }),
    (error) => error.path.join('.') === 'timeline.markers.0.label',
  );
  assert.throws(() => validatePlan({ ...raw, today: false }), /timeline.markers/);
});

test('markers are explicit, localized, escaped and hidden without changing viewport or diffs', () => {
  const current = plan([task]);
  const empty = renderSvg(current).svg;
  assert.doesNotMatch(empty, /data-marker=/);
  assert.equal(
    renderSvg(validatePlan({ ...current.toJSON(), timeline: { ...current.timeline, markers: [] } }))
      .svg,
    empty,
  );
  for (const position of ['2026-01-01', '2027-01-01']) {
    assert.equal(renderSvg(withMarker(current, 'Hidden', position)).svg, empty);
  }
  const marked = validatePlan({
    ...current.toJSON(),
    dateLocale: 'en-US',
    timeline: {
      ...current.timeline,
      markers: [
        { position: '2026-09-18', label: '<Review> & $position / $position' },
        { position: '2026-09-18', label: 'Same date' },
      ],
    },
  });
  for (const theme of ['light', 'dark']) {
    const svg = renderSvg(marked, { lang: 'it', theme, weekends: true }).svg;
    assert.match(svg, /&lt;Review&gt; &amp; 09\/18\/2026 \/ 09\/18\/2026/);
    assert.equal((svg.match(/data-marker="line"/g) ?? []).length, 1);
    assert.equal((svg.match(/data-marker="label"/g) ?? []).length, 2);
  }
  assert.deepEqual(comparePlans(marked, current), []);
  assert.doesNotMatch(renderSvg(current, { previous: marked, diff: true }).svg, /data-marker=/);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const dynamic = validatePlan({
    title: 'Atlas',
    project: 'atlas',
    timeline: { origin: today, markers: [{ position: 'today', label: '$position' }] },
    tasks: [{ id: 'now', name: 'Now', type: 'milestone', date: 1 }],
  });
  assert.match(renderSvg(dynamic).svg, /data-marker="line"/);
  assert.ok(renderSvg(dynamic).svg.includes(dateFormatters('en').full(today)));
  assert.equal(dynamic.timeline.markers[0].position, 'today');
});

test('marker labels share compact lanes and group coincident dates above one arrow', () => {
  const renderMarkers = (markers, options = {}) =>
    renderSvg(
      {
        title: 'Atlas',
        project: 'atlas',
        timeline: { origin: '2026-08-31', visibleRange: { end: 4 }, markers },
        tasks: [{ ...task, start: 1, end: 4 }],
      },
      options,
    );
  const labels = (svg) =>
    [
      ...svg.matchAll(
        /<text x="([\d.]+)" y="([\d.]+)"[^>]*data-marker="label"[^>]*>(.*?)<\/text>/g,
      ),
    ].map((match) => ({ left: Number(match[1]), top: Number(match[2]), text: match[3] }));
  for (const width of [1000, 1600]) {
    for (const theme of ['light', 'dark']) {
      const options = { width, theme, shadeWeekends: true, holidayLabels: true };
      const first = { position: 1, label: 'Start' };
      const single = renderMarkers([first], options);
      const spaced = renderMarkers([first, { position: 4, label: 'End' }], options);
      assert.equal(spaced.height, single.height);
      assert.equal(labels(spaced.svg)[0].top, labels(spaced.svg)[1].top);
      assert.doesNotMatch(spaced.svg, /data-marker="connector"/);
      const arrowTop = Number(
        single.svg.match(/<polygon points="[\d.]+,([\d.]+)[^"]*"[^>]*data-marker="arrow"/)[1],
      );
      assert.equal(arrowTop - labels(single.svg)[0].top, 10);
      const crowded = renderMarkers(
        [
          { position: 2, label: 'First review' },
          { position: '2026-09-15', label: 'Second review' },
        ],
        options,
      );
      assert.ok(crowded.height > single.height);
      assert.notEqual(labels(crowded.svg)[0].top, labels(crowded.svg)[1].top);
      assert.match(crowded.svg, /data-marker="connector"/);
      const coincident = renderMarkers([first, { ...first, label: 'Also start' }], options);
      assert.equal((coincident.svg.match(/data-marker="arrow"/g) ?? []).length, 1);
      assert.equal(labels(coincident.svg)[1].top - labels(coincident.svg)[0].top, 18);
      assert.equal(labels(coincident.svg)[0].left, labels(coincident.svg)[1].left);
      const long = renderMarkers(
        [{ position: 4, label: 'Long marker label '.repeat(20) }],
        options,
      );
      assert.ok(labels(long.svg).length > 1);
      const plotLeft = 48 + Math.min(330, width * 0.25) + 28;
      for (const label of labels(long.svg)) {
        const halfWidth = Array.from(label.text).length * 6;
        assert.ok(label.left - halfWidth >= plotLeft + 7.99);
        assert.ok(label.left + halfWidth <= width - 99.99);
      }
    }
  }
});

test('JSON and YAML preserve markers and removed today flags are rejected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-markers-'));
  const raw = {
    title: 'Atlas',
    project: 'atlas',
    timeline: { origin: '2026-08-31', markers: [{ position: 2, label: 'Review $position' }] },
    tasks: [{ id: 'release', name: 'Release', type: 'milestone', date: '2' }],
  };
  try {
    const json = join(directory, 'plan.json');
    const yaml = join(directory, 'plan.yaml');
    writeFileSync(json, JSON.stringify(raw));
    writeFileSync(yaml, stringify(raw));
    assert.deepEqual(loadPlan(json).toJSON(), loadPlan(yaml).toJSON());
    for (const flag of ['--today', '--no-today', '--today-label', '--today-color']) {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../packages/cutegantt-cli/dist/cli.js', import.meta.url)),
          json,
          flag,
          '--out-dir',
          join(directory, 'output'),
        ],
        { encoding: 'utf8' },
      );
      assert.notEqual(result.status, 0);
      assert.ok(!existsSync(join(directory, 'output')));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('holiday intervals merge overlaps transitively but not adjacent days', () => {
  const intervals = [
    { start: 5, end: 8, labels: ['First'] },
    { start: 1, end: 4, labels: ['Second'] },
    { start: 3, end: 6, labels: ['First', 'Third'] },
    { start: 8, end: 9, labels: ['Adjacent'] },
  ];
  const snapshot = JSON.stringify(intervals);
  assert.deepEqual(mergeIntervals(intervals), [
    { start: 1, end: 8, labels: ['First', 'Second', 'Third'] },
    { start: 8, end: 9, labels: ['Adjacent'] },
  ]);
  assert.equal(JSON.stringify(intervals), snapshot);
  const timeline = { start: dateValue('2026-12-31'), end: dateValue('2027-01-05') };
  const holidays = [
    { start: '2026-12-30', end: '2027-01-02', label: 'Closure' },
    { start: '2027-01-03', end: '2027-01-03', label: 'Adjacent' },
  ];
  const result = calendarIntervals(holidays, timeline, true);
  assert.equal(result.labels.length, 2);
  assert.equal(result.shading.length, 1);
  assert.equal(result.shading[0].start, timeline.start);
  assert.equal(result.shading[0].end, dateValue('2027-01-04'));
  assert.equal(calendarIntervals([], timeline).shading.length, 0);
  assert.deepEqual(
    calendarIntervals([], { start: dateValue('2026-09-20'), end: dateValue('2026-09-21') }, true)
      .shading,
    [{ start: dateValue('2026-09-20'), end: dateValue('2026-09-21'), labels: [] }],
  );
});

test('holiday directory loads mixed annual files in lexical order and validates fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-holidays-'));
  const holiday = { start: '2026-12-31', end: '2027-01-02', label: 'B' };
  try {
    assert.throws(() => loadHolidays(directory), /No annual/);
    writeFileSync(join(directory, 'b_2026.JSON'), JSON.stringify({ holydays: [holiday] }));
    writeFileSync(
      join(directory, 'a_2026.yaml'),
      stringify({ holydays: [{ ...holiday, label: 'A' }] }),
    );
    writeFileSync(
      join(directory, 'a_2026.json'),
      JSON.stringify({ holydays: [{ ...holiday, label: 'First' }] }),
    );
    writeFileSync(join(directory, 'c_2028.YML'), stringify({ holydays: [] }));
    writeFileSync(join(directory, 'ignored_bad_2026.json'), 'invalid');
    assert.deepEqual(
      loadHolidays(directory).map((entry) => entry.label),
      ['First', 'A', 'B'],
    );
    const invalid = join(directory, 'bad_2026.yaml');
    for (const entry of [
      { ...holiday, label: '' },
      { ...holiday, start: '2026-02-30' },
      { ...holiday, end: '2026-01-01' },
      { start: holiday.start, end: holiday.end, description: 'Old' },
    ]) {
      writeFileSync(invalid, stringify({ holydays: [entry] }));
      assert.throws(
        () => loadHolidays(directory),
        (error) => error.file === invalid && error.path[0] === 'holydays',
      );
    }
    writeFileSync(invalid, 'holydays: []\nholydays: []');
    assert.throws(() => loadHolidays(directory), /Cannot read/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('holiday shading and static labels preserve tasks, notes and viewport', () => {
  const current = plan([{ ...task, progress: 50 }], '2026-09-01');
  const previous = plan([{ ...task, end: '2026-09-20' }], '2026-09-01');
  const options = { previous, diff: true };
  const base = renderSvg(current, options);
  assert.doesNotMatch(base.svg, /data-calendar=/);
  const holidays = [
    { start: '2026-09-02', end: '2026-09-08', label: 'A & B' },
    {
      start: '2026-09-07',
      end: '2026-09-15',
      label: 'A very long closure name that must be truncated',
    },
  ];
  for (const theme of ['light', 'dark']) {
    const shaded = renderSvg(current, { ...options, holidays, theme });
    assert.match(
      shaded.svg,
      /<pattern id="nonworking-hatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate\(45\)"/,
    );
    assert.ok(
      shaded.svg.includes(
        `stroke-width="1" stroke-opacity="${theme === 'dark' ? 0.38 : 0.3}"/></pattern>`,
      ),
    );
    for (const showWeekNumbers of [false, true]) {
      const chart = renderSvg(
        { ...current.toJSON(), timeline: { ...current.timeline, showWeekNumbers } },
        { holidays, theme },
      );
      const clip = chart.svg.match(
        /<clipPath id="timeline-clip"><rect[^>]* y="([^"]+)"[^>]* height="([^"]+)"/,
      );
      const band = chart.svg.match(
        /<rect data-calendar="nonworking"[^>]* y="([^"]+)"[^>]* height="([^"]+)"/,
      );
      assert.ok(clip && band);
      assert.equal(band[1], clip[1]);
      assert.equal(band[2], clip[2]);
    }
    const bands = [...shaded.svg.matchAll(/<rect[^>]*data-calendar="nonworking"[^>]*\/>/g)];
    assert.ok(bands.length > 0);
    for (const [band] of bands) {
      assert.match(band, /fill="url\(#nonworking-hatch\)"/);
      assert.doesNotMatch(band, /fill-opacity/);
    }
    const labeled = renderSvg(current, {
      ...options,
      holidays,
      theme,
      holidayLabels: true,
      shadeWeekends: true,
    });
    assert.equal(labeled.height, shaded.height + 24);
    assert.deepEqual(labeled.changes, shaded.changes);
    assert.deepEqual(
      [...labeled.notesSvg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((match) => match[1]),
      [...shaded.notesSvg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((match) => match[1]),
    );
    assert.equal(
      /viewBox="([^"]+)"/.exec(labeled.notesSvg)[1],
      /viewBox="([^"]+)"/.exec(shaded.notesSvg)[1],
    );
    assert.match(labeled.svg, /data-calendar="label"/);
    assert.match(labeled.svg, /A &amp; B;.*\.\.\./);
    assert.ok(
      labeled.svg.indexOf('data-calendar="nonworking"') < labeled.svg.indexOf('height="19"'),
    );
    assert.equal((labeled.svg.match(/<title\b/g) ?? []).length, 1);
    assert.doesNotMatch(shaded.svg, /data-calendar="label"/);
  }
  const weekends = renderSvg(current, { ...options, shadeWeekends: true, holidayLabels: true });
  assert.match(weekends.svg, /data-calendar="nonworking"/);
  assert.doesNotMatch(weekends.svg, /data-calendar="label"/);
  assert.equal(weekends.height, base.height + 24);
  assert.equal(
    renderSvg(current, {
      ...options,
      holidays: [{ start: '2028-01-01', end: '2028-01-02', label: 'Outside' }],
    }).svg,
    base.svg,
  );
});

test('CLI calendar options work independently and invalid calendars fail before output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-calendar-cli-'));
  try {
    const input = join(directory, 'plan.json');
    writeFileSync(input, JSON.stringify(plan([task])));
    const calendar = join(directory, 'office_2026.yaml');
    writeFileSync(
      calendar,
      stringify({ holydays: [{ start: '2026-09-01', end: '2026-09-14', label: 'Closure' }] }),
    );
    const output = join(directory, 'output');
    const result = spawnSync(
      process.execPath,
      [
        'packages/cutegantt-cli/dist/cli.js',
        input,
        '--holidays-dir',
        directory,
        '--shade-weekends',
        '--holiday-labels',
        '--out-dir',
        output,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(output, 'plan.svg'), 'utf8'), /Closure/);
    writeFileSync(calendar, stringify({ holydays: [{ start: '2026-09-01', end: '2026-09-14' }] }));
    const invalidOutput = join(directory, 'invalid-output');
    const invalid = spawnSync(
      process.execPath,
      [
        'packages/cutegantt-cli/dist/cli.js',
        input,
        '--holidays-dir',
        directory,
        '--lang',
        'it',
        '--out-dir',
        invalidOutput,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /office_2026.yaml.*holydays\[0\]\.label/);
    assert.ok(!existsSync(invalidOutput));
    const weekend = spawnSync(
      process.execPath,
      [
        'packages/cutegantt-cli/dist/cli.js',
        input,
        '--shade-weekends',
        '--out-dir',
        join(directory, 'weekends'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(weekend.status, 0, weekend.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('month label overrides are optional per language and validated when present', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-month-labels-'));
  try {
    mkdirSync(join(directory, 'locales'));
    const dependency = pathToFileURL(createRequire(import.meta.url).resolve('i18next')).href;
    const source = readFileSync(
      new URL('../packages/cutegantt/dist/i18n.js', import.meta.url),
      'utf8',
    )
      .replace("'i18next'", JSON.stringify(dependency))
      .replaceAll('./locales/en.js', './locales/en.mjs')
      .replaceAll('./locales/it.js', './locales/it.mjs');
    const modulePath = join(directory, 'i18n.mjs');
    writeFileSync(modulePath, source);
    writeFileSync(
      join(directory, 'locales/en.mjs'),
      `export default ${JSON.stringify({ monthLabels: Array(12).fill('OVERRIDE') })};`,
    );
    for (const labels of [undefined, [], Array(12).fill(''), [...Array(11).fill('M'), 9], null]) {
      writeFileSync(
        join(directory, 'locales/it.mjs'),
        `export default ${JSON.stringify(labels === undefined ? {} : { monthLabels: labels })};`,
      );
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {dateFormatters} from ${JSON.stringify(pathToFileURL(modulePath).href)}; console.log(dateFormatters('it', 'en-GB').month('2026-09-01'));`,
        ],
        { encoding: 'utf8' },
      );
      if (labels === undefined) {
        assert.equal(result.status, 0, result.stderr);
        const expected = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'UTC',
          calendar: 'gregory',
          numberingSystem: 'latn',
          month: 'short',
          year: 'numeric',
        }).format(Date.UTC(2026, 8, 1));
        assert.equal(result.stdout.trim(), expected);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /monthLabels must contain 12 nonempty strings/);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('month labels follow language without changing date locale or relative months', () => {
  assert.equal(dateFormatters('en', 'en-GB').month('2026-09-01'), 'SEP 2026');
  assert.equal(dateFormatters('it', 'en-GB').month('2026-09-01'), 'SET 2026');
  assert.equal(dateFormatters('it', 'en-US').full('2026-09-23'), '09/23/2026');
  assert.equal(dateFormatters('en', 'en-GB').full('2026-09-23'), '23/09/2026');
  for (const lang of ['en', 'it']) {
    const catalog = JSON.parse(
      readFileSync(new URL(`./fixtures/locales/${lang}.json`, import.meta.url), 'utf8'),
    );
    for (let month = 0; month < 12; month++) {
      assert.equal(
        dateFormatters(lang, 'en-GB').month(Date.UTC(2026, month, 1)),
        `${catalog.monthLabels[month]} 2026`,
      );
    }
  }
  const current = plan([task], '2026-09-01');
  assert.match(renderSvg(current).svg, />SEP 2026</);
  assert.match(renderSvg(current, { lang: 'it' }).svg, />SET 2026</);
  const relative = renderSvg({
    ...current.toJSON(),
    timeline: { ...current.timeline, relativeTime: true },
  }).svg;
  assert.match(relative, />M1</);
  assert.doesNotMatch(relative, />SEP 2026</);
});

test('month labels remain visible on narrow absolute and relative segments', () => {
  for (const relativeTime of [false, true]) {
    const current = {
      project: 'narrow-months',
      title: 'Narrow months',
      version: '2026-01-01',
      timeline: {
        origin: '2026-01-01',
        relativeTime,
        timeUnit: { duration: '90d', name: 'Quarter' },
        visibleRange: { start: '2026-01-01', end: '2027-12-01' },
      },
      tasks: [{ id: 'work', name: 'Work', start: '2026-01-01', end: '2027-12-01' }],
    };
    const { svg } = renderSvg(current, { width: 1000 });
    assert.equal(renderSvg(current, { width: 1000, months: true }).svg, svg);
    const hidden = renderSvg(current, { width: 1000, months: false }).svg;
    const configured = {
      ...current,
      timeline: { ...current.timeline, showMonths: false },
    };
    assert.equal(renderSvg(configured, { width: 1000 }).svg, hidden);
    assert.equal(renderSvg(configured, { width: 1000, months: true }).svg, svg);
    assert.equal(validatePlan(configured).toJSON().timeline.showMonths, false);
    for (const showMonths of [null, 'false', 0]) {
      assert.throws(
        () => validatePlan({ ...current, timeline: { ...current.timeline, showMonths } }),
        (error) => error.path.join('.') === 'timeline.showMonths',
      );
    }
    assert.doesNotMatch(hidden, /stroke-width="4"/);
    assert.match(hidden, />Quarter</);
    for (let month = 0; month < 24; month++) {
      const label = relativeTime
        ? `M${month + 1}`
        : dateFormatters('en', 'en-GB')
            .month(Date.UTC(2026, month, 1))
            .toUpperCase();
      assert.ok(svg.includes(`>${label}</text>`), `Missing month label: ${label}`);
      assert.ok(!hidden.includes(`>${label}</text>`), `Unexpected month label: ${label}`);
    }
  }
});

test('CLI respects month visibility in YAML and JSON and supports no-months overrides', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-months-'));
  const cli = fileURLToPath(new URL('../packages/cutegantt-cli/dist/cli.js', import.meta.url));
  try {
    for (const extension of ['json', 'yaml']) {
      const input = join(directory, `current.${extension}`);
      const encode = extension === 'json' ? JSON.stringify : stringify;
      for (const [showMonths, flags, expected] of [
        [undefined, [], true],
        [false, [], false],
        [true, [], true],
        [true, ['--no-months'], false],
      ]) {
        const current = {
          project: 'months',
          title: 'Months',
          timeline: { origin: '2026-09-01', showMonths, showWeekNumbers: true },
          tasks: [task, { ...task, id: 'second' }],
        };
        writeFileSync(input, encode(current));
        const output = join(directory, `${extension}-${showMonths}-${expected}`);
        const run = spawnSync(
          process.execPath,
          [cli, input, '--out-dir', output, '--page-size', '1', ...flags],
          { encoding: 'utf8' },
        );
        assert.equal(run.status, 0, run.stderr);
        for (const page of [1, 2]) {
          const svg = readFileSync(join(output, `current_${page}.svg`), 'utf8');
          assert.equal(svg.includes('>SEP 2026</text>'), expected);
          assert.match(svg, /data-calendar="week"/);
        }
      }
    }
    const schema = planJsonSchema('en').properties.timeline.properties.showMonths;
    assert.equal(schema.type, 'boolean');
    assert.match(schema.description, /on by default/);
    const run = spawnSync(process.execPath, [cli, '--schema', '--no-months'], {
      encoding: 'utf8',
    });
    assert.notEqual(run.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('date locales default by language and remain independent of translated text', () => {
  assert.equal(dateFormatters('en').locale, 'en-GB');
  assert.equal(dateFormatters('it').locale, 'it-IT');
  const before = plan([task]);
  const after = validatePlan({
    ...before.toJSON(),
    dateLocale: 'en-us',
    tasks: [{ ...task, end: '2026-10-07' }],
  });
  assert.equal(after.dateLocale, 'en-US');
  assert.equal(new ProjectPlan(after).dateLocale, 'en-US');
  const result = renderSvg(withMarker(after, 'OGGI / $position'), {
    previous: before,
    diff: true,
    lang: 'it',
  });
  assert.match(result.svg, /OGGI \/ 09\/18\/2026/);
  assert.match(result.svg, /SET|SEP/);
  assert.match(result.changes[0].details[0], /Fine: 09\/30\/2026 -> 10\/07\/2026/);
  assert.equal(result.changes[0].after.end, '2026-10-07');
  assert.match(
    renderMarkdown(after, before, result.changes, undefined, undefined, 'it'),
    /10\/07\/2026/,
  );
  assert.match(renderSvg(withMarker(before, 'TODAY / $position')).svg, /TODAY \/ 18\/09\/2026/);
  for (const dateLocale of ['', null, 'en_US', 'zz-ZZ', 12]) {
    assert.throws(
      () => validatePlan({ ...before.toJSON(), dateLocale }),
      (error) => error.path.join('.') === 'dateLocale',
    );
  }
  const code =
    'import {dateFormatters} from "cutegantt"; console.log(dateFormatters("it","en-US").full("2024-02-29"));';
  for (const TZ of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      env: { ...process.env, TZ },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '02/29/2024');
  }
});

test('CLI reads dateLocale only from JSON or YAML and reports it without changing ISO data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-locale-'));
  try {
    const raw = { ...plan([task]).toJSON(), dateLocale: 'en-US' };
    const baseline = join(directory, 'before.json');
    writeFileSync(baseline, JSON.stringify({ ...raw, tasks: [{ ...task, end: '2026-09-29' }] }));
    for (const extension of ['json', 'yaml']) {
      const input = join(directory, `current.${extension}`);
      writeFileSync(input, extension === 'json' ? JSON.stringify(raw) : stringify(raw));
      const output = join(directory, extension);
      const result = spawnSync(
        process.execPath,
        [
          'packages/cutegantt-cli/dist/cli.js',
          input,
          '--mode',
          'diff',
          '--previous',
          baseline,
          '--lang',
          'it',
          '--out-dir',
          output,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(readFileSync(join(output, 'current.changes.json'), 'utf8'));
      assert.equal(report.dateLocale, 'en-US');
      assert.equal(report.changes[0].after.end, task.end);
      assert.match(report.changes[0].details[0], /09\/30\/2026/);
    }
    const invalid = join(directory, 'invalid.json');
    writeFileSync(invalid, JSON.stringify({ ...raw, dateLocale: 'en_US' }));
    const result = spawnSync(
      process.execPath,
      [
        'packages/cutegantt-cli/dist/cli.js',
        invalid,
        '--lang',
        'it',
        '--out-dir',
        join(directory, 'invalid'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dateLocale.*supported locale/);
    assert.ok(!existsSync(join(directory, 'invalid')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unit addresses normalize to inclusive dates without changing input or diff', () => {
  const raw = {
    title: 'Atlas',
    project: 'atlas',
    timeline: { origin: '2026-08-31' },
    tasks: [{ ...task, start: 2, end: '02' }],
  };
  const relative = validatePlan(raw);
  const absolute = validatePlan({
    ...raw,
    tasks: [{ ...task, start: '2026-09-14', end: '2026-09-27' }],
  });
  assert.deepEqual(relative, absolute);
  assert.deepEqual(comparePlans(relative, absolute), []);
  assert.equal(raw.tasks[0].start, 2);
  assert.deepEqual(new ProjectPlan(relative), relative);
  assert.equal(renderSvg(relative, {}).svg, renderSvg(absolute, {}).svg);
  const mixed = validatePlan({ ...raw, tasks: [{ ...task, start: '2026-09-15', end: 2 }] });
  assert.equal(mixed.tasks[0].end, '2026-09-27');
  const leap = validatePlan({
    ...raw,
    timeline: { origin: '2024-02-28', timeUnit: { duration: '1d' } },
    tasks: [{ ...task, start: '2', end: 2 }],
  });
  assert.equal(leap.tasks[0].start, '2024-02-29');
  assert.throws(() => new Task({ ...task, start: 1 }));
  const directory = mkdtempSync(join(tmpdir(), 'gantt-address-'));
  try {
    for (const extension of ['json', 'yaml']) {
      const path = join(directory, `plan.${extension}`);
      writeFileSync(path, extension === 'json' ? JSON.stringify(raw) : stringify(raw));
      assert.deepEqual(loadPlan(path), absolute);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('origin and endpoint validation reports precise paths and rejects legacy limits', () => {
  const raw = {
    title: 'Atlas',
    project: 'atlas',
    timeline: { origin: '2026-08-31' },
    tasks: [task],
  };
  for (const timeline of [undefined, null, {}, { origin: null }]) {
    assert.throws(
      () => validatePlan({ ...raw, timeline }),
      (error) => error.path.join('.') === 'timeline.origin',
    );
  }
  for (const field of ['start', 'end']) {
    assert.throws(
      () => validatePlan({ ...raw, timeline: { ...raw.timeline, [field]: '2026-09-01' } }),
      (error) => error.path.join('.') === `timeline.${field}`,
    );
  }
  for (const start of [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER,
    '0',
    '-2',
    '1.5',
    '1e2',
    ' 2 ',
    true,
    null,
    '2026-02-30',
    '2026-08-30',
  ]) {
    assert.throws(
      () => validatePlan({ ...raw, tasks: [{ ...task, start }] }),
      (error) => error.path.join('.') === 'tasks.0.start',
      String(start),
    );
  }
  assert.throws(() => validatePlan({ ...raw, tasks: [{ ...task, start: 3, end: 2 }] }), /precedes/);
  assert.throws(
    () =>
      validatePlan({
        ...raw,
        tasks: [{ id: 'gate', name: 'Gate', type: 'milestone', date: '2026-08-30' }],
      }),
    /origin/,
  );
  assert.throws(
    () =>
      validatePlan({
        ...raw,
        timeline: { ...raw.timeline, visibleRange: { start: '2026-08-30' } },
      }),
    /origin/,
  );
  assert.throws(
    () =>
      validatePlan({ ...raw, timeline: { ...raw.timeline, visibleRange: { start: 3, end: 2 } } }),
    /visible range/,
  );
});

test('visible bounds are independent, exact and preserve anchored numbering', () => {
  const raw = {
    title: 'Atlas',
    project: 'atlas',
    timeline: { origin: '2026-08-31' },
    tasks: [{ ...task, start: 1, end: 4 }],
  };
  const axis = (visibleRange) => {
    const current = validatePlan({ ...raw, timeline: { ...raw.timeline, visibleRange } });
    return makeTimeline(current.tasks, current.timeline);
  };
  assert.deepEqual(axis({}), axis(undefined));
  assert.equal(axis({ start: 2 }).start, dateValue('2026-09-14'));
  assert.equal(axis({ start: 2 }).end, axis().end);
  assert.equal(axis({ end: 2 }).end, dateValue('2026-09-28'));
  assert.equal(axis({ end: 6 }).end, dateValue('2026-11-23'));
  assert.equal(axis({ start: 4 }).segments[0].unit, 4);
  assert.throws(() => axis({ start: 5 }), /visible range/);
  const day = axis({ start: '2026-09-15', end: '2026-09-15' });
  assert.equal(day.end - day.start, 86400000);
  const current = validatePlan({
    ...raw,
    timeline: { ...raw.timeline, visibleRange: { start: '2026-09-13', end: 3 } },
  });
  const svg = renderSvg(current, {}).svg;
  assert.match(svg, /Sprint 2/);
  assert.match(svg, /clip-path="url\(#timeline-clip\)"/);
});

test('baseline resolves its own origin and viewport does not filter changes or notes', () => {
  const raw = {
    title: 'Atlas',
    project: 'atlas',
    tasks: [{ ...task, start: 1, end: 2, progress: 50 }],
  };
  const before = validatePlan({ ...raw, timeline: { origin: '2026-08-01' } });
  const after = validatePlan({ ...raw, timeline: { origin: '2026-09-01' } });
  const timeline = makeTimeline([...after.tasks, ...before.tasks], after.timeline);
  assert.equal(timeline.start, dateValue('2026-08-01'));
  assert.equal(timeline.segments[0].unit, null);
  assert.equal(
    timeline.segments.find((segment) => segment.unit === 1).start,
    dateValue('2026-09-01'),
  );
  const full = renderSvg(after, { previous: before, diff: true });
  assert.doesNotMatch(full.svg, /Sprint (?:0|-\d)/);
  const cropped = validatePlan({
    ...raw,
    timeline: { origin: '2026-09-01', visibleRange: { start: 2, end: 2 } },
  });
  const result = renderSvg(cropped, { previous: before, diff: true });
  assert.deepEqual(result.changes, full.changes);
  assert.equal(result.notesSvg, full.notesSvg);
  assert.match(result.svg, /stroke-dasharray="5 4"/);
});

test('generic time units parse durations, validate names and reject partial or sub-day input', () => {
  for (const [duration, expected] of [
    ['1d', 1],
    ['1w', 7],
    ['5d', 5],
    ['2w', 14],
    ['1w 2d', 9],
    ['1.5w 0.5d', 11],
  ]) {
    assert.equal(durationDays(duration), expected);
    assert.equal(resolveTimeUnit({ timeUnit: { duration, name: 'Cycle' } }).days, expected);
  }
  assert.deepEqual(timeUnitSchema.parse({}), { duration: '2w', name: 'Sprint' });
  for (const duration of [
    '0d',
    '-1w',
    '12h',
    '0.5d',
    '1m',
    '1mo',
    'oops 1w',
    '1w junk',
    '3661d',
    '',
    5,
  ]) {
    assert.equal(timeUnitSchema.safeParse({ duration }).success, false, String(duration));
  }
  assert.equal(timeUnitSchema.safeParse({ name: ' ' }).success, false);
  assert.throws(
    () =>
      validatePlan({
        title: 'Atlas',
        project: 'atlas',
        tasks: [task],
        timeline: { origin: '2026-08-01', timeUnit: { duration: '0d' } },
      }),
    (error) => {
      assert.deepEqual(error.path, ['timeline', 'timeUnit', 'duration']);
      return true;
    },
  );
});

test('time units come exclusively from the input configuration', () => {
  const config = { timeUnit: { duration: '5d', name: 'Cycle' } };
  assert.equal(resolveTimeUnit(config).days, 5);
  for (const field of ['granularity', 'sprintWeeks']) {
    assert.throws(
      () =>
        validatePlan({
          title: 'Atlas',
          project: 'atlas',
          tasks: [task],
          timeline: { origin: '2026-08-01', [field]: field === 'granularity' ? 'month' : 3 },
        }),
      (error) => {
        assert.deepEqual(error.path, ['timeline', field]);
        assert.match(error.message, /timeline.timeUnit/);
        return true;
      },
    );
  }
  const current = validatePlan({
    title: 'Atlas',
    project: 'atlas',
    tasks: [task],
    timeline: { origin: '2026-09-01', timeUnit: { duration: '5d', name: 'Cycle & review' } },
  });
  const timeline = makeTimeline(current.tasks, current.timeline);
  assert.equal(timeline.ticks[1] - timeline.ticks[0], 5 * 86400000);
  assert.equal(timeline.ticks.length, 7);
  assert.match(renderSvg(current, {}).svg, /Cycle &amp; review 1/);
  assert.match(renderSvg(current, { lang: 'it' }).svg, /Cycle &amp; review 1/);
  assert.match(
    renderSvg(current, { timeUnitName: 'Day', timeUnit: '1d', width: 3000 }).svg,
    /Cycle &amp; review 1/,
  );
});

test('CLI uses input time units for clean and diff output and rejects timeline flags', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-unit-'));
  try {
    const input = JSON.parse(readFileSync('test/fixtures/atlas-2026-09-18.json', 'utf8'));
    input.timeline.timeUnit = { duration: '1w', name: 'Cycle' };
    const inputPath = join(directory, 'atlas-2026-09-18.json');
    writeFileSync(inputPath, JSON.stringify(input));
    const result = spawnSync(
      process.execPath,
      [
        'packages/cutegantt-cli/dist/cli.js',
        inputPath,
        '--mode',
        'both',
        '--previous',
        'test/fixtures/atlas-2026-09-04.json',
        '--width',
        '2200',
        '--out-dir',
        directory,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const suffix of ['.svg', '.diff.svg']) {
      assert.match(readFileSync(join(directory, `atlas-2026-09-18${suffix}`), 'utf8'), /Cycle 1/);
    }
    for (const flag of ['--granularity', '--sprint-weeks', '--time-unit', '--time-unit-name']) {
      const rejected = spawnSync(
        process.execPath,
        ['packages/cutegantt-cli/dist/cli.js', inputPath, flag, '1w'],
        { encoding: 'utf8' },
      );
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /unknown option/i);
    }
    input.timeline.timeUnit.duration = '12h';
    writeFileSync(inputPath, JSON.stringify(input));
    const invalid = spawnSync(
      process.execPath,
      [
        'packages/cutegantt-cli/dist/cli.js',
        inputPath,
        '--lang',
        'it',
        '--out-dir',
        join(directory, 'invalid'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Duration must use/);
    assert.ok(!existsSync(join(directory, 'invalid')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Zod schemas normalize inputs, strip unknown fields and report structured issues', () => {
  const normalized = projectPlanSchema.parse({
    title: ' Atlas ',
    project: ' atlas ',
    unknown: 'ignored',
    tasks: [{ ...task, name: ' Build ', unknown: true }],
    timeline: { origin: '2026-08-01' },
    style: null,
    changeNotes: null,
  });
  assert.equal(normalized.title, 'Atlas');
  assert.equal(normalized.tasks[0].name, 'Build');
  assert.equal(normalized.tasks[0].type, 'task');
  assert.equal(normalized.tasks[0].progress, 0);
  assert.equal(normalized.tasks[0].group, null);
  assert.ok(!('unknown' in normalized));
  assert.ok(!('unknown' in normalized.tasks[0]));
  assert.ok(!('today' in normalized));
  assert.deepEqual(normalized.timeline, { origin: '2026-08-01' });
  const invalid = projectPlanSchema.safeParse({
    title: 'Atlas',
    project: 'atlas',
    timeline: { origin: '2026-01-01' },
    tasks: [
      { ...task, progress: 101 },
      { ...task, id: 'other', start: '2026-02-30' },
    ],
  });
  assert.equal(invalid.success, false);
  assert.ok(invalid.error.issues.some((issue) => issue.path.join('.') === 'tasks.0.progress'));
  assert.ok(invalid.error.issues.some((issue) => issue.path.join('.') === 'tasks.1.start'));
  assert.throws(
    () => plan([{ ...task, progress: 101 }]),
    (error) => {
      assert.equal(error.translationKey, 'errors.progress');
      assert.deepEqual(error.path, ['tasks', 0, 'progress']);
      assert.ok(error.issues.length);
      assert.equal(error.cause.name, 'ZodError');
      return true;
    },
  );
  assert.throws(
    () => plan([task, task]),
    (error) => {
      assert.deepEqual(error.path, ['tasks', 1, 'id']);
      assert.equal(error.parameters.id, 'build');
      return true;
    },
  );
  assert.equal(taskSchema.safeParse({ ...task, end: '2026-08-01' }).success, false);
  assert.equal(planItemSchema.safeParse({ ...task, type: 'unknown' }).success, false);
});

test('direct model constructors validate through schemas and retain domain methods', () => {
  const item = new Task(task);
  assert.equal(item.progress, 0);
  assert.equal(item.endTime - item.startTime, 30 * 86400000);
  assert.throws(() => new Task({ ...task, progress: -1 }), /progress/);
  assert.throws(() => new Task({ ...task, type: 'milestone' }), /type/);
  assert.throws(
    () => new Milestone({ id: 'gate', name: 'Gate', type: 'milestone', date: '2026-02-30' }),
    /invalid date/,
  );
  assert.throws(() => new ChangeNotes({ build: 123 }), /changeNotes/);
  const original = plan([task]);
  const copy = new ProjectPlan(original);
  assert.deepEqual(copy, original);
  assert.notEqual(copy.tasks[0], original.tasks[0]);
  assert.ok(copy.tasks[0] instanceof Task);
  assert.ok(copy.tasks[0].hasSameFootprint(original.tasks[0]));
});

test('CLI reports English Zod errors with field paths regardless of output language', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-zod-'));
  try {
    const invalid = {
      title: 'Atlas',
      project: 'atlas',
      timeline: { origin: '2026-08-01' },
      tasks: [{ ...task, progress: 101 }],
    };
    for (const extension of ['json', 'yaml']) {
      const file = join(directory, `invalid.${extension}`);
      writeFileSync(file, extension === 'json' ? JSON.stringify(invalid) : stringify(invalid));
      for (const lang of ['en', 'it']) {
        const result = spawnSync(
          process.execPath,
          [
            'packages/cutegantt-cli/dist/cli.js',
            file,
            '--lang',
            lang,
            '--out-dir',
            join(directory, 'out'),
          ],
          { encoding: 'utf8' },
        );
        assert.equal(result.status, 1);
        assert.match(result.stderr, /tasks\[0\]\.progress/);
        assert.match(result.stderr, /progress must be/);
        assert.ok(!existsSync(join(directory, 'out')));
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('application model owns typed items and configurations independently of parsed input', () => {
  const raw = {
    title: 'Atlas',
    project: 'atlas',
    tasks: [task, { id: 'gate', name: 'Gate', type: 'milestone', date: '2026-09-30' }],
    timeline: { origin: '2026-09-01', markers: [{ position: '2026-09-18', label: 'Review' }] },
    style: { width: 1600 },
    changeNotes: { build: 'Original', get: 'Reserved ID' },
  };
  const model = validatePlan(raw);
  assert.ok(model instanceof ProjectPlan);
  assert.ok(model.tasks[0] instanceof Task);
  assert.ok(model.tasks[1] instanceof Milestone);
  assert.ok(model.timeline instanceof TimelineConfig);
  assert.ok(model.style instanceof StyleConfig);
  assert.equal(model.timeline.markers.length, 1);
  assert.ok(model.changeNotes instanceof ChangeNotes);
  assert.equal(model.changeNotes.get('get'), 'Reserved ID');
  assert.equal(model.changeNotes.get('toString'), undefined);
  raw.tasks = [];
  raw.timeline.origin = '2026-08-01';
  raw.style.width = 1200;
  raw.timeline.markers[0].position = '2026-09-19';
  raw.changeNotes.build = 'Changed';
  assert.equal(model.tasks.length, 2);
  assert.equal(model.timeline.origin, '2026-09-01');
  assert.equal(model.style.width, 1600);
  assert.equal(model.timeline.markers[0].position, '2026-09-18');
  assert.equal(model.changeNotes.get('build'), 'Original');
  const restored = validatePlan(JSON.parse(JSON.stringify(model)));
  assert.deepEqual(restored, model);
  assert.ok(restored.tasks[0].hasSameFootprint(model.tasks[0]));
  assert.deepEqual(comparePlans(restored, model), []);
  assert.throws(() => validatePlan({ ...raw, tasks: [task], style: [] }), /Invalid plan/);
});

test('JSON, YAML and YML load equivalent models and generate identical SVGs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-formats-'));
  try {
    const raw = JSON.parse(
      readFileSync(new URL('./fixtures/atlas-2026-09-18.json', import.meta.url), 'utf8'),
    );
    const expected = validatePlan(raw);
    for (const extension of ['json', 'yaml', 'yml', 'YAML', 'JSON']) {
      const file = join(directory, `plan.${extension}`);
      writeFileSync(
        file,
        extension.toLowerCase() === 'json' ? JSON.stringify(raw) : stringify(raw),
      );
      const actual = loadPlan(file);
      assert.ok(actual instanceof ProjectPlan);
      assert.deepEqual(actual, expected);
      assert.equal(renderSvg(actual, {}).svg, renderSvg(expected, {}).svg);
    }
    const file = join(directory, 'unquoted.yaml');
    writeFileSync(
      file,
      'project: atlas\ntitle: Atlas\ntimeline:\n  origin: 2026-08-31\ntasks:\n  - id: build\n    name: Build\n    start: 2026-09-01\n    end: 2026-09-30\n',
    );
    assert.equal(loadPlan(file).tasks[0].start, '2026-09-01');
    for (const invalid of [
      'title: a\ntitle: b',
      'tasks: [',
      '---\na: 1\n---\na: 2',
      'project: atlas\ntitle: Atlas\ntasks: []',
      'project: atlas\ntitle: Atlas\ntasks:\n - id: x\n   name: X\n   start: 2026-02-30\n   end: 2026-09-30',
    ]) {
      writeFileSync(file, invalid);
      assert.throws(() => loadPlan(file));
    }
    assert.throws(() => loadPlan(join(directory, 'plan.txt')), /Unsupported file extension/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mixed-format baseline selection ignores same-version copies and rejects ambiguity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-mixed-'));
  try {
    const raw = {
      title: 'Atlas',
      project: 'atlas',
      timeline: { origin: '2026-08-01' },
      tasks: [task],
    };
    const current = join(directory, 'atlas-003.yaml');
    writeFileSync(current, stringify(raw));
    writeFileSync(join(directory, 'atlas-003.json'), JSON.stringify(raw));
    writeFileSync(join(directory, 'atlas-001.json'), JSON.stringify(raw));
    writeFileSync(join(directory, 'atlas-002.yml'), stringify(raw));
    assert.equal(findPrevious(current), join(directory, 'atlas-002.yml'));
    writeFileSync(join(directory, 'atlas-002.json'), JSON.stringify(raw));
    assert.throws(() => findPrevious(current), /Multiple previous files/);
    rmSync(join(directory, 'atlas-002.json'));
    writeFileSync(join(directory, 'atlas-002.yml'), stringify({ ...raw, tasks: [] }));
    assert.throws(() => findPrevious(current), /at least one item/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI accepts mixed YAML and JSON versions and strips input extensions from output names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-yaml-cli-'));
  try {
    const previous = {
      title: 'Atlas',
      project: 'atlas',
      timeline: { origin: '2026-08-01' },
      tasks: [task],
    };
    const current = { ...previous, tasks: [{ ...task, end: '2026-10-07' }] };
    const beforeFile = join(directory, 'atlas-001.json');
    const afterFile = join(directory, 'atlas-002.YML');
    writeFileSync(beforeFile, JSON.stringify(previous));
    writeFileSync(afterFile, stringify(current));
    const output = join(directory, 'output');
    const args = [
      'packages/cutegantt-cli/dist/cli.js',
      afterFile,
      '--mode',
      'both',
      '--out-dir',
      output,
    ];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const suffix of ['.svg', '.diff.svg', '.notes.svg', '.changes.md', '.changes.json']) {
      assert.ok(existsSync(join(output, `atlas-002${suffix}`)));
    }
    const report = JSON.parse(readFileSync(join(output, 'atlas-002.changes.json'), 'utf8'));
    assert.equal(report.previous, 'atlas-001.json');
    assert.equal(report.current, 'atlas-002.YML');
    assert.equal(report.changes[0].after.end, '2026-10-07');
    const explicit = spawnSync(
      process.execPath,
      [
        'packages/cutegantt-cli/dist/cli.js',
        beforeFile,
        '--previous',
        afterFile,
        '--mode',
        'diff',
        '--notes',
        'inline',
        '--lang',
        'it',
        '--out-dir',
        output,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.match(readFileSync(join(output, 'atlas-001.diff.svg'), 'utf8'), /REGISTRO VARIAZIONI/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('strict calendar dates and UTC day arithmetic', () => {
  assert.throws(() => dateValue('2026-02-29'), /invalid date/);
  assert.throws(() => dateValue('2026-9-01'), /YYYY-MM-DD/);
  assert.equal(dateValue('2026-03-30') - dateValue('2026-03-29'), 86400000);
});

test('validation rejects duplicate IDs, reversed dates, invalid progress', () => {
  assert.throws(() => plan([task, task]), /Duplicate/);
  assert.throws(() => plan([{ ...task, end: '2026-08-01' }]), /precedes/);
  assert.throws(() => plan([{ ...task, progress: 101 }]), /progress/);
});

test('diff tracks stable IDs, dates, milestones, additions and removals', () => {
  const before = plan([
    task,
    { id: 'gate', name: 'Gate', type: 'milestone', date: '2026-10-01' },
    { ...task, id: 'remove' },
  ]);
  const after = plan([
    { ...task, name: 'Delivery', end: '2026-10-07', note: 'Scope cliente' },
    { id: 'gate', name: 'Gate', type: 'milestone', date: '2026-10-08' },
    { ...task, id: 'new' },
  ]);
  const changes = comparePlans(after, before);
  assert.deepEqual(
    changes.map((change) => change.kind),
    ['changed', 'changed', 'added', 'removed'],
  );
  assert.deepEqual(
    changes.map((change) => change.number),
    [1, 2, 3, 4],
  );
  assert.match(changes[0].details.join(' '), /\+7 days/);
  assert.equal(changes[0].note, 'Scope cliente');
  assert.match(changes[1].details.join(' '), /\+7 days/);
  assert.deepEqual(comparePlans(before, before), []);
});

test('additions do not create spurious reorder annotations', () => {
  assert.equal(comparePlans(plan([{ ...task, id: 'new' }, task]), plan([task])).length, 1);
  const before = plan([task, { ...task, id: 'second' }]);
  const after = plan([{ ...task, id: 'second' }, task]);
  assert.ok(comparePlans(after, before).every((change) => change.fields.includes('order')));
});

test('previous version is lexical predecessor in the same project', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-'));
  try {
    const current = plan([task]);
    for (const name of ['atlas-001.json', 'atlas-003.json', 'atlas-005.json']) {
      writeFileSync(join(directory, name), JSON.stringify(current));
    }
    writeFileSync(
      join(directory, 'atlas-002.json'),
      JSON.stringify({ ...current, project: 'other' }),
    );
    assert.equal(
      findPrevious(join(directory, 'atlas-003.json')),
      join(directory, 'atlas-001.json'),
    );
    assert.throws(() => findPrevious(join(directory, 'atlas-001.json')), /No previous version/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('default is a two-week sprint; custom periods are validated', () => {
  assert.deepEqual(resolveTimeUnit(), { days: 14, label: 'Sprint' });
  assert.deepEqual(resolveTimeUnit({ timeUnit: { name: 'Cycle' } }), { days: 14, label: 'Cycle' });
  assert.deepEqual(resolveTimeUnit({ timeUnit: { duration: '4w' } }), {
    days: 28,
    label: 'Sprint',
  });
  assert.throws(() => resolveTimeUnit({ timeUnit: { duration: '0d' } }));
});

test('inclusive ends and calendar months including leap February', () => {
  const current = plan([{ ...task, start: '2024-02-01', end: '2024-02-29' }], '2024-02-01');
  const timeline = makeTimeline(current.tasks, {
    origin: '2024-02-01',
    timeUnit: { duration: '1d' },
  });
  assert.equal(timeline.end, dateValue('2024-03-01'));
  assert.equal(timeline.end - timeline.start, 29 * 86400000);
  const oneDay = makeTimeline(plan([{ ...task, end: task.start }]).tasks, {
    origin: task.start,
    timeUnit: { duration: '1d' },
  });
  assert.equal(oneDay.end - oneDay.start, 86400000);
});

test('SVG is transparent, self-contained, escaped and configurable', () => {
  const current = plan([{ ...task, name: '<script>& "cliente"' }]);
  const result = renderSvg(withMarker(current, 'STEERING / $position'));
  assert.match(result.svg, /&lt;script&gt;&amp;/);
  assert.match(result.svg, /STEERING \/ 18\/09\/2026/);
  assert.match(result.svg, /Sprint 1/);
  assert.doesNotMatch(result.svg, /<script>|<foreignObject|<image|<style|<rect[^>]*width="1600"/);
  assert.doesNotMatch(renderSvg(current, {}).svg, /TODAY/);
  assert.doesNotMatch(renderSvg(withMarker(current, 'Hidden', '2027-01-01')).svg, /Hidden/);
  assert.throws(() => renderSvg(current, { width: 300 }), /width/);
});

test('diff keeps baseline dates, removed rows, references and notes', () => {
  const before = plan([
    { ...task, start: '2026-08-01' },
    { ...task, id: 'removed' },
  ]);
  const after = plan([{ ...task, note: 'Confermare & discutere' }]);
  const result = renderSvg(after, { previous: before, diff: true, notes: 'inline' });
  assert.equal(result.changes.length, 2);
  assert.match(result.svg, /CHANGE LOG/);
  assert.match(result.svg, /Confermare &amp; discutere/);
  assert.match(result.svg, /line-through/);
  assert.match(result.svg, /01\/08\/2026/);
  assert.match(renderMarkdown(after, before, result.changes), /## 01 - Build/);
  assert.match(renderSvg(after, { previous: after, diff: true }).svg, /No changes/);
  const separate = renderSvg(after, { previous: before, diff: true });
  assert.ok(separate.height < result.height);
  assert.doesNotMatch(separate.svg, /CHANGE LOG/);
  assert.match(separate.svg, /see change log/);
  assert.match(separate.notesSvg, /CHANGE LOG/);
  assert.match(separate.notesSvg, /Confermare &amp; discutere/);
  assert.doesNotMatch(separate.notesSvg, /WORKSTREAM|Sprint 1|TODAY/);
  assert.equal(separate.notesSvg, result.notesSvg);
  assert.match(renderSvg(after, { previous: after, diff: true }).notesSvg, /No changes/);
  assert.equal(renderSvg(after, {}).notesSvg, undefined);
});

test('diff draws baseline only when temporal footprint or type changes', () => {
  const before = plan([task]);
  const render = (after) => renderSvg(plan([after]), { previous: before, diff: true });
  for (const update of [
    { progress: 65 },
    { name: 'Nuovo nome' },
    { owner: 'Team' },
    { group: 'Nuova area' },
  ]) {
    const result = render({ ...task, ...update });
    assert.equal(result.changes.length, 1);
    assert.doesNotMatch(result.svg, /stroke-dasharray="5 4"/);
  }
  for (const update of [
    { start: '2026-09-02' },
    { end: '2026-10-01' },
    { start: '2026-09-02', end: '2026-10-01' },
    { type: 'milestone', date: task.start },
  ]) {
    assert.match(render({ ...task, ...update }).svg, /stroke-dasharray="5 4"/);
  }
  const milestone = { id: 'gate', type: 'milestone', name: 'Gate', date: '2026-09-15' };
  const baseline = plan([milestone]);
  const unchanged = renderSvg(plan([{ ...milestone, name: 'Gate rinominato' }]), {
    previous: baseline,
    diff: true,
  });
  assert.doesNotMatch(unchanged.svg, /stroke-dasharray="3 2"/);
  const shifted = renderSvg(plan([{ ...milestone, date: '2026-09-16' }]), {
    previous: baseline,
    diff: true,
  });
  assert.match(shifted.svg, /stroke-dasharray="3 2"/);
});

test('baseline overlays current bar transparently without increasing row height', () => {
  const before = plan([task]);
  const after = plan([{ ...task, end: '2026-10-07', progress: 50 }]);
  const diff = renderSvg(after, { previous: before, diff: true });
  const clean = renderSvg(after, {});
  const rectangles = [...diff.svg.matchAll(/<rect\s[^>]*\/>/g)].map((match) => match[0]);
  const baseline = rectangles.find((rectangle) => rectangle.includes('stroke-dasharray="5 4"'));
  const actual = rectangles.find(
    (rectangle) => rectangle.includes('height="19"') && rectangle.includes('fill-opacity="0.2"'),
  );
  const attribute = (element, name) => Number(new RegExp(`\\b${name}="([^"]+)"`).exec(element)[1]);
  assert.ok(baseline);
  assert.ok(actual);
  assert.equal(
    attribute(baseline, 'y') + attribute(baseline, 'height') / 2,
    attribute(actual, 'y') + attribute(actual, 'height') / 2,
  );
  assert.equal(attribute(baseline, 'stroke-opacity'), 0.6);
  assert.ok(diff.svg.indexOf(baseline) > diff.svg.indexOf(actual));
  assert.equal(diff.height, clean.height);
});

test('task date labels include full inclusive duration in days or exact weeks', () => {
  for (const [end, duration] of [
    ['2026-09-01', '1d'],
    ['2026-09-04', '4d'],
    ['2026-09-07', '1w'],
    ['2026-09-14', '2w'],
    ['2026-09-10', '10d'],
  ]) {
    const current = plan([{ ...task, end }]);
    for (const lang of ['en', 'it']) {
      assert.ok(renderSvg(current, { lang }).svg.includes(`(${duration})`));
    }
  }
  const previous = plan([{ ...task, end: '2026-09-14' }]);
  const current = validatePlan({
    ...previous.toJSON(),
    timeline: { origin: '2026-08-01', visibleRange: { start: '2026-09-02', end: '2026-09-03' } },
  });
  assert.match(renderSvg(current, {}).svg, /01\/09 - 14\/09 \(2w\)/);
  const milestone = plan([{ id: 'gate', name: 'Gate', type: 'milestone', date: '2026-09-14' }]);
  assert.doesNotMatch(renderSvg(milestone, {}).svg, /\(1d\)/);
  const removed = renderSvg(milestone, { previous, diff: true });
  assert.match(removed.svg, /\(2w\)/);
});

test('ungrouped tasks have no group header or reserved header space in clean and diff charts', () => {
  const ungrouped = plan([task]);
  const grouped = plan([{ ...task, group: 'Delivery' }]);
  const options = {};
  assert.equal(renderSvg(grouped, options).height - renderSvg(ungrouped, options).height, 36);
  const mixed = plan([
    task,
    { ...task, id: 'named', group: 'Delivery' },
    { ...task, id: 'null', group: null },
  ]);
  const previous = plan([...mixed.tasks, { ...task, id: 'removed', name: 'Removed item' }]);
  for (const lang of ['en', 'it']) {
    for (const diff of [false, true]) {
      const result = renderSvg(mixed, { ...options, previous, diff, lang });
      assert.doesNotMatch(result.svg, /(?:PROJECT|PROGETTO)<\/text>/);
      assert.match(result.svg, /DELIVERY<\/text>/);
      if (diff) assert.match(result.svg, /Removed item/);
    }
  }
});

test('translation catalogs have matching keys and interpolation parameters', async () => {
  const english = JSON.parse(
    readFileSync(new URL('./fixtures/locales/en.json', import.meta.url), 'utf8'),
  );
  const italian = JSON.parse(
    readFileSync(new URL('./fixtures/locales/it.json', import.meta.url), 'utf8'),
  );
  const check = (left, right, prefix = '') => {
    assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort(), prefix);
    for (const key of Object.keys(left)) {
      if (typeof left[key] === 'object') check(left[key], right[key], `${prefix}.${key}`);
      else {
        assert.equal(typeof right[key], 'string');
        assert.ok(right[key].length > 0);
        assert.deepEqual(
          [...left[key].matchAll(/{{(.*?)}}/g)].map((match) => match[1]).sort(),
          [...right[key].matchAll(/{{(.*?)}}/g)].map((match) => match[1]).sort(),
          `${prefix}.${key}`,
        );
      }
    }
  };
  check(english, italian);
  for (const [lang, catalog] of [
    ['en', english],
    ['it', italian],
  ]) {
    const { default: compiledCatalog } = await import(
      `../packages/cutegantt/dist/locales/${lang}.js`
    );
    assert.deepEqual(compiledCatalog, catalog);
    for (const key of [
      'help',
      'schemaHelp',
      'calendarHelp',
      'timeUnitHelp',
      'relativeTimeHelp',
      'groupSummaryHelp',
      'inputFormats',
    ]) {
      assert.equal(Object.hasOwn(catalog, key), false);
    }
    for (const key of [
      'schemaArguments',
      'prefix',
      'holidayFiles',
      'format',
      'ambiguousPrevious',
      'read',
      'previous',
      'input',
      'mode',
      'relativeTimeConflict',
      'groupSummaryConflict',
      'sameFile',
      'overwrite',
    ]) {
      assert.equal(Object.hasOwn(catalog.errors, key), false);
    }
  }
  assert.equal(translator()('references', { count: 1 }), '1 reference');
  assert.equal(translator('it')('references', { count: 2 }), '2 riferimenti');
  assert.throws(() => translator('fr'), /Unsupported language/);
});

test('rendering and reports localize labels without changing user content or IDs', () => {
  const before = plan([task]);
  const after = withMarker(
    plan([
      { ...task, name: 'Consegna & collaudo', end: '2026-10-07', note: 'Nota del cliente <ok>' },
    ]),
  );
  const options = { previous: before, diff: true, notes: 'inline' };
  const english = renderSvg(after, options);
  const italian = renderSvg(after, { ...options, lang: 'it' });
  assert.match(english.svg, /xml:lang="en"/);
  assert.match(english.svg, /Review \/ 18\/09\/2026/);
  assert.match(english.svg, /SEPT? 2026/);
  assert.match(english.svg, /CHANGE LOG/);
  assert.doesNotMatch(english.svg, /PROJECT<\/text>/);
  assert.match(italian.svg, /xml:lang="it"/);
  assert.match(italian.svg, /Review \/ 18\/09\/2026/);
  assert.match(italian.svg, /SET 2026/);
  assert.doesNotMatch(italian.svg, /PROGETTO<\/text>/);
  assert.match(italian.notesSvg, /REGISTRO VARIAZIONI/);
  assert.match(english.notesSvg, /CHANGE LOG/);
  assert.match(english.changes[0].details.join(' '), /End:.*\+7 days/);
  assert.match(italian.changes[0].details.join(' '), /Fine:.*\+7 gg/);
  for (const result of [english, italian]) {
    assert.match(result.svg, /Consegna &amp; collaudo/);
    assert.match(result.notesSvg, /Nota del cliente &lt;ok&gt;/);
    assert.equal(result.changes[0].id, task.id);
    assert.equal(result.changes[0].number, 1);
    assert.doesNotMatch(result.svg, /{{|}}/);
  }
  assert.equal(renderSvg(after, options).svg, english.svg);
  assert.match(
    renderMarkdown(after, before, italian.changes, undefined, undefined, 'it'),
    /\*\*Nota:\*\*/,
  );
  assert.match(renderMarkdown(after, before, english.changes), /\*\*Note:\*\*/);
  assert.match(
    renderSvg(withMarker(after, 'CUSTOM / $position'), { lang: 'it' }).svg,
    /CUSTOM \/ 18\/09\/2026/,
  );
  assert.match(
    renderSvg(after, { previous: after, diff: true, lang: 'it' }).notesSvg,
    /Nessuna variazione/,
  );
  assert.match(renderSvg(plan([{ ...task, group: 'Progetto' }]), {}).svg, /PROGETTO<\/text>/);
});

test('CLI supports both languages from any directory and rejects unsupported languages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-languages-'));
  const script = fileURLToPath(new URL('../packages/cutegantt-cli/dist/cli.js', import.meta.url));
  const input = fileURLToPath(new URL('./fixtures/atlas-2026-09-18.json', import.meta.url));
  try {
    for (const lang of ['en', 'it']) {
      const help = spawnSync(process.execPath, [script, '--help', '--lang', lang], {
        encoding: 'utf8',
        cwd: directory,
      });
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /Usage: cutegantt/);
      assert.match(help.stdout, /--lang <language>/);
      const invalid = spawnSync(process.execPath, [script, '--lang', lang], {
        encoding: 'utf8',
        cwd: directory,
      });
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /error: missing required argument 'input'/);
      const output = join(directory, lang);
      const result = spawnSync(
        process.execPath,
        [script, input, '--lang', lang, '--mode', 'both', '--out-dir', output],
        { encoding: 'utf8', cwd: directory },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(
        readFileSync(join(output, 'atlas-2026-09-18.svg'), 'utf8'),
        /outside range/,
      );
      assert.match(
        readFileSync(join(output, 'atlas-2026-09-18.notes.svg'), 'utf8'),
        lang === 'en' ? /CHANGE LOG/ : /REGISTRO VARIAZIONI/,
      );
      assert.match(
        readFileSync(join(output, 'atlas-2026-09-18.changes.md'), 'utf8'),
        lang === 'en' ? /\*\*Note:/ : /\*\*Nota:/,
      );
      const report = JSON.parse(
        readFileSync(join(output, 'atlas-2026-09-18.changes.json'), 'utf8'),
      );
      assert.equal(report.language, lang);
      assert.equal(report.changes[0].kind, 'changed');
      assert.match(report.changes[0].details[0], lang === 'en' ? /Progress:/ : /Avanzamento:/);
    }
    const invalidLanguage = spawnSync(
      process.execPath,
      [script, input, '--lang', 'fr', '--out-dir', join(directory, 'fr')],
      { encoding: 'utf8' },
    );
    assert.equal(invalidLanguage.status, 1);
    assert.match(invalidLanguage.stderr, /Allowed choices are en, it/);
    assert.ok(!existsSync(join(directory, 'fr')));
    assert.match(
      spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' }).stdout,
      /Usage:/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI generates both charts and reports, prevents accidental overwrites', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gantt-cli-'));
  try {
    const args = [
      'packages/cutegantt-cli/dist/cli.js',
      'test/fixtures/atlas-2026-09-18.json',
      '--mode',
      'both',
      '--out-dir',
      directory,
    ];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const suffix of ['.svg', '.diff.svg', '.notes.svg', '.changes.md', '.changes.json']) {
      assert.ok(existsSync(join(directory, `atlas-2026-09-18${suffix}`)));
    }
    const report = JSON.parse(
      readFileSync(join(directory, 'atlas-2026-09-18.changes.json'), 'utf8'),
    );
    assert.equal(report.previous, 'atlas-2026-09-04.json');
    assert.equal(report.changes.length, 9);
    assert.equal(spawnSync(process.execPath, args).status, 1);
    assert.equal(spawnSync(process.execPath, [...args, '--force']).status, 0);
    const inlineDirectory = join(directory, 'inline');
    const inlineResult = spawnSync(
      process.execPath,
      [...args, '--notes', 'inline', '--out-dir', inlineDirectory],
      { encoding: 'utf8' },
    );
    assert.equal(inlineResult.status, 0, inlineResult.stderr);
    assert.match(
      readFileSync(join(inlineDirectory, 'atlas-2026-09-18.diff.svg'), 'utf8'),
      /CHANGE LOG/,
    );
    assert.ok(!existsSync(join(inlineDirectory, 'atlas-2026-09-18.notes.svg')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
