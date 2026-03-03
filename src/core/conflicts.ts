import type { DatasourceProfile } from '../types/core.js';

export function expectedKindFromKb(kb: Record<string, unknown>): string {
  const accessMethod = String(kb.access_method || '').toLowerCase();
  const engine = String(kb.engine || 'mysql').toLowerCase();
  if (accessMethod === 'tsh') return 'teleport-mysql';
  if (engine.includes('postgres')) return 'postgres';
  return 'mysql';
}

export function datasourceKbConflicts(datasource: DatasourceProfile, kb: Record<string, unknown>): string[] {
  const conflicts: string[] = [];
  const expectedKind = expectedKindFromKb(kb);
  if (String(datasource.kind || '').trim() && datasource.kind !== expectedKind) {
    conflicts.push(`kind=${datasource.kind} (kb:${expectedKind})`);
  }
  const pairs: Array<{ key: string; ds: unknown; kb: unknown }> = [
    { key: 'host', ds: datasource.connection?.host, kb: kb.host },
    { key: 'port', ds: datasource.connection?.port, kb: kb.port },
    { key: 'database', ds: datasource.connection?.database, kb: kb.database },
    { key: 'target', ds: datasource.connection?.target, kb: kb.target },
  ];
  for (const p of pairs) {
    const dsVal = String(p.ds ?? '').trim();
    const kbVal = String(p.kb ?? '').trim();
    if (dsVal && kbVal && dsVal !== kbVal) conflicts.push(`${p.key}=${dsVal} (kb:${kbVal})`);
  }
  return conflicts;
}
