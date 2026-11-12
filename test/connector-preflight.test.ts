import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatasourceProfile, DoctorCheck, TapRootPlugin } from '../src/types/core.js';

process.env.TAPROOT_CONNECTOR_CONNECT_MS = '300';
const { runDatasourceConnectors } = await import('../src/core/app.js');
const { RUNTIME_CONSTANTS } = await import('../src/core/constants.js');
const { kubectlPortforwardPlugin } = await import('../src/plugins-builtins/kubectl-portforward/index.js');

function datasource(name: string, connectors: string[] = ['fake']): DatasourceProfile {
  return {
    name,
    kind: 'mysql',
    connection: { host: '127.0.0.1', port: 3306 },
    credentialRef: `${name}:creds`,
    connectors,
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: new Date().toISOString(),
    confidence: 1,
  };
}

function fakeConnector(statuses: DoctorCheck['status'][]) {
  const connect = vi.fn(async (): Promise<DoctorCheck[]> => [
    { check: 'fake connect', status: statuses[Math.min(connect.mock.calls.length - 1, statuses.length - 1)], detail: 'ok' },
  ]);
  const plugin: TapRootPlugin = {
    manifest: { name: 'fake', kind: 'connector', capabilities: ['doctor'], priority: 1 },
    connect,
  };
  return { connect, pluginRegistry: new Map([['fake', plugin]]) };
}

function connectInput(profile: DatasourceProfile, pluginRegistry: Map<string, TapRootPlugin>) {
  return { datasource: profile, credentialStore: { get: async () => ({}) }, pluginRegistry, mode: 'connect' as const };
}

describe('connector preflight reuse', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips connect for a second query inside the reuse window', async () => {
    // arrange
    const { connect, pluginRegistry } = fakeConnector(['ok']);
    const input = connectInput(datasource('reuse-window'), pluginRegistry);
    await runDatasourceConnectors(input);

    // act
    const checks = await runDatasourceConnectors(input);

    // assert
    expect(connect).toHaveBeenCalledTimes(1);
    expect(checks).toEqual([{ check: 'fake connect', status: 'ok', detail: 'ok' }]);
  });

  it('runs connect once for parallel queries', async () => {
    // arrange
    const { connect, pluginRegistry } = fakeConnector(['ok']);
    const input = connectInput(datasource('parallel'), pluginRegistry);

    // act
    const results = await Promise.all([runDatasourceConnectors(input), runDatasourceConnectors(input), runDatasourceConnectors(input)]);

    // assert
    expect(connect).toHaveBeenCalledTimes(1);
    expect(results.every((checks) => checks[0].status === 'ok')).toBe(true);
  });

  it('runs connect again once the reuse window has passed', async () => {
    // arrange
    vi.useFakeTimers({ toFake: ['Date'] });
    const { connect, pluginRegistry } = fakeConnector(['ok']);
    const input = connectInput(datasource('expired'), pluginRegistry);
    await runDatasourceConnectors(input);
    vi.setSystemTime(Date.now() + RUNTIME_CONSTANTS.connector.connectReuseMs + 1);

    // act
    await runDatasourceConnectors(input);

    // assert
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('retries a failed connect on the next query', async () => {
    // arrange
    const { connect, pluginRegistry } = fakeConnector(['fail', 'ok']);
    const input = connectInput(datasource('retry-after-fail'), pluginRegistry);
    const first = await runDatasourceConnectors(input);

    // act
    const second = await runDatasourceConnectors(input);

    // assert
    expect(connect).toHaveBeenCalledTimes(2);
    expect(first[0].status).toBe('fail');
    expect(second[0].status).toBe('ok');
  });

  it('runs doctor checks on every call', async () => {
    // arrange
    const doctor = vi.fn(async (): Promise<DoctorCheck[]> => [{ check: 'fake status', status: 'ok', detail: 'ok' }]);
    const plugin: TapRootPlugin = { manifest: { name: 'fake', kind: 'connector', capabilities: ['doctor'], priority: 1 }, doctor };
    const input = { ...connectInput(datasource('doctor'), new Map([['fake', plugin]])), mode: 'doctor' as const };

    // act
    await runDatasourceConnectors(input);
    await runDatasourceConnectors(input);

    // assert
    expect(doctor).toHaveBeenCalledTimes(2);
  });
});

describe('kubectl-portforward connect', () => {
  it('fails a hung connect command at the timeout without blocking other work', async () => {
    // arrange
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 10);

    // act
    const checks = await kubectlPortforwardPlugin.connect!({
      datasource: datasource('hung-forward', ['kubectl-portforward']),
      credentials: { connectCommand: 'sleep 5' },
    });

    // assert
    expect(checks).toEqual([
      { check: 'kubectl-portforward connect', status: 'fail', detail: 'command timed out after 300ms', code: 'connector_connect_blocked' },
    ]);
    expect(timerFired).toBe(true);
  });
});
