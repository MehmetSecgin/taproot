import { Command } from 'commander';

const COMMANDS = ['self-check', 'doctor', 'query', 'datasource', 'template', 'kb', 'cache', 'learn', 'daemon', 'session', 'completion'];

function zshScript(): string {
  return `#compdef taproot\n_taproot_complete() {\n  _arguments '*: :(${COMMANDS.join(' ')})'\n}\ncompdef _taproot_complete taproot\n`;
}

function bashScript(): string {
  return `taproot_complete() {\n  COMPREPLY=( $(compgen -W "${COMMANDS.join(' ')}" -- "${'${COMP_WORDS[1]}'}") )\n}\ncomplete -F taproot_complete taproot\n`;
}

function fishScript(): string {
  return COMMANDS.map((c) => `complete -c taproot -f -a \"${c}\"`).join('\n') + '\n';
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
