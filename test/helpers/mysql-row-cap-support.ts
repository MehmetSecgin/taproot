import { onTestFinished } from 'vitest';
import type { DatasourceProfile } from '../../src/types/datasource.js';
import type { QueryRequest, QueryResult, TapRootPlugin } from '../../src/types/plugin.js';
import type { FakeMysqlError, FakeMysqlServer } from './fake-mysql-server.js';

const noErrors: FakeMysqlError[] = [];

export function answerWithoutError(): FakeMysqlError | undefined {
  return noErrors.at(0);
}

export async function startServerForTest(start: () => Promise<FakeMysqlServer>): Promise<FakeMysqlServer> {
  const server = await start();
  onTestFinished(() => {
    server.close();
  });
  return server;
}

export function executeOf(plugin: TapRootPlugin): (request: QueryRequest, credentials: Record<string, string>) => Promise<QueryResult> {
  const { execute } = plugin;
  if (execute === undefined) {
    throw new Error(`plugin ${plugin.manifest.name} has no execute`);
  }
  return execute.bind(plugin);
}

export function profilesDatasource(kind: string, connection: DatasourceProfile['connection']): DatasourceProfile {
  return {
    name: 'qa-profiles',
    kind,
    connection,
    credentialRef: 'qa-profiles',
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: new Date().toISOString(),
  };
}

export function mysqlProfilesDatasource(port: number): DatasourceProfile {
  return profilesDatasource('mysql', { host: '127.0.0.1', port, database: 'profiles' });
}

export function doctorOf(plugin: TapRootPlugin): NonNullable<TapRootPlugin['doctor']> {
  const { doctor } = plugin;
  if (doctor === undefined) {
    throw new Error(`plugin ${plugin.manifest.name} has no doctor`);
  }
  return doctor.bind(plugin);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
