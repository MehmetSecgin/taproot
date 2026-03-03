import { Command } from 'commander';
import type { AppContext } from '../core/app.js';

const ROOT_COMMANDS = ['self-check', 'doctor', 'query', 'datasource', 'template', 'kb', 'cache', 'learn', 'daemon', 'session', 'completion'];

const QUERY_OPTS = ['--datasource', '--env', '--service', '--intent', '--template', '--query', '--param', '--allow-discovery', '--allow-mutate'];
const DOCTOR_OPTS = ['--datasource', '--env', '--service', '--connect', '--verbose-detail', '--all'];
const DATASOURCE_OPTS = ['list', 'show', 'add', 'update', 'remove', 'resolve'];
const TEMPLATE_OPTS = ['list', 'validate', 'run', 'save'];

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function withPrefix(values: string[], prefix: string): string[] {
  if (!prefix) return values;
  return values.filter((v) => v.startsWith(prefix));
}

function resolveSuggestions(tokens: string[], ctx: AppContext): string[] {
  const args = tokens.filter((t) => t !== undefined);
  const current = args[args.length - 1] || '';
  const command = args[0] || '';

  if (!command || command.startsWith('-')) {
    return withPrefix(ROOT_COMMANDS, current);
  }
  if (!ROOT_COMMANDS.includes(command)) {
    return withPrefix(ROOT_COMMANDS, command);
  }

  const datasourceNames = uniqueSorted(ctx.datasourceStore.list().map((d) => d.name));
  const templateIds = uniqueSorted(ctx.templateStore.list().map((t) => t.id));
  const serviceNames = uniqueSorted(ctx.kbStore.services().map((s: any) => String(s.service || '').trim()).filter(Boolean));

  const prev = args[args.length - 2] || '';
  if (command === 'query') {
    if (prev === '--datasource') return withPrefix(datasourceNames, current);
    if (prev === '--template') return withPrefix(templateIds, current);
    if (prev === '--service') return withPrefix(serviceNames, current);
    if (current.startsWith('-')) return withPrefix(QUERY_OPTS, current);
    return withPrefix(QUERY_OPTS, current);
  }
  if (command === 'doctor') {
    if (prev === '--datasource') return withPrefix(datasourceNames, current);
    if (prev === '--service') return withPrefix(serviceNames, current);
    if (current.startsWith('-')) return withPrefix(DOCTOR_OPTS, current);
    return withPrefix(DOCTOR_OPTS, current);
  }
  if (command === 'datasource') {
    return withPrefix(DATASOURCE_OPTS, current);
  }
  if (command === 'template') {
    if (prev === '--id') return withPrefix(templateIds, current);
    return withPrefix(TEMPLATE_OPTS, current);
  }
  return [];
}

function zshScript(): string {
  return `#compdef taproot
_taproot_complete() {
  local -a suggestions
  suggestions=("\${(@f)\$(taproot __complete "\${words[@]:1}")}")
  _describe 'taproot' suggestions
}
compdef _taproot_complete taproot
`;
}

function bashScript(): string {
  return `taproot_complete() {
  local IFS=$'\\n'
  COMPREPLY=( $(taproot __complete "\${COMP_WORDS[@]:1}") )
}
complete -F taproot_complete taproot
`;
}

function fishScript(): string {
  return `complete -c taproot -f -a "(taproot __complete (commandline -opc | string split ' ')[2..-1])"
`;
}

export function registerCompletion(program: Command, getCtx: () => AppContext): void {
  program
    .command('completion')
    .argument('<shell>', 'zsh|bash|fish')
    .action((shell: string) => {
      if (shell === 'zsh') {
        process.stdout.write(zshScript());
        return;
      }
      if (shell === 'bash') {
        process.stdout.write(bashScript());
        return;
      }
      if (shell === 'fish') {
        process.stdout.write(fishScript());
        return;
      }
      throw new Error(`Unsupported shell '${shell}'.`);
    });

  program
    .command('__complete', { hidden: true })
    .argument('[tokens...]')
    .allowUnknownOption(true)
    .action((tokens: string[] = []) => {
      const ctx = getCtx();
      const out = resolveSuggestions(tokens, ctx);
      process.stdout.write(`${out.join('\n')}\n`);
    });
}
