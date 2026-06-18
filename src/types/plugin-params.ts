export interface GrpcPluginParams {
  protoRoot?: string;
  requestJson?: string;
  skipProtoValidate?: boolean | string;
  params?: Record<string, string>;
  [key: string]: unknown;
}

export interface RedisPluginParams {
  protoRoot?: string;
  protoMessage?: string;
  allowFlush?: boolean;
  [key: string]: unknown;
}

export interface BuiltinPluginParams {
  protoRoot?: string;
  protoMessage?: string;
  requestJson?: string;
  skipProtoValidate?: boolean | string;
  allowFlush?: boolean;
  params?: Record<string, string>;
  [key: string]: unknown;
}
