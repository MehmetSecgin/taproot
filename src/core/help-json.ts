import type { Command, Help } from 'commander';

export function helpJson(cmd: Command, helper: Help): string {
  const data = {
    usage: helper.commandUsage(cmd),
    description: helper.commandDescription(cmd) || undefined,
    arguments: helper.visibleArguments(cmd).map((a) => ({ name: helper.argumentTerm(a), description: helper.argumentDescription(a) || undefined })),
    options: helper.visibleOptions(cmd).map((o) => ({ flags: helper.optionTerm(o), description: helper.optionDescription(o) || undefined })),
    commands: helper.visibleCommands(cmd).map((c) => ({ name: helper.subcommandTerm(c), description: helper.subcommandDescription(c) || undefined })),
  };
  return `${JSON.stringify({ ok: true, data })}\n`;
}
