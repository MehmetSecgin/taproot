import { spawn } from 'node:child_process';
import { firstNonEmpty } from '../../core/text-presence.js';
import { truncateDetail } from './truncate-detail.js';

export type ShellCommandOutcome = {
  ok: boolean;
  detail: string;
};

export async function runShellCommand(command: string, timeoutMs: number): Promise<ShellCommandOutcome> {
  return new Promise((resolve) => {
    const proc = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ ok: false, detail: `command timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    const finish = (outcome: ShellCommandOutcome): void => {
      clearTimeout(timer);
      resolve(outcome);
    };

    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    proc.once('error', (error) => {
      finish({ ok: false, detail: truncateDetail(error.message === '' ? 'spawn error' : error.message) });
    });
    proc.once('exit', (code) => {
      if (code === 0) {
        finish({ ok: true, detail: stdout.trim() === '' ? 'ok' : stdout.trim() });
        return;
      }
      const output = firstNonEmpty(stderr.trim(), stdout.trim()) ?? `exit=${code}`;
      finish({ ok: false, detail: truncateDetail(output) });
    });
  });
}
