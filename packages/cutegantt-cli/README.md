# cutegantt-cli

Node.js >=24 CLI for `cutegantt`. The installed executable is `cutegantt`; input and previous plans accept JSON, YAML and YML, case-insensitively.

```sh
cutegantt plans/atlas-2026-09-18.json --mode both --lang it --out-dir output
cutegantt plans/current.yaml --mode diff --previous plans/baseline.json --notes inline
cutegantt --schema --lang en
cutegantt --help
```

The library dependency is the public `cutegantt` package. The CLI archive bundles the compiled core and its runtime dependencies, so installing the CLI does not require a separate core archive or a published core version. In the source workspace, run `node packages/cutegantt-cli/dist/cli.js` after `npm run build`.

## Global Installation

With Node.js >=24, run these commands from the repository root (`src/cutegantt`):

```sh
npm ci
npm run pack:cli
npm install -g ./cutegantt-cli-1.1.0.tgz
cutegantt --help
```

Use `npm run pack:cli`, not a direct `npm pack --workspace cutegantt-cli`, to produce the distributable archive. The packaging script builds both packages and stages the CLI and a real core package in a temporary directory for npm's `bundleDependencies`; workspace symlinks alone are not bundled. The staging directory is removed afterward, without changing workspace dependency resolution. Package from this source workspace, not from an installed CLI. YAML and Commander remain normal dependencies installed automatically by npm from the registry or cache; the archive is not a fully offline distribution.

The executable is named `cutegantt`, while the CLI package is named `cutegantt-cli`. Ensure npm's global executable directory is on `PATH` (`$(npm prefix -g)/bin` on macOS/Linux). With a Node version manager, install using the Node version you intend to run.

After the generated CLI archive is published to your configured registry, installation becomes `npm install -g cutegantt-cli`. Publish the generated archive rather than the workspace directory to retain its bundled core. This repository has not published the packages.

The packaging test installs only the CLI archive globally into a temporary prefix and invokes `cutegantt` through `PATH` from another directory, checking the bundled core, help, schema and generated files without modifying your normal global installation.

## Standalone Executable

From the source repository root, run `npm run build:sea`. On macOS ARM64 the result is `dist/sea/darwin-arm64/cutegantt`; it can run directly without Node.js, npm or external JavaScript dependencies. Other platforms use `dist/sea/<platform>-<arch>/cutegantt` (with `.exe` on Windows); those builds have not been verified here. This builds for the current runtime's platform and architecture, not a cross-platform executable.

Use `npm run test:sea` to verify execution without Node on PATH. macOS builds require `codesign` and use an ad-hoc signature, not Developer ID signing or notarization. The npm installation workflow remains available independently.

The repository's `SEA Binaries` GitHub Actions workflow builds and tests natively on macOS Intel/Apple Silicon and Linux x64/ARM64 (glibc). Successful jobs upload a target-specific `.tar.gz`, SHA-256 checksum and build metadata. Extract the archive to preserve executable permissions. Windows and Alpine/musl are not included; macOS downloads are not notarized. The workflow has not yet been run on GitHub.

## Options

Run `cutegantt --version` (or `cutegantt -V`) to print the CLI package version and exit successfully, without an input plan or generated files. This also works in the standalone executable; rebuild it after updating the package version.

Commander generates the English help directly from option descriptions, choices and defaults. All CLI diagnostics and operational messages are English; `--lang` affects generated content only. A required option consumes the next token as its value even if it begins with a dash. Use `--` before positional filenames beginning with a dash. Positive/negative boolean pairs use the last supplied value; omitting both preserves the plan setting. Calling the exported `main()` prints diagnostics and throws errors rather than terminating the host process; displaying help returns normally.

