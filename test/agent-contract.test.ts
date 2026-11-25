import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runCli } from './helpers/cli.js';
import { tempStateRoot, writeRuntimeConfig } from './helpers/state-root.js';

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

const daemonStatusDataSchema = z.object({ pid: z.number() });

describe('agent JSON contract', () => {
  it('daemon status JSON uses envelope with requestId after a query starts the daemon', async () => {
    const { stateRoot } = tempStateRoot();
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-master-key' };
    runCli(['query', '--datasource', 'missing', '--sql', 'SELECT 1'], env);
    try {
      const out = runCli(['daemon', 'status'], env);
      expect(out.status).toBe(0);
      const parsed = successEnvelopeSchema.parse(JSON.parse(out.stdout));
      expect(daemonStatusDataSchema.parse(parsed.data).pid).toBeTypeOf('number');
    } finally {
      runCli(['daemon', 'stop'], env);
    }
  });

  it('query JSON error keeps request correlation metadata when daemon responds with error', async () => {
    const { stateRoot } = tempStateRoot();
    writeRuntimeConfig(stateRoot, {
      environmentPolicies: {
        prod: {
          deterministicRequired: true,
          allowDiscoveryByDefault: false,
        },
      },
    });
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-master-key' };
    try {
      const out = runCli(['query', '--env', 'prod', '--service', 'missing', '--sql', 'SELECT 1 AS ok'], env);
      expect(out.status).not.toBe(0);
      const parsed = errorEnvelopeSchema.parse(JSON.parse(out.stdout));
      expect(parsed.error.code).toBe('DETERMINISTIC_REQUIRED');
      expect(parsed.meta?.requestId).toBeDefined();
    } finally {
      runCli(['daemon', 'stop'], env);
    }
  });

  it('direct-mode query error emits the same error envelope', async () => {
    const { stateRoot } = tempStateRoot();
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
