import * as grpc from '@grpc/grpc-js';
import { loadGrpcPackage } from '../../src/core/proto-loader.js';

export async function profileServiceDefinition(protoRoot: string): Promise<grpc.ServiceDefinition> {
  const bundle = await loadGrpcPackage(protoRoot);
  const pkg = bundle.grpcPackage as unknown as { taproot: { test: { ProfileService: { service: grpc.ServiceDefinition } } } };
  return pkg.taproot.test.ProfileService.service;
}

export async function startGrpcServer(
  service: grpc.ServiceDefinition,
  handlers: grpc.UntypedServiceImplementation,
): Promise<{ server: grpc.Server; port: number }> {
  const server = new grpc.Server();
  server.addService(service, handlers);
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, bound) => (err ? reject(err) : resolve(bound)));
  });
  return { server, port };
}
