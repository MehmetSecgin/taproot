import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson, renderTable } from '../core/output.js';
import {
  describeDriver,
  diffStatus,
  discoverIdeaConfigRoots,
  findProjectDirUp,
  resolveProjectTarget,
  syncToHistoryFile,
} from '../core/idea-sync.js';
import {
  type CardGrouping,
  diffCardsAgainstProject,
  resolveCardsRoot,
  syncCardsToProject,
} from '../core/idea-cards-sync.js';

function resolveTarget(opts: { target?: string; project?: string }): string {
  if (opts.target) return path.resolve(opts.target);
  const project = opts.project ? path.resolve(opts.project) : findProjectDirUp(process.cwd());
  if (!project) {
    throw new Error(
      `No .idea project found. Pass --project <path> to a directory containing .idea/, or --target <file> for an explicit XML path.`,
    );
  }
  return resolveProjectTarget(project);
}

function resolveProjectDir(opts: { project?: string }): string {
  const project = opts.project ? path.resolve(opts.project) : findProjectDirUp(process.cwd());
  if (!project) {
    throw new Error(
      `No .idea project found. Pass --project <path> to a directory containing .idea/.`,
    );
  }
  return project;
}

function parseGrouping(value: unknown): CardGrouping {
  const raw = String(value || 'service').toLowerCase();
  if (raw === 'service' || raw === 'datasource' || raw === 'intent' || raw === 'flat') return raw;
  throw new Error(`Invalid --group-by '${value}'. Expected service|datasource|intent|flat.`);
}

