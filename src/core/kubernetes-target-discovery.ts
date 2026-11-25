import { spawnSync } from 'node:child_process';
import type { EnvironmentPolicy } from '../store/runtime-config.js';
import { textUnlessFalsy } from './text-presence.js';

type TargetRanking = {
  service: string;
  env: string;
  policy: EnvironmentPolicy;
};

export type TargetSearch = TargetRanking & { namespace: string };

const ENV_MATCH_SCORE = 4;
const SERVICE_TOKEN_SCORE = 3;
const PREFERENCE_BASE_SCORE = 20;

function runCommand(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const processResult = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: processResult.status ?? 0,
    stdout: textUnlessFalsy(processResult.stdout),
    stderr: textUnlessFalsy(processResult.stderr),
  };
}

function normalizeText(value: string): string {
  return textUnlessFalsy(value)
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9-_\s]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ');
}

function serviceTokens(service: string): string[] {
  return normalizeText(service)
    .split(/[-_\s]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function envMatchScore(lowerTarget: string, env: string): number {
  const lowerEnv = env.toLowerCase();
  const matchesEnv = env !== '' && (lowerTarget.includes(lowerEnv) || lowerTarget.endsWith(`-${lowerEnv}`));
  return matchesEnv ? ENV_MATCH_SCORE : 0;
}

function serviceTokenScore(lowerTarget: string, service: string): number {
  return serviceTokens(service).filter((token) => lowerTarget.includes(token)).length * SERVICE_TOKEN_SCORE;
}

function preferenceScore(lowerTarget: string, policy: EnvironmentPolicy): number {
  let score = 0;
  for (const [position, preference] of policy.targetPreference.entries()) {
    const lowerPreference = textUnlessFalsy(preference).trim().toLowerCase();
    if (lowerPreference !== '' && lowerTarget.includes(lowerPreference)) {
      score += PREFERENCE_BASE_SCORE - position;
    }
  }
  return score;
}

function targetScore(target: string, ranking: TargetRanking): number {
  const lowerTarget = target.toLowerCase();
  return envMatchScore(lowerTarget, ranking.env) + serviceTokenScore(lowerTarget, ranking.service) + preferenceScore(lowerTarget, ranking.policy);
}

function sortTargets(targets: string[], ranking: TargetRanking): string[] {
  return [...new Set(targets.filter(Boolean))]
    .toSorted((first, second) => targetScore(second, ranking) - targetScore(first, ranking) || first.localeCompare(second));
}

export function discoverKubernetesTargets(search: TargetSearch): string[] {
  const { namespace, ...ranking } = search;
  const serviceList = runCommand('kubectl', ['-n', namespace, 'get', 'svc', '-o', 'name']);
  if (serviceList.status !== 0) {
    return [];
  }
  const names = serviceList.stdout
    .split('\n')
    .map((line) => line.trim().split('/', 2)[1] ?? '')
    .filter(Boolean);
  return sortTargets(names, ranking);
}
