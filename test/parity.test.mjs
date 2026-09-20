import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stringify } from 'yaml';
import * as core from 'cutegantt';
import * as legacy from '../../../gantt/cutegantt.mjs';
import { planJsonSchema as legacySchema } from '../../../gantt/schemas.mjs';

const before = JSON.parse(
  readFileSync(new URL('./fixtures/atlas-2026-09-04.json', import.meta.url)),
);
const after = JSON.parse(
  readFileSync(new URL('./fixtures/atlas-2026-09-18.json', import.meta.url)),
);
const oldCli = fileURLToPath(new URL('../../../gantt/cutegantt.mjs', import.meta.url));
const newCli = fileURLToPath(new URL('../packages/cutegantt-cli/dist/cli.js', import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));

test('core matches legacy output across rendering options and languages', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-20T12:00:00Z') });
  for (const lang of ['en', 'it']) {
    assert.deepEqual(core.planJsonSchema(lang), legacySchema(lang));
    for (const theme of ['light', 'dark']) {
      for (const height of ['short', 'normal', 'tall']) {
        for (const relativeTime of [false, true]) {
          const current = {
            ...after,
            style: {
              ...after.style,
              height,
              fontScale: '75%',
              leftSideScale: '22.5%',
              groupSummary: true,
            },
            timeline: {
              ...after.timeline,
              relativeTime,
              showWeekNumbers: true,
              truncateUnits: true,
              markers: [
                { position: 'today', label: '$position' },
                { position: 1, label: 'Start' },
              ],
            },
          };
          assert.equal(
            JSON.stringify(core.validatePlan(current).toJSON()),
            JSON.stringify(legacy.validatePlan(current).toJSON()),
          );
          for (const notes of ['separate', 'inline']) {
            const options = {
              lang,
              theme,
              notes,
              previous: before,
              diff: true,
              width: 2200,
              font: 'Arial',
              currentLabel: 'current',
              previousLabel: 'previous',
              shadeWeekends: true,
              holidayLabels: true,
              holidays: [{ start: '2026-09-01', end: '2026-09-04', label: 'Closure' }],
            };
            const actual = core.renderSvg(current, options);
            const expected = legacy.renderSvg(current, options);
            assert.deepEqual(plain(actual), plain(expected));
            assert.equal(
              core.renderMarkdown(current, before, actual.changes, 'current', 'previous', lang),
              legacy.renderMarkdown(current, before, expected.changes, 'current', 'previous', lang),
            );
          }
        }
      }
    }
  }
});

test('core preserves structured validation errors', () => {
  const invalid = [
    null,
    {},
    { ...after, timeline: {} },
    { ...after, tasks: [] },
    { ...after, tasks: [{ id: 'x', name: 'X', start: '2026-02-30', end: 2 }] },
    { ...after, timeline: { ...after.timeline, visibleRange: { start: 0 } } },
    { ...after, tasks: [{ id: 'x', name: 'X', start: 1, end: 2, progress: 101 }] },
  ];
  const errorData = (api, input) => {
    try {
      api.validatePlan(input);
      assert.fail('Expected invalid input');
    } catch (error) {
      return plain({
        message: error.message,
        path: error.path,
        issues: error.issues,
        translationKey: error.translationKey,
        parameters: error.parameters,
        cause: error.cause?.issues,
      });
    }
  };
  for (const input of invalid) assert.deepEqual(errorData(core, input), errorData(legacy, input));
});

