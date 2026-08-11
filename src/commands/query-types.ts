
export interface QueryOpts {
  datasource?: string;
  env?: string;
  namespace?: string;
  service?: string;
  intent?: string;
  reason?: string;
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
  timeout?: string;
  timeoutMs?: string;
  tz?: string;
  jsonExtract?: string[];
}

