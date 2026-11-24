import { levenshtein, suggestNames } from './name-match.js';
import { firstNonEmpty, nonEmptyOr, textUnlessFalsy } from './text-presence.js';
import type { DatasourceProfile } from '../types/datasource.js';

type ResolutionAsk = {
  datasourceName?: string;
  env?: string;
  namespace?: string;
  service?: string;
};

type RequestedTarget = {
  datasourceName: string;
  service: string;
  env: string;
  namespace: string;
};

const MAX_SUGGESTED_NAMES = 3;
const MAX_LISTED_PROFILES = 6;
const MIN_TYPO_DISTANCE = 2;
const NAME_LENGTH_PER_TYPO = 3;
const WHITESPACE_RE = /\s+/u;

function splitDatasourceName(datasourceName: string, services: string[]): { service: string; env: string } | undefined {
  const nameParts = datasourceName.split('-');
  for (const service of services.toSorted((left, right) => right.length - left.length)) {
    const serviceParts = service.split('-');
    for (let offset = 0; offset + serviceParts.length <= nameParts.length; offset += 1) {
      if (serviceParts.every((part, position) => nameParts[offset + position] === part)) {
        return { service, env: nameParts.slice(0, offset).join('-') };
      }
    }
  }
  return undefined;
}

function closeDatasourceNames(datasourceName: string, names: string[]): string[] {
  const query = datasourceName.toLowerCase();
  const maxDistance = Math.max(MIN_TYPO_DISTANCE, Math.floor(query.length / NAME_LENGTH_PER_TYPO));
  const isDemoted = (name: string): boolean => !query.startsWith('prod') && name.toLowerCase().startsWith('prod');
  return suggestNames(datasourceName, names, names.length)
    .filter((name) => name.toLowerCase().includes(query) || levenshtein(query, name.toLowerCase()) <= maxDistance)
    .toSorted((left, right) => Number(isDemoted(left)) - Number(isDemoted(right)))
    .slice(0, MAX_SUGGESTED_NAMES);
}

function trimmedField(value: string | undefined): string {
  return textUnlessFalsy(value).trim();
}

function envLabel(profile: DatasourceProfile): string {
  const namespace = trimmedField(profile.namespace);
  return trimmedField(profile.env) + (namespace === '' ? '' : `/${namespace}`);
}

function requestedTarget(profiles: DatasourceProfile[], ask: ResolutionAsk): RequestedTarget {
  const datasourceName = trimmedField(ask.datasourceName);
  const knownServices = [...new Set(profiles.map((profile) => trimmedField(profile.service)).filter((service) => service !== ''))];
  const fromName = datasourceName === '' ? undefined : splitDatasourceName(datasourceName, knownServices);
  return {
    datasourceName,
    service: firstNonEmpty(trimmedField(ask.service), fromName?.service) ?? '',
    env: firstNonEmpty(trimmedField(ask.env), fromName?.env) ?? '',
    namespace: trimmedField(ask.namespace),
  };
}

function describeAsked(target: RequestedTarget): string {
  if (target.datasourceName !== '') {
    return `datasource '${target.datasourceName}'`;
  }
  return `env=${nonEmptyOr(target.env, '?')} service=${nonEmptyOr(target.service, '?')}`;
}

function isInRequestedEnv(profile: DatasourceProfile, target: RequestedTarget): boolean {
  const profileNamespace = trimmedField(profile.namespace);
  if (profile.env === target.env) {
    return target.namespace === '' || profileNamespace === target.namespace;
  }
  return target.namespace === '' && profileNamespace !== '' && `${profile.env}-${profileNamespace}` === target.env;
}

function describeServiceProfiles(matches: DatasourceProfile[], target: RequestedTarget): string {
  const names = matches.map((profile) => profile.name).toSorted();
  const hiddenCount = names.length - MAX_LISTED_PROFILES;
  const shown = names.slice(0, MAX_LISTED_PROFILES).join(', ') + (hiddenCount > 0 ? ` (+${hiddenCount})` : '');
  const envs = [...new Set(matches.map((profile) => envLabel(profile)).filter((label) => label !== ''))].toSorted().join(', ');
  const where = `env '${target.env}'${target.namespace === '' ? '' : ` namespace '${target.namespace}'`}`;
  const isEnvMissing = target.env !== '' && !matches.some((profile) => isInRequestedEnv(profile, target));
  const missing = isEnvMissing ? ` No profile in ${where}; add one with datasource add.` : '';
  return `Profiles for service '${target.service}': ${shown} (envs: ${envs}).${missing}`;
}

function spacedNameHint(profiles: DatasourceProfile[], datasourceName: string): string | undefined {
  const [firstToken] = datasourceName.split(WHITESPACE_RE);
  if (firstToken !== datasourceName && profiles.some((profile) => profile.name === firstToken)) {
    return `Datasource value contains spaces; did you mean '${firstToken}'?`;
  }
  return undefined;
}

function describeUnknownService(profiles: DatasourceProfile[], datasourceName: string): string {
  const close = datasourceName === '' ? [] : closeDatasourceNames(datasourceName, profiles.map((profile) => profile.name));
  const hint = close.length > 0 ? ` Did you mean ${close.join(', ')}?` : '';
  return `${hint} Use --datasource or --env+--service; list profiles with datasource list.`;
}

export function describeResolutionFailure(profiles: DatasourceProfile[], ask: ResolutionAsk): string {
  const target = requestedTarget(profiles, ask);
  const head = `Datasource resolution failed: no profile for ${describeAsked(target)}.`;
  const spacedName = spacedNameHint(profiles, target.datasourceName);
  if (spacedName !== undefined) {
    return `${head} ${spacedName}`;
  }
  const matches = target.service === '' ? [] : profiles.filter((profile) => trimmedField(profile.service) === target.service);
  if (matches.length === 0) {
    return `${head}${describeUnknownService(profiles, target.datasourceName)}`;
  }
  return `${head} ${describeServiceProfiles(matches, target)}`;
}
