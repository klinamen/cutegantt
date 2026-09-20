# cutegantt workspace

The Node project root is this directory, `src/cutegantt`. Run npm commands here, not in the enclosing repository or `src` directory. Node.js >=24 is required for development and the CLI.

```text
src/cutegantt/
  package.json
  package-lock.json
  tsconfig.base.json
  packages/
    cutegantt/       Browser-safe ESM library
    cutegantt-cli/   Node CLI; executable: cutegantt
  test/             Migrated regression tests, parity, browser and packaging checks
```

The original `gantt` directory remains unchanged. `src/cutegantt-app` is independent and outside the workspaces. No Git repository or release is created by the migration.

## Development

```sh
cd src/cutegantt
npm ci
npx playwright install chromium
npm run build
npm run check
npm test
```

Build compiles the library before the CLI. Both packages use strict TypeScript, ESM, explicit public exports and declaration output. The library has no Node ambient types. The DOM type library supplies standard Web types required by dependency declarations; the library itself does not access the DOM.

`npm run check` runs `format:check`, `lint` and `typecheck` without modifying sources. Run `build` first on a fresh checkout so the CLI can resolve the core declarations. `npm run format` explicitly formats supported source, test, script, configuration and documentation files with Prettier (single quotes, 100-column target). Generated output, dependencies, fixture data and the npm lockfile are excluded from formatting.

ESLint uses the recommended JavaScript and typescript-eslint rules, with zero warnings allowed; type-aware lint rules are not enabled. Prettier runs separately, and eslint-config-prettier disables conflicting stylistic rules. The schema-backed models in `packages/cutegantt/src/model.ts` intentionally merge interfaces and classes initialized through validated data, so only that file permits declaration merging and empty derived interfaces. Browser globals are enabled only for the Playwright test. These tools are development dependencies and do not enter the CLI or SEA runtime.

```sh
node packages/cutegantt-cli/dist/cli.js test/fixtures/atlas-2026-09-18.json --mode both
node packages/cutegantt-cli/dist/cli.js --schema --lang it
npm run test:parity
npm run test:browser
npm run test:pack
```

`npm test` builds and runs 66 top-level tests: all 58 migrated legacy cases plus 1 Commander regression, 3 parity, 2 architecture/browser, 1 isolated packaging and 1 SEA test. The parity suite reads the unchanged legacy implementation in `../../gantt`; it requires its original dependencies to be available. The packaging suite uses temporary directories outside the workspace, npm's registry/cache and the installed TypeScript compiler. Chromium is required by the browser suite. The SEA test builds a native executable and requires `codesign` on macOS. Tests do not inspect or constrain the independent sibling app directory.

## Package Boundaries

`cutegantt` owns validation, normalized models, comparisons, timeline and calendar calculations, SVG and Markdown rendering. English and Italian catalogs are compiled modules: no runtime filesystem or fetch is needed. Language is selected per call with fixed translators, not a globally changed language. Browser verification bundles the entire public API with `platform: browser` and executes it in Chromium without Node polyfills, at desktop and mobile viewport sizes, including SVG rasterization.

`cutegantt-cli` owns filesystem access, YAML parsing, document discovery, argument parsing, output names and writing. It imports the library only through `cutegantt`, never sibling source paths. Importing `cutegantt-cli` exposes `main`, `loadPlan`, `loadHolidays`, `findPrevious` and `planStem` without executing the command. Only the bin entrypoint runs `main`.

## Compatibility

Existing rendering flags, JSON/YAML/YML inputs, localized schema descriptions and output formats are retained. The CLI interface is English-only: Commander generates `-h, --help` from the option definitions and reports syntax and value errors. Application diagnostics and operational messages are also English. `--lang` selects the language of generated charts, reports and schema descriptions only. Obsolete CLI help and error entries have been removed from both language catalogs; core validation and output translations remain available. Old direct `.mjs` module import paths are not a supported compatibility surface.

Required option values follow Commander semantics, including accepting a following token beginning with a dash as a value. If both positive and negative boolean flags are supplied, the last one wins; omitted flags preserve the plan settings. Invalid choices or syntax are rejected during parsing, even alongside `--help`. Importing and calling `main()` reports and throws on failure without exiting the caller, and returns normally after displaying help; only the executable sets an exit code. File and field context are preserved in application diagnostics.

Dates remain strict ISO calendar dates with UTC arithmetic. Task ends are inclusive in documents and exclusive in internal timestamps. Unit indices resolve against each plan's own origin. The `today` marker intentionally uses the machine-local date. Relative display never rewrites structured ISO dates. Holiday documents retain the historical `holydays` key; shading does not reschedule tasks. Overlapping holiday intervals merge, adjacent intervals remain separate.

Baseline discovery retains lexical stems, project filtering, mixed extensions and ambiguity checks. Overwrite checks remain non-atomic, as in the original CLI. JSON output adds file metadata in the CLI; the library does not know filenames.

## Packaging

```sh
npm run build
npm pack --workspace cutegantt
npm run pack:cli
```

The core archive is for consumers of the standalone library. To install the CLI globally, only its own archive is needed:

```sh
npm install -g ./cutegantt-cli-1.0.0.tgz
cutegantt --help
```

