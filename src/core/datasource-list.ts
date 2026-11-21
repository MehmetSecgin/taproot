import type { AppContext } from './app.js';
import { str } from './strings.js';
import type { DatasourceProfile } from '../types/core.js';

export const DATASOURCE_COLUMNS = ['name', 'kind', 'env', 'namespace', 'service', 'host', 'target', 'database', 'updatedAt'] as const;

export type DatasourceColumn = (typeof DATASOURCE_COLUMNS)[number];

const DETAILED_ONLY_COLUMNS: ReadonlySet<DatasourceColumn> = new Set(['updatedAt']);

const CELLS: Record<DatasourceColumn, (d: DatasourceProfile) => unknown> = {
  name: (d) => d.name,
  kind: (d) => d.kind,
  env: (d) => d.env,
  namespace: (d) => d.namespace,
  service: (d) => d.service,
  host: (d) => d.connection.host,
  target: (d) => d.connection.target,
  database: (d) => d.connection.database,
  updatedAt: (d) => d.updatedAt,
};

export interface DatasourceListRequest {
  pattern: string;
  detailed: boolean;
}

export function knownDatasourceColumns(columns: readonly string[]): readonly DatasourceColumn[] {
  const unknown = columns.filter((column) => !(DATASOURCE_COLUMNS as readonly string[]).includes(column));
  if (unknown.length) throw new Error(`unknown datasource columns: ${unknown.join(', ')}; known: ${DATASOURCE_COLUMNS.join(', ')}.`);
  return columns as readonly DatasourceColumn[];
}

function isEmptyCell(cell: unknown): boolean {
  return cell === undefined || cell === null || cell === '';
}

function withoutEmptyColumns(columns: string[], rows: unknown[][]): { columns: string[]; rows: unknown[][] } {
  const kept = columns.map((_, index) => index).filter((index) => rows.some((row) => !isEmptyCell(row[index])));
  return {
    columns: kept.map((index) => columns[index]),
    rows: rows.map((row) => kept.map((index) => (isEmptyCell(row[index]) ? null : row[index]))),
  };
}

export function listDatasources(
  ctx: AppContext,
  request: DatasourceListRequest,
  columns: readonly DatasourceColumn[],
  filter: ((profile: DatasourceProfile) => boolean) | undefined,
): Record<string, unknown> {
  const shown = columns.filter((column) => request.detailed || !DETAILED_ONLY_COLUMNS.has(column));
  const needle = request.pattern.toLowerCase();
  const { profiles, warnings } = ctx.datasourceStore.load();
  const rows = profiles
    .filter((d) => d.name.toLowerCase().includes(needle) && (filter?.(d) ?? true))
    .toSorted((a, b) =>
      str(a.env).localeCompare(str(b.env))
      || str(a.namespace).localeCompare(str(b.namespace))
      || str(a.service).localeCompare(str(b.service))
      || a.name.localeCompare(b.name),
    )
    .map((d) => shown.map((column) => CELLS[column](d)));
  const table = withoutEmptyColumns(shown, rows);
  return { ...table, ...(warnings.length ? { warnings } : {}) };
}
