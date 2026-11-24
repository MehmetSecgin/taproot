import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KbStore } from '../src/store/kb.js';

describe('kbStore relations', () => {
  let dir = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-kb-rel-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(relations: unknown): void {
    fs.writeFileSync(path.join(dir, 'relations.json'), JSON.stringify(relations));
  }

  it('promoteRelations merges new edges and dedupes by id', () => {
    seed([{ id: 'a', from: { service: 's1', table: 't1', column: 'id' }, to: { service: 's2', table: 't2', column: 's1_id' } }]);
    const store = new KbStore(dir);
    const result = store.promoteRelations([
      { id: 'a', from: { service: 's1', table: 't1', column: 'id' }, to: { service: 's2', table: 't2', column: 's1_id' }, source: 'curated' },
      { id: 'b', from: { service: 's3', table: 't3', column: 's1_id' }, to: { service: 's1', table: 't1', column: 'id' }, source: 'curated' },
    ]);
    expect(result.added).toBe(1);
    expect(result.total).toBe(2);
    expect(store.typedRelations().map((relation) => relation.id).toSorted()).toStrictEqual(['a', 'b']);
  });

  it('typedRelations returns empty when relations.json is absent', () => {
    expect(new KbStore(dir).typedRelations()).toStrictEqual([]);
  });

  it('typedRelations returns empty when relations.json holds null', () => {
    // arrange
    seed(null);

    // act
    const relations = new KbStore(dir).typedRelations();

    // assert
    expect(relations).toStrictEqual([]);
  });

  it('typedRelations refuses a relations.json that is not an array, so promoting cannot overwrite it', () => {
    // arrange
    seed({ relations: [] });
    const store = new KbStore(dir);

    // assert
    expect(() => store.typedRelations()).toThrow('must hold a JSON array of relation objects.');
  });
});
