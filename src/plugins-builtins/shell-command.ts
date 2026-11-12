import { spawn } from 'node:child_process';

export async function runShellCommand(command: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  return await new Promise((resolve) => {
    const proc = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: { ok: boolean; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!proc.killed) proc.kill('SIGKILL');
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, detail: `command timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    proc.once('error', (error) => {
      finish({ ok: false, detail: ((error as Error).message || 'spawn error').slice(0, 400) });
    });
    proc.once('exit', (code) => {
      if (code === 0) {
        finish({ ok: true, detail: stdout.trim() || 'ok' });
        return;
      }
      finish({ ok: false, detail: (stderr.trim() || stdout.trim() || `exit=${code}`).slice(0, 400) });
    });
  });
}
