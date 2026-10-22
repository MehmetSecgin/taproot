import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

function runCli(args: string[], env: Record<string, string>) {
  const distCli = path.join(process.cwd(), 'dist', 'index.js');
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function makeStateRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-contract-'));
}

function writeRuntimeConfig(stateRoot: string, config: Record<string, unknown>) {
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify(config));
}

const envelopeMetaSchema = z.object({
  requestId: z.string().min(1),
  runId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  timings: z.object({ durationMs: z.number().nonnegative() }).optional(),
});

const successEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
  meta: envelopeMetaSchema,
});

const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
  meta: envelopeMetaSchema.optional(),
});

describe('agent JSON contract', () => {
  it('daemon status JSON uses envelope with requestId', async () => {
    const stateRoot = makeStateRoot();
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-master-key' };
    const startOut = runCli(['daemon', 'start'], env);
    expect(startOut.status).toBe(0);
    try {
      const out = runCli(['daemon', 'status'], env);
      expect(out.status).toBe(0);
      const parsed = successEnvelopeSchema.parse(JSON.parse(out.stdout));
      expect((parsed.data as any).pid).toBeTypeOf('number');
    } finally {
      runCli(['daemon', 'stop'], env);
    }
  });

  it('session commands carry correlation metadata in JSON', async () => {
    const stateRoot = makeStateRoot();
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-master-key' };
    const startOut = runCli(['daemon', 'start'], env);
    expect(startOut.status).toBe(0);
    try {
      const openOut = runCli(['session', 'open', '--datasource', 'qa-any'], {
        ...env,
      });
      expect(openOut.status).toBe(0);
      const openParsed = successEnvelopeSchema.parse(JSON.parse(openOut.stdout));
      expect(openParsed.meta.sessionId).toBeTruthy();

      const lsOut = runCli(['session', 'ls'], env);
      expect(lsOut.status).toBe(0);
      const lsParsed = successEnvelopeSchema.parse(JSON.parse(lsOut.stdout));
      expect(Array.isArray((lsParsed.data as any).sessions)).toBe(true);
    } finally {
      runCli(['daemon', 'stop'], env);
    }
  });

  it('query JSON error keeps request correlation metadata when daemon responds with error', async () => {
    const stateRoot = makeStateRoot();
    writeRuntimeConfig(stateRoot, {
      environmentPolicies: {
        prod: {
          deterministicRequired: true,
          allowDiscoveryByDefault: false,
        },
      },
    });
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-master-key' };
    const startOut = runCli(['daemon', 'start'], env);
    expect(startOut.status).toBe(0);
    try {
      const out = runCli(['query', '--env', 'prod', '--service', 'missing', '--sql', 'SELECT 1 AS ok'], env);
      expect(out.status).not.toBe(0);
      const parsed = errorEnvelopeSchema.parse(JSON.parse(out.stdout));
      expect(parsed.error.code).toBe('DETERMINISTIC_REQUIRED');
      expect(parsed.meta?.requestId).toBeTruthy();
    } finally {
      runCli(['daemon', 'stop'], env);
    }
  });

  it('direct-mode query error emits the same error envelope', async () => {
    const stateRoot = makeStateRoot();
    writeRuntimeConfig(stateRoot, {
      environmentPolicies: {
        prod: {
          deterministicRequired: true,
          allowDiscoveryByDefault: false,
        },
      },
    });
    const env = {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-master-key',
      TAPROOT_FORCE_DIRECT: '1',
    };
    const out = runCli(['query', '--env', 'prod', '--service', 'missing', '--sql', 'SELECT 1 AS ok'], env);
    expect(out.status).not.toBe(0);
    const parsed = errorEnvelopeSchema.parse(JSON.parse(out.stdout));
    expect(parsed.error.code).toBe('DETERMINISTIC_REQUIRED');
    expect(parsed.error.message).toContain('--datasource');
  });
});
