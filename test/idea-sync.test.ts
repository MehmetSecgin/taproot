import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultDbUser,
  describeDriver,
  deterministicLocalPort,
  diffStatus,
  ideaDisplayName,
  mergeIntoHistory,
  splitForeignEntries,
  stableUuidForDatasource,
  syncToHistoryFile,
  tshTunnelCommand,
} from '../src/core/idea-sync.js';
import type { DatasourceProfile } from '../src/types/core.js';

function makeProfile(overrides: Partial<DatasourceProfile> = {}): DatasourceProfile {
  return {
    name: 'develop-billing',
    kind: 'mysql',
    env: 'develop',
    service: 'billing',
    tags: [],
    connection: {
      host: 'tiproxy-billing.develop',
      port: 6000,
      database: 'billing_db',
    },
    credentialRef: 'develop:billing',
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: '2026-05-12T00:00:00.000Z',
    confidence: 0.9,
    ...overrides,
  } as DatasourceProfile;
}

describe('idea-sync', () => {
  it('stableUuidForDatasource is deterministic and well-formed', () => {
    const a = stableUuidForDatasource('develop-billing');
    const b = stableUuidForDatasource('develop-billing');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableUuidForDatasource('other')).not.toBe(a);
  });

  it('describeDriver returns mysql-family spec for mysql kind', () => {
    const d = describeDriver(makeProfile());
    expect('skip' in d).toBe(false);
    if ('skip' in d) return;
    expect(d.driverRef).toBe('tidb');
    expect(d.jdbcUrl).toBe('jdbc:mysql://tiproxy-billing.develop:6000/billing_db?allowPublicKeyRetrieval=true&useSSL=false');
  });

  it('describeDriver returns postgres spec for postgres kind', () => {
    const d = describeDriver(makeProfile({ kind: 'postgres', connection: { host: 'pg', port: 5432, database: 'app' } }));
    expect('skip' in d).toBe(false);
    if ('skip' in d) return;
    expect(d.driverRef).toBe('postgresql');
    expect(d.jdbcUrl).toBe('jdbc:postgresql://pg:5432/app');
  });

  it('describeDriver emits localhost tunnel jdbc for teleport-mysql', () => {
    const d = describeDriver(makeProfile({
      kind: 'teleport-mysql',
      connection: { database: 'orders', target: 'tidb-orders-prod' },
    }));
    expect('skip' in d).toBe(false);
    if ('skip' in d) return;
    expect(d.driverRef).toBe('tidb');
    expect(d.jdbcUrl).toMatch(/^jdbc:mysql:\/\/127\.0\.0\.1:3\d{4}\/orders/);
  });

  it('describeDriver skips teleport-mysql without target', () => {
    const d = describeDriver(makeProfile({ kind: 'teleport-mysql', connection: { database: 'x' } }));
    expect('skip' in d).toBe(true);
  });

  it('describeDriver skips when host/port missing', () => {
    const d = describeDriver(makeProfile({ connection: { database: 'x' } }));
    expect('skip' in d).toBe(true);
  });

  it('mergeIntoHistory preserves foreign entries and adds managed ones', () => {
    const existing = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="DataSourceManagerImpl" format="xml" multifile-model="false">
    <data-source source="LOCAL" name="hand-added" uuid="11111111-1111-1111-1111-111111111111">
      <driver-ref>mysql.8</driver-ref>
    </data-source>
  </component>
</project>`;
    const merged = mergeIntoHistory(existing, [
      {
        uuid: stableUuidForDatasource('develop-billing'),
        ideaName: 'billing_db@billing.develop (taproot)',
        managedName: 'develop-billing',
        spec: {
          driverRef: 'mysql.8',
          jdbcDriver: 'com.mysql.cj.jdbc.Driver',
          dbms: 'MYSQL',
          jdbcUrl: 'jdbc:mysql://h:1/d',
        },
        authMode: 'idea-managed',
      },
    ]);
    expect(merged).toContain('DataSourceManagerImpl');
    expect(merged).toContain('hand-added');
    expect(merged).toContain('taproot-managed: develop-billing');
    expect(merged).toContain('(taproot)');
    expect(splitForeignEntries(merged)).toHaveLength(1);
  });

  it('re-syncing overwrites previous managed entry instead of duplicating', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-sync-'));
    const target = path.join(tmp, '.idea', 'dataSources.xml');
    const profiles = [makeProfile()];
    syncToHistoryFile({ target, profiles });
    syncToHistoryFile({ target, profiles });
    const xml = fs.readFileSync(target, 'utf8');
    const occurrences = xml.match(/taproot-managed: develop-billing/g) || [];
    expect(occurrences).toHaveLength(1);
  });

  it('skipped profiles are reported and not written', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-sync-'));
    const target = path.join(tmp, '.idea', 'dataSources.xml');
    const result = syncToHistoryFile({
      target,
      profiles: [makeProfile({ name: 'tsh-orders', kind: 'teleport-mysql' })],
    });
    expect(result.written).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].name).toBe('tsh-orders');
    const xml = fs.readFileSync(target, 'utf8');
    expect(xml).not.toContain('tsh-orders');
  });

  it('diffStatus categorizes matched, taprootOnly, ideaOnly', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="DataSourceManagerImpl" format="xml" multifile-model="false">
    <!-- taproot-managed: develop-billing -->
    <data-source uuid="x" name="a"></data-source>
    <!-- taproot-managed: stale-only-in-idea -->
    <data-source uuid="y" name="b"></data-source>
  </component>
</project>`;
    const diff = diffStatus(xml, [
      makeProfile(),
      makeProfile({ name: 'new-in-taproot' }),
    ]);
    expect(diff.matched).toEqual(['develop-billing']);
    expect(diff.taprootOnly).toEqual(['new-in-taproot']);
    expect(diff.ideaOnly).toEqual(['stale-only-in-idea']);
  });

  it('ideaDisplayName uses <ns>.<env>.<service> when namespace present', () => {
    expect(ideaDisplayName(makeProfile({ namespace: 'test', env: 'qa', service: 'settlement' }))).toBe('test.qa.settlement');
    expect(ideaDisplayName(makeProfile({ namespace: 'develop', env: 'qa', service: 'orders' }))).toBe('develop.qa.orders');
  });

  it('ideaDisplayName omits namespace when empty', () => {
    expect(ideaDisplayName(makeProfile({ namespace: undefined, env: 'prod', service: 'orders' }))).toBe('prod.orders');
    expect(ideaDisplayName(makeProfile({ namespace: undefined, env: 'stg', service: 'billing' }))).toBe('stg.billing');
  });

  it('deterministicLocalPort is stable and inside 30000-39999, keyed by datasource', () => {
    const p = deterministicLocalPort('prod-catalog');
    expect(p).toBeGreaterThanOrEqual(30000);
    expect(p).toBeLessThan(40000);
    expect(deterministicLocalPort('prod-catalog')).toBe(p);
    expect(deterministicLocalPort('prod-billing')).not.toBe(p);
  });

  it('tshTunnelCommand renders ready-to-paste command with --db-user', () => {
    const cmd = tshTunnelCommand(makeProfile({
      name: 'prod-catalog', kind: 'teleport-mysql', service: 'orders',
      connection: { database: 'orders', target: 'tidb-orders-prod' },
    }));
    expect(cmd).toMatch(/^tsh proxy db --tunnel --port=3\d{4} --db-user=orders_reader tidb-orders-prod$/);
  });

  it('defaultDbUser converts service dashes to underscores and appends _reader', () => {
    expect(defaultDbUser(makeProfile({ service: 'billing' }))).toBe('billing_reader');
    expect(defaultDbUser(makeProfile({ service: 'pricing-template' }))).toBe('templates_reader');
  });

  it('defaultDbUser uses resolverHints.dbUser when present', () => {
    expect(defaultDbUser(makeProfile({ service: 'x', resolverHints: { dbUser: 'override_user' } }))).toBe('override_user');
  });

  it('syncToHistoryFile emits tsh tunnel hint comment for teleport-mysql', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-sync-'));
    const target = path.join(tmp, '.idea', 'dataSources.xml');
    syncToHistoryFile({
      target,
      profiles: [makeProfile({ name: 'prod-catalog', kind: 'teleport-mysql', env: 'prod', namespace: undefined, service: 'orders', connection: { database: 'orders', target: 'tidb-orders-prod' } })],
    });
    const xml = fs.readFileSync(target, 'utf8');
    expect(xml).toMatch(/<comment>tunnel: tsh proxy db --tunnel[^<]*<\/comment>/);
    expect(xml).toContain('name="prod.orders"');
    // XML comments must not contain `--`; ensure no tsh flags leaked into a comment node.
    const xmlComments = xml.match(/<!--[\s\S]*?-->/g) || [];
    for (const c of xmlComments) expect(c.includes('--tunnel')).toBe(false);
  });

  it('default driver-ref is tidb for mysql/tidb/teleport-mysql', () => {
    const m = describeDriver(makeProfile({ kind: 'mysql' }));
    const t = describeDriver(makeProfile({ kind: 'teleport-mysql', connection: { database: 'd', target: 'tgt' } }));
    expect('skip' in m).toBe(false);
    expect('skip' in t).toBe(false);
    if ('skip' in m || 'skip' in t) return;
    expect(m.driverRef).toBe('tidb');
    expect(t.driverRef).toBe('tidb');
  });

  it('prod-orders overrides driver-ref to mysql.8', () => {
    const d = describeDriver(makeProfile({ name: 'prod-orders', kind: 'teleport-mysql', connection: { database: 'rp', target: 'tidb-orders-prod' } }));
    expect('skip' in d).toBe(false);
    if ('skip' in d) return;
    expect(d.driverRef).toBe('mysql.8');
  });

  it('syncToHistoryFile writes entries sorted alphabetically by display name', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-sync-'));
    const target = path.join(tmp, '.idea', 'dataSources.xml');
    syncToHistoryFile({
      target,
      profiles: [
        makeProfile({ name: 'b', service: 'beta', env: 'qa', namespace: 'test' }),
        makeProfile({ name: 'a', service: 'alpha', env: 'prod', namespace: undefined, kind: 'mysql', connection: { host: 'h', port: 1, database: 'a' } }),
        makeProfile({ name: 'c', service: 'gamma', env: 'qa', namespace: 'develop' }),
      ],
    });
    const xml = fs.readFileSync(target, 'utf8');
    const names = [...xml.matchAll(/<data-source\s[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(['develop.qa.gamma', 'prod.alpha', 'test.qa.beta']);
  });

  it('jdbc URL escapes ampersand correctly inside XML output', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-sync-'));
    const target = path.join(tmp, '.idea', 'dataSources.xml');
    syncToHistoryFile({ target, profiles: [makeProfile()] });
    const xml = fs.readFileSync(target, 'utf8');
    expect(xml).toContain('useSSL=false');
    expect(xml).toContain('&amp;');
    expect(xml).not.toMatch(/[^&]&useSSL/);
  });
});
