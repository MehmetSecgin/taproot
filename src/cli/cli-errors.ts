import type { Command } from 'commander';
import { classifyError } from '../core/error-classification.js';
import { unknownOptionHint } from '../core/option-hints.js';
import { printFailure } from '../core/output.js';
import { emptyToUndefined, textUnlessFalsy } from '../core/text-presence.js';
import { errorTextOrUnknown } from '../core/error-text.js';
import { isRecord } from '../core/json-shapes.js';

export type CommanderHint = (commanderMessage: string, argv: string[]) => string | undefined;

type ErrorEnvelopeExtras = { details?: unknown; meta?: Record<string, unknown> };

function optionOwners(command: Command, path: string[] = [], owners: Record<string, string[]> = {}): Record<string, string[]> {
  for (const option of command.options) {
    if (option.long !== undefined) {
      (owners[option.long] ??= []).push(path.join(' '));
    }
  }
  for (const subcommand of command.commands) {
    optionOwners(subcommand, [...path, subcommand.name()], owners);
  }
  return owners;
}

function errorEnvelopeExtras(error: unknown): ErrorEnvelopeExtras {
  if (!isRecord(error)) {
    return {};
  }
  const { details, meta } = error;
  return { details, meta: isRecord(meta) ? meta : undefined };
}

export function commanderErrorCode(error: unknown): string {
  return isRecord(error) ? textUnlessFalsy(error.code) : '';
}

export function commanderErrorMessage(context: { program: Command; cliName: string; hint?: CommanderHint }, rawMessage: string, argv: string[]): string {
  const hintedMessage = emptyToUndefined(context.hint?.(rawMessage, argv));
  if (hintedMessage !== undefined) {
    return hintedMessage;
  }
  const optionHint = emptyToUndefined(unknownOptionHint(rawMessage, optionOwners(context.program), { argv, programName: context.cliName }));
  return optionHint === undefined ? rawMessage : `${rawMessage}. ${optionHint}`;
}

export function printCaughtError(error: unknown): void {
  const message = errorTextOrUnknown(error);
  const { details, meta } = errorEnvelopeExtras(error);
  printFailure({ code: classifyError(message), message, details }, meta);
}
