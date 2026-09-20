import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120000 });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

test('packed core and CLI install, typecheck and run outside workspaces', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cutegantt-pack-'));
  const tarballs = join(directory, 'tarballs');
  const consumer = join(directory, 'consumer');
  const elsewhere = join(directory, 'elsewhere');
  for (const path of [tarballs, consumer, elsewhere]) mkdirSync(path);
  try {
    const archives = [];
    for (const name of ['cutegantt', 'cutegantt-cli']) {
      const args =
        name === 'cutegantt-cli'
          ? ['run', '--silent', 'pack:cli', '--', '--pack-destination', tarballs]
          : ['pack', '--workspace', name, '--pack-destination', tarballs, '--json', '--silent'];
      const [packed] = JSON.parse(run('npm', args, root));
      archives.push(join(tarballs, packed.filename));
      assert.ok(packed.files.some((file) => file.path.endsWith('.d.ts')));
      assert.ok(
        packed.files.every(
          (file) =>
            file.path.startsWith('dist/') ||
            ['package.json', 'README.md'].includes(file.path) ||
            (name === 'cutegantt-cli' && file.path.startsWith('node_modules/')),
        ),
      );
      if (name === 'cutegantt') {
        for (const language of ['en', 'it'])
          assert.ok(packed.files.some((file) => file.path === `dist/locales/${language}.js`));
      } else {
        assert.ok(packed.bundled.includes('cutegantt'));
        assert.ok(
          packed.files.some((file) => file.path === 'node_modules/cutegantt/dist/index.js'),
        );
        assert.ok(
          !packed.files.some((file) => file.path.startsWith('node_modules/cutegantt/src/')),
        );
        assert.equal(
          existsSync(join(root, 'packages/cutegantt-cli/node_modules/cutegantt')),
          false,
        );
      }
    }
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'isolated-consumer', private: true, type: 'module' }),
    );
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...archives], consumer);
    for (const name of ['cutegantt', 'cutegantt-cli']) {
      assert.equal(lstatSync(join(consumer, 'node_modules', name)).isSymbolicLink(), false);
      assert.equal(existsSync(join(consumer, 'node_modules', name, 'src')), false);
    }
    const bin = join(consumer, 'node_modules/.bin/cutegantt');
    assert.match(run(bin, ['--help'], elsewhere), /--holidays-dir/);
    const schema = JSON.parse(run(bin, ['--schema', '--lang', 'it'], elsewhere));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.deepEqual(readdirSync(elsewhere), []);
    for (const version of ['04', '18']) {
      writeFileSync(
        join(elsewhere, `atlas-2026-09-${version}.json`),
        readFileSync(new URL(`./fixtures/atlas-2026-09-${version}.json`, import.meta.url)),
      );
    }
    run(bin, ['atlas-2026-09-18.json', '--mode', 'both', '--lang', 'it'], elsewhere);
    const output = join(elsewhere, 'output');
    assert.equal(readdirSync(output).length, 5);
    assert.match(readFileSync(join(output, 'atlas-2026-09-18.svg'), 'utf8'), /xml:lang="it"/);
    assert.equal(
      JSON.parse(readFileSync(join(output, 'atlas-2026-09-18.changes.json'))).language,
      'it',
    );
    writeFileSync(
      join(consumer, 'consumer.ts'),
      readFileSync(new URL('./fixtures/consumer.ts', import.meta.url)),
    );
    for (const [module, moduleResolution] of [
      ['NodeNext', 'NodeNext'],
      ['ESNext', 'Bundler'],
    ]) {
      writeFileSync(
        join(consumer, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module,
            moduleResolution,
            types: [],
            lib: ['ES2022', 'DOM'],
          },
          files: ['consumer.ts'],
        }),
      );
      run(
        process.execPath,
        [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')],
        consumer,
      );
    }
    const bundle = await build({
      stdin: {
        contents: 'export { renderSvg, planJsonSchema } from "cutegantt";',
        resolveDir: consumer,
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
    });
    assert.ok(bundle.outputFiles[0].text.includes('renderSvg'));
    for (const input of Object.keys(bundle.metafile.inputs))
      assert.ok(!input.includes('packages/cutegantt/'));
    const probe = `import assert from 'node:assert/strict';
      import { renderSvg } from 'cutegantt';
      import { loadPlan } from 'cutegantt-cli';
      assert.equal(typeof renderSvg, 'function'); assert.equal(typeof loadPlan, 'function');
      await assert.rejects(import('cutegantt/dist/model.js'), {code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'});`;
    run(process.execPath, ['--input-type=module', '-e', probe], consumer);
    const globalPrefix = join(directory, 'global');
    run(
      'npm',
      [
        'install',
        '-g',
        '--prefix',
        globalPrefix,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        archives[1],
      ],
      elsewhere,
    );
    const globalModules =
      process.platform === 'win32'
        ? join(globalPrefix, 'node_modules')
        : join(globalPrefix, 'lib/node_modules');
    assert.equal(existsSync(join(globalModules, 'cutegantt')), false);
    assert.equal(
      lstatSync(join(globalModules, 'cutegantt-cli/node_modules/cutegantt')).isSymbolicLink(),
      false,
    );
    const globalBin = process.platform === 'win32' ? globalPrefix : join(globalPrefix, 'bin');
    const globalEnv = { ...process.env, PATH: `${globalBin}${delimiter}${process.env.PATH ?? ''}` };
    assert.match(run('cutegantt', ['--help'], elsewhere, globalEnv), /--holidays-dir/);
    assert.deepEqual(
      JSON.parse(run('cutegantt', ['--schema', '--lang', 'it'], elsewhere, globalEnv)),
      schema,
    );
    const globalOutput = join(elsewhere, 'global-output');
    run(
      'cutegantt',
      ['atlas-2026-09-18.json', '--mode', 'both', '--lang', 'it', '--out-dir', globalOutput],
      elsewhere,
      globalEnv,
    );
    assert.deepEqual(readdirSync(globalOutput), readdirSync(output));
    for (const filename of readdirSync(output)) {
      assert.equal(
        readFileSync(join(globalOutput, filename), 'utf8'),
        readFileSync(join(output, filename), 'utf8'),
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
