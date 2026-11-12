import type { DatasourceProfile } from '../../src/types/core.js';

export function testDatasource(kind: 'grpc' | 'redis', port: number, resolverHints: Record<string, string>): DatasourceProfile {
  return {
    name: `unit-${kind}`,
    kind,
    connection: { host: '127.0.0.1', port },
    credentialRef: `unit-${kind}`,
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    resolverHints,
    updatedAt: new Date().toISOString(),
    confidence: 0.9,
  };
}
