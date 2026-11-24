import { describe, expect, it } from 'vitest';
import { parseKeyValuePairs } from '../src/core/key-value.js';

describe('parsing --flag key=value pairs', () => {
  it('splits on the first = and keeps the value as given', () => {
    // act
    const pairs = parseKeyValuePairs('--hint', [' protoRoot =/a,/b', 'metadata.x=a=b', 'empty=']);

    // assert
    expect(pairs).toStrictEqual({ protoRoot: '/a,/b', 'metadata.x': 'a=b', empty: '' });
  });

  it.each(['brokenpair', '=value', ' =value'])('rejects %j with one message naming the flag', (value) => {
    // act
    const parse = (): Record<string, string> => parseKeyValuePairs('--kv', [value]);

    // assert
    expect(parse).toThrow(`BAD_INPUT: Invalid --kv '${value}'. Expected key=value.`);
  });
});
