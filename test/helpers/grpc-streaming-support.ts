import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UntypedServiceImplementation } from '@grpc/grpc-js';
import { onTestFinished } from 'vitest';
import { profileServiceDefinition, startGrpcServer } from './grpc-server.js';

type RejectionError = Error & { code?: unknown; details?: unknown };

export function protoRootWith(prefix: string, proto: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'profile.proto'), proto, 'utf8');
  return dir;
}

export async function startProfileServer(protoRoot: string, handlers: UntypedServiceImplementation): Promise<number> {
  const { server, port } = await startGrpcServer(await profileServiceDefinition(protoRoot), handlers);
  onTestFinished(() => {
    server.forceShutdown();
  });
  return port;
}

export async function rejectionOf(pending: Promise<unknown>): Promise<RejectionError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the call to reject');
}
