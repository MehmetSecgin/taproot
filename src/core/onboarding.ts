import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { AppContext } from './app.js';
import { defaultDatasourceName, normalizeNamespace, normalizeService, runDatasourceConnectors } from './app.js';
import { reconcileDatasource } from './bootstrap.js';
import { ensureCredentialDefaults } from './bootstrap.js';
import { collectReadinessSnapshot } from './readiness.js';
import { ensureStarterRuntime } from './runtime-init.js';
import { nowIso } from './time.js';

export type OnboardStepKind = 'local' | 'access' | 'live' | 'input' | 'setup' | 'validation';
export type OnboardStepStatus = 'done' | 'skipped' | 'blocked' | 'not_needed' | 'failed';

export interface OnboardStep {
  id: string;
  title: string;
  kind: OnboardStepKind;
  status: OnboardStepStatus;
  summary: string;
  details?: string[];
  nextAction?: string | null;
}

export interface OnboardTarget {
  env: string;
  service: string;
  namespace?: string;
}

export interface OnboardRunOptions {
  approveLocal: boolean;
  approveAccess: boolean;
  approveLive: boolean;
  target?: OnboardTarget;
  runValidation?: boolean;
  manualDatasourceDeclined?: boolean;
}

export interface OnboardRunResult {
  steps: OnboardStep[];
  approvedGroups: string[];
  skippedGroups: string[];
  target?: OnboardTarget;
  datasource?: string | null;
  nextActions: string[];
}

export interface ManualDatasourceInput {
  env: string;
  service: string;
  namespace?: string;
  mode: 'native' | 'qa-portforward' | 'tsh';
  engine: 'mysql' | 'postgres';
  database: string;
  host?: string;
  port?: number;
  target?: string;
  credentialRef?: string;
  dbUser?: string;
}

interface CommandResult {
  ok: boolean;
  detail: string;
}

function runCommand(command: string, args: string[]): CommandResult {
  const proc = spawnSync(command, args, { encoding: 'utf8' });
  const detail = String(proc.stdout || proc.stderr || '').trim() || `exit=${proc.status || 0}`;
  return { ok: (proc.status || 0) === 0, detail };
}

function commandPath(command: string): string | null {
  const out = runCommand('/bin/zsh', ['-lc', `command -v ${command}`]);
  return out.ok ? out.detail.split('\n')[0].trim() : null;
}

async function keychainAvailable(): Promise<boolean> {
  try {
    await import('keytar');
    return true;
  } catch {
    return false;
  }
}

function summarizeChecks(checks: Array<{ check: string; status: string; detail: string }>, filter: (check: { check: string; status: string; detail: string }) => boolean): string[] {
  return checks.filter(filter).map((check) => `${check.check}: ${check.status} - ${check.detail}`);
}

async function manualTargetValidation(ctx: AppContext, target: OnboardTarget) {
  const datasource = ctx.datasourceStore.resolveByEnvService(target.env, target.service, target.namespace);
  if (!datasource) {
    return {
      status: 'blocked' as const,
      summary: 'Final validation could not run because no datasource was created for the target.',
      details: [] as string[],
      nextAction: 'Create a datasource for the target, then rerun taproot onboard or taproot self-check --agent --env <env> --service <service> ...',
    };
  }
  const creds = await ctx.credentialStore.get(datasource.credentialRef);
  const hasCreds = Object.keys(creds).length > 0;
  const connectorChecks = hasCreds
    ? await runDatasourceConnectors({
        datasource,
        credentialStore: ctx.credentialStore,
        pluginRegistry: ctx.pluginRegistry,
        mode: 'doctor',
      })
    : [];
  const details = [
    `target_datasource: ok - ${datasource.name}`,
    `target_credentials: ${hasCreds ? 'ok' : 'fail'} - ${hasCreds ? `${datasource.credentialRef} is populated` : `${datasource.credentialRef} has no stored values`}`,
    ...connectorChecks.map((check) => `${check.check}: ${check.status} - ${check.detail}`),
  ];
  if (!hasCreds) {
    return {
      status: 'blocked' as const,
      summary: 'Target-specific readiness is incomplete because datasource credentials are still missing.',
      details,
      nextAction: `taproot --json creds set --ref ${datasource.credentialRef} --user <user> --password <password>`,
    };
  }
  const blockedConnector = connectorChecks.find((check) => check.status !== 'ok');
  if (blockedConnector) {
    return {
      status: 'blocked' as const,
      summary: 'Target-specific readiness is incomplete because connector checks are still blocked.',
      details,
      nextAction: `taproot doctor --datasource ${datasource.name} --connect`,
    };
  }
  return {
    status: 'done' as const,
    summary: 'Target-specific readiness check passed for the saved datasource.',
    details,
    nextAction: null,
  };
}

