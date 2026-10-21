import fs from 'node:fs';
import path from 'node:path';
import type { QueryResult } from '../types/core.js';
import { RUNTIME_CONSTANTS } from './constants.js';
import { nowIso, nowStamp } from './time.js';

export interface RunArtifacts {
  runId: string;
  runDir: string;
}

export function createRunArtifacts(runsDir: string, label: string): RunArtifacts {
  pruneRunArtifactsDaily(runsDir);
  const runId = `${nowStamp()}-${label}`;
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  return { runId, runDir };
}

export function writeRunSummary(runDir: string, result: QueryResult): void {
  const { rows } = result.result;
  const limit = RUNTIME_CONSTANTS.runs.storedRowLimit;
  const stored = {
    ...result,
    result: { ...result.result, rows: rows.slice(0, limit), rowCount: rows.length, truncated: rows.length > limit },
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
}

export function appendEvent(runDir: string, message: string): void {
  fs.appendFileSync(path.join(runDir, 'events.log'), `${nowIso()} ${message}\n`, 'utf8');
}

export function pruneRunArtifacts(runsDir: string, cutoffMs: number): { before: number; after: number } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return { before: 0, after: 0 };
  }
  const dirs = entries.filter((entry) => entry.isDirectory());
  let kept = 0;
  for (const dir of dirs) {
    const runDir = path.join(runsDir, dir.name);
    let modifiedMs: number;
    try {
      modifiedMs = fs.statSync(runDir).mtimeMs;
    } catch {
      continue;
    }
    if (modifiedMs >= cutoffMs) {
      kept += 1;
      continue;
    }
    fs.rmSync(runDir, { recursive: true, force: true });
  }
  return { before: dirs.length, after: kept };
}

export function pruneRunArtifactsDaily(runsDir: string, nowMs = Date.now()): void {
  const marker = path.join(runsDir, '.last-prune');
  const lastPruneMs = fs.statSync(marker, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (nowMs - lastPruneMs < RUNTIME_CONSTANTS.runs.pruneIntervalMs) return;
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(marker, '');
  pruneRunArtifacts(runsDir, nowMs - RUNTIME_CONSTANTS.runs.ttlHours * 3600 * 1000);
}
