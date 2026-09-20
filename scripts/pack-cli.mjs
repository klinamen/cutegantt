import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({
  options: { 'pack-destination': { type: 'string', default: root } },
});
const destination = resolve(values['pack-destination']);
const npmPath = process.env.npm_execpath;
if (!npmPath) throw new Error('Run this script with npm run pack:cli.');

function npm(args, cwd) {
  return execFileSync(process.execPath, [npmPath, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

const directory = mkdtempSync(join(tmpdir(), 'cutegantt-cli-pack-'));
try {
  npm(['run', 'build'], root);
  const [core] = JSON.parse(
    npm(
      [
        'pack',
        '--workspace',
        'cutegantt',
        '--ignore-scripts',
        '--pack-destination',
        directory,
        '--json',
        '--silent',
      ],
      root,
    ),
  );
  const staging = join(directory, 'cli');
  mkdirSync(staging);
  for (const entry of ['package.json', 'README.md', 'dist']) {
    cpSync(join(root, 'packages/cutegantt-cli', entry), join(staging, entry), { recursive: true });
  }
  npm(
    [
      'install',
      '--ignore-scripts',
      '--no-save',
      '--package-lock=false',
      '--no-audit',
      '--no-fund',
      join(directory, core.filename),
    ],
    staging,
  );
  mkdirSync(destination, { recursive: true });
  process.stdout.write(
    npm(
      ['pack', '--ignore-scripts', '--pack-destination', destination, '--json', '--silent'],
      staging,
    ),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
