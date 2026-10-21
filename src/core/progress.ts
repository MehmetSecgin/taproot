import { styleText as paint } from 'node:util';
import type { Ora } from 'ora';

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
const COLORS = { success: 'green', warning: 'yellow', error: 'red', info: 'cyan' } as const;

function symbol(kind: 'success' | 'warning' | 'error' | 'info', noColor: boolean): string {
  if (noColor) {
    return {
      success: 'OK',
      warning: 'WARN',
      error: 'ERR',
      info: 'INFO',
    }[kind];
  }
  return paint(COLORS[kind], { success: '✔', warning: '⚠', error: '✖', info: 'ℹ' }[kind]);
}

function styleText(text: string, kind: 'success' | 'warning' | 'error' | 'info', noColor: boolean): string {
  return noColor ? text : paint(COLORS[kind], text);
}

class Progress implements ProgressReporter {
  private spinner?: Ora;
  private lastText = '';
  private finished = false;
  private readonly stream: NodeJS.WriteStream;
  private readonly noColor: boolean;
  private readonly plainUpdates: boolean;
  private readonly useSpinner: boolean;
  private readonly prefix: string;

  constructor(opts: ProgressOptions) {
    this.stream = opts.stream || process.stderr;
    this.noColor = Boolean(opts.noColor);
    this.plainUpdates = Boolean(opts.plainUpdates || opts.verbose);
    this.prefix = opts.prefix || 'taproot';
    this.useSpinner = Boolean(opts.enabled && !opts.noAnimations && this.stream.isTTY);
    if (this.useSpinner) {
      void import('ora').then(({ default: ora }) => {
        if (this.finished) return;
        this.spinner = ora({
          text: this.lastText || 'starting...',
          stream: this.stream,
          isEnabled: true,
        }).start();
        ACTIVE_SPINNERS.add(this.spinner);
      });
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

  private settle(kind: 'success' | 'warning' | 'error', text: string): void {
    this.finished = true;
    if (this.spinner) {
      if (kind === 'success') this.spinner.succeed(text);
      else if (kind === 'warning') this.spinner.warn(text);
      else this.spinner.fail(text);
      ACTIVE_SPINNERS.delete(this.spinner);
      this.spinner = undefined;
      return;
    }
    if (this.plainUpdates || this.useSpinner) this.stream.write(`${this.line(kind, text)}\n`);
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
    this.settle('success', (text || this.lastText || 'done').trim());
  }

  warn(text?: string): void {
    this.settle('warning', (text || this.lastText || 'warning').trim());
  }

  fail(text?: string): void {
    this.settle('error', (text || this.lastText || 'failed').trim());
  }

  stop(): void {
    this.finished = true;
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
