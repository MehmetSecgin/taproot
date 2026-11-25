export type SchemaIndex = {
  name: string;
  columns: string[];
  unique?: boolean;
  type?: string;
};

export type SchemaPartition = {
  kind: string;
  expr?: string;
  key?: string;
  keys?: string[];
};

export type TableContext = {
  database: string;
  columns: string[];
  primaryKey?: string[];
  indexes: SchemaIndex[];
  partition?: SchemaPartition;
};

type SchemaCatalogSummary = {
  tables: number;
  fetchedAt: string;
};

export type SchemaContext = {
  tables: Record<string, TableContext>;
  catalog?: SchemaCatalogSummary;
};
