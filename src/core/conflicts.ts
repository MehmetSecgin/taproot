import { AccessMethod, DatasourceKind } from '../types/datasource.js';
import type { DatasourceProfile } from '../types/datasource.js';
import { kubectlPortforwardLocalPort } from './kubectl-portforward.js';
import { isNonEmpty, textUnlessFalsy } from './text-presence.js';

type KbEntry = Record<string, unknown>;
type KbConflictField = 'kind' | 'host' | 'port' | 'database' | 'target' | 'local port';
type KbConflict = { field: KbConflictField; message: string };

const COMPARED_CONNECTION_FIELDS = ['host', 'port', 'database', 'target'] as const;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

function kbAccessMethod(kb: KbEntry): string {
  return textUnlessFalsy(kb.access_method).toLowerCase();
}

function expectedKindFromKb(kb: KbEntry): DatasourceKind {
  return kbAccessMethod(kb) === AccessMethod.Tsh ? DatasourceKind.TeleportMysql : DatasourceKind.Mysql;
}

function trimmedText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).trim() : '';
}

function kindConflict(datasource: DatasourceProfile, kb: KbEntry): KbConflict[] {
  const expectedKind = expectedKindFromKb(kb);
  if (textUnlessFalsy(datasource.kind).trim() === '' || datasource.kind === expectedKind) {
    return [];
  }
  return [{ field: 'kind', message: `kind=${datasource.kind} (kb:${expectedKind})` }];
}

function connectionFieldConflicts(datasource: DatasourceProfile, kb: KbEntry): KbConflict[] {
  const conflicts: KbConflict[] = [];
  for (const field of COMPARED_CONNECTION_FIELDS) {
    const datasourceValue = trimmedText(datasource.connection?.[field]);
    const kbValue = trimmedText(kb[field]);
    if (datasourceValue !== '' && kbValue !== '' && datasourceValue !== kbValue) {
      conflicts.push({ field, message: `${field}=${datasourceValue} (kb:${kbValue})` });
    }
  }
  return conflicts;
}

function kubectlPortforwardPortConflict(datasource: DatasourceProfile, kb: KbEntry): KbConflict[] {
  if (kbAccessMethod(kb) !== AccessMethod.KubectlPortforward) {
    return [];
  }
  if (!isNonEmpty(datasource.env) || !isNonEmpty(datasource.service)) {
    return [];
  }
  const expectedPort = kubectlPortforwardLocalPort(datasource.env, datasource.namespace, datasource.service);
  const actualPort = datasource.connection?.port;
  if (actualPort === expectedPort) {
    return [];
  }
  return [{ field: 'local port', message: `local port=${actualPort} (kubectl-portforward:${expectedPort})` }];
}

function findKbConflicts(datasource: DatasourceProfile, kb: KbEntry): KbConflict[] {
  return [
    ...kindConflict(datasource, kb),
    ...connectionFieldConflicts(datasource, kb),
    ...kubectlPortforwardPortConflict(datasource, kb),
  ];
}

function messagesOfField(conflicts: KbConflict[], field: KbConflictField): string[] {
  return conflicts.filter((conflict) => conflict.field === field).map((conflict) => conflict.message);
}

function blockingTshConflicts(datasource: DatasourceProfile, kb: KbEntry, conflicts: KbConflict[]): string[] {
  const datasourceTarget = textUnlessFalsy(datasource.connection.target).trim();
  const kbTarget = textUnlessFalsy(kb.target).trim();
  const targetDiffersFromKb = datasourceTarget !== '' && kbTarget !== '' && datasourceTarget !== kbTarget;
  return [
    ...(datasource.kind === DatasourceKind.TeleportMysql ? [] : messagesOfField(conflicts, 'kind')),
    ...(textUnlessFalsy(datasource.connection.host).trim() === '' ? [] : messagesOfField(conflicts, 'host')),
    ...(textUnlessFalsy(datasource.connection.port).trim() === '' ? [] : messagesOfField(conflicts, 'port')),
    ...(datasourceTarget === '' ? ['target missing (kb requires teleport target)'] : []),
    ...(targetDiffersFromKb ? messagesOfField(conflicts, 'target') : []),
  ];
}

function blockingKubectlPortforwardConflicts(datasource: DatasourceProfile, conflicts: KbConflict[]): string[] {
  const blocking: string[] = [];
  const host = textUnlessFalsy(datasource.connection.host).trim();
  if (host !== '' && !LOCAL_HOSTS.has(host)) {
    blocking.push(...messagesOfField(conflicts, 'host'));
  }
  if (datasource.kind === DatasourceKind.TeleportMysql) {
    blocking.push(...messagesOfField(conflicts, 'kind'));
  }
  blocking.push(...messagesOfField(conflicts, 'local port'));
  return blocking;
}

export function datasourceKbConflicts(datasource: DatasourceProfile, kb: KbEntry): string[] {
  return findKbConflicts(datasource, kb).map((conflict) => conflict.message);
}

export function blockingDatasourceKbConflicts(datasource: DatasourceProfile, kb: KbEntry): string[] {
  const conflicts = findKbConflicts(datasource, kb);
  if (conflicts.length === 0) {
    return [];
  }
  const accessMethod = kbAccessMethod(kb);
  const blocking = [
    ...(accessMethod === AccessMethod.Tsh ? blockingTshConflicts(datasource, kb, conflicts) : []),
    ...(accessMethod === AccessMethod.KubectlPortforward ? blockingKubectlPortforwardConflicts(datasource, conflicts) : []),
  ];
  return [...new Set(blocking)];
}
