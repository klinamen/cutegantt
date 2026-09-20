import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));

test('SEA runs without Node on PATH and matches CLI output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cutegantt-sea-test-'));
  const executable = join(directory, process.platform === 'win32' ? 'cutegantt.exe' : 'cutegantt');
  const cli = join(root, 'packages/cutegantt-cli/dist/cli.js');
  function run(command, args, standalone = false) {
    const result = spawnSync(command, args, {
      cwd: directory,
      encoding: 'utf8',
      timeout: 180000,
      env: standalone
        ? { ...process.env, PATH: join(directory, 'empty-path'), NODE_PATH: '', NODE_OPTIONS: '' }
        : process.env,
    });
    assert.ifError(result.error);
    return result;
  }
  try {
    if (process.env.CUTEGANTT_SEA_BINARY) {
      copyFileSync(resolve(process.env.CUTEGANTT_SEA_BINARY), executable);
    } else {
      const built = spawnSync('npm', ['run', 'build:sea', '--', '--output', executable], {
        cwd: root,
        encoding: 'utf8',
        timeout: 180000,
      });
      assert.ifError(built.error);
      assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
    }
    mkdirSync(join(directory, 'empty-path'));
    for (const args of [['--help'], ['--schema', '--lang', 'it'], ['--unknown-option']]) {
      const normal = run(process.execPath, [cli, ...args]);
      const sea = run(executable, args, true);
      assert.equal(sea.status, normal.status);
      assert.equal(sea.stdout, normal.stdout);
      assert.equal(sea.stderr, normal.stderr);
    }
    for (const extension of ['json', 'yaml']) {
      const name = `plan.${extension}`;
      const source = readFileSync(join(root, 'test/fixtures/atlas-2026-09-18.json'), 'utf8');
      writeFileSync(
        join(directory, name),
        extension === 'json' ? source : stringify(JSON.parse(source)),
      );
      const args = [name, '--lang', 'it', '--out-dir', `normal-${extension}`];
      const normal = run(process.execPath, [cli, ...args]);
      assert.equal(normal.status, 0, normal.stderr);
      args[args.length - 1] = `sea-${extension}`;
      const sea = run(executable, args, true);
      assert.equal(sea.status, 0, sea.stderr);
      const expected = join(directory, `normal-${extension}`);
      const actual = join(directory, `sea-${extension}`);
      assert.deepEqual(readdirSync(actual), readdirSync(expected));
      for (const file of readdirSync(expected))
        assert.equal(
          readFileSync(join(actual, file), 'utf8'),
          readFileSync(join(expected, file), 'utf8'),
        );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
