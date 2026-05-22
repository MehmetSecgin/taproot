import { describe, expect, it } from 'vitest';
import {
  classifyKubeService,
  classifyTshDatabase,
  type KubeService,
  type TshDatabase,
} from '../src/core/discover-datasources.js';

const baseOpts = { env: 'qa', mode: 'native' as const };

describe('classifyKubeService', () => {
  it('matches mysql via port 3306', () => {
    const svc: KubeService = {
      metadata: { name: 'orders-mysql', namespace: 'orders' },
      spec: { ports: [{ port: 3306, protocol: 'TCP' }] },
    };
    const p = classifyKubeService(svc, baseOpts);
    expect(p).toMatchObject({
      kind: 'mysql',
      name: 'qa-orders-orders-mysql',
      service: 'orders-mysql',
      namespace: 'orders',
      connection: { host: 'orders-mysql', port: 3306, database: 'orders_mysql' },
      credentialRef: 'qa:orders-mysql',
      connectors: [],
      source: 'kubectl',
    });
    expect(p?.reason).toContain('port 3306');
  });

  it('matches postgres via port 5432', () => {
    const svc: KubeService = {
      metadata: { name: 'invoices-pg', namespace: 'billing' },
      spec: { ports: [{ port: 5432 }] },
    };
    const p = classifyKubeService(svc, baseOpts);
    expect(p?.kind).toBe('postgres');
    expect(p?.connection.port).toBe(5432);
  });

  it('matches tidb (port 4000) as mysql wire protocol', () => {
    const svc: KubeService = {
      metadata: { name: 'analytics-tidb', namespace: 'analytics' },
      spec: { ports: [{ port: 4000 }] },
    };
    const p = classifyKubeService(svc, baseOpts);
    expect(p?.kind).toBe('mysql');
    expect(p?.connection.port).toBe(4000);
  });

  it('matches via service name when ports do not match', () => {
    const svc: KubeService = {
      metadata: { name: 'mariadb-headless', namespace: 'db' },
      spec: { ports: [{ port: 7777 }] },
    };
    const p = classifyKubeService(svc, baseOpts);
    expect(p?.kind).toBe('mysql');
    expect(p?.reason).toMatch(/service name matches/);
  });

  it('skips non-DB services', () => {
    const svc: KubeService = {
      metadata: { name: 'api-gateway', namespace: 'default' },
      spec: { ports: [{ port: 8080 }] },
    };
    expect(classifyKubeService(svc, baseOpts)).toBeNull();
  });

  it('skips system namespaces', () => {
    const svc: KubeService = {
      metadata: { name: 'kube-dns', namespace: 'kube-system' },
      spec: { ports: [{ port: 3306 }] },
    };
    expect(classifyKubeService(svc, baseOpts)).toBeNull();
  });

  it('produces qa-portforward wiring when mode=qa-portforward', () => {
    const svc: KubeService = {
      metadata: { name: 'orders-mysql', namespace: 'orders' },
      spec: { ports: [{ port: 3306 }] },
    };
    const p = classifyKubeService(svc, { env: 'qa', mode: 'qa-portforward' });
    expect(p?.connection.host).toBe('127.0.0.1');
    expect(p?.connection.target).toBe('orders-mysql');
    expect(p?.connectors).toContain('kubectl-portforward');
    expect(p?.resolverHints['kubectl-portforwardCredentialRef']).toBe('kpf:qa:orders:orders-mysql');
  });
});

describe('classifyTshDatabase', () => {
  it('classifies mysql tsh DB as teleport-mysql', () => {
    const db: TshDatabase = {
      metadata: { name: 'prod-orders-tidb', labels: { env: 'prod', service: 'orders' } },
      spec: { protocol: 'mysql' },
    };
    const p = classifyTshDatabase(db, { env: 'prod' });
    expect(p).toMatchObject({
      kind: 'teleport-mysql',
      env: 'prod',
      service: 'orders',
      connection: { database: 'orders', target: 'prod-orders-tidb' },
      credentialRef: 'prod:orders',
      connectors: ['teleport'],
      source: 'teleport',
    });
    expect(p?.resolverHints.teleportCredentialRef).toBe('tsh:prod');
  });

  it('classifies postgres tsh DB', () => {
    const db: TshDatabase = {
      metadata: { name: 'prod-billing-pg', labels: { env: 'prod', service: 'billing' } },
      spec: { protocol: 'postgres' },
    };
    const p = classifyTshDatabase(db, { env: 'prod' });
    expect(p?.kind).toBe('postgres');
    expect(p?.connectors).toContain('teleport');
  });

  it('drops DB when label env mismatches', () => {
    const db: TshDatabase = {
      metadata: { name: 'staging-orders', labels: { env: 'staging' } },
      spec: { protocol: 'mysql' },
    };
    expect(classifyTshDatabase(db, { env: 'prod' })).toBeNull();
  });

  it('tolerates flat shape (no metadata wrapper)', () => {
    const db: TshDatabase = { name: 'flat-db', protocol: 'mysql', labels: { service: 'orders' } };
    const p = classifyTshDatabase(db, { env: 'prod' });
    expect(p).toMatchObject({ env: 'prod', service: 'orders', connection: { target: 'flat-db' } });
  });

  it('skips unsupported protocols', () => {
    const db: TshDatabase = { name: 'cache', protocol: 'redis' };
    expect(classifyTshDatabase(db, { env: 'prod' })).toBeNull();
  });
});
