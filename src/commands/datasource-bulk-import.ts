import fs from 'node:fs';
import type { AppContext } from '../core/app.js';
import { extractImportArray, validateImportedProfile } from '../core/datasource-import.js';
import { badInput } from '../core/taproot-error.js';
import { printJson } from '../core/output.js';
import { emptyToUndefined, textUnlessFalsy } from '../core/text-presence.js';

export type DatasourceImportOptions = { file?: string; credentialRef?: string; dryRun: boolean };

type ImportSettings = { defaults: { credentialRef?: string }; dryRun: boolean };
type ImportOutcome = { imported: string } | { failed: { name: string; error: string } };

const UNKNOWN_PROFILE_NAME = '(unknown)';

function importedProfileName(raw: unknown): string {
  const name = typeof raw === 'object' && raw !== null ? textUnlessFalsy(Reflect.get(raw, 'name')) : '';
  return name === '' ? UNKNOWN_PROFILE_NAME : name;
}

function readImportCandidates(rawFile: string | undefined): unknown[] {
  const file = emptyToUndefined(rawFile);
  if (file === undefined) {
    throw badInput('Specify --file <path>.');
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  return extractImportArray(parsed);
}

function importCandidate(ctx: AppContext, raw: unknown, settings: ImportSettings): ImportOutcome {
  const result = validateImportedProfile(raw, settings.defaults);
  if (!result.ok) {
    return { failed: { name: importedProfileName(raw), error: result.error } };
  }
  if (!settings.dryRun) {
    ctx.datasourceStore.save(result.profile);
  }
  return { imported: result.profile.name };
}

export function importDatasources(ctx: AppContext, opts: DatasourceImportOptions): void {
  const candidates = readImportCandidates(opts.file);
  const settings = { defaults: { credentialRef: emptyToUndefined(opts.credentialRef) }, dryRun: opts.dryRun };
  const outcomes = candidates.map((raw) => importCandidate(ctx, raw, settings));
  const imported = outcomes.flatMap((outcome) => ('imported' in outcome ? [outcome.imported] : []));
  const failed = outcomes.flatMap((outcome) => ('failed' in outcome ? [outcome.failed] : []));
  printJson({ ok: failed.length === 0, data: { total: candidates.length, imported, failed, dryRun: opts.dryRun } });
}
