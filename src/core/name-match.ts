import { textUnlessFalsy } from './text-presence.js';

export type NameResolution = {
  match?: string;
  candidates: string[];
};

const DEFAULT_SUGGESTION_LIMIT = 5;

function shortName(fullName: string): string {
  return fullName.slice(fullName.lastIndexOf('.') + 1);
}

function nextLevenshteinRow(previousRow: number[], sourceChar: string, targetChars: string[]): number[] {
  const row = [previousRow[0] + 1];
  for (const [column, targetChar] of targetChars.entries()) {
    const substitutionCost = sourceChar === targetChar ? 0 : 1;
    row.push(Math.min(previousRow[column + 1] + 1, row[column] + 1, previousRow[column] + substitutionCost));
  }
  return row;
}

export function levenshtein(source: string, target: string): number {
  if (source.length === 0) {
    return target.length;
  }
  if (target.length === 0) {
    return source.length;
  }
  const targetChars = target.split('');
  let row = Array.from({ length: targetChars.length + 1 }, (_, column) => column);
  for (const sourceChar of source.split('')) {
    row = nextLevenshteinRow(row, sourceChar, targetChars);
  }
  return row[targetChars.length];
}

export function suggestNames(query: string, names: string[], limit = DEFAULT_SUGGESTION_LIMIT): string[] {
  const lowerQuery = query.toLowerCase();
  return [...new Set(names)]
    .map((name) => ({
      name,
      distance: Math.min(levenshtein(lowerQuery, name.toLowerCase()), levenshtein(lowerQuery, shortName(name).toLowerCase())),
    }))
    .toSorted((first, second) => first.distance - second.distance || first.name.localeCompare(second.name))
    .slice(0, limit)
    .map((suggestion) => suggestion.name);
}

function sameNames(query: string, names: string[]): string[] {
  if (names.includes(query)) {
    return [query];
  }
  const lowerQuery = query.toLowerCase();
  return names.filter((name) => shortName(name).toLowerCase() === lowerQuery);
}

export function matchName(query: string, names: string[]): string | undefined {
  const same = sameNames(query, names);
  return same.length === 1 ? same[0] : undefined;
}

function resolutionOf(found: string[]): NameResolution | undefined {
  if (found.length === 1) {
    return { match: found[0], candidates: found };
  }
  return found.length > 1 ? { candidates: found } : undefined;
}

function namesContaining(query: string, names: string[]): string[] {
  const lowerQuery = query.toLowerCase();
  return names.filter((name) => name.toLowerCase().includes(lowerQuery) || shortName(name).toLowerCase().includes(lowerQuery));
}

export function resolveName(query: string, names: string[]): NameResolution {
  const trimmedQuery = textUnlessFalsy(query).trim();
  if (trimmedQuery === '') {
    return { candidates: names };
  }
  return resolutionOf(sameNames(trimmedQuery, names))
    ?? resolutionOf(namesContaining(trimmedQuery, names))
    ?? { candidates: suggestNames(trimmedQuery, names) };
}
