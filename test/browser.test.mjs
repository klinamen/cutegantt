import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { renderSvg } from 'cutegantt';

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