export function registerIdea(program: Command, getCtx: () => AppContext): void {
  const idea = program
    .command('idea')
    .description('IntelliJ IDEA Database tool sync (write taproot datasources to .idea/dataSources.xml)');

  idea
    .command('path')
    .description('Show detected IntelliJ config roots and the resolved sync target')
    .option('--project <dir>', 'IntelliJ project directory (one containing .idea/)')
    .option('--target <file>', 'Explicit dataSources.xml path')
    .action((opts) => {
      const ctx = getCtx();
      const roots = discoverIdeaConfigRoots();
      let target: string | undefined;
      let targetError: string | undefined;
      try {
        target = resolveTarget(opts);
      } catch (err) {
        targetError = (err as Error).message;
      }
      if (ctx.jsonMode) {
        printJson({
          configRoots: roots.configRoots,
          selectedConfigRoot: roots.selected,
          target,
          targetError,
        });
        return;
      }
      console.log(`IntelliJ config roots:`);
      for (const r of roots.configRoots) console.log(`  ${r}${r === roots.selected ? ' (latest)' : ''}`);
      if (!roots.configRoots.length) console.log(`  (none found)`);
      console.log(`\nResolved sync target: ${target || `(error: ${targetError})`}`);
    });

  idea
    .command('sync')
    .description('Write taproot datasources into the IDEA project dataSources.xml')
    .option('--project <dir>', 'IntelliJ project directory (one containing .idea/)')
    .option('--target <file>', 'Explicit dataSources.xml path')
    .option('--name <name>', 'Sync only a single named datasource')
    .option('--env <env>', 'Filter by env')
    .option('--service <svc>', 'Filter by service')
    .option('--dry-run', 'Print what would be written; do not touch files', false)
    .action(async (opts) => {
      const ctx = getCtx();
      const target = resolveTarget(opts);
      let profiles = ctx.datasourceStore.list();
      if (opts.name) profiles = profiles.filter((p) => p.name === opts.name);
      if (opts.env) profiles = profiles.filter((p) => p.env === opts.env);
      if (opts.service) profiles = profiles.filter((p) => p.service === opts.service);

      const credentialLookup = (ref: string): { username?: string } => {
        // CredentialStore.get is async + may prompt keychain. Sync XML write only needs the username hint.
        // We probe synchronously via the encrypted fallback file via the store but skip if unavailable.
        // For simplicity, leave username empty; IDEA will prompt on first connect.
        void ref;
        return {};
      };

      if (opts.dryRun) {
        const previewed = profiles.map((p) => {
          const d = describeDriver(p);
          if ('skip' in d) return { name: p.name, action: 'skip', reason: d.skip };
          return { name: p.name, action: 'write', driver: d.driverRef, jdbcUrl: d.jdbcUrl };
        });
        if (ctx.jsonMode) printJson({ target, dryRun: true, entries: previewed });
        else {
          console.log(`Target: ${target}`);
          console.log(renderTable(previewed));
        }
        return;
      }

      const result = syncToHistoryFile({ target, profiles, credentialLookup });
      if (ctx.jsonMode) {
        printJson({
          target: result.target,
          written: result.written.map((w) => ({ name: w.managedName, uuid: w.uuid, ideaName: w.ideaName, driver: w.spec.driverRef })),
          preservedForeignEntries: result.preserved,
          skipped: result.skipped,
        });
      } else {
        console.log(`Wrote ${result.written.length} datasource(s) to ${result.target}`);
        if (result.preserved) console.log(`Preserved ${result.preserved} non-taproot entries.`);
        if (result.skipped.length) {
          console.log(`\nSkipped:`);
          for (const s of result.skipped) console.log(`  - ${s.name}: ${s.reason}`);
        }
        console.log(`\nNext: open the project in IntelliJ. Database tool will show entries marked '(taproot)'.`);
      }
    });

  const cards = idea
    .command('cards')
    .description('Sync taproot query cards into the IDEA project as managed .sql files');

  cards
    .command('sync')
    .description('Write query cards to <project>/taproot-cards/ as .sql files (idempotent, drift-aware)')
    .option('--project <dir>', 'IntelliJ project directory (one containing .idea/)')
    .option('--root <dir>', 'Override cards root (default <project>/taproot-cards)')
    .option('--group-by <mode>', 'service|datasource|intent|flat', 'service')
    .option('--datasource <name>', 'Filter cards by datasource')
    .option('--service <svc>', 'Filter cards by owning service (resolved via datasource profile)')
    .option('--intent <intent>', 'Filter cards by intent')
    .option('--force', 'Overwrite locally-edited managed files', false)
    .option('--adopt', 'Strip the taproot marker from locally-edited files (file remains, no longer managed)', false)
    .option('--dry-run', 'Print what would change; do not touch files', false)
    .action((opts) => {
      const ctx = getCtx();
      const projectDir = resolveProjectDir(opts);
      const grouping = parseGrouping(opts.groupBy);
      const profiles = ctx.datasourceStore.list();
      const serviceByDatasource = new Map<string, string>();
      for (const p of profiles) {
        if (p.service) serviceByDatasource.set(p.name, p.service);
      }
      let cardsList = ctx.cardStore.list();
      if (opts.datasource) cardsList = cardsList.filter((c) => c.datasource === opts.datasource);
      if (opts.intent) cardsList = cardsList.filter((c) => c.intent === opts.intent);
      if (opts.service) cardsList = cardsList.filter((c) => c.datasource && serviceByDatasource.get(c.datasource) === opts.service);

      const result = syncCardsToProject({
        projectDir,
        rootDir: opts.root,
        cards: cardsList,
        grouping,
        force: Boolean(opts.force),
        adopt: Boolean(opts.adopt),
        dryRun: Boolean(opts.dryRun),
        serviceFor: (ds) => serviceByDatasource.get(ds),
      });

      if (ctx.jsonMode) {
        printJson({ ...result, dryRun: Boolean(opts.dryRun) });
        return;
      }
      console.log(`Root: ${result.root}${opts.dryRun ? ' (dry-run)' : ''}`);
      console.log(
        renderTable(
          result.written.map((w) => ({ id: w.id, action: w.action, relPath: w.relPath, prev: w.prevRelPath || '' })),
        ),
      );
      if (result.unchanged.length) console.log(`Unchanged: ${result.unchanged.length}`);
      if (result.pruned.length) {
        console.log(`Pruned ${result.pruned.length} file(s):`);
        for (const p of result.pruned) console.log(`  - ${p}`);
      }
      if (result.drifted.length) {
        console.log(`\nDrift detected (skipped):`);
        for (const d of result.drifted) console.log(`  - ${d.id} (${d.relPath}): ${d.reason}`);
        console.log(`Re-run with --force to overwrite or --adopt to keep your edits.`);
      }
      if (result.foreign.length) console.log(`\nForeign files (left alone): ${result.foreign.length}`);
    });

  cards
    .command('status')
    .description('Diff taproot cards against files in <project>/taproot-cards/')
    .option('--project <dir>')
    .option('--root <dir>', 'Override cards root')
    .action((opts) => {
      const ctx = getCtx();
      const projectDir = resolveProjectDir(opts);
      const result = diffCardsAgainstProject({
        projectDir,
        rootDir: opts.root,
        cards: ctx.cardStore.list(),
      });
      if (ctx.jsonMode) {
        printJson(result);
        return;
      }
      console.log(`Root: ${result.root}`);
      console.log(`Matched:    ${result.matched.length}`);
      console.log(`Cards only: ${result.cardsOnly.length}${result.cardsOnly.length ? ` -> ${result.cardsOnly.join(', ')}` : ''}`);
      console.log(`Files only: ${result.filesOnly.length}${result.filesOnly.length ? ` -> ${result.filesOnly.join(', ')}` : ''}`);
      console.log(`Drifted:    ${result.drifted.length}${result.drifted.length ? ` -> ${result.drifted.join(', ')}` : ''}`);
      console.log(`Foreign:    ${result.foreign.length}${result.foreign.length ? ` -> ${result.foreign.join(', ')}` : ''}`);
    });

  cards
    .command('path')
    .description('Print the resolved cards root for the project')
    .option('--project <dir>')
    .option('--root <dir>')
    .action((opts) => {
      const ctx = getCtx();
      const projectDir = resolveProjectDir(opts);
      const root = resolveCardsRoot(projectDir, opts.root);
      if (ctx.jsonMode) printJson({ projectDir, root });
      else console.log(root);
    });

  idea
    .command('status')
    .description('Diff taproot datasources against IDEA project dataSources.xml')
    .option('--project <dir>')
    .option('--target <file>')
    .action((opts) => {
      const ctx = getCtx();
      const target = resolveTarget(opts);
      const xml = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
      const diff = diffStatus(xml, ctx.datasourceStore.list());
      const payload = { target, ...diff };
      if (ctx.jsonMode) printJson(payload);
      else {
        console.log(`Target: ${target}`);
        console.log(`Matched: ${diff.matched.length}`);
        console.log(`In taproot only: ${diff.taprootOnly.length}${diff.taprootOnly.length ? ` -> ${diff.taprootOnly.join(', ')}` : ''}`);
        console.log(`In IDEA only:    ${diff.ideaOnly.length}${diff.ideaOnly.length ? ` -> ${diff.ideaOnly.join(', ')}` : ''}`);
      }
    });
}