Use Node.js >=24 and ensure npm's global executable directory is on `PATH`. The `pack:cli` script builds both packages and stages the CLI and compiled core in a temporary directory for npm's `bundleDependencies`, then removes that directory. Its archive includes the core and its runtime dependencies, without merging their code or changing workspace dependency resolution. YAML and Commander remain normal registry/cache dependencies automatically installed by npm. Use this script rather than `npm pack --workspace cutegantt-cli`, which does not bundle workspace symlinks. An alternate output directory can be passed with `npm run pack:cli -- --pack-destination /path/to/output`.

Run packaging from this source workspace and publish the generated CLI archive, not the workspace directory. Once that archive is published to your configured registry, use `npm install -g cutegantt-cli`.

The packaging test verifies CLI-only global installation in a temporary prefix, command lookup through `PATH`, archive contents, localized output, declarations in NodeNext and Bundler consumers without Node types, browser bundling and blocked deep imports. It removes temporary tarballs on completion. No npm publication is performed; project license and release metadata must be decided before publishing.

## Standalone Executable (SEA)

```sh
npm run build:sea
./dist/sea/darwin-arm64/cutegantt --help
npm run test:sea
```

The output is `dist/sea/<platform>-<arch>/cutegantt` (`cutegantt.exe` on Windows), based on the running Node executable. Override it with `npm run build:sea -- --output /path/to/cutegantt`. Build using Node.js >=24. This is a native-platform build, not cross-compilation; build each release on its target OS and architecture. Only macOS ARM64 has been verified here; Linux and Windows builds are not validated.

The SEA includes the Node runtime, bundled CLI, core, YAML, Commander and translation catalogs. The resulting file needs no external Node installation, JavaScript files or node_modules. The source packages remain ESM; only the embedded SEA bundle is CommonJS. esbuild bundles the dependencies, Node generates the SEA blob, and postject injects it into a copy of the same runtime. Build intermediates are removed automatically.

On macOS, `codesign` must be available; the build removes the original signature, applies an ad-hoc signature and verifies it. This is not a Developer ID signature or notarization. Public distribution signing/notarization is a separate release step. SEA is a Node feature under active development; runtime updates require rebuilding the executable.

The SEA test copies the executable into an isolated temporary directory, runs it with no Node on PATH, and compares help, localized schema, invalid-argument errors and JSON/YAML rendering against the normal CLI.

## GitHub Actions SEA Builds

The workflow `.github/workflows/sea.yml` belongs to this repository: publish the contents of `src/cutegantt` as the Git repository root, not the enclosing project. It runs on pushes, pull requests and manual dispatch, with four native targets:

| Target              | GitHub runner      |
| ------------------- | ------------------ |
| macOS Intel         | `macos-15-intel`   |
| macOS Apple Silicon | `macos-15`         |
| Linux x64 (glibc)   | `ubuntu-24.04`     |
| Linux ARM64 (glibc) | `ubuntu-24.04-arm` |

Each job installs Node 24 and locked dependencies, checks the runtime architecture, builds the SEA, runs `npm run check` (formatting, lint and typecheck) and all 59 core/CLI regression tests, then tests the exact distributable with Node absent from PATH. `CUTEGANTT_SEA_BINARY=dist/sea/darwin-arm64/cutegantt npm run test:sea` selects an existing binary instead of rebuilding it.

Successful jobs upload `cutegantt-<platform>-<arch>` artifacts containing a `.tar.gz`, SHA-256 checksum and build metadata (Node version and commit). The archive preserves executable permissions. Artifacts are retained for 14 days; no GitHub Release or npm publication occurs. Extract the archive before running `cutegantt`.

These Linux builds target glibc, not Alpine/musl; compatibility with older distributions is not tested. macOS artifacts use ad-hoc signing without notarization. Windows is not included. Browser, packaging and legacy-parity suites remain separate local commands; this workflow does not require the external legacy `gantt` directory.

The workflow has been prepared locally but has not been executed on GitHub. Other target binaries are produced and validated only when their jobs run successfully; local validation so far covers macOS ARM64.

## Implementation References

Runtime dependencies include Zod for validation and input JSON Schema, i18next for fixed-language translation, parse-duration for duration conversion, and YAML plus Commander only in the CLI. Commander provides argument parsing, generated English help, declarative choices and diagnostics with built-in TypeScript declarations. Only Gantt-specific rules remain in application code. Native `Intl`, `Date`, `node:test` and npm workspaces cover the remaining capabilities. Build scripts still use `node:util.parseArgs`. TypeScript, esbuild, postject and Playwright are development-only tools.

Official reference locations:

```text
https://nodejs.org/download/release/v24.0.0/docs/api/util.html#utilparseargsconfig
https://nodejs.org/download/release/v24.0.0/docs/api/packages.html
https://docs.npmjs.com/cli/v11/using-npm/workspaces/
https://docs.npmjs.com/cli/v11/commands/npm-pack/
https://www.typescriptlang.org/tsconfig/strict.html
https://www.typescriptlang.org/docs/handbook/modules/reference.html
https://zod.dev/json-schema
https://www.i18next.com/overview/api
https://eemeli.org/yaml/
https://github.com/jkroso/parse-duration
https://esbuild.github.io/api/
https://playwright.dev/docs/browsers
```
