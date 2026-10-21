
export interface QueryOpts {
  datasource?: string;
  env?: string;
  namespace?: string;
  service?: string;
  reason?: string;
  sql?: string;
  param?: string[];
  allowDiscovery?: boolean;
  allowMutate?: boolean;
  allowPartitionScan?: boolean;
  allowSchemaIntrospection?: boolean;
  explain?: boolean;
  rowsObject?: boolean;
  proto?: string;
  protoRoot?: string;
  allowFlush?: boolean;
  requestJson?: string;
  skipProtoValidate?: boolean;
  timeout?: string;
  tz?: string;
  jsonExtract?: string[];
}