| Flag                                    | Meaning                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `--lang en\|it`                         | Generated chart, report and schema language; default `en`                           |
| `--mode clean\|diff\|both`              | Output mode; default `clean`                                                        |
| `--previous file`                       | Explicit baseline; otherwise lexical predecessor in the same project                |
| `--out-dir directory`                   | Destination; default `output`                                                       |
| `--width pixels`                        | Output width, 1000 through 8000; default 1600 or plan style                         |
| `--theme light\|dark`                   | Presentation colors; SVG remains transparent                                        |
| `--font family`                         | SVG font family override                                                            |
| `--notes separate\|inline`              | Comparison notes placement; default `separate`                                      |
| `--relative-time`, `--no-relative-time` | Display overrides; last supplied flag wins                                          |
| `--group-summary`, `--no-group-summary` | Group summary overrides; last supplied flag wins                                    |
| `--holidays-dir directory`              | Annual calendars named `name_YYYY.json`, `.yaml` or `.yml`                          |
| `--shade-weekends`                      | Shade Saturdays and Sundays                                                         |
| `--holiday-labels`                      | Render holiday labels                                                               |
| `--force`                               | Allow overwriting existing outputs                                                  |
| `--schema`                              | Print input JSON Schema only; accepts `--lang` and `--help`, no rendering arguments |
| `-h`, `--help`                          | Display generated English help without rendering                                    |

Use `--no-header` to omit the visible title, subtitle, summary metrics and header decorations from all SVG outputs, including separate comparison notes. The chart closes the space left by the header; axes, legends and accessibility metadata remain present. The header is enabled by default, and Markdown/JSON reports are unaffected.

```sh
cutegantt plans/current.yaml --no-header
```

### Pagination

`--page-size <count>` limits activities per SVG page. It accepts a non-negative safe integer and defaults to `0`, which disables pagination. `--pages <selection>` defaults to `0` (all pages); use `p` for one page or `p-q` for an inclusive range, numbered from 1. Decimal digits only are accepted; invalid, reversed or out-of-bounds selections fail before writing files. With pagination disabled, only `0`, `1` and `1-1` are valid selections.

```sh
cutegantt plans/current.yaml --page-size 10 --pages 2-4 --no-header
```

Every chart page repeats the full timeline. Tasks, milestones and removed comparison rows each count as one activity; group headings and baseline overlays do not. Pages follow the existing group-first display order, repeating group headings where a group continues. Colors, group summaries and header metrics remain global. Heights depend on content rather than a paper format.

Paginated charts are named `current_1.svg`, `current_2.svg`, or `current_1.diff.svg` for comparisons. The numeric suffix is present even for a single page when `--page-size` is positive. Selecting pages preserves their original numbers. With `--page-size 0`, the existing filenames remain unchanged.

Clean and diff are paginated independently because removed rows may add pages to the comparison. In `--mode both`, an explicit selection must exist in both outputs. Inline notes follow the activities on each page with global change numbers. The single `current.notes.svg` register and `current.changes.md`/`.json` reports always cover the complete comparison; the separate register has no timeline and is not paginated.

All output paths are checked before writing. Shared notes and reports also participate in overwrite checks for partial exports. `--force` overwrites only the emitted files and does not delete stale pages or unselected files.

Timeline origin, unit duration/name, visible range, markers, week numbers, truncation and date locale are configured in the input, not new flags. Removed legacy flags remain rejected. Commander still validates syntax and option choices when `--help` is present. CLI help and diagnostics no longer use the core language catalogs.

Clean mode writes `<stem>.svg`. Diff mode writes `<stem>.diff.svg`, `<stem>.changes.md`, `<stem>.changes.json` and, unless inline notes are requested, `<stem>.notes.svg`. Both mode also writes the clean chart. Only the last input extension is removed from the stem. Paths and the selected baseline are reported on stdout; errors go to stderr with exit code 1. Existing output files are protected unless `--force` is given.

Holiday files retain the exact key `holydays` with entries `{ start, end, label }`. YAML uses the core 1.2 schema, unique string keys, a maximum alias count of 100 and rejection of parser warnings or errors. Baseline discovery validates matching projects, ignores same-version copies and rejects ambiguous earlier stems.

The package entrypoint also exports `main(args)`, `loadPlan(file)`, `loadHolidays(directory)`, `findPrevious(file, current?)` and `planStem(file)`. Importing the package does not execute the CLI. Rendering and comparison APIs belong to `cutegantt`.
