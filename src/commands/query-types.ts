import type { AppContext } from '../core/app.js';
import type { ProgressReporter } from '../core/progress.js';

export interface QueryOpts {
  datasource?: string;
  env?: string;
  namespace?: string;
  service?: string;
  intent?: string;
  reason?: string;
  card?: string;
  template?: string;
  query?: string;
  sql?: string;
  param?: string[];
  allowDiscovery?: boolean;
  allowMutate?: boolean;
  allowPartitionScan?: boolean;
  allowSchemaIntrospection?: boolean;
  explain?: boolean;
  full?: boolean;
  rowsObject?: boolean;
  pluck?: string;
  proto?: string;
  protoRoot?: string;
  allowFlush?: boolean;
  requestJson?: string;
  skipProtoValidate?: boolean;
  timeoutMs?: string;
}

export interface QueryEnv {
  ctx: AppContext;
  opts: QueryOpts;
  progress: ProgressReporter;
  logVerbose: (msg: string) => void;
  env: string;
  namespace: string;
  timeoutMs: number;
  allowDiscovery: boolean;
  explicitProfile: ReturnType<AppContext['datasourceStore']['get']>;
  alias: { env: string; service: string } | null;
}
