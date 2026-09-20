import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBuiltin } from 'node:module';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { inject } from 'postject';

const root = fileURLToPath(new URL('../', import.meta.url));
const filename = process.platform === 'win32' ? 'cutegantt.exe' : 'cutegantt';
const { values } = parseArgs({
  options: {
    output: {
      type: 'string',
      default: join(root, 'dist/sea', `${process.platform}-${process.arch}`, filename),
    },
  },
});
const output = resolve(values.output);
if (output === process.execPath) throw new Error('Output must not replace the Node executable.');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js >=24 is required.');
const npmPath = process.env.npm_execpath;
if (!npmPath) throw new Error('Run this script with npm run build:sea.');
execFileSync(process.execPath, [npmPath, 'run', 'build'], { cwd: root, stdio: 'inherit' });

const staging = mkdtempSync(join(tmpdir(), 'cutegantt-sea-'));
try {
  const main = join(staging, 'cli.cjs');
  const bundle = await build({
    entryPoints: [join(root, 'packages/cutegantt-cli/dist/cli.js')],
    outfile: main,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    metafile: true,
  });
  for (const artifact of Object.values(bundle.metafile.outputs)) {
    for (const dependency of artifact.imports) {
      if (dependency.external && !isBuiltin(dependency.path))
        throw new Error(`Unbundled dependency: ${dependency.path}`);
    }
  }
  const blob = join(staging, 'sea.blob');
  const config = join(staging, 'sea.json');
  writeFileSync(
    config,
    JSON.stringify({
      main,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    }),
  );
  execFileSync(process.execPath, ['--experimental-sea-config', config], {
    cwd: staging,
    stdio: 'inherit',
  });
  const executable = join(staging, filename);
  copyFileSync(process.execPath, executable);
  chmodSync(executable, 0o755);
  if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', executable]);
  await inject(executable, 'NODE_SEA_BLOB', readFileSync(blob), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
  });
  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--sign', '-', executable]);
    execFileSync('codesign', ['--verify', '--strict', executable]);
  }
  execFileSync(executable, ['--help'], { cwd: staging, stdio: 'pipe' });
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(executable, output);
  chmodSync(output, 0o755);
  console.log(`SEA executable: ${output}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
