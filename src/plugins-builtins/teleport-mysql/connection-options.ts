import type { ConnectionOptions } from 'mysql2/promise';
import { LOOPBACK_HOST } from '../_shared/connection-endpoint.js';
import type { ProxyRuntime } from './proxy-process.js';

export type ProxyTarget = {
  target: string;
  user: string;
  database: string;
};

export function proxyConnectionOptions(proxy: ProxyRuntime, { user, database }: ProxyTarget, password: string | undefined): ConnectionOptions {
  return { host: LOOPBACK_HOST, port: proxy.port, user, password, database };
}
