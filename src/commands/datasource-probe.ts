import type { AppContext } from '../core/app.js';
import { runDatasourceConnectors } from '../core/connector-runner.js';
import type { DatasourceProfile } from '../types/datasource.js';
import { DoctorStatus } from '../types/plugin.js';
import type { DoctorCheck } from '../types/plugin.js';
import { isDoctorCapable } from './doctor-plugin.js';
import type { DoctorCapablePlugin } from './doctor-plugin.js';
import { errorText } from '../core/error-text.js';

function probeFailed(name: string, detail: string): Error {
  const rerun = `taproot doctor --datasource ${name} --connect`;
  const remove = `taproot datasource remove ${name}`;
  return new Error(`PROBE_FAILED: profile ${name} saved, probe failed. ${detail}. Re-run: ${rerun}. Remove: ${remove}`);
}

function describeFailedChecks(checks: DoctorCheck[]): string | undefined {
  const failures = checks.filter((check) => check.status === DoctorStatus.Fail);
  return failures.length > 0 ? failures.map((check) => `${check.check}: ${check.detail}`).join(' | ') : undefined;
}

async function runProbeChecks(ctx: AppContext, saved: DatasourceProfile, plugin: DoctorCapablePlugin): Promise<DoctorCheck[]> {
  const connectorChecks = await runDatasourceConnectors({
    datasource: saved,
    credentialStore: ctx.credentialStore,
    pluginRegistry: ctx.pluginRegistry,
    mode: 'connect',
  });
  const connectorFailures = describeFailedChecks(connectorChecks);
  if (connectorFailures !== undefined) {
    throw probeFailed(saved.name, connectorFailures);
  }
  const credentials = await ctx.credentialStore.get(saved.credentialRef);
  const pluginChecks = await plugin.doctor({ datasource: saved, credentials });
  const pluginFailures = describeFailedChecks(pluginChecks);
  if (pluginFailures !== undefined) {
    throw probeFailed(saved.name, pluginFailures);
  }
  return [...connectorChecks, ...pluginChecks];
}

function isProbeVerdict(error: unknown): boolean {
  const message = errorText(error);
  return message.startsWith('PROBE_FAILED') || message.startsWith('PROBE_UNSUPPORTED');
}

export async function probeSavedProfile(ctx: AppContext, saved: DatasourceProfile, existedBeforeSave: boolean): Promise<DoctorCheck[]> {
  const plugin = ctx.pluginRegistry.get(saved.kind);
  if (!isDoctorCapable(plugin)) {
    if (!existedBeforeSave) {
      ctx.datasourceStore.remove(saved.name);
    }
    throw new Error(`PROBE_UNSUPPORTED: plugin '${saved.kind}' does not implement doctor(); cannot probe.`);
  }
  try {
    return await runProbeChecks(ctx, saved, plugin);
  } catch (error) {
    if (isProbeVerdict(error)) {
      throw error;
    }
    throw probeFailed(saved.name, errorText(error));
  }
}
