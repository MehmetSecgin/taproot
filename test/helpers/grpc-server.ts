import { Server, ServerCredentials } from '@grpc/grpc-js';
import type { ServiceDefinition, UntypedServiceImplementation } from '@grpc/grpc-js';
import { loadGrpcPackage } from '../../src/core/proto-loader.js';

type ProfileServicePackage = { taproot: { test: { ProfileService: { service: ServiceDefinition } } } };

function isProfileServicePackage(value: unknown): value is ProfileServicePackage {
  return typeof value === 'object' && value !== null && 'taproot' in value;
}

export async function profileServiceDefinition(protoRoot: string): Promise<ServiceDefinition> {
  const bundle = await loadGrpcPackage(protoRoot);
  const grpcPackage: unknown = bundle.grpcPackage;
  if (!isProfileServicePackage(grpcPackage)) {
    throw new Error('proto root does not define taproot.test.ProfileService');
  }
  return grpcPackage.taproot.test.ProfileService.service;
}

export async function startGrpcServer(
  service: ServiceDefinition,
  handlers: UntypedServiceImplementation,
): Promise<{ server: Server; port: number }> {
  const server = new Server();
  server.addService(service, handlers);
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, bound) => {
      if (error === null) {
        resolve(bound);
      } else {
        reject(error);
      }
    });
  });
  return { server, port };
}
