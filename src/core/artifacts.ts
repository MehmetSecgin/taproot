import fs from 'node:fs';
import path from 'node:path';
import type { QueryResult } from '../types/core.js';
import { nowIso, nowStamp } from './time.js';

export interface RunArtifacts {
  runId: string;
  runDir: string;
}

export function createRunArtifacts(runsDir: string, label: string): RunArtifacts {
  const runId = `${nowStamp()}-${label}`;
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  return { runId, runDir };
}

export function writeRunSummary(runDir: string, result: QueryResult): void {
  fs.writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

export function appendEvent(runDir: string, message: string): void {
  fs.appendFileSync(path.join(runDir, 'events.log'), `${nowIso()} ${message}\n`, 'utf8');
}
