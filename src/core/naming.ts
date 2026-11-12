export function normalizeService(value?: string, aliases?: Record<string, string>): string {
  const v = (value || '').trim();
  if (!v) return '';
  const normalized = v.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').replace(/\s+/g, '-').toLowerCase();
  const aliasMap = aliases || {};
  return aliasMap[normalized] || normalized;
}

export function normalizeNamespace(value?: string): string {
  return (value || '').trim().replace(/_/g, '-').replace(/\s+/g, '-').toLowerCase();
}

export function defaultDatasourceName(env: string, service: string, namespace?: string): string {
  const normalizedNamespace = normalizeNamespace(namespace);
  return normalizedNamespace ? `${env}-${normalizedNamespace}-${service}` : `${env}-${service}`;
}
