import type { AppContext } from './app.js';
import { textUnlessFalsy } from './text-presence.js';
import type { DatasourceProfile } from '../types/datasource.js';

export const DATASOURCE_COLUMNS = ['name', 'kind', 'env', 'namespace', 'service', 'host', 'target', 'database', 'updatedAt'] as const;

export type DatasourceColumn = (typeof DATASOURCE_COLUMNS)[number];

const DETAILED_ONLY_COLUMNS: ReadonlySet<DatasourceColumn> = new Set(['updatedAt']);

const CELL_VALUE_BY_COLUMN: Record<DatasourceColumn, (profile: DatasourceProfile) => unknown> = {
  name: (profile) => profile.name,
  kind: (profile) => profile.kind,
  env: (profile) => profile.env,
  namespace: (profile) => profile.namespace,
  service: (profile) => profile.service,
  host: (profile) => profile.connection.host,
  target: (profile) => profile.connection.target,
  database: (profile) => profile.connection.database,
  updatedAt: (profile) => profile.updatedAt,
};

export type DatasourceListRequest = {
  pattern: string;
  detailed: boolean;
};

function isDatasourceColumn(column: string): column is DatasourceColumn {
  return DATASOURCE_COLUMNS.some((known) => known === column);
}

export function knownDatasourceColumns(columns: readonly string[]): readonly DatasourceColumn[] {
  const unknownColumns = columns.filter((column) => !isDatasourceColumn(column));
  if (unknownColumns.length > 0) {
    throw new Error(`unknown datasource columns: ${unknownColumns.join(', ')}; known: ${DATASOURCE_COLUMNS.join(', ')}.`);
  }
  return columns.filter((column) => isDatasourceColumn(column));
}

function isEmptyCell(cell: unknown): boolean {
  return cell === undefined || cell === null || cell === '';
}

function withoutEmptyColumns(columns: string[], rows: unknown[][]): { columns: string[]; rows: unknown[][] } {
  const keptIndexes = columns.map((_, index) => index).filter((index) => rows.some((row) => !isEmptyCell(row[index])));
  return {
    columns: keptIndexes.map((index) => columns[index]),
    rows: rows.map((row) => keptIndexes.map((index) => (isEmptyCell(row[index]) ? null : row[index]))),
  };
}

type DatasourceListView = {
  columns: readonly DatasourceColumn[];
  filter: ((profile: DatasourceProfile) => boolean) | undefined;
};

export function listDatasources(ctx: AppContext, request: DatasourceListRequest, view: DatasourceListView): Record<string, unknown> {
  const { columns, filter } = view;
  const shownColumns = columns.filter((column) => request.detailed || !DETAILED_ONLY_COLUMNS.has(column));
  const nameFragment = request.pattern.toLowerCase();
  const { profiles, warnings } = ctx.datasourceStore.load();
  const rows = profiles
    .filter((profile) => profile.name.toLowerCase().includes(nameFragment) && (filter?.(profile) ?? true))
    .toSorted((first, second) =>
      textUnlessFalsy(first.env).localeCompare(textUnlessFalsy(second.env))
      || textUnlessFalsy(first.namespace).localeCompare(textUnlessFalsy(second.namespace))
      || textUnlessFalsy(first.service).localeCompare(textUnlessFalsy(second.service))
      || first.name.localeCompare(second.name),
    )
    .map((profile) => shownColumns.map((column) => CELL_VALUE_BY_COLUMN[column](profile)));
  const table = withoutEmptyColumns(shownColumns, rows);
  return { ...table, ...(warnings.length > 0 ? { warnings } : {}) };
}
