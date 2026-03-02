import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson, renderTable } from '../core/output.js';

const DEFAULT_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { id: 'private-key', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { id: 'aws-secret', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'password-assignment', re: /\b(password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi },
];

function trackedFiles(): string[] {
  const p = spawnSync('git', ['ls-files'], { encoding: 'utf8' });
  if (p.status !== 0) return [];
  return p.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

function loadExtraPatterns(configDir: string): Array<{ id: string; re: RegExp }> {
  const file = path.join(configDir, 'sanitize-denylist.txt');
  if (!fs.existsSync(file)) return [];
  const rows = fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const out: Array<{ id: string; re: RegExp }> = [];
  for (const row of rows) {
    try {
      out.push({ id: `custom:${row}`, re: new RegExp(row, 'g') });
    } catch {
      // ignore invalid regex
    }
  }
  return out;
}

export function registerSanitize(program: Command, getCtx: () => AppContext): void {
  const s = program.command('sanitize').description('Repo safety checks for secret/sensitive leaks');

  s.command('check-repo').action(() => {
    const ctx = getCtx();
    const patterns = [...DEFAULT_PATTERNS, ...loadExtraPatterns(ctx.paths.configDir)];
    const findings: Array<{ file: string; pattern: string; matches: number }> = [];
    for (const file of trackedFiles()) {
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const p of patterns) {
        const matches = text.match(p.re);
        if (matches?.length) findings.push({ file, pattern: p.id, matches: matches.length });
      }
    }
    if (ctx.jsonMode) printJson({ findings, count: findings.length });
    else console.log(findings.length ? renderTable(findings) : 'No leak patterns found.');
    if (findings.length) process.exitCode = 1;
  });
}
