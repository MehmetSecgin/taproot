import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { badInput } from '../core/error-classification.js';
import { str } from '../core/strings.js';

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function withPrefix(values: string[], prefix: string): string[] {
  if (!prefix) return values;
  return values.filter((v) => v.startsWith(prefix));
}

function visibleCommands(command: Command): Command[] {
  return command.commands.filter((c) => !c.name().startsWith('__'));
}

function commandNames(command: Command): string[] {
  return uniqueSorted(visibleCommands(command).map((c) => c.name()));
}

function optionNames(command: Command): string[] {
  return uniqueSorted(
    command.options
      .map((o) => o.long)
      .filter((v): v is string => Boolean(v)),
  );
}

function findCommand(command: Command, name: string): Command | undefined {
  return visibleCommands(command).find((c) => c.name() === name);
}

function valueSuggestions(prev: string, current: string, ctx: AppContext): string[] {
  const datasourceNames = uniqueSorted(ctx.datasourceStore.list().map((d) => d.name));
  const serviceNames = uniqueSorted(ctx.kbStore.services().map((s: any) => str(s.service).trim()).filter(Boolean));
  const connectorNames = uniqueSorted(ctx.pluginRegistry.list().filter((p) => p.manifest.kind === 'connector').map((p) => p.manifest.name));

  if (prev === '--datasource') return withPrefix(datasourceNames, current);
  if (prev === '--service') return withPrefix(serviceNames, current);
  if (prev === '--connector') return withPrefix(connectorNames, current);
  return [];
}

function resolveSuggestions(tokens: string[], ctx: AppContext, program: Command): string[] {
  const args = tokens.filter((t) => t !== undefined);
  const current = args[args.length - 1] || '';
  const command = args[0] || '';
  const rootCommands = commandNames(program);

  if (!command || command.startsWith('-')) {
    return withPrefix(rootCommands, current);
  }
  if (!rootCommands.includes(command)) {
    return withPrefix(rootCommands, command);
  }
  const root = findCommand(program, command);
  if (!root) return [];
  const prev = args[args.length - 2] || '';

  const valueMatches = valueSuggestions(prev, current, ctx);
  if (valueMatches.length) return valueMatches;

  const subcommands = commandNames(root);
  const second = args[1] || '';
  const hasSubcommands = subcommands.length > 0;
  if (hasSubcommands) {
    if (!second || second.startsWith('-')) {
      return withPrefix(subcommands, current);
    }
    const sub = findCommand(root, second);
    if (!sub) return withPrefix(subcommands, second);
    const opts = optionNames(sub);
    if (current.startsWith('-')) return withPrefix(opts, current);
    return withPrefix(opts, current);
  }
  const opts = optionNames(root);
  if (current.startsWith('-')) return withPrefix(opts, current);
  return withPrefix(opts, current);
}

function zshScript(): string {
  return `#compdef taproot
_taproot_complete() {
  local -a suggestions
  local -a args
  args=("\${words[@]:2:$((CURRENT-1))}")
  suggestions=("\${(@f)\$(taproot __complete -- "\${args[@]}" "\${PREFIX}")}")
  _describe 'taproot' suggestions
}
compdef _taproot_complete taproot
`;
}

function bashScript(): string {
  return `taproot_complete() {
  local IFS=$'\\n'
  COMPREPLY=( $(taproot __complete -- "\${COMP_WORDS[@]:1}") )
}
complete -F taproot_complete taproot
`;
}

function fishScript(): string {
  return `complete -c taproot -f -a "(taproot __complete -- (commandline -opc | string split ' ')[2..-1])"
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
      throw badInput(`Unsupported shell '${shell}'.`);
    });

  program
    .command('__complete', { hidden: true })
    .argument('[tokens...]')
    .allowUnknownOption(true)
    .action((tokens: string[] = []) => {
      const ctx = getCtx();
      const out = resolveSuggestions(tokens, ctx, program);
      process.stdout.write(`${out.join('\n')}\n`);
    });
}
