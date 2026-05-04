import { Command } from 'commander';
import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { AppContext } from '../core/app.js';
import { printJson } from '../core/output.js';
import type { OnboardRunResult, OnboardStep } from '../core/onboarding.js';
import { kbIsAvailable, runOnboarding, saveManualDatasource } from '../core/onboarding.js';

class PromptSession {
  private readonly rl = input.isTTY ? createInterface({ input, output }) : null;
  private readonly scriptedAnswers = input.isTTY ? [] : fs.readFileSync(0, 'utf8').split(/\r?\n/);
  private index = 0;

  async ask(prompt: string): Promise<string> {
    if (this.rl) return (await this.rl.question(prompt)).trim();
    process.stdout.write(prompt);
    const answer = this.scriptedAnswers[this.index] ?? '';
    this.index += 1;
    process.stdout.write('\n');
    return answer.trim();
  }

  close(): void {
    this.rl?.close();
  }
}

async function askYesNo(session: PromptSession, prompt: string, defaultValue = true): Promise<boolean> {
  const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await session.ask(`${prompt}${suffix}`)).toLowerCase();
  if (!answer) return defaultValue;
  return answer === 'y' || answer === 'yes';
}

async function askText(session: PromptSession, prompt: string, required = false): Promise<string> {
  while (true) {
    const answer = await session.ask(`${prompt}: `);
    if (answer || !required) return answer;
  }
}

async function askChoice(session: PromptSession, prompt: string, choices: string[], defaultValue?: string): Promise<string> {
  const rendered = choices.join('/');
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await session.ask(`${prompt} (${rendered})${suffix}: `)).toLowerCase();
    const picked = answer || defaultValue || '';
    if (choices.includes(picked)) return picked;
  }
}

function printStep(step: OnboardStep): void {
  console.log(`\n${step.title}`);
  console.log(step.summary);
  if (step.details?.length) {
    for (const detail of step.details) console.log(`- ${detail}`);
  }
  if (step.nextAction) console.log(`next: ${step.nextAction}`);
}

function groupByStatus(steps: OnboardStep[]): { done: OnboardStep[]; notDone: OnboardStep[]; skipped: OnboardStep[] } {
  return {
    done: steps.filter((step) => step.status === 'done'),
    notDone: steps.filter((step) => step.status === 'blocked' || step.status === 'failed'),
    skipped: steps.filter((step) => step.status === 'skipped'),
  };
}

function printFinalSummary(result: OnboardRunResult): void {
  const grouped = groupByStatus(result.steps);
  console.log('\nDone');
  if (!grouped.done.length) console.log('- Nothing completed yet.');
  for (const step of grouped.done) console.log(`- ${step.summary}`);

  console.log('\nNot done yet');
  if (!grouped.notDone.length) console.log('- Nothing is currently blocked.');
  for (const step of grouped.notDone) console.log(`- ${step.summary}`);

  console.log('\nSkipped by choice');
  if (!grouped.skipped.length) console.log('- Nothing was skipped.');
  for (const step of grouped.skipped) console.log(`- ${step.summary}`);

  console.log('\nNext commands');
  if (!result.nextActions.length) console.log('- No follow-up commands are required right now.');
  for (const action of result.nextActions) console.log(`- ${action}`);
}

