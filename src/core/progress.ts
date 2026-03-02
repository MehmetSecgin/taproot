import ora, { type Ora } from 'ora';
import chalk from 'chalk';
import logSymbols from 'log-symbols';

export interface ProgressReporter {
  update(text: string): void;
  succeed(text?: string): void;
  warn(text?: string): void;
  fail(text?: string): void;
  stop(): void;
}

export interface ProgressOptions {
  enabled: boolean;
  noAnimations?: boolean;
  noColor?: boolean;
  verbose?: boolean;
  stream?: NodeJS.WriteStream;
  plainUpdates?: boolean;
  prefix?: string;
}

const ACTIVE_SPINNERS = new Set<Ora>();

function symbol(kind: 'success' | 'warning' | 'error' | 'info', noColor: boolean): string {
  if (noColor) {
    return {
      success: 'OK',
      warning: 'WARN',
      error: 'ERR',
      info: 'INFO',
    }[kind];
  }
  return {
    success: logSymbols.success,
    warning: logSymbols.warning,
    error: logSymbols.error,
    info: logSymbols.info,
  }[kind];
}

function styleText(text: string, kind: 'success' | 'warning' | 'error' | 'info', noColor: boolean): string {
  if (noColor) return text;
  if (kind === 'success') return chalk.green(text);
  if (kind === 'warning') return chalk.yellow(text);
  if (kind === 'error') return chalk.red(text);
  return chalk.cyan(text);
}

class Progress implements ProgressReporter {
  private spinner?: Ora;
  private lastText = '';
  private readonly stream: NodeJS.WriteStream;
  private readonly noColor: boolean;
  private readonly plainUpdates: boolean;
  private readonly prefix: string;

  constructor(opts: ProgressOptions) {
    this.stream = opts.stream || process.stderr;
    this.noColor = Boolean(opts.noColor);
    this.plainUpdates = Boolean(opts.plainUpdates || opts.verbose);
    this.prefix = opts.prefix || 'taproot';
    const useSpinner = Boolean(opts.enabled && !opts.noAnimations && this.stream.isTTY);
    if (useSpinner) {
      this.spinner = ora({
        text: 'starting...',
        stream: this.stream,
        isEnabled: true,
      }).start();
      ACTIVE_SPINNERS.add(this.spinner);
    }
  }

  private line(kind: 'success' | 'warning' | 'error' | 'info', text: string): string {
    const prefixed = `${this.prefix}: ${styleText(text, kind, this.noColor)}`;
    return `${symbol(kind, this.noColor)} ${prefixed}`;
  }

  private write(kind: 'success' | 'warning' | 'error' | 'info', text: string): void {
    if (!this.plainUpdates) return;
    this.stream.write(`${this.line(kind, text)}\n`);
  }

  update(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || trimmed === this.lastText) return;
    this.lastText = trimmed;
    if (this.spinner) {
      this.spinner.text = trimmed;
      return;
    }
    this.write('info', trimmed);
  }

  succeed(text?: string): void {
    const finalText = (text || this.lastText || 'done').trim();
    if (this.spinner) {
      this.spinner.succeed(finalText);
      ACTIVE_SPINNERS.delete(this.spinner);
      this.spinner = undefined;
      return;
    }
    this.write('success', finalText);
  }

  warn(text?: string): void {
    const finalText = (text || this.lastText || 'warning').trim();
    if (this.spinner) {
      this.spinner.warn(finalText);
      ACTIVE_SPINNERS.delete(this.spinner);
      this.spinner = undefined;
      return;
    }
    this.write('warning', finalText);
  }

  fail(text?: string): void {
    const finalText = (text || this.lastText || 'failed').trim();
    if (this.spinner) {
      this.spinner.fail(finalText);
      ACTIVE_SPINNERS.delete(this.spinner);
      this.spinner = undefined;
      return;
    }
    this.write('error', finalText);
  }

  stop(): void {
    if (!this.spinner) return;
    this.spinner.stop();
    ACTIVE_SPINNERS.delete(this.spinner);
    this.spinner = undefined;
  }
}

export function createProgress(opts: ProgressOptions): ProgressReporter {
  if (!opts.enabled) {
    return {
      update: () => undefined,
      succeed: () => undefined,
      warn: () => undefined,
      fail: () => undefined,
      stop: () => undefined,
    };
  }
  return new Progress(opts);
}

export function cleanupProgress(): void {
  for (const spinner of ACTIVE_SPINNERS) spinner.stop();
  ACTIVE_SPINNERS.clear();
}
