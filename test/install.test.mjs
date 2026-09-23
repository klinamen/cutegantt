import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));
const binary = '#!/bin/sh\nprintf "CuteGantt test binary\\n"\n';

function fixture(context, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cutegantt-install-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const tools = join(directory, 'tools');
  const home = join(directory, 'home');
  const temporary = join(directory, 'temporary');
  const source = join(directory, 'source');
  const destination = join(home, '.local/bin');
  for (const path of [tools, home, temporary, source, destination]) mkdirSync(path, { recursive: true });
  for (const command of ['tar', 'mktemp', 'mkdir', 'chmod', 'mv', 'rm', 'shasum']) {
    const located = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', command], {
      encoding: 'utf8',
    });
    assert.equal(located.status, 0, `Missing test prerequisite: ${command}`);
    symlinkSync(located.stdout.trim(), join(tools, command));
  }
  if (options.sha256sum) {
    writeFileSync(join(tools, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n', { mode: 0o755 });
  }
  if (options.noChecksumTool) rmSync(join(tools, 'shasum'));
  writeFileSync(join(tools, 'uname'), '#!/bin/sh\ncase "$1" in -s) printf "%s\\n" "$MOCK_OS";; -m) printf "%s\\n" "$MOCK_ARCH";; esac\n', { mode: 0o755 });
  writeFileSync(join(tools, 'getconf'), '#!/bin/sh\n[ "$MOCK_LIBC" = glibc ] || exit 1\nprintf "glibc 2.39\\n"\n', { mode: 0o755 });
  writeFileSync(join(tools, 'curl'), `#!${process.execPath}
const { appendFileSync, copyFileSync } = require('node:fs');
const args = process.argv.slice(2);
const url = args.at(-1);
appendFileSync(process.env.MOCK_LOG, JSON.stringify(args) + '\\n');
if (args[0] !== '-q' || args[args.indexOf('--proto') + 1] !== '=https' || args[args.indexOf('--proto-redir') + 1] !== '=https') process.exit(90);
if (url.endsWith('/releases/latest')) {
  process.stdout.write(process.env.MOCK_LATEST);
} else {
  if (process.env.MOCK_MISSING === 'yes') process.exit(22);
  if (!url.startsWith('https://github.com/klinamen/cutegantt/releases/download/v1.2.3/')) process.exit(91);
  copyFileSync(url.endsWith('.sha256') ? process.env.MOCK_CHECKSUM : process.env.MOCK_ARCHIVE, args[args.indexOf('--output') + 1]);
}
`, { mode: 0o755 });
  const archive = join(directory, 'release.tar.gz');
  const member = options.invalidArchive ? 'unexpected' : 'cutegantt';
  writeFileSync(join(source, member), options.nonRunnable ? '#!/bin/sh\nexit 1\n' : binary);
  const packed = spawnSync('tar', ['-czf', archive, '-C', source, member], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const target = options.target ?? 'darwin-arm64';
  const digest = options.corrupt ? '0'.repeat(64) : createHash('sha256').update(readFileSync(archive)).digest('hex');
  const checksum = join(directory, 'release.sha256');
  writeFileSync(checksum, `${digest}  ${options.wrongName ? 'wrong.tar.gz' : `cutegantt-${target}.tar.gz`}\n`);
  const log = join(directory, 'requests.jsonl');
  writeFileSync(log, '');
  const executable = join(destination, 'cutegantt');
  writeFileSync(executable, 'previous installation');
  const run = (args = [], piped = false) => spawnSync('/bin/sh', piped ? ['-s', '--', ...args] : [installer, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    input: piped ? readFileSync(installer, 'utf8') : undefined,
    env: {
      ...process.env,
      PATH: tools,
      HOME: home,
      TMPDIR: temporary,
      MOCK_OS: options.os ?? 'Darwin',
      MOCK_ARCH: options.arch ?? 'arm64',
      MOCK_LIBC: options.libc ?? 'glibc',
      MOCK_ARCHIVE: archive,
      MOCK_CHECKSUM: checksum,
      MOCK_LOG: log,
      MOCK_MISSING: options.missing ? 'yes' : 'no',
      MOCK_LATEST: options.latest ?? 'https://github.com/klinamen/cutegantt/releases/tag/v1.2.3',
    },
  });
  return { run, directory, destination, executable, temporary, log };
}

for (const [os, arch, target] of [
  ['Darwin', 'x86_64', 'darwin-x64'],
  ['Darwin', 'arm64', 'darwin-arm64'],
  ['Linux', 'x86_64', 'linux-x64'],
  ['Linux', 'aarch64', 'linux-arm64'],
]) {
  test(`installer selects ${target}, pins latest and replaces an existing binary`, context => {
    const setup = fixture(context, { os, arch, target, sha256sum: os === 'Linux' });
    const result = setup.run();
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(setup.executable, 'utf8'), binary);
    assert.match(result.stdout, /Add this directory to your shell PATH/);
    const requests = readFileSync(setup.log, 'utf8').trim().split('\n').map(line => JSON.parse(line).at(-1));
    assert.deepEqual(requests, [
      'https://github.com/klinamen/cutegantt/releases/latest',
      `https://github.com/klinamen/cutegantt/releases/download/v1.2.3/cutegantt-${target}.tar.gz`,
      `https://github.com/klinamen/cutegantt/releases/download/v1.2.3/cutegantt-${target}.tar.gz.sha256`,
    ]);
    assert.deepEqual(readdirSync(setup.temporary), []);
    assert.deepEqual(readdirSync(setup.destination), ['cutegantt']);
  });
}

test('installer accepts piped input, explicit version and a directory containing spaces', context => {
  const setup = fixture(context);
  const destination = join(setup.directory, 'custom bin');
  const result = setup.run(['--version', 'v1.2.3', '--dir', destination], true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(destination, 'cutegantt'), 'utf8'), binary);
  assert.doesNotMatch(readFileSync(setup.log, 'utf8'), /releases\/latest/);
  assert.equal(readFileSync(setup.executable, 'utf8'), 'previous installation');
});

