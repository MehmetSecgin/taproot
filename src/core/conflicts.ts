import { AccessMethod, DatasourceKind, type DatasourceProfile } from '../types/core.js';
import { str } from './strings.js';

export function expectedKindFromKb(kb: Record<string, unknown>): DatasourceKind {
  const accessMethod = str(kb.access_method).toLowerCase();
  const engine = String(kb.engine || DatasourceKind.Mysql).toLowerCase();
  if (accessMethod === AccessMethod.Tsh) return DatasourceKind.TeleportMysql;
  if (engine.includes('postgres')) return DatasourceKind.Postgres;
  return DatasourceKind.Mysql;
}

export function datasourceKbConflicts(datasource: DatasourceProfile, kb: Record<string, unknown>): string[] {
  const conflicts: string[] = [];
  const expectedKind = expectedKindFromKb(kb);
  if (str(datasource.kind).trim() && datasource.kind !== expectedKind) {
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

export function criticalDatasourceKbConflicts(datasource: DatasourceProfile, kb: Record<string, unknown>): string[] {
  const conflicts = datasourceKbConflicts(datasource, kb);
  if (!conflicts.length) return [];

  const accessMethod = str(kb.access_method).toLowerCase();
  const critical: string[] = [];

  if (accessMethod === AccessMethod.Tsh) {
    if (datasource.kind !== DatasourceKind.TeleportMysql) critical.push(...conflicts.filter((c) => c.startsWith('kind=')));
    if (str(datasource.connection.host).trim()) critical.push(...conflicts.filter((c) => c.startsWith('host=')));
    if (str(datasource.connection.port).trim()) critical.push(...conflicts.filter((c) => c.startsWith('port=')));
    if (!str(datasource.connection.target).trim()) critical.push('target missing (kb requires teleport target)');
    if (str(datasource.connection.target).trim() && str(kb.target).trim() && str(datasource.connection.target).trim() !== str(kb.target).trim()) {
      critical.push(...conflicts.filter((c) => c.startsWith('target=')));
    }
  }

  if (accessMethod === AccessMethod.QaPortforward) {
    const host = str(datasource.connection.host).trim();
    if (host && host !== '127.0.0.1' && host !== 'localhost') critical.push(...conflicts.filter((c) => c.startsWith('host=')));
    if (datasource.kind === DatasourceKind.TeleportMysql) critical.push(...conflicts.filter((c) => c.startsWith('kind=')));
  }

  return Array.from(new Set(critical));
}
