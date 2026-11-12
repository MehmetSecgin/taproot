import { badInput } from './error-classification.js';

export function parseKeyValuePairs(flag: string, values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    const key = separator > 0 ? value.slice(0, separator).trim() : '';
    if (!key) throw badInput(`Invalid ${flag} '${value}'. Expected key=value.`);
    out[key] = value.slice(separator + 1);
  }
  return out;
}
