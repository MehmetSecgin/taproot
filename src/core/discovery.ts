import { spawnSync } from 'node:child_process';
import type { EnvironmentPolicy } from '../types/core.js';

function runJson(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: proc.status || 0,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
  };
}

function normalizeText(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_\s]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function serviceTokens(service: string): string[] {
  return normalizeText(service)
    .split(/[-_\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function targetScore(target: string, service: string, env: string, policy: EnvironmentPolicy): number {
  const lower = target.toLowerCase();
  let score = 0;
  if (env && (lower.includes(env.toLowerCase()) || lower.endsWith(`-${env.toLowerCase()}`))) score += 4;
  for (const token of serviceTokens(service)) {
    if (lower.includes(token)) score += 3;
  }
  for (let i = 0; i < policy.targetPreference.length; i += 1) {
    const pref = String(policy.targetPreference[i] || '').trim().toLowerCase();
    if (pref && lower.includes(pref)) score += 20 - i;
  }
  return score;
}

export function sortTargets(targets: string[], service: string, env: string, policy: EnvironmentPolicy): string[] {
  return [...new Set(targets.filter(Boolean))]
    .sort((a, b) => targetScore(b, service, env, policy) - targetScore(a, service, env, policy) || a.localeCompare(b));
}

export function discoverKubernetesTargets(namespace: string, service: string, env: string, policy: EnvironmentPolicy): string[] {
  const out = runJson('kubectl', ['-n', namespace, 'get', 'svc', '-o', 'name']);
  if (out.status !== 0) return [];
  const names = out.stdout
    .split('\n')
    .map((line) => line.trim().split('/', 2)[1] || '')
    .filter(Boolean);
  return sortTargets(names, service, env, policy);
}

export function discoverTeleportTargets(service: string, env: string, policy: EnvironmentPolicy): string[] {
  const out = runJson('tsh', ['db', 'ls', '--format', 'json']);
  if (out.status !== 0) return [];
  try {
    const rows = JSON.parse(out.stdout) as Array<Record<string, any>>;
    const names = rows
      .map((row) => String(row?.metadata?.name || '').trim())
      .filter(Boolean);
    return sortTargets(names, service, env, policy);
  } catch {
    return [];
  }
}

export function inferDatabaseCandidates(service: string, explicit?: string): string[] {
  if (explicit) return [explicit];
  const base = service.replace(/-/g, '_');
  return [...new Set([`agi_${base}`, base].filter(Boolean))];
}
