import type { DatasourceProfile } from '../../types/datasource.js';

export const LOOPBACK_HOST = '127.0.0.1';

export function connectionHost(connection: DatasourceProfile['connection']): string {
  const { host } = connection;
  return host === undefined || host === '' ? LOOPBACK_HOST : host;
}

export function connectionPort(connection: DatasourceProfile['connection'], defaultPort: number): number {
  const { port } = connection;
  return port === undefined || port === 0 || Number.isNaN(port) ? defaultPort : port;
}
