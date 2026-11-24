import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import type { GrpcModule } from '../../core/proto-loader.js';
import type { QueryRequest } from '../../types/plugin.js';
import { connectionHost, connectionPort } from '../_shared/connection-endpoint.js';

type GrpcClient = Record<string, unknown> & {
  waitForReady: (deadline: number, callback: (error?: Error) => void) => void;
  close: () => void;
};

type ServiceConstructor = new (target: string, credentials: unknown) => Record<string, unknown>;

type ClientRequest = {
  grpcModule: GrpcModule;
  serviceConstructor: ServiceConstructor;
  datasource: QueryRequest['datasource'];
  protoRoot: string;
  serviceName: string;
};

const clientCache = new Map<string, { serviceConstructor: ServiceConstructor; client: GrpcClient }>();

function isGrpcClient(value: Record<string, unknown>): value is GrpcClient {
  return typeof value.waitForReady === 'function' && typeof value.close === 'function';
}

function clientTarget(datasource: QueryRequest['datasource']): string {
  const { connection } = datasource;
  return `${connectionHost(connection)}:${connectionPort(connection, RUNTIME_CONSTANTS.defaultPorts.grpc)}`;
}

export function buildClient(grpcModule: GrpcModule, ServiceClient: ServiceConstructor, datasource: QueryRequest['datasource']): GrpcClient {
  const credentials = datasource.connection.ssl === true ? grpcModule.credentials.createSsl() : grpcModule.credentials.createInsecure();
  const client = new ServiceClient(clientTarget(datasource), credentials);
  if (!isGrpcClient(client)) {
    throw new Error('grpc service client is missing waitForReady or close');
  }
  return client;
}

export function getOrCreateClient({ grpcModule, serviceConstructor, datasource, protoRoot, serviceName }: ClientRequest): GrpcClient {
  const transport = datasource.connection.ssl === true ? 'tls' : 'h2c';
  const key = [clientTarget(datasource), transport, protoRoot, serviceName].join('|');
  const cached = clientCache.get(key);
  if (cached?.serviceConstructor === serviceConstructor) {
    return cached.client;
  }
  cached?.client.close();
  const client = buildClient(grpcModule, serviceConstructor, datasource);
  clientCache.set(key, { serviceConstructor, client });
  return client;
}