export async function runOnboarding(ctx: AppContext, opts: OnboardRunOptions): Promise<OnboardRunResult> {
  const steps: OnboardStep[] = [];
  const approvedGroups: string[] = [];
  const skippedGroups: string[] = [];
  let datasourceName: string | null = null;

  const addStep = (step: OnboardStep): void => {
    steps.push(step);
  };

  if (opts.approveLocal) {
    approvedGroups.push('local');
    const createdConfig = ensureStarterRuntime(ctx);
    addStep({
      id: 'local_state',
      title: 'Local TapRoot state',
      kind: 'local',
      status: 'done',
      summary: createdConfig ? 'Created starter TapRoot config.' : 'TapRoot config already existed.',
      details: [ctx.paths.runtimeConfigFile, ctx.paths.stateRoot],
    });
    const plugins = ctx.pluginRegistry.list().map((plugin) => plugin.manifest.name);
    addStep({
      id: 'plugin_inventory',
      title: 'Plugins available',
      kind: 'local',
      status: 'done',
      summary: `${plugins.length} plugin(s) available.`,
      details: plugins,
    });
    const kcAvailable = await keychainAvailable();
    addStep({
      id: 'kb_presence',
      title: 'KB and credential mode',
      kind: 'local',
      status: 'done',
      summary: 'Checked KB visibility and credential storage mode.',
      details: [
        `kb: ${fs.existsSync(ctx.paths.kbDir) ? 'present' : 'missing'} at ${ctx.paths.kbDir}`,
        `master key: ${process.env.TAPROOT_MASTER_KEY ? 'set' : 'fallback local secret in use'}`,
        `keychain: ${kcAvailable ? 'available' : 'unavailable'}`,
        `datasources: ${ctx.datasourceStore.list().length}`,
      ],
    });
  } else {
    skippedGroups.push('local');
    addStep({
      id: 'local_state',
      title: 'Local TapRoot state',
      kind: 'local',
      status: 'skipped',
      summary: 'Skipped local setup checks.',
    });
    addStep({
      id: 'plugin_inventory',
      title: 'Plugins available',
      kind: 'local',
      status: 'skipped',
      summary: 'Skipped plugin inventory.',
    });
    addStep({
      id: 'kb_presence',
      title: 'KB and credential mode',
      kind: 'local',
      status: 'skipped',
      summary: 'Skipped KB and credential mode inspection.',
    });
  }

  const toolPaths = {
    kubectl: commandPath('kubectl'),
    tsh: commandPath('tsh'),
    openvpn3: commandPath('openvpn3'),
    openvpn: commandPath('openvpn'),
  };

  if (opts.approveAccess) {
    approvedGroups.push('access');
    addStep({
      id: 'tool_detection',
      title: 'Access tooling',
      kind: 'access',
      status: 'done',
      summary: 'Checked local access tooling.',
      details: Object.entries(toolPaths).map(([name, value]) => `${name}: ${value || 'not found'}`),
    });
    const daemon = (await collectReadinessSnapshot(ctx)).checks.find((check) => check.check === 'daemon');
    const tsh = toolPaths.tsh ? runCommand('/bin/zsh', ['-lc', 'tsh status']) : null;
    addStep({
      id: 'access_status',
      title: 'Access status',
      kind: 'access',
      status: 'done',
      summary: 'Checked access-related local status.',
      details: [
        daemon ? `daemon: ${daemon.status} - ${daemon.detail}` : 'daemon: unavailable',
        toolPaths.tsh ? `tsh: ${tsh?.ok ? 'ok' : 'blocked'} - ${(tsh?.detail || '').split('\n')[0]}` : 'tsh: not installed',
      ],
    });
  } else {
    skippedGroups.push('access');
    addStep({
      id: 'tool_detection',
      title: 'Access tooling',
      kind: 'access',
      status: 'skipped',
      summary: 'Skipped access tooling checks.',
    });
    addStep({
      id: 'access_status',
      title: 'Access status',
      kind: 'access',
      status: 'skipped',
      summary: 'Skipped access status checks.',
    });
  }

  const target = opts.target
    ? {
        env: String(opts.target.env).trim(),
        service: normalizeService(opts.target.service, ctx.runtimeConfigStore.serviceAliases()),
        namespace: normalizeNamespace(opts.target.namespace || '') || undefined,
      }
    : undefined;
  addStep({
    id: 'target_selection',
    title: 'Target selection',
    kind: 'input',
    status: target ? 'done' : 'not_needed',
    summary: target
      ? `Target selected: ${target.env}${target.namespace ? ` / ${target.namespace}` : ''} / ${target.service}`
      : 'No target selected during onboarding.',
  });

  let validationSnapshot: Awaited<ReturnType<typeof collectReadinessSnapshot>> | null = null;
  if (opts.approveLive) {
    approvedGroups.push('live');
    const liveDetails: string[] = [];
    if (toolPaths.kubectl) {
      const context = runCommand('kubectl', ['config', 'current-context']);
      liveDetails.push(`kubectl context: ${context.ok ? context.detail.split('\n')[0] : 'unavailable'}`);
      const namespaces = runCommand('kubectl', ['get', 'ns', '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}']);
      liveDetails.push(
        namespaces.ok
          ? `namespaces: ${namespaces.detail.split('\n').filter(Boolean).slice(0, 8).join(', ')}`
          : `namespaces: ${namespaces.detail.split('\n')[0]}`,
      );
      if (target?.namespace) {
        const services = runCommand('kubectl', ['-n', target.namespace, 'get', 'svc', '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}']);
        const visibleServices = services.detail.split('\n').filter(Boolean).slice(0, 8);
        liveDetails.push(
          services.ok
            ? `services in ${target.namespace}: ${visibleServices.length ? visibleServices.join(', ') : '(none found)'}`
            : `services in ${target.namespace}: ${services.detail.split('\n')[0]}`,
        );
      }
    } else {
      liveDetails.push('kubectl: not installed');
    }
    addStep({
      id: 'live_visibility',
      title: 'Live environment visibility',
      kind: 'live',
      status: 'done',
      summary: 'Checked live environment visibility.',
      details: liveDetails,
    });

    if (target) {
      const kbExists = fs.existsSync(ctx.paths.kbDir) && fs.existsSync(`${ctx.paths.kbDir}/services.json`);
      const existing = ctx.datasourceStore.resolveByEnvService(target.env, target.service, target.namespace);
      if (existing) {
        datasourceName = existing.name;
        addStep({
          id: 'datasource_setup',
          title: 'Datasource setup',
          kind: 'setup',
          status: 'done',
          summary: `Datasource already existed: ${existing.name}`,
          details: [
            `connectors: ${(existing.connectors || []).join(', ') || '(none)'}`,
            `credential ref: ${existing.credentialRef}`,
          ],
        });
        validationSnapshot = await collectReadinessSnapshot(ctx, { target });
        const targetChecks = validationSnapshot.checks;
        const targetCreds = targetChecks.find((check) => check.check === 'target_credentials');
        addStep({
          id: 'credential_setup_status',
          title: 'Credential setup',
          kind: 'setup',
          status: targetCreds?.status === 'ok' ? 'done' : 'blocked',
          summary:
            targetCreds?.status === 'ok'
              ? `Credentials are present for ${existing.credentialRef}.`
              : `Credentials are still missing for ${existing.credentialRef}.`,
          nextAction: validationSnapshot.nextActions.find((action) => action.includes('creds set')) || null,
        });
        const connectorDetails = summarizeChecks(targetChecks, (check) => check.check.startsWith('connector:') || check.check.includes('openvpn') || check.check.includes('teleport') || check.check.includes('kubectl-portforward'));
        addStep({
          id: 'connector_setup_status',
          title: 'Connector setup',
          kind: 'setup',
          status: connectorDetails.length === 0 || connectorDetails.every((detail) => detail.includes('ok -')) ? 'done' : 'blocked',
          summary: connectorDetails.length === 0 ? 'No connector checks were needed yet.' : 'Checked connector readiness for the target datasource.',
          details: connectorDetails.length ? connectorDetails : undefined,
          nextAction: validationSnapshot.nextActions.find((action) => action.includes('connector setup') || action.includes('doctor --datasource')) || null,
        });
      } else if (kbExists) {
        const datasourceNameGuess = `${target.env}-${target.namespace ? `${target.namespace}-` : ''}${target.service}`;
        const result = await reconcileDatasource(ctx, target.env, target.service, datasourceNameGuess, target.namespace);
        if (result) {
          datasourceName = result.profile.name;
          addStep({
            id: 'datasource_setup',
            title: 'Datasource setup',
            kind: 'setup',
            status: 'done',
            summary:
              result.source === 'store-existing'
                ? `Datasource already existed: ${result.profile.name}`
                : result.source === 'kb-repaired'
                  ? `Repaired datasource: ${result.profile.name}`
                  : `Created datasource: ${result.profile.name}`,
            details: [
              `connectors: ${result.connectors.join(', ') || '(none)'}`,
              `credential refs: ${result.credentialRefs.join(', ') || '(none)'}`,
            ],
          });
          validationSnapshot = await collectReadinessSnapshot(ctx, { target });
          const targetChecks = validationSnapshot.checks;
          const targetCreds = targetChecks.find((check) => check.check === 'target_credentials');
          addStep({
            id: 'credential_setup_status',
            title: 'Credential setup',
            kind: 'setup',
            status: targetCreds?.status === 'ok' ? 'done' : 'blocked',
            summary:
              targetCreds?.status === 'ok'
                ? `Credentials are present for ${result.profile.credentialRef}.`
                : `Credentials are still missing for ${result.profile.credentialRef}.`,
            nextAction: validationSnapshot.nextActions.find((action) => action.includes('creds set')) || null,
          });
          const connectorDetails = summarizeChecks(targetChecks, (check) => check.check.startsWith('connector:') || check.check.includes('openvpn') || check.check.includes('teleport') || check.check.includes('kubectl-portforward'));
          addStep({
            id: 'connector_setup_status',
            title: 'Connector setup',
            kind: 'setup',
            status: connectorDetails.length === 0 || connectorDetails.every((detail) => detail.includes('ok -')) ? 'done' : 'blocked',
            summary: connectorDetails.length === 0 ? 'No connector checks were needed yet.' : 'Checked connector readiness for the target datasource.',
            details: connectorDetails.length ? connectorDetails : undefined,
            nextAction: validationSnapshot.nextActions.find((action) => action.includes('connector setup') || action.includes('doctor --datasource')) || null,
          });
        } else {
          addStep({
            id: 'datasource_setup',
            title: 'Datasource setup',
            kind: 'setup',
            status: 'blocked',
            summary: 'Could not create a datasource from KB for the chosen target.',
            nextAction: `taproot --json init datasource --env ${target.env}${target.namespace ? ` --namespace ${target.namespace}` : ''} --service ${target.service}`,
          });
          addStep({
            id: 'credential_setup_status',
            title: 'Credential setup',
            kind: 'setup',
            status: 'not_needed',
            summary: 'Credential setup could not be checked because datasource setup did not complete.',
          });
          addStep({
            id: 'connector_setup_status',
            title: 'Connector setup',
            kind: 'setup',
            status: 'not_needed',
            summary: 'Connector setup could not be checked because datasource setup did not complete.',
          });
        }
      } else {
        addStep({
          id: 'datasource_setup',
          title: 'Datasource setup',
          kind: 'setup',
          status: opts.manualDatasourceDeclined ? 'skipped' : 'blocked',
          summary: opts.manualDatasourceDeclined
            ? 'Skipped manual datasource setup after KB was not found.'
            : 'KB is missing, so TapRoot could not auto-create datasource wiring.',
          nextAction: opts.manualDatasourceDeclined ? 'Run taproot onboard again and choose manual datasource setup, or use taproot datasource add ...' : 'Add KB data or create a datasource manually with taproot datasource add ...',
        });
        addStep({
          id: 'credential_setup_status',
          title: 'Credential setup',
          kind: 'setup',
          status: opts.manualDatasourceDeclined ? 'skipped' : 'not_needed',
          summary: opts.manualDatasourceDeclined ? 'Skipped because datasource setup was declined.' : 'Credential setup is waiting on datasource setup.',
        });
        addStep({
          id: 'connector_setup_status',
          title: 'Connector setup',
          kind: 'setup',
          status: opts.manualDatasourceDeclined ? 'skipped' : 'not_needed',
          summary: opts.manualDatasourceDeclined ? 'Skipped because datasource setup was declined.' : 'Connector setup is waiting on datasource setup.',
        });
      }
    } else {
      addStep({
        id: 'datasource_setup',
        title: 'Datasource setup',
        kind: 'setup',
        status: 'not_needed',
        summary: 'No target was selected, so datasource setup was skipped.',
      });
      addStep({
        id: 'credential_setup_status',
        title: 'Credential setup',
        kind: 'setup',
        status: 'not_needed',
        summary: 'No target was selected, so credential setup was not checked.',
      });
      addStep({
        id: 'connector_setup_status',
        title: 'Connector setup',
        kind: 'setup',
        status: 'not_needed',
        summary: 'No target was selected, so connector setup was not checked.',
      });
    }
  } else {
    skippedGroups.push('live');
    addStep({
      id: 'live_visibility',
      title: 'Live environment visibility',
      kind: 'live',
      status: 'skipped',
      summary: 'Skipped live environment checks.',
    });
    addStep({
      id: 'datasource_setup',
      title: 'Datasource setup',
      kind: 'setup',
      status: target ? 'blocked' : 'not_needed',
      summary: target ? 'Datasource setup was not attempted because live checks were not approved.' : 'No target was selected, so datasource setup was not attempted.',
    });
    addStep({
      id: 'credential_setup_status',
      title: 'Credential setup',
      kind: 'setup',
      status: 'not_needed',
      summary: 'Credential setup was not checked.',
    });
    addStep({
      id: 'connector_setup_status',
      title: 'Connector setup',
      kind: 'setup',
      status: 'not_needed',
      summary: 'Connector setup was not checked.',
    });
  }

  if (opts.runValidation && target) {
    const targetDatasource = ctx.datasourceStore.resolveByEnvService(target.env, target.service, target.namespace);
    const kbMissing = !kbIsAvailable(ctx);
    if (!targetDatasource && kbMissing) {
      addStep({
        id: 'validation',
        title: 'Validation',
        kind: 'validation',
        status: opts.manualDatasourceDeclined ? 'skipped' : 'blocked',
        summary: opts.manualDatasourceDeclined
          ? 'Skipped final validation because no datasource was created.'
          : 'Final validation could not run because no datasource was created for the target.',
        nextAction: opts.manualDatasourceDeclined
          ? 'Run taproot onboard again and choose manual datasource setup, or use taproot datasource add ...'
          : 'Create a datasource for the target, then rerun taproot onboard or taproot self-check --agent --env <env> --service <service> ...',
      });
    } else if (targetDatasource && kbMissing) {
      const manual = await manualTargetValidation(ctx, target);
      addStep({
        id: 'validation',
        title: 'Validation',
        kind: 'validation',
        status: manual.status,
        summary: manual.summary,
        details: manual.details,
        nextAction: manual.nextAction,
      });
    } else {
      validationSnapshot = validationSnapshot || (await collectReadinessSnapshot(ctx, { target }));
      addStep({
        id: 'validation',
        title: 'Validation',
        kind: 'validation',
        status: validationSnapshot.readiness === 'ready' ? 'done' : 'blocked',
        summary:
          validationSnapshot.readiness === 'ready'
            ? 'Target-specific readiness check passed.'
            : `Target-specific readiness is still incomplete: ${validationSnapshot.readiness}.`,
        details: summarizeChecks(validationSnapshot.checks, (check) => check.check.startsWith('target_') || check.check.startsWith('connector:')),
        nextAction: validationSnapshot.nextActions[0] || null,
      });
    }
  } else {
    addStep({
      id: 'validation',
      title: 'Validation',
      kind: 'validation',
      status: opts.runValidation ? 'not_needed' : 'skipped',
      summary: opts.runValidation ? 'Validation was not needed for this onboarding path.' : 'Skipped validation.',
    });
  }

  const nextActions = [...new Set(steps.map((step) => step.nextAction).filter(Boolean) as string[])];
  return {
    steps,
    approvedGroups,
    skippedGroups,
    ...(target ? { target } : {}),
    datasource: datasourceName,
    nextActions,
  };
}