export function registerOnboard(program: Command, getCtx: () => AppContext): void {
  program
    .command('onboard')
    .description('Interactive onboarding flow for first-time TapRoot setup')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--yes-local', 'approve local setup checks', false)
    .option('--yes-access', 'approve access tooling checks', false)
    .option('--yes-live', 'approve live environment checks', false)
    .action(async (opts) => {
      const ctx = getCtx();
      if (ctx.jsonMode) {
        const target = opts.env && opts.service
          ? { env: String(opts.env), namespace: opts.namespace ? String(opts.namespace) : undefined, service: String(opts.service) }
          : undefined;
        const out = await runOnboarding(ctx, {
          approveLocal: Boolean(opts.yesLocal),
          approveAccess: Boolean(opts.yesAccess),
          approveLive: Boolean(opts.yesLive),
          target,
          runValidation: Boolean(opts.yesLive && target),
        });
        printJson(out);
        return;
      }

      console.log('TapRoot onboarding');
      console.log('I can help with local setup, access checks, and live environment checks. I will ask before I run each group.');
      const session = new PromptSession();
      try {
        const approveLocal = Boolean(opts.yesLocal) || (await askYesNo(session, 'Run local setup checks and create starter config if needed?', true));
        const approveAccess = Boolean(opts.yesAccess) || (await askYesNo(session, 'Run local access checks like tool detection and session status?', true));
        const wantsTarget = Boolean(opts.env && opts.service) || (await askYesNo(session, 'Do you want to set up a specific env/service target now?', true));
        const target = wantsTarget
          ? {
              env: String(opts.env || (await askText(session, 'Environment', true))),
              namespace: String(opts.namespace || (await askText(session, 'Namespace (optional)', false))) || undefined,
              service: String(opts.service || (await askText(session, 'Service', true))),
            }
          : undefined;
        const approveLive = Boolean(opts.yesLive) || (await askYesNo(session, 'Run live environment checks like kubectl visibility and target setup?', Boolean(target)));
        let manualDatasourceDeclined = false;
        if (target && approveLive && !kbIsAvailable(ctx)) {
          const wantsManualSetup = await askYesNo(session, 'KB is missing. Do you want to enter datasource details now so TapRoot can save a usable datasource?', true);
          if (wantsManualSetup) {
            const mode = (await askChoice(session, 'Connection mode', ['native', 'qa-portforward', 'tsh'], toolPathsHint(target.namespace))) as 'native' | 'qa-portforward' | 'tsh';
            const engine = (await askChoice(session, 'Database engine', mode === 'tsh' ? ['mysql'] : ['mysql', 'postgres'], 'mysql')) as 'mysql' | 'postgres';
            const database = await askText(session, 'Database name', true);
            if (mode === 'native') {
              const host = await askText(session, 'Host', true);
              const defaultPort = engine === 'postgres' ? '5432' : '3306';
              const port = Number(await askText(session, `Port [${defaultPort}]`, false) || defaultPort);
              const dbUser = await askText(session, 'Database user (optional)', false);
              await saveManualDatasource(ctx, {
                env: target.env,
                namespace: target.namespace,
                service: target.service,
                mode,
                engine,
                database,
                host,
                port,
                dbUser: dbUser || undefined,
              });
            } else if (mode === 'qa-portforward') {
              const targetService = await askText(session, 'Kubernetes service name to port-forward', true);
              const defaultPort = engine === 'postgres' ? '5432' : '4406';
              const port = Number(await askText(session, `Local forwarded port [${defaultPort}]`, false) || defaultPort);
              const dbUser = await askText(session, 'Database user (optional)', false);
              await saveManualDatasource(ctx, {
                env: target.env,
                namespace: target.namespace,
                service: target.service,
                mode,
                engine,
                database,
                port,
                target: targetService,
                dbUser: dbUser || undefined,
              });
            } else {
              const targetName = await askText(session, 'Teleport database target name', true);
              const dbUser = await askText(session, 'Teleport database user', true);
              await saveManualDatasource(ctx, {
                env: target.env,
                namespace: target.namespace,
                service: target.service,
                mode,
                engine: 'mysql',
                database,
                target: targetName,
                dbUser,
              });
            }
          } else {
            manualDatasourceDeclined = true;
          }
        }
        const runValidation = target && approveLive ? await askYesNo(session, 'Run a final target-specific readiness check?', true) : false;
        const result = await runOnboarding(ctx, {
          approveLocal,
          approveAccess,
          approveLive,
          target,
          runValidation,
          manualDatasourceDeclined,
        });
        for (const step of result.steps) printStep(step);
        printFinalSummary(result);
      } finally {
        session.close();
      }
    });
}

function toolPathsHint(namespace?: string): 'native' | 'qa-portforward' | 'tsh' {
  return namespace ? 'qa-portforward' : 'native';
}
