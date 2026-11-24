import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../core/time.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { isRecord } from '../core/json-shapes.js';

const SESSION_ID_LENGTH = 16;
const LEASE_ID_LENGTH = 12;
const CHECKPOINT_SCHEMA_VERSION = 1;

type SessionState = 'recovering' | 'ready' | 'closed';

export type SessionRecord = {
  sessionId: string;
  fingerprint: string;
  datasourceName: string;
  env?: string;
  namespace?: string;
  service?: string;
  kind?: string;
  state: SessionState;
  createdAt: string;
  lastUsedAt: string;
  idleTtlMs: number;
  hardTtlMs: number;
  leaseCount: number;
};

type SessionCheckpoint = {
  schemaVersion: number;
  updatedAt: string;
  sessions?: SessionRecord[] | null;
};

type SessionKey = {
  datasourceName: string;
  env?: string;
  namespace?: string;
  service?: string;
  kind?: string;
  connection?: Record<string, unknown>;
  connectors?: string[];
};

type ExpirySweep = { expired: number; staleLeases: number; expiredSessionIds: string[] };

function isSessionCheckpoint(value: unknown): value is SessionCheckpoint {
  return isRecord(value) && value.schemaVersion === CHECKPOINT_SCHEMA_VERSION && (value.sessions === undefined || value.sessions === null || Array.isArray(value.sessions));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value).toSorted(([keyA], [keyB]) => keyA.localeCompare(keyB));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

function sha256(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return `sha256:${hash}`;
}

