import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { renderSvg, renderSvgPages } from 'cutegantt';

const root = new URL('../', import.meta.url);
const manifest = (relative) => JSON.parse(readFileSync(new URL(relative, root), 'utf8'));

test('workspace and compiled packages enforce public boundaries', () => {
  assert.deepEqual(manifest('package.json').workspaces, [
    'packages/cutegantt',
    'packages/cutegantt-cli',
  ]);
  for (const directory of ['../', '../../']) {
    for (const filename of ['package.json', 'package-lock.json'])
      assert.equal(existsSync(new URL(directory + filename, root)), false);
  }
  const core = manifest('packages/cutegantt/package.json');
  const cli = manifest('packages/cutegantt-cli/package.json');
  assert.equal(core.type, 'module');
  assert.equal(cli.dependencies.cutegantt, core.version);
  assert.equal(cli.engines.node, '>=24');
  assert.equal(cli.bin.cutegantt, './dist/cli.js');
  assert.deepEqual(Object.keys(core.exports), ['.']);
  assert.equal(core.dependencies['cutegantt-cli'], undefined);
  for (const directory of ['packages/cutegantt/src/', 'packages/cutegantt/dist/']) {
    for (const name of readdirSync(new URL(directory, root), { recursive: true }).filter((name) =>
      /\.(ts|js)$/.test(name),
    )) {
      const source = readFileSync(new URL(directory + name, root), 'utf8');
      assert.doesNotMatch(
        source,
        /(?:from\s*|import\s*\()['"](?:node:|fs['"/]|path['"/]|yaml['"]|cutegantt-cli)/,
      );
      if (!name.startsWith('locales/')) {
        assert.doesNotMatch(source, /\b(?:process|console|document|window)\s*\./);
        assert.doesNotMatch(source, /@ts-(?:ignore|nocheck)|\bany\b/);
      }
    }
  }
  for (const name of readdirSync(new URL('packages/cutegantt-cli/src/', root))) {
    const source = readFileSync(new URL('packages/cutegantt-cli/src/' + name, root), 'utf8');
    assert.doesNotMatch(source, /from\s*['"](?:\.\.\/|cutegantt\/)/);
  }
});

test('headerless charts and notes keep visible text inside the SVG on desktop and mobile', async () => {
  const browser = await chromium.launch({ headless: true });
  const input = {
    project: 'headerless',
    title: 'A long title that must not reserve any visible space '.repeat(5),
    timeline: {
      origin: '2026-09-01',
      markers: [{ position: '2026-09-10', label: 'Review' }],
    },
    tasks: [{ id: 'build', name: 'Build', start: 1, end: 2, progress: 50 }],
  };
  const previous = { ...input, tasks: [{ ...input.tasks[0], end: 1 }] };
  try {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      for (const fontScale of ['50%', '150%']) {
        const rendered = renderSvg(
          { ...input, style: { fontScale } },
          {
            previous,
            diff: true,
            header: false,
            width: 1000,
          },
        );
        for (const svg of [rendered.svg, rendered.notesSvg]) {
          await page.setContent(`<style>svg { max-width: 100%; height: auto; }</style>${svg}`);
          const result = await page.evaluate(() => {
            const svg = document.querySelector('svg');
            const bounds = svg.getBoundingClientRect();
            const textBounds = [...svg.querySelectorAll('text')].map((text) => {
              const box = text.getBoundingClientRect();
              return {
                text: text.textContent,
                top: box.top,
                bottom: box.bottom,
                left: box.left,
                right: box.right,
              };
            });
            return {
              width: bounds.width,
              height: bounds.height,
              summaries: svg.querySelectorAll('[data-summary]').length,
              outside: textBounds.filter(
                (box) =>
                  box.top < bounds.top ||
                  box.bottom > bounds.bottom ||
                  box.left < bounds.left ||
                  box.right > bounds.right,
              ),
              topGap:
                ((Math.min(...textBounds.map((box) => box.top)) - bounds.top) *
                  svg.viewBox.baseVal.height) /
                bounds.height,
            };
          });
          assert.equal(result.summaries, 0);
          assert.deepEqual(result.outside, []);
          assert.ok(result.width > 0 && result.width <= viewport.width);
          assert.ok(result.height > 0);
          assert.ok(result.topGap >= 0 && result.topGap < 60);
          assert.ok((await page.screenshot()).length > 1000);
        }
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('pagination repeats timeline and group styling without clipping on desktop and mobile', async () => {
  const browser = await chromium.launch({ headless: true });
  const input = {
    project: 'pagination',
    title: 'Paginated project',
    timeline: {
      origin: '2026-09-01',
      showWeekNumbers: true,
      truncateUnits: true,
      visibleRange: { start: '2026-09-01', end: '2026-10-31' },
      markers: [{ position: '2026-09-10', label: 'Review' }],
    },
    tasks: [
      { id: 'alpha', name: 'Work Alpha', group: 'First', start: 1, end: 2, progress: 50 },
      { id: 'beta', name: 'Work Beta', group: 'Second', start: 1, end: 3, progress: 10 },
      {
        id: 'release',
        name: 'Work Release',
        group: 'First',
        type: 'milestone',
        date: '2026-10-01',
      },
      { id: 'gamma', name: 'Work Gamma', group: 'First', start: 2, end: 3, progress: 80 },
    ],
  };
  const previous = {
    ...input,
    tasks: input.tasks.map((task) => (task.id === 'alpha' ? { ...task, end: 1 } : task)),
  };
  try {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      for (const fontScale of ['50%', '150%']) {
        for (const header of [false, true]) {
          for (const notes of ['inline', 'separate']) {
            const current = { ...input, style: { fontScale, groupSummary: true } };
            const options = {
              header,
              previous,
              diff: true,
              notes,
              shadeWeekends: true,
              width: 1600,
            };
            const whole = renderSvg(current, options);
            const paginated = renderSvgPages(current, { ...options, pageSize: 2 });
            const inspect = async (source) => {
              await page.setContent(
                `<style>svg { max-width: 100%; height: auto; }</style>${source}`,
              );
              return page.evaluate(() => {
                const svg = document.querySelector('svg');
                const bounds = svg.getBoundingClientRect();
                const texts = [...svg.querySelectorAll('text')];
                const axisY =
                  Number(svg.querySelector('[data-marker="line"]').getAttribute('y1')) + 5;
                const axisBottom = axisY + 24 + 56;
                const entries = (selected) =>
                  selected.map((text) => ({
                    text: text.textContent,
                    x: text.getAttribute('x'),
                    y: text.getAttribute('y'),
                    fill: text.getAttribute('fill'),
                  }));
                return {
                  timeline: entries(
                    texts.filter(
                      (text) =>
                        Number(text.getAttribute('y')) >= axisY &&
                        Number(text.getAttribute('y')) <= axisBottom,
                    ),
                  ),
                  colors: texts
                    .filter((text) => ['FIRST', 'SECOND'].includes(text.textContent))
                    .map((text) => [text.textContent, text.getAttribute('fill')]),
                  summaries: [...svg.querySelectorAll('[data-group-summary="span"]')].map(
                    (element) => [
                      element.getAttribute('x'),
                      element.getAttribute('width'),
                      element.getAttribute('fill'),
                    ],
                  ),
                  outside: texts
                    .filter((text) => {
                      const box = text.getBoundingClientRect();
                      return (
                        box.top < bounds.top - 1 ||
                        box.bottom > bounds.bottom + 1 ||
                        box.left < bounds.left - 1 ||
                        box.right > bounds.right + 1
                      );
                    })
                    .map((text) => text.textContent),
                  width: bounds.width,
                  height: bounds.height,
                  text: svg.textContent,
                };
              });
            };
            const expected = await inspect(whole.svg);
            for (const rendered of paginated.pages) {
              const actual = await inspect(rendered.svg);
              assert.deepEqual(actual.timeline, expected.timeline);
              assert.ok(actual.timeline.length > 5);
              for (const color of actual.colors)
                assert.ok(
                  expected.colors.some((entry) => JSON.stringify(entry) === JSON.stringify(color)),
                );
              for (const summary of actual.summaries)
                assert.ok(
                  expected.summaries.some(
                    (entry) => JSON.stringify(entry) === JSON.stringify(summary),
                  ),
                );
              assert.deepEqual(actual.outside, []);
              assert.ok(actual.width > 0 && actual.width <= viewport.width);
              assert.ok(actual.height > 0);
              assert.ok(actual.text.includes('FIRST'));
              assert.equal(actual.text.includes('SECOND'), rendered.page === 2);
              assert.ok((await page.screenshot()).length > 1000);
            }
          }
        }
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('core bundles and renders in a real browser without Node globals', async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('packages/cutegantt/dist/index.js', root))],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    metafile: true,
  });
  assert.ok(Object.keys(bundle.metafile.inputs).some((name) => name.includes('locales/it.js')));
  for (const input of Object.values(bundle.metafile.inputs)) {
    for (const dependency of input.imports)
      assert.equal(dependency.external, undefined, dependency.path);
  }
  const browser = await chromium.launch({ headless: true });
  const input = {
    project: 'browser',
    title: 'Browser <test>',
    timeline: { origin: '2026-09-01' },
    tasks: [{ id: 'build', name: 'Build', start: 1, end: 2, progress: 50 }],
  };
  try {
    const page = await browser.newPage();
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      const result = await page.evaluate(
        async ({ source, input }) => {
          const moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
          try {
            const core = await import(moduleUrl);
            const before = structuredClone(input);
            before.tasks[0].end = 1;
            const english = core.renderSvg(input, { lang: 'en' });
            const italian = core.renderSvg(input, { lang: 'it', diff: true, previous: before });
            const report = core.renderMarkdown(
              input,
              before,
              italian.changes,
              undefined,
              undefined,
              'it',
            );
            document.body.innerHTML = english.svg;
            const svg = document.querySelector('svg');
            svg.style.maxWidth = '100%';
            svg.style.height = 'auto';
            const bounds = svg.getBoundingClientRect();
            const image = new Image();
            image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(english.svg);
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let visible = 0;
            for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) visible++;
            return {
              svg: english.svg,
              italian: italian.notesSvg,
              report,
              visible,
              width: bounds.width,
              height: bounds.height,
              processType: typeof process,
              requireType: typeof require,
              issues: core.projectPlanSchema.safeParse({}).success,
              language: core.translator('en')('baseline'),
            };
          } finally {
            URL.revokeObjectURL(moduleUrl);
          }
        },
        { source: bundle.outputFiles[0].text, input },
      );
      assert.equal(result.svg, renderSvg(input, { lang: 'en' }).svg);
      assert.equal(result.processType, 'undefined');
      assert.equal(result.requireType, 'undefined');
      assert.equal(result.issues, false);
      assert.ok(result.italian.includes('<svg'));
      assert.ok(result.report.length > 50);
      assert.ok(result.visible > 1000);
      assert.ok(result.width > 0 && result.width <= viewport.width);
      assert.ok(result.height > 0);
    }
  } finally {
    await browser.close();
  }
});
