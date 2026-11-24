import { Command } from 'commander';
import type { CommanderError } from 'commander';
import { EXIT_CODES, classifyExitCode } from '../core/exit-codes.js';
import { helpJson } from '../core/help-json.js';
import { printFailure, printJson, setLines, setPluck } from '../core/output.js';
import { TAPROOT_VERSION } from '../core/version.js';
import { commanderErrorCode, commanderErrorMessage, printCaughtError } from './cli-errors.js';
import type { CommanderHint } from './cli-errors.js';
import type { CliCommand, Executor } from './types.js';
import { emptyToUndefined } from '../core/text-presence.js';


type CliDefinition<ExecutorType extends Executor> = {
  name: string;
  description: string;
  commands: CliCommand<ExecutorType>[];
  executor: ExecutorType;
  hint?: CommanderHint;
};

type CliRun = { program: Command; cliName: string; hint?: CommanderHint; argv: string[] };

type GlobalOutputOptions = { pluck?: string; lines?: boolean };

const COMMANDER_ERROR_PREFIX = 'commander.';
const COMMANDER_HELP_CODES = new Set(['commander.helpDisplayed', 'commander.help']);
const VERSION_ARGUMENTS = new Set(['-V', '--version']);
const FIRST_USER_ARGUMENT_INDEX = 2;

function rethrow(error: CommanderError): never {
  throw error;
}

const discardOutputError = (): undefined => undefined;

function createProgram<ExecutorType extends Executor>(definition: CliDefinition<ExecutorType>): Command {
  const program = new Command();
  program
    .name(definition.name)
    .description(definition.description)
    .option('-V, --version', 'Print the version')
    .option('--pluck <path>', 'Print only the subtree at this dot-path (e.g. data.rows, meta.schemaContext). A failure prints the full error envelope.')
    .option('--lines', 'Print one JSON value per line: a query prints {ok, columns, truncated, warnings}, then one line per row; a list prints {ok}, then one line per item; with --pluck, one line per array item. A failure prints the full error envelope.', false);
  definition.executor.addOptions(program);
  program
    .configureHelp({ formatHelp: helpJson })
    .configureOutput({
      writeErr: (text) => {
        process.stdout.write(text);
      },
      outputError: discardOutputError,
    })
    .exitOverride(rethrow);
  return program;
}

function applyOutputOptions(program: Command): void {
  const options = program.opts<GlobalOutputOptions>();
  setPluck(emptyToUndefined(options.pluck));
  setLines(Boolean(options.lines));
}

function exitWithCaughtError(program: Command, caught: unknown): void {
  applyOutputOptions(program);
  printCaughtError(caught);
  process.exit(classifyExitCode(caught));
}

function exitWithCommanderError(run: CliRun, commanderError: unknown): void {
  applyOutputOptions(run.program);
  const rawMessage = commanderError instanceof Error ? commanderError.message : '';
  const message = commanderErrorMessage(
    { program: run.program, cliName: run.cliName, hint: run.hint },
    rawMessage,
    run.argv.slice(FIRST_USER_ARGUMENT_INDEX),
  );
  printFailure({ code: 'CLI_ERROR', message });
  process.exit(classifyExitCode(commanderError));
}

function exitWithParseFailure(run: CliRun, failure: unknown): void {
  const code = commanderErrorCode(failure);
  if (COMMANDER_HELP_CODES.has(code)) {
    process.exit(EXIT_CODES.OK);
  }
  if (code.startsWith(COMMANDER_ERROR_PREFIX)) {
    exitWithCommanderError(run, failure);
    return;
  }
  exitWithCaughtError(run.program, failure);
}

async function runCli(run: CliRun): Promise<void> {
  if (VERSION_ARGUMENTS.has(run.argv[FIRST_USER_ARGUMENT_INDEX])) {
    printJson({ version: TAPROOT_VERSION });
    process.exit(EXIT_CODES.OK);
  }
  process.on('unhandledRejection', (reason) => {
    exitWithCaughtError(run.program, reason);
  });
  process.on('uncaughtException', (exception) => {
    exitWithCaughtError(run.program, exception);
  });
  try {
    await run.program.parseAsync(run.argv);
  } catch (error) {
    exitWithParseFailure(run, error);
  }
}

export function buildCli<ExecutorType extends Executor>(definition: CliDefinition<ExecutorType>): { run: (argv: string[]) => Promise<void> } {
  const program = createProgram(definition);
  program.hook('preAction', () => {
    applyOutputOptions(program);
  });
  for (const command of definition.commands) {
    command(program, definition.executor);
  }
  return { run: async (argv) => runCli({ program, cliName: definition.name, hint: definition.hint, argv }) };
}
