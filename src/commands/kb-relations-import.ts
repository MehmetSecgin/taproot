import fs from 'node:fs';
import type { AppContext } from '../core/app.js';
import { printSuccess } from '../core/output.js';
import { normalizeRelations } from '../core/relations.js';
import { errorText } from '../core/error-text.js';

function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${errorText(error)}`, { cause: error });
  }
}

function readRelationsFile(file: string): unknown[] {
  if (!fs.existsSync(file)) {
    throw new Error(`Relations file not found: ${file}`);
  }
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseJson(text, file);
  if (!Array.isArray(parsed)) {
    throw new TypeError('Relations file must be a JSON array of relation objects.');
  }
  return parsed;
}

export function importRelations(ctx: AppContext, file: string): void {
  const parsed = readRelationsFile(file);
  const normalized = normalizeRelations(parsed);
  const skipped = parsed.length - normalized.length;
  const result = ctx.kbStore.promoteRelations(normalized);
  printSuccess({ added: result.added, total: result.total, skipped });
}
