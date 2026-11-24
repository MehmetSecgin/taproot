import type { Command, Help } from 'commander';

export function helpJson(cmd: Command, helper: Help): string {
  const data = {
    usage: helper.commandUsage(cmd),
    description: helper.commandDescription(cmd) || undefined,
    arguments: helper.visibleArguments(cmd).map((argument) => ({ name: helper.argumentTerm(argument), description: helper.argumentDescription(argument) || undefined })),
    options: helper.visibleOptions(cmd).map((option) => ({ flags: helper.optionTerm(option), description: helper.optionDescription(option) || undefined })),
    commands: helper.visibleCommands(cmd).map((subcommand) => ({ name: helper.subcommandTerm(subcommand), description: helper.subcommandDescription(subcommand) || undefined })),
  };
  return `${JSON.stringify({ ok: true, data })}\n`;
}
