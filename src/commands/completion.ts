import { Command } from 'commander';

const COMMANDS = ['self-check', 'doctor', 'query', 'datasource', 'template', 'kb', 'cache', 'learn', 'completion'];

function zshScript(): string {
  return `#compdef telequery\n_telequery_complete() {\n  _arguments '*: :(${COMMANDS.join(' ')})'\n}\ncompdef _telequery_complete telequery\n`;
}

function bashScript(): string {
  return `telequery_complete() {\n  COMPREPLY=( $(compgen -W "${COMMANDS.join(' ')}" -- "${'${COMP_WORDS[1]}'}") )\n}\ncomplete -F telequery_complete telequery\n`;
}

function fishScript(): string {
  return COMMANDS.map((c) => `complete -c telequery -f -a \"${c}\"`).join('\n') + '\n';
}

export function registerCompletion(program: Command): void {
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
}