function shortId(prefix: string, length: number): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, length)}`;
}

export function buildFingerprint(key: SessionKey): string {
  const payload = {
    datasourceName: key.datasourceName,
    env: key.env ?? '',
    namespace: key.namespace ?? '',
    service: key.service ?? '',
    kind: key.kind ?? '',
    connection: key.connection ?? {},
    connectors: (key.connectors ?? []).toSorted(),
  };
  return sha256(stableStringify(payload));
}

function readCheckpointSessions(checkpointFile: string): SessionRecord[] | undefined {
  try {
    const checkpoint: unknown = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
    return isSessionCheckpoint(checkpoint) ? (checkpoint.sessions ?? []) : undefined;
  } catch {
    return undefined;
  }
}

function isExpired(session: SessionRecord, now: number): boolean {
  const hardExpired = now - new Date(session.createdAt).getTime() >= session.hardTtlMs;
  const idleExpired = now - new Date(session.lastUsedAt).getTime() >= session.idleTtlMs;
  return hardExpired || idleExpired;
}

function recordLeaseActivity(session: SessionRecord, leases: Map<string, number>): void {
  session.leaseCount = leases.size;
  session.lastUsedAt = nowIso();
}

function removeStaleHeartbeats(leases: Map<string, number>, now: number): number {
  let removed = 0;
  for (const [leaseId, heartbeatAt] of leases.entries()) {
    if (now - heartbeatAt > RUNTIME_CONSTANTS.session.leaseStaleThresholdMs) {
      leases.delete(leaseId);
      removed += 1;
    }
  }
  return removed;
}

export class SessionRegistry {
  private readonly runDir: string;
  private readonly checkpointFile: string;
  private readonly sessionsById = new Map<string, SessionRecord>();
  private readonly sessionIdByFingerprint = new Map<string, string>();
  private readonly leaseHeartbeats = new Map<string, Map<string, number>>();
  private lastWrittenSessions: string | undefined = undefined;

  public constructor(runDir: string) {
    this.runDir = runDir;
    fs.mkdirSync(this.runDir, { recursive: true });
    this.checkpointFile = path.join(this.runDir, 'sessions.json');
    this.loadCheckpoint();
  }

  public list(): SessionRecord[] {
    return [...this.sessionsById.values()].toSorted((first, second) => first.createdAt.localeCompare(second.createdAt));
  }

  public get(sessionId: string): SessionRecord | undefined {
    return this.sessionsById.get(sessionId);
  }

  public open(key: SessionKey): SessionRecord {
    const fingerprint = buildFingerprint(key);
    const reused = this.reuseOpenSession(fingerprint);
    if (reused !== undefined) {
      return reused;
    }
    const now = nowIso();
    const created: SessionRecord = {
      sessionId: shortId('sess', SESSION_ID_LENGTH),
      fingerprint,
      datasourceName: key.datasourceName,
      env: key.env,
      namespace: key.namespace,
      service: key.service,
      kind: key.kind,
      state: 'ready',
      createdAt: now,
      lastUsedAt: now,
      idleTtlMs: RUNTIME_CONSTANTS.session.idleTtlMs,
      hardTtlMs: RUNTIME_CONSTANTS.session.hardTtlMs,
      leaseCount: 0,
    };
    this.sessionsById.set(created.sessionId, created);
    this.sessionIdByFingerprint.set(created.fingerprint, created.sessionId);
    this.persist();
    return created;
  }

  public acquireLease(sessionId: string): string {
    const session = this.sessionsById.get(sessionId);
    if (session === undefined) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const leaseId = shortId('lease', LEASE_ID_LENGTH);
    const leases = this.leaseHeartbeats.get(sessionId) ?? new Map<string, number>();
    leases.set(leaseId, Date.now());
    this.leaseHeartbeats.set(sessionId, leases);
    recordLeaseActivity(session, leases);
    return leaseId;
  }

  public heartbeatLease(sessionId: string, leaseId: string): void {
    const leases = this.leaseHeartbeats.get(sessionId);
    if (leases?.has(leaseId) !== true) {
      return;
    }
    leases.set(leaseId, Date.now());
  }

  public releaseLease(sessionId: string, leaseId: string): void {
    const session = this.sessionsById.get(sessionId);
    const leases = this.leaseHeartbeats.get(sessionId);
    if (session === undefined || leases === undefined) {
      return;
    }
    leases.delete(leaseId);
    recordLeaseActivity(session, leases);
    if (leases.size === 0) {
      this.leaseHeartbeats.delete(sessionId);
    }
  }

  public onTick(): ExpirySweep {
    const now = Date.now();
    let staleLeases = 0;
    const expiredSessionIds: string[] = [];
    for (const session of this.sessionsById.values()) {
      staleLeases += this.dropStaleLeases(session, now);
      if (isExpired(session, now)) {
        this.forget(session);
        expiredSessionIds.push(session.sessionId);
      }
    }
    this.persist();
    return { expired: expiredSessionIds.length, staleLeases, expiredSessionIds };
  }

  private loadCheckpoint(): void {
    if (!fs.existsSync(this.checkpointFile)) {
      return;
    }
    const sessions = readCheckpointSessions(this.checkpointFile);
    if (sessions === undefined) {
      fs.renameSync(this.checkpointFile, `${this.checkpointFile}.corrupt.${Date.now()}`);
      return;
    }
    for (const session of sessions) {
      const recovering: SessionRecord = { ...session, state: 'recovering' };
      this.sessionsById.set(recovering.sessionId, recovering);
      this.sessionIdByFingerprint.set(recovering.fingerprint, recovering.sessionId);
    }
  }

  private persist(): void {
    const sessions = this.list();
    const content = JSON.stringify(sessions);
    if (content === this.lastWrittenSessions) {
      return;
    }
    const checkpoint: SessionCheckpoint = { schemaVersion: CHECKPOINT_SCHEMA_VERSION, updatedAt: nowIso(), sessions };
    const temporaryFile = `${this.checkpointFile}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryFile, this.checkpointFile);
    this.lastWrittenSessions = content;
  }

  private reuseOpenSession(fingerprint: string): SessionRecord | undefined {
    const existingId = this.sessionIdByFingerprint.get(fingerprint);
    const existing = existingId === undefined ? undefined : this.sessionsById.get(existingId);
    if (existing === undefined || existing.state === 'closed') {
      return undefined;
    }
    existing.lastUsedAt = nowIso();
    if (existing.state === 'recovering') {
      existing.state = 'ready';
    }
    return existing;
  }

  private dropStaleLeases(session: SessionRecord, now: number): number {
    const leases = this.leaseHeartbeats.get(session.sessionId);
    if (leases === undefined) {
      return 0;
    }
    const dropped = removeStaleHeartbeats(leases, now);
    session.leaseCount = leases.size;
    if (leases.size === 0) {
      this.leaseHeartbeats.delete(session.sessionId);
    }
    return dropped;
  }

  private forget(session: SessionRecord): void {
    this.sessionIdByFingerprint.delete(session.fingerprint);
    this.sessionsById.delete(session.sessionId);
    this.leaseHeartbeats.delete(session.sessionId);
  }
}
