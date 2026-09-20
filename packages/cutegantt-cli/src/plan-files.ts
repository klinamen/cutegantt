import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename, extname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { ProjectPlan, holidaysFileSchema, parseModel } from 'cutegantt';
import type { PlanError } from 'cutegantt';

const EXTENSIONS = new Set(['.json', '.yaml', '.yml']);

export function planStem(file: string) {
  return basename(file, extname(file));
}

function readDocument(file: string): unknown {
  const extension = extname(file).toLowerCase();
  if (!EXTENSIONS.has(extension))
    throw new Error(`Unsupported file extension: ${file}. Use .json, .yaml or .yml.`);
  try {
    const source = readFileSync(file, 'utf8');
    if (extension === '.json') return JSON.parse(source);
    else {
      const document = parseDocument(source, {
        version: '1.2',
        schema: 'core',
        uniqueKeys: true,
        stringKeys: true,
      });
      if (document.errors.length || document.warnings.length) {
        throw document.errors[0] ?? document.warnings[0];
      }
      return document.toJS({ maxAliasCount: 100 });
    }
  } catch (error) {
    throw new Error(
      `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function loadHolidays(directory: string) {
  let files;
  try {
    files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[^_]+_\d{4}\.(json|ya?ml)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    throw new Error(
      `Cannot read ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!files.length) throw new Error(`No annual calendar files found in ${directory}.`);
  return files.flatMap((name) => {
    const file = join(directory, name);
    const document = readDocument(file);
    try {
      return parseModel(holidaysFileSchema, document).holydays;
    } catch (caught) {
      const error: PlanError = caught instanceof Error ? caught : new Error(String(caught));
      error.file = file;
      throw error;
    }
  });
}

class PlanDocument {
  #data;

  constructor(file: string) {
    this.#data = readDocument(file);
  }

  get project() {
    return this.#data && typeof this.#data === 'object' && 'project' in this.#data
      ? this.#data.project
      : undefined;
  }
  toPlan() {
    return new ProjectPlan(this.#data);
  }
}

export function loadPlan(file: string) {
  return new PlanDocument(file).toPlan();
}

export function findPrevious(file: string, currentInput: unknown = loadPlan(file)) {
  const current = ProjectPlan.from(currentInput);
  const absolute = resolve(file);
  const stem = planStem(absolute);
  const candidates = readdirSync(dirname(absolute))
    .filter(
      (candidate) => EXTENSIONS.has(extname(candidate).toLowerCase()) && planStem(candidate) < stem,
    )
    .sort((left, right) =>
      planStem(left) < planStem(right) ? 1 : planStem(left) > planStem(right) ? -1 : 0,
    );
  let selected;
  for (const candidate of candidates) {
    if (selected && planStem(candidate) !== planStem(selected)) break;
    const path = join(dirname(absolute), candidate);
    let document;
    try {
      document = new PlanDocument(path);
    } catch {
      continue;
    }
    if (document.project !== current.project) continue;
    document.toPlan();
    if (selected)
      throw new Error(
        `Multiple previous files for ${planStem(candidate)}. Specify --previous explicitly.`,
      );
    selected = path;
  }
  if (selected) return selected;
  throw new Error(
    `No previous version for "${current.project}". Specify --previous or use --mode clean.`,
  );
}
