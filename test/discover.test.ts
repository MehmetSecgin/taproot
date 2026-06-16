import { describe, expect, it } from 'vitest';
import {
  classifyKubeService,
  classifyTshDatabase,
  type KubeService,
  type TshDatabase,
} from '../src/core/discover-datasources.js';

const baseOpts = { env: 'qa' };

describe('classifyKubeService', () => {
  it('matches mysql via port 3306 and wires openvpn by default', () => {
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
      connectors: ['openvpn'],
      resolverHints: { openvpnCredentialRef: 'vpn:work' },
      source: 'kubectl',
    });
    expect(p?.reason).toContain('port 3306');
  });

  it('matches tidb (port 4000) and tiproxy (port 6000) as mysql', () => {
    const tidbSvc: KubeService = {
      metadata: { name: 'analytics', namespace: 'analytics' },
      spec: { ports: [{ port: 4000 }] },
    };
    expect(classifyKubeService(tidbSvc, baseOpts)?.kind).toBe('mysql');

    const tiproxySvc: KubeService = {
      metadata: { name: 'orders', namespace: 'develop' },
      spec: { ports: [{ port: 6000 }] },
    };
    expect(classifyKubeService(tiproxySvc, baseOpts)?.connection.port).toBe(6000);
  });

  it('matches postgres via port 5432', () => {
    const svc: KubeService = {
      metadata: { name: 'invoices', namespace: 'billing' },
      spec: { ports: [{ port: 5432 }] },
    };
    expect(classifyKubeService(svc, baseOpts)?.kind).toBe('postgres');
  });

  it('skips system namespaces and non-DB services', () => {
    expect(classifyKubeService({ metadata: { name: 'kube-dns', namespace: 'kube-system' }, spec: { ports: [{ port: 3306 }] } }, baseOpts)).toBeNull();
    expect(classifyKubeService({ metadata: { name: 'api-gateway', namespace: 'default' }, spec: { ports: [{ port: 8080 }] } }, baseOpts)).toBeNull();
  });

  it('builds tiproxy host pattern when hostPattern=tiproxy', () => {
    const svc: KubeService = {
      metadata: { name: 'orders', namespace: 'develop' },
      spec: { ports: [{ port: 6000 }] },
    };
    const p = classifyKubeService(svc, { env: 'qa', hostPattern: 'tiproxy', sharedCredentialRef: true });
    expect(p?.connection.host).toBe('tiproxy-orders.develop');
    expect(p?.connection.port).toBe(6000);
    expect(p?.credentialRef).toBe('qa');
    expect(p?.connectors).toEqual(['openvpn']);
  });

  it('omits openvpn connector when vpn=false', () => {
    const svc: KubeService = {
      metadata: { name: 'orders-mysql', namespace: 'orders' },
      spec: { ports: [{ port: 3306 }] },
    };
    const p = classifyKubeService(svc, { env: 'qa', vpn: false });
    expect(p?.connectors).toEqual([]);
    expect(p?.resolverHints).toEqual({});
  });
});

describe('classifyTshDatabase', () => {
  it('emits openvpn + teleport connectors by default', () => {
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
      connectors: ['openvpn', 'teleport'],
      source: 'teleport',
    });
    expect(p?.resolverHints.openvpnCredentialRef).toBe('vpn:work');
    expect(p?.resolverHints.teleportCredentialRef).toBe('tsh:prod');
  });

  it('classifies postgres tsh DB', () => {
    const db: TshDatabase = {
      metadata: { name: 'prod-billing-pg', labels: { env: 'prod', service: 'billing' } },
      spec: { protocol: 'postgres' },
    };
    expect(classifyTshDatabase(db, { env: 'prod' })?.kind).toBe('postgres');
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
    expect(classifyTshDatabase(db, { env: 'prod' })?.connection.target).toBe('flat-db');
  });

  it('omits openvpn connector when vpn=false', () => {
    const db: TshDatabase = { name: 'prod-orders', protocol: 'mysql', labels: { env: 'prod', service: 'orders' } };
    const p = classifyTshDatabase(db, { env: 'prod', vpn: false });
    expect(p?.connectors).toEqual(['teleport']);
    expect(p?.resolverHints.openvpnCredentialRef).toBeUndefined();
  });

  it('skips unsupported protocols', () => {
    expect(classifyTshDatabase({ name: 'cache', protocol: 'redis' }, { env: 'prod' })).toBeNull();
  });
});
