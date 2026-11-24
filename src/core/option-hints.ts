const UNKNOWN_OPTION = /unknown option '(?<option>[^']+)'/u;
const WHITESPACE_OR_EQUALS = /[\s=]/u;
const WHITESPACE = /\s/u;
const MAX_COMMANDS_SHOWN = 3;

type CommandLine = {
  argv: string[];
  programName: string;
};

type OwnedFlag = CommandLine & {
  flag: string;
  commands: string[];
};

function indexOfCommandWords(argv: string[], command: string): number {
  const words = command.split(' ');
  return argv.findIndex((_, start) => words.every((word, offset) => argv[start + offset] === word));
}

function ownedFlagHint({ flag, commands, argv, programName }: OwnedFlag): string | undefined {
  if (commands.includes('')) {
    return undefined;
  }
  const shown = commands.slice(0, MAX_COMMANDS_SHOWN).map((command) => `'${programName} ${command}'`).join(', ');
  const flagPosition = argv.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  const typedOwner = flagPosition === -1 ? undefined : commands.find((command) => indexOfCommandWords(argv, command) > flagPosition);
  if (typedOwner !== undefined) {
    return `option '${flag}' belongs to ${shown}; put it after the subcommand: ${programName} ${typedOwner} ${flag} ...`;
  }
  return `'${flag}' is an option of ${shown}`;
}

export function unknownOptionHint(commanderMessage: string, commandsByFlag: Record<string, string[] | undefined>, commandLine: CommandLine): string | undefined {
  const rawOption = UNKNOWN_OPTION.exec(commanderMessage)?.groups?.option;
  if (rawOption === undefined) {
    return undefined;
  }
  const [flag] = rawOption.split(WHITESPACE_OR_EQUALS);
  const commands = commandsByFlag[flag];
  if (commands === undefined) {
    return undefined;
  }
  if (WHITESPACE.test(rawOption)) {
    return `option '${flag}' and its value arrived as one argument; pass them as separate words. zsh does not split an unquoted variable, so write the flag and value out or use an array.`;
  }
  return ownedFlagHint({ ...commandLine, flag, commands });
}