export function kbIsAvailable(ctx: Pick<AppContext, 'paths'>): boolean {
  return fs.existsSync(ctx.paths.kbDir) && fs.existsSync(`${ctx.paths.kbDir}/services.json`);
}

export async function saveManualDatasource(ctx: AppContext, input: ManualDatasourceInput): Promise<{ profileName: string; credentialRefs: string[]; connectors: string[] }> {
  const namespace = normalizeNamespace(input.namespace || '') || undefined;
  const service = normalizeService(input.service, ctx.runtimeConfigStore.serviceAliases());
  const name = defaultDatasourceName(input.env, service, namespace);

  if (input.mode === 'native') {
    const credentialRef = input.credentialRef || `${input.env}:${service}`;
    ctx.datasourceStore.save({
      name,
      kind: input.engine,
      env: input.env,
      namespace,
      service,
      tags: ['manual-onboard'],
      connection: {
        host: input.host || '127.0.0.1',
        port: input.port || (input.engine === 'postgres' ? 5432 : 3306),
        database: input.database,
      },
      credentialRef,
      connectors: [],
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      resolverHints: {},
      updatedAt: nowIso(),
      confidence: 0.7,
    });
    if (input.dbUser) {
      await ensureCredentialDefaults(ctx, credentialRef, input.engine === 'postgres' ? { user: input.dbUser } : { user: input.dbUser });
    }
    return { profileName: name, credentialRefs: [credentialRef], connectors: [] };
  }

  if (input.mode === 'qa-portforward') {
    const effectiveNamespace = namespace || 'default';
    const credentialRef = input.credentialRef || input.env;
    const localPort = input.port || (input.engine === 'postgres' ? 5432 : 4406);
    const target = String(input.target || service);
    const context = String(process.env.TAPROOT_QA_CONTEXT || input.env || effectiveNamespace);
    const logFile = `/tmp/taproot-pf-${input.env}-${service}.log`;
    const statusCommand = `lsof -iTCP:${localPort} -sTCP:LISTEN >/dev/null`;
    const connectCommand = `${statusCommand} || (svc_port=$(kubectl --context ${context} -n ${effectiveNamespace} get svc/${target} -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo ${input.engine === 'postgres' ? 5432 : 4000}); nohup kubectl --context ${context} -n ${effectiveNamespace} port-forward svc/${target} ${localPort}:$svc_port >${logFile} 2>&1 & for _ in 1 2 3 4 5; do ${statusCommand} && break; sleep 1; done; ${statusCommand})`;
    const kpfRef = `kpf:${input.env}:${effectiveNamespace}:${service}`;
    ctx.datasourceStore.save({
      name,
      kind: input.engine,
      env: input.env,
      namespace,
      service,
      tags: ['manual-onboard'],
      connection: {
        host: '127.0.0.1',
        port: localPort,
        database: input.database,
      },
      credentialRef,
      connectors: ['openvpn', 'kubectl-portforward'],
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      resolverHints: {
        openvpnCredentialRef: 'vpn:work',
        'kubectl-portforwardCredentialRef': kpfRef,
      },
      updatedAt: nowIso(),
      confidence: 0.65,
    });
    await ensureCredentialDefaults(ctx, credentialRef, input.dbUser ? { user: input.dbUser } : {});
    await ensureCredentialDefaults(ctx, 'vpn:work', {
      statusCommand: 'pgrep -f openvpn >/dev/null && echo connected || (echo disconnected >&2; exit 1)',
    });
    await ensureCredentialDefaults(ctx, kpfRef, { statusCommand, connectCommand }, true);
    return { profileName: name, credentialRefs: [credentialRef, 'vpn:work', kpfRef], connectors: ['openvpn', 'kubectl-portforward'] };
  }

  const credentialRef = input.credentialRef || input.env;
  const target = String(input.target || service);
  const tshRef = `tsh:${input.env}`;
  ctx.datasourceStore.save({
    name,
    kind: 'teleport-mysql',
    env: input.env,
    namespace,
    service,
    tags: ['manual-onboard'],
    connection: {
      database: input.database,
      target,
    },
    credentialRef,
    connectors: ['openvpn', 'teleport'],
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    resolverHints: {
      openvpnCredentialRef: 'vpn:work',
      teleportCredentialRef: tshRef,
    },
    updatedAt: nowIso(),
    confidence: 0.65,
  });
  await ensureCredentialDefaults(ctx, credentialRef, input.dbUser ? { dbUser: input.dbUser } : {});
  await ensureCredentialDefaults(ctx, 'vpn:work', {
    statusCommand: 'pgrep -f openvpn >/dev/null && echo connected || (echo disconnected >&2; exit 1)',
  });
  await ensureCredentialDefaults(ctx, tshRef, {
    statusCommand: 'tsh status',
  });
  return { profileName: name, credentialRefs: [credentialRef, 'vpn:work', tshRef], connectors: ['openvpn', 'teleport'] };
}
