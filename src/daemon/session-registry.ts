import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../core/time.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { sessionBusy } from '../core/error-classification.js';
import type { SessionCheckpoint, SessionRecord } from './types.js';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function sha256(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return `sha256:${hash}`;
}

export function buildFingerprint(input: {
  datasourceName: string;
  env?: string;
  namespace?: string;
  service?: string;
  kind?: string;
  connection?: Record<string, unknown>;
  connectors?: string[];
}): string {
  const payload = {
    datasourceName: input.datasourceName,
    env: input.env || '',
    namespace: input.namespace || '',
    service: input.service || '',
    kind: input.kind || '',
    connection: input.connection || {},
    connectors: [...(input.connectors || [])].sort(),
  };
  return sha256(stableStringify(payload));
}

export class SessionRegistry {
  private readonly checkpointFile: string;
  private readonly sessionsById = new Map<string, SessionRecord>();
  private readonly sessionIdByFingerprint = new Map<string, string>();
  private readonly leaseHeartbeats = new Map<string, Map<string, number>>();

  constructor(private readonly runDir: string) {
    fs.mkdirSync(this.runDir, { recursive: true });
    this.checkpointFile = path.join(this.runDir, 'sessions.json');
    this.loadCheckpoint();
  }

  private checkpointPayload(): SessionCheckpoint {
    return {
      schemaVersion: 1,
      updatedAt: nowIso(),
      sessions: this.list(),
    };
  }

  private loadCheckpoint(): void {
    if (!fs.existsSync(this.checkpointFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.checkpointFile, 'utf8')) as SessionCheckpoint;
      if (raw.schemaVersion !== 1) throw new Error(`Unsupported sessions checkpoint schemaVersion=${raw.schemaVersion}`);
      for (const session of raw.sessions || []) {
        const recovering: SessionRecord = {
          ...session,
          state: 'recovering',
        };
        this.sessionsById.set(recovering.sessionId, recovering);
        this.sessionIdByFingerprint.set(recovering.fingerprint, recovering.sessionId);
      }
    } catch {
      const backup = `${this.checkpointFile}.corrupt.${Date.now()}`;
      fs.renameSync(this.checkpointFile, backup);
    }
  }

  persist(): void {
    const payload = this.checkpointPayload();
    const tmp = `${this.checkpointFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.checkpointFile);
  }

  list(): SessionRecord[] {
    return [...this.sessionsById.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessionsById.get(sessionId);
  }

  findByFingerprint(fingerprint: string): SessionRecord | undefined {
    const id = this.sessionIdByFingerprint.get(fingerprint);
    return id ? this.sessionsById.get(id) : undefined;
  }

  open(input: {
    datasourceName: string;
    env?: string;
    namespace?: string;
    service?: string;
    kind?: string;
    connection?: Record<string, unknown>;
    connectors?: string[];
  }): SessionRecord {
    const fingerprint = buildFingerprint(input);
    const existing = this.findByFingerprint(fingerprint);
    if (existing && existing.state !== 'closed') {
      existing.lastUsedAt = nowIso();
      if (existing.state === 'recovering' || existing.state === 'opening') existing.state = 'ready';
      this.persist();
      return existing;
    }

    const now = nowIso();
    const sessionId = `sess_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const created: SessionRecord = {
      sessionId,
      fingerprintVersion: RUNTIME_CONSTANTS.fingerprintVersion,
      fingerprint,
      datasourceName: input.datasourceName,
      env: input.env,
      namespace: input.namespace,
      service: input.service,
      kind: input.kind,
      state: 'ready',
      createdAt: now,
      lastUsedAt: now,
      idleTtlMs: RUNTIME_CONSTANTS.session.idleTtlMs,
      hardTtlMs: RUNTIME_CONSTANTS.session.hardTtlMs,
      leaseCount: 0,
      resources: [],
      metrics: {
        queryCount: 0,
        successCount: 0,
        failureCount: 0,
        p50DurationMs: 0,
      },
      degraded: {
        attempts: 0,
        nextRevalidateAt: now,
        lastErrorCode: '',
      },
    };
    this.sessionsById.set(created.sessionId, created);
    this.sessionIdByFingerprint.set(created.fingerprint, created.sessionId);
    this.persist();
    return created;
  }

  acquireLease(sessionId: string): string {
    const session = this.sessionsById.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const leaseId = `lease_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const now = Date.now();
    const leases = this.leaseHeartbeats.get(sessionId) || new Map<string, number>();
    if (leases.size >= RUNTIME_CONSTANTS.session.maxConcurrentLeases) {
      throw sessionBusy(
        `session ${sessionId} has ${leases.size} active leases (max ${RUNTIME_CONSTANTS.session.maxConcurrentLeases})`,
      );
    }
    leases.set(leaseId, now);
    this.leaseHeartbeats.set(sessionId, leases);
    session.leaseCount = leases.size;
    session.lastUsedAt = nowIso();
    return leaseId;
  }

  heartbeatLease(sessionId: string, leaseId: string): void {
    const leases = this.leaseHeartbeats.get(sessionId);
    if (!leases || !leases.has(leaseId)) return;
    leases.set(leaseId, Date.now());
  }

  releaseLease(sessionId: string, leaseId: string): void {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;
    const leases = this.leaseHeartbeats.get(sessionId);
    if (!leases) return;
    leases.delete(leaseId);
    session.leaseCount = leases.size;
    session.lastUsedAt = nowIso();
    if (!leases.size) this.leaseHeartbeats.delete(sessionId);
  }

  onTick(): { expired: number; staleLeases: number; expiredSessionIds: string[] } {
    const now = Date.now();
    let expired = 0;
    let staleLeases = 0;
    const expiredSessionIds: string[] = [];
    for (const session of [...this.sessionsById.values()]) {
      const leases = this.leaseHeartbeats.get(session.sessionId);
      if (leases) {
        for (const [leaseId, heartbeatAt] of [...leases.entries()]) {
          if (now - heartbeatAt > RUNTIME_CONSTANTS.session.leaseStaleThresholdMs) {
            leases.delete(leaseId);
            staleLeases += 1;
          }
        }
        session.leaseCount = leases.size;
        if (!leases.size) this.leaseHeartbeats.delete(session.sessionId);
      }
      const createdAt = new Date(session.createdAt).getTime();
      const lastUsedAt = new Date(session.lastUsedAt).getTime();
      const hardExpired = now - createdAt >= session.hardTtlMs;
      const idleExpired = now - lastUsedAt >= session.idleTtlMs;
      if (hardExpired || idleExpired) {
        this.sessionIdByFingerprint.delete(session.fingerprint);
        this.sessionsById.delete(session.sessionId);
        this.leaseHeartbeats.delete(session.sessionId);
        expiredSessionIds.push(session.sessionId);
        expired += 1;
      }
    }
    this.persist();
    return { expired, staleLeases, expiredSessionIds };
  }
}
