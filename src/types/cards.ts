export interface CardParam {
  name: string;
  type?: string;
  required?: boolean;
  description?: string;
  default?: unknown;
}

export interface CardRequires {
  partition_predicates?: Record<string, string[]>;
  must_filter?: string[];
  max_range_days?: number;
}

export interface QueryCard {
  id: string;
  datasource?: string;
  kind?: string;
  purpose: string;
  intent?: string;
  aliases: string[];
  tables: string[];
  requires?: CardRequires;
  forbids: string[];
  sql: string;
  params: CardParam[];
  notes: string[];
  indexes_considered: string[];
  owners: string[];
  verified_at?: string;
  sourcePath?: string;
}

export interface QueryCardMatch {
  card: QueryCard;
  score: number;
  reasons: string[];
}