test('CLI preserves formats, modes, flags, files, streams and overwrite behavior', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cutegantt-parity-'));
  const output = join(directory, 'output');
  const calendars = join(directory, 'calendars');
  mkdirSync(calendars);
  writeFileSync(
    join(calendars, 'office_2026.yaml'),
    stringify({ holydays: [{ start: '2026-09-01', end: '2026-09-04', label: 'Closure' }] }),
  );
  const invoke = (script, args) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, TZ: 'UTC' },
    });
    assert.ifError(result.error);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const snapshot = () =>
    existsSync(output)
      ? Object.fromEntries(
          readdirSync(output)
            .sort()
            .map((name) => [name, readFileSync(join(output, name), 'utf8')]),
        )
      : {};
  try {
    const previous = join(directory, 'atlas-01.json');
    writeFileSync(previous, JSON.stringify(before));
    for (const extension of ['json', 'yaml', 'yml']) {
      const input = join(directory, `atlas-02.${extension}`);
      writeFileSync(input, extension === 'json' ? JSON.stringify(after) : stringify(after));
      for (const lang of ['en', 'it']) {
        for (const mode of ['clean', 'diff', 'both']) {
          for (const notes of ['inline', 'separate']) {
            const args = [
              input,
              '--mode',
              mode,
              '--lang',
              lang,
              '--notes',
              notes,
              '--out-dir',
              output,
              '--width',
              '2200',
              '--theme',
              'dark',
              '--font',
              'Arial',
              '--holidays-dir',
              calendars,
              '--shade-weekends',
              '--holiday-labels',
              ...(notes === 'inline'
                ? ['--relative-time', '--group-summary', '--previous', previous]
                : ['--no-relative-time', '--no-group-summary']),
            ];
            rmSync(output, { recursive: true, force: true });
            const expected = invoke(oldCli, args);
            assert.equal(expected.status, 0, expected.stderr);
            const expectedFiles = snapshot();
            const overwrite = invoke(oldCli, args);
            const rejected = invoke(newCli, args);
            assert.equal(rejected.status, overwrite.status);
            assert.equal(rejected.stdout, overwrite.stdout);
            assert.match(rejected.stderr, /error: Output already exists:.*Use --force/);
            rmSync(output, { recursive: true, force: true });
            assert.deepEqual(invoke(newCli, args), expected);
            assert.deepEqual(snapshot(), expectedFiles);
            assert.deepEqual(invoke(newCli, [...args, '--force']), expected);
            assert.deepEqual(snapshot(), expectedFiles);
          }
        }
      }
      rmSync(input);
    }
    for (const lang of ['en', 'it']) {
      assert.deepEqual(
        invoke(newCli, ['--schema', '--lang', lang]),
        invoke(oldCli, ['--schema', '--lang', lang]),
      );
      const help = invoke(newCli, ['--help', '--lang', lang]);
      assert.deepEqual(help, invoke(newCli, ['--help', '--lang', 'en']));
      assert.equal(help.status, 0);
      assert.match(help.stdout, /Usage: cutegantt/);
      for (const args of [
        ['--schema', '--width', '1'],
        ['--schema', previous],
        [],
        [previous, '--mode', 'other'],
        [previous, '--width', '999'],
        [previous, '--theme', 'other'],
        [previous, '--notes', 'other'],
        [previous, '--mode', 'diff', '--previous', previous],
        [join(directory, 'missing.json')],
        [previous, '--holidays-dir', join(directory, 'missing')],
      ]) {
        const options = [...args, '--lang', lang];
        const actual = invoke(newCli, options);
        const expected = invoke(oldCli, options);
        assert.equal(actual.status, 1, options.join(' '));
        assert.equal(actual.status, expected.status);
        assert.equal(actual.stdout, expected.stdout);
        assert.match(actual.stderr, /^error:/);
        assert.deepEqual(actual, invoke(newCli, [...args, '--lang', 'en']));
      }
      for (const args of [['--unknown'], [previous, '--today']]) {
        const options = [...args, '--lang', lang];
        const actual = invoke(newCli, options);
        const expected = invoke(oldCli, options);
        assert.equal(actual.status, expected.status);
        assert.equal(actual.stdout, expected.stdout);
        assert.match(actual.stderr, /unknown option/i);
      }
    }
    for (const source of ['tasks: [', 'title: X\ntitle: Y', '!unknown tagged']) {
      const invalid = join(directory, 'invalid.yaml');
      writeFileSync(invalid, source);
      const actual = invoke(newCli, [invalid, '--lang', 'it']);
      const expected = invoke(oldCli, [invalid, '--lang', 'en']);
      assert.deepEqual(actual, {
        ...expected,
        stderr: expected.stderr.replace(/^Error:/, 'error:'),
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
