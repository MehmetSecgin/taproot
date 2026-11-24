export function describeTarget(target: { env: string; namespace?: string; service: string }): string {
  const namespacePart = target.namespace === undefined || target.namespace === '' ? '' : ` namespace=${target.namespace}`;
  return `env=${target.env}${namespacePart} service=${target.service}`;
}
