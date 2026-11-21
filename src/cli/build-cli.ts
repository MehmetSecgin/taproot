import { Command } from 'commander';
import { classifyError } from '../core/error-classification.js';
import { EXIT_CODES, classifyExitCode } from '../core/exit-codes.js';
import { helpJson } from '../core/help-json.js';
import { unknownOptionHint } from '../core/option-hints.js';
import { printEnvelope, printJson, setLines, setPluck } from '../core/output.js';
import { str } from '../core/strings.js';
import { TAPROOT_VERSION } from '../core/version.js';
import type { CliCommand, Executor } from './types.js';

export type CommanderHint = (commanderMessage: string, argv: string[]) => string | undefined;

function optionOwners(cmd: Command, path: string[] = [], owners: Record<string, string[]> = {}): Record<string, string[]> {
  for (const option of cmd.options) if (option.long) (owners[option.long] ||= []).push(path.join(' '));
  for (const sub of cmd.commands) optionOwners(sub, [...path, sub.name()], owners);
  return owners;
}

export function buildCli<E extends Executor>(input: {
  name: string;
  description: string;
  commands: CliCommand<E>[];
  executor: E;
  hint?: CommanderHint;
}): { run: (argv: string[]) => Promise<void> } {
  const program = new Command();
  program
    .name(input.name)
    .description(input.description)
    .option('-V, --version', 'Print the version')
    .option('--pluck <path>', 'Print only the subtree at this dot-path (e.g. data.rows, meta.schemaContext). A failure prints the full error envelope.')
    .option('--lines', 'Print one JSON value per line: a query prints {ok, columns, warnings}, then one line per row; a list prints {ok}, then one line per item; with --pluck, one line per array item. A failure prints the full error envelope.', false);
  input.executor.addOptions(program);
  program
    .configureHelp({ formatHelp: helpJson })
    .configureOutput({ writeErr: (text) => process.stdout.write(text), outputError: () => undefined })
    .exitOverride((error) => {
      throw error;
    });

  const applyOutputOptions = (): void => {
    const opts = program.opts();
    setPluck(opts.pluck ? String(opts.pluck) : undefined);
    setLines(Boolean(opts.lines));
  };
  program.hook('preAction', applyOutputOptions);

  for (const command of input.commands) command(program, input.executor);

  const commanderMessage = (raw: string, argv: string[]): string => {
    const named = input.hint?.(raw, argv);
    if (named) return named;
    const hint = unknownOptionHint(raw, optionOwners(program), argv, input.name);
    return hint ? `${raw}. ${hint}` : raw;
  };

  const emitError = (error: unknown, code: string): void => {
    const message = (error as Error)?.message || String(error || 'Unknown error');
    const classifiedCode = code === 'UNHANDLED' || code === 'UNCAUGHT_EXCEPTION' || code === 'UNHANDLED_REJECTION'
      ? classifyError(message)
      : code;
    applyOutputOptions();
    const details = (error as Error & { details?: Record<string, unknown> })?.details;
    const meta = (error as Error & { meta?: Record<string, unknown> })?.meta;
    printEnvelope(false, undefined, { code: classifiedCode, message, details }, meta);
  };

  return {
    async run(argv) {
      if (argv[2] === '-V' || argv[2] === '--version') {
        printJson({ version: TAPROOT_VERSION });
        process.exit(EXIT_CODES.OK);
      }
      process.on('unhandledRejection', (reason) => {
        emitError(reason, 'UNHANDLED_REJECTION');
        process.exit(classifyExitCode(reason));
      });
      process.on('uncaughtException', (error) => {
        emitError(error, 'UNCAUGHT_EXCEPTION');
        process.exit(classifyExitCode(error));
      });
      await program.parseAsync(argv).catch((error) => {
        const commanderCode = str((error as { code?: string })?.code);
        if (commanderCode === 'commander.helpDisplayed' || commanderCode === 'commander.help') {
          process.exit(EXIT_CODES.OK);
        }
        if (commanderCode.startsWith('commander.')) {
          applyOutputOptions();
          printEnvelope(false, undefined, { code: 'CLI_ERROR', message: commanderMessage((error as Error)?.message || '', argv.slice(2)) });
          process.exit(classifyExitCode(error));
        }
        emitError(error, 'UNHANDLED');
        process.exit(classifyExitCode(error));
      });
    },
  };
}
