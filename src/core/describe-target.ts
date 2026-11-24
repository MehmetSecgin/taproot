import { isNonEmpty } from './text-presence.js';

export function describeTarget(target: { env: string; namespace?: string | undefined; service: string }): string {
  const namespacePart = isNonEmpty(target.namespace) ? ` namespace=${target.namespace}` : '';
  return `env=${target.env}${namespacePart} service=${target.service}`;
}
