import { isList } from './json-shapes.js';

const INDEXED_SEGMENT = /^(?<key>\w*)\[(?<position>\d+)\]$/u;

function readIndexedSegment(current: object, key: string, position: number): unknown {
  const container: unknown = key === '' ? current : Reflect.get(current, key);
  return isList(container) ? container[position] : undefined;
}

function stepInto(current: unknown, segment: string): unknown {
  if (typeof current !== 'object' || current === null) {
    return undefined;
  }
  const indexed = INDEXED_SEGMENT.exec(segment);
  if (indexed === null) {
    return Reflect.get(current, segment);
  }
  const [, key, position] = indexed;
  return readIndexedSegment(current, key, Number(position));
}

export function pluckPath(source: unknown, path: string): unknown {
  const segments = path.trim().split('.').filter((segment) => segment !== '');
  let current = source;
  for (const segment of segments) {
    current = stepInto(current, segment);
  }
  return current;
}
