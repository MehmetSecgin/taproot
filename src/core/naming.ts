const CAMEL_CASE_BOUNDARY = /(?<lower>[a-z0-9])(?<upper>[A-Z])/gu;
const WHITESPACE_RUN = /\s+/gu;

function kebabCaseSeparators(text: string): string {
  return text.replaceAll('_', '-').replaceAll(WHITESPACE_RUN, '-').toLowerCase();
}

export function normalizeService(value?: string, aliases?: Record<string, string>): string {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') {
    return '';
  }
  const normalized = kebabCaseSeparators(trimmed.replaceAll(CAMEL_CASE_BOUNDARY, '$<lower>-$<upper>'));
  const aliasMap: Record<string, string | undefined> = aliases ?? {};
  const alias = aliasMap[normalized];
  return alias === undefined || alias === '' ? normalized : alias;
}

export function normalizeNamespace(value?: string): string {
  return kebabCaseSeparators((value ?? '').trim());
}

export function defaultDatasourceName(env: string, service: string, namespace?: string): string {
  const normalizedNamespace = normalizeNamespace(namespace);
  return normalizedNamespace === '' ? `${env}-${service}` : `${env}-${normalizedNamespace}-${service}`;
}