for (const [name, options, args, message] of [
  ['corrupt checksum', { corrupt: true }, [], /SHA-256 mismatch/],
  ['wrong checksum filename', { wrongName: true }, [], /Checksum filename mismatch/],
  ['missing assets', { missing: true }, [], /assets may still be building/],
  ['unexpected archive entries', { invalidArchive: true }, [], /Archive must contain only/],
  ['incompatible binary', { nonRunnable: true }, [], /Binary cannot run/],
  ['unsupported OS', { os: 'FreeBSD' }, [], /Unsupported operating system/],
  ['unsupported architecture', { arch: 'riscv64' }, [], /Unsupported architecture/],
  ['musl Linux', { os: 'Linux', libc: 'musl' }, [], /Linux requires glibc/],
  ['missing checksum utility', { noChecksumTool: true }, [], /verification requires/],
  ['unexpected latest redirect', { latest: 'https://example.com/v1.2.3' }, [], /did not return a release tag/],
  ['unsafe tag', {}, ['--version', '../other'], /Invalid release tag/],
  ['missing option value', {}, ['--dir'], /Missing value/],
  ['unknown option', {}, ['--unknown'], /Unknown option/],
]) {
  test(`installer rejects ${name} and preserves the previous installation`, context => {
    const setup = fixture(context, options);
    const result = setup.run(args);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(readFileSync(setup.executable, 'utf8'), 'previous installation');
    assert.deepEqual(readdirSync(setup.temporary), []);
    assert.deepEqual(readdirSync(setup.destination), ['cutegantt']);
  });
}

test('installer refuses to replace a symlink', context => {
  const setup = fixture(context);
  rmSync(setup.executable);
  const untouched = join(setup.directory, 'untouched');
  writeFileSync(untouched, 'original');
  symlinkSync(untouched, setup.executable);
  const result = setup.run(['--version', 'v1.2.3']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /directory or symlink/);
  assert.equal(readFileSync(untouched, 'utf8'), 'original');
  assert.deepEqual(readdirSync(setup.temporary), []);
});

test('installer help does not download or install anything', context => {
  const setup = fixture(context);
  const result = setup.run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.equal(readFileSync(setup.log, 'utf8'), '');
  assert.ok(existsSync(setup.executable));
});