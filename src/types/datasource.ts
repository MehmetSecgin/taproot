export type Capability = 'doctor' | 'resolveConnection' | 'executeRead' | 'executeMutate';

export const DatasourceKind = {
  Mysql: 'mysql',
  TeleportMysql: 'teleport-mysql',
  Redis: 'redis',
  Grpc: 'grpc',
} as const;

export type DatasourceKind = (typeof DatasourceKind)[keyof typeof DatasourceKind];

export const SQL_DATASOURCE_KINDS: ReadonlySet<string> = new Set([DatasourceKind.Mysql, DatasourceKind.TeleportMysql]);

export const AccessMethod = {
  Native: 'native',
  KubectlPortforward: 'kubectl-portforward',
  Tsh: 'tsh',
} as const;

export type AccessMethod = (typeof AccessMethod)[keyof typeof AccessMethod];

export type DatasourcePolicy = {
  allowRead: boolean;
  allowMutate: boolean;
  allowedCapabilities: Capability[];
  requireDatabase?: boolean;
  strictKeyspace?: boolean;
};

export type DatasourceProfile = {
  name: string;
  kind: string;
  env?: string;
  namespace?: string;
  service?: string;
  tags?: string[];
  connection: {
    host?: string;
    port?: number;
    database?: string;
    target?: string;
    ssl?: boolean;
  };
  credentialRef: string;
  connectors?: string[];
  policy: DatasourcePolicy;
  resolverHints?: Record<string, string>;
  updatedAt: string;
};
