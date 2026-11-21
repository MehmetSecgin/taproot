import { qaPortforwardLocalPort } from './qa-portforward.js';
import { expectedKindFromKb } from './conflicts.js';
import { normalizeNamespace } from './naming.js';
import { str } from './strings.js';
import { AccessMethod, DatasourceKind } from '../types/core.js';
import type { KbStore } from '../store/kb.js';

export interface KbConnectionRow {
  service: string;
  namespace?: string;
  connection: Record<string, unknown>;
}

export function kbConnectionRows(kb: KbStore, env: string): KbConnectionRow[] {
  const newest = new Map<string, KbConnectionRow>();
  for (const row of kb.services()) {
    const service = str(row?.service).trim();
    if (!service || !Array.isArray(row.connections)) continue;
    for (const connection of row.connections as Record<string, unknown>[]) {
      if (str(connection?.env) !== env || str(connection?.status || 'active') !== 'active') continue;
      const namespace = normalizeNamespace(str(connection.namespace)) || undefined;
      const key = `${service.toLowerCase()}/${namespace || ''}`;
      const current = newest.get(key);
      if (current && str(current.connection.verified_at_utc) >= str(connection.verified_at_utc)) continue;
      newest.set(key, { service, namespace, connection });
    }
  }
  return [...newest.values()].sort((a, b) => a.service.localeCompare(b.service) || str(a.namespace).localeCompare(str(b.namespace)));
}

export type KbDraft = { ok: true; connection: Record<string, unknown>; kind: string; resolverHints: Record<string, string> } | { ok: false; reason: string };

export function kbProfileDraft(env: string, row: KbConnectionRow): KbDraft {
  const kb = row.connection;
  const kind = expectedKindFromKb(kb);
  const database = str(kb.database).trim() || undefined;
  if (kind === DatasourceKind.TeleportMysql) {
    const target = str(kb.target).trim();
    if (!target) return { ok: false, reason: 'tsh row has no target' };
    const dbUser = str(kb.db_user).trim();
    return {
      ok: true,
      kind,
      connection: { target, database },
      resolverHints: dbUser ? { dbUser } : {},
    };
  }
  if (str(kb.access_method) === AccessMethod.QaPortforward) {
    return {
      ok: true,
      kind,
      connection: { host: '127.0.0.1', port: qaPortforwardLocalPort(env, row.namespace, row.service), database },
      resolverHints: {},
    };
  }
  const host = str(kb.host).trim();
  if (!host) return { ok: false, reason: 'native row has no host' };
  const port = kb.port === undefined || kb.port === '' ? undefined : Number(kb.port);
  return { ok: true, kind, connection: { host, port, database }, resolverHints: {} };
}
