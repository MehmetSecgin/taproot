import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNTIME_CONSTANTS } from '../src/core/constants.js';
import { buildFingerprint, SessionRegistry } from '../src/daemon/session-registry.js';

function tmpRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-sessions-'));
}

describe('session registry', () => {
  it('enforces per-session concurrent lease cap', () => {
    const reg = new SessionRegistry(tmpRunDir());
    const session = reg.open({ datasourceName: 'qa-sample', kind: 'mysql' });
    const leases: string[] = [];
    for (let i = 0; i < RUNTIME_CONSTANTS.session.maxConcurrentLeases; i += 1) {
      leases.push(reg.acquireLease(session.sessionId));
    }
    expect(() => reg.acquireLease(session.sessionId)).toThrow(/SESSION_BUSY/);
    for (const lease of leases) reg.releaseLease(session.sessionId, lease);
  });

  it('reclaims stale leases on sweep', () => {
    const reg = new SessionRegistry(tmpRunDir());
    const session = reg.open({ datasourceName: 'qa-sample', kind: 'mysql' });
    const lease = reg.acquireLease(session.sessionId);
    const leases = (reg as any).leaseHeartbeats.get(session.sessionId) as Map<string, number>;
    leases.set(lease, Date.now() - RUNTIME_CONSTANTS.session.leaseStaleThresholdMs - 1000);
    const out = reg.onTick();
    expect(out.staleLeases).toBe(1);
    expect(reg.get(session.sessionId)?.leaseCount).toBe(0);
  });

  it('loads checkpoint sessions as recovering and returns to ready on open', () => {
    const runDir = tmpRunDir();
    const now = new Date().toISOString();
    const payload = {
      schemaVersion: 1,
      updatedAt: now,
      sessions: [
        {
          sessionId: 'sess_abc123',
          fingerprintVersion: RUNTIME_CONSTANTS.fingerprintVersion,
          fingerprint: buildFingerprint({ datasourceName: 'qa-sample', kind: 'mysql', env: 'qa', service: 'sample' }),
          datasourceName: 'qa-sample',
          env: 'qa',
          service: 'sample',
          kind: 'mysql',
          state: 'ready',
          createdAt: now,
          lastUsedAt: now,
          idleTtlMs: RUNTIME_CONSTANTS.session.idleTtlMs,
          hardTtlMs: RUNTIME_CONSTANTS.session.hardTtlMs,
          leaseCount: 0,
          resources: [],
          metrics: { queryCount: 0, successCount: 0, failureCount: 0, p50DurationMs: 0 },
          degraded: { attempts: 0, nextRevalidateAt: now, lastErrorCode: '' },
        },
      ],
    };
    fs.writeFileSync(path.join(runDir, 'sessions.json'), JSON.stringify(payload, null, 2));
    const reg = new SessionRegistry(runDir);
    expect(reg.get('sess_abc123')?.state).toBe('recovering');
    const reopened = reg.open({ datasourceName: 'qa-sample', kind: 'mysql', env: 'qa', service: 'sample' });
    expect(reopened.sessionId).toBe('sess_abc123');
    expect(reopened.state).toBe('ready');
  });
});
