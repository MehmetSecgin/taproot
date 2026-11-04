function commandIndex(argv: string[], command: string): number {
  const words = command.split(' ');
  return argv.findIndex((_, start) => words.every((word, offset) => argv[start + offset] === word));
}

export function unknownOptionHint(commanderMessage: string, owners: Record<string, string[]>, argv: string[]): string | undefined {
  const raw = commanderMessage.match(/unknown option '([^']+)'/)?.[1];
  if (!raw) return undefined;
  const flag = raw.split(/[\s=]/)[0];
  const commands = owners[flag];
  if (!commands) return undefined;
  if (/\s/.test(raw)) {
    return `option '${flag}' and its value arrived as one argument; pass them as separate words. zsh does not split an unquoted variable, so write the flag and value out or use an array.`;
  }
  if (commands.includes('')) return undefined;
  const shown = commands.slice(0, 3).map((c) => `'taproot ${c}'`).join(', ');
  const flagAt = argv.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  const typedOwner = flagAt < 0 ? undefined : commands.find((command) => commandIndex(argv, command) > flagAt);
  if (typedOwner) {
    return `option '${flag}' belongs to ${shown}; put it after the subcommand: taproot ${typedOwner} ${flag} ...`;
  }
  return `'${flag}' is an option of ${shown}`;
}
