import { AccessMethod, DatasourceKind } from '../types/datasource.js';
import type { DatasourceProfile } from '../types/datasource.js';
import { RUNTIME_CONSTANTS } from './constants.js';
import { kubectlPortforwardLocalPort } from './kubectl-portforward.js';
import { readOnlyPolicy } from './read-only-policy.js';
import { textUnlessFalsy } from './text-presence.js';
import { nowIso } from './time.js';

export type KbEntry = Record<string, unknown>;

export type CredentialDefaultSpec = {
  ref: string;
  defaults: Record<string, string>;
  overwrite?: boolean;
};

export type KbDatasourceCandidate = {
  kb: KbEntry;
  profile: DatasourceProfile;
  credentialDefaults: CredentialDefaultSpec[];
};

type KbCandidateInputs = {
  env: string;
  service: string;
  datasourceName: string;
  kb: KbEntry;
  database: string;
  dbUser: string;
  target: string;
  credentialRef: string;
  tags: string[];
  namespace?: string;
};

type CandidateBuilder = (inputs: KbCandidateInputs) => KbDatasourceCandidate | undefined;

type DatasourceVariant = Pick<DatasourceProfile, 'kind' | 'connection' | 'connectors' | 'resolverHints'>;

const DEFAULT_DB_USER = 'root';
const DEFAULT_NAMESPACE = 'default';
const DEFAULT_SERVICE_PORT_FALLBACK = 4000;
const LOCAL_HOST = '127.0.0.1';

function datasourceProfile(inputs: KbCandidateInputs, variant: DatasourceVariant): DatasourceProfile {
  return {
    name: inputs.datasourceName,
    kind: variant.kind,
    env: inputs.env,
    namespace: inputs.namespace,
    service: inputs.service,
    tags: inputs.tags,
    connection: variant.connection,
    credentialRef: inputs.credentialRef,
    connectors: variant.connectors,
    policy: readOnlyPolicy(),
    resolverHints: variant.resolverHints,
    updatedAt: nowIso(),
  };
}

function portForwardCommands(inputs: KbCandidateInputs, localPort: number): { statusCommand: string; connectCommand: string } {
  const namespace = inputs.namespace ?? DEFAULT_NAMESPACE;
  const context = textUnlessFalsy(inputs.kb.k8s_context) || inputs.env || namespace;
  const logFile = `/tmp/taproot-pf-${inputs.env}-${inputs.service}.log`;
  const forwardArgs = `--context ${context} -n ${namespace} port-forward svc/${inputs.target} ${localPort}:`;
  const listenerPid = `$(lsof -tiTCP:${localPort} -sTCP:LISTEN | head -n 1)`;
  const statusCommand = `ps -o command= -p "${listenerPid}" 2>/dev/null | grep -qF -- '${forwardArgs}'`;
  const servicePort = `svc_port=$(kubectl --context ${context} -n ${namespace} get svc/${inputs.target} -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo ${DEFAULT_SERVICE_PORT_FALLBACK})`;
  const connectCommand = `${statusCommand} || (${servicePort}; nohup kubectl ${forwardArgs}$svc_port >${logFile} 2>&1 & for _ in 1 2 3 4 5; do ${statusCommand} && break; sleep 1; done; ${statusCommand})`;
  return { statusCommand, connectCommand };
}

function buildKubectlPortforwardCandidate(inputs: KbCandidateInputs): KbDatasourceCandidate {
  const localPort = kubectlPortforwardLocalPort(inputs.env, inputs.namespace, inputs.service);
  const portForwardRef = `kpf:${inputs.env}:${inputs.namespace ?? DEFAULT_NAMESPACE}:${inputs.service}`;
  return {
    kb: inputs.kb,
    profile: datasourceProfile(inputs, {
      kind: DatasourceKind.Mysql,
      connection: { host: LOCAL_HOST, port: localPort, database: inputs.database },
      connectors: ['kubectl-portforward'],
      resolverHints: { 'kubectl-portforwardCredentialRef': portForwardRef },
    }),
    credentialDefaults: [
      { ref: inputs.credentialRef, defaults: { user: inputs.dbUser || DEFAULT_DB_USER } },
      { ref: portForwardRef, defaults: portForwardCommands(inputs, localPort), overwrite: true },
    ],
  };
}

function buildNativeCandidate(inputs: KbCandidateInputs): KbDatasourceCandidate | undefined {
  const host = textUnlessFalsy(inputs.kb.host).trim();
  if (host === '') {
    return undefined;
  }
  const port = Number(textUnlessFalsy(inputs.kb.port)) || RUNTIME_CONSTANTS.defaultPorts.mysql;
  return {
    kb: inputs.kb,
    profile: datasourceProfile(inputs, {
      kind: DatasourceKind.Mysql,
      connection: { host, port, database: inputs.database },
      connectors: [],
      resolverHints: {},
    }),
    credentialDefaults: [{ ref: inputs.credentialRef, defaults: { user: inputs.dbUser || DEFAULT_DB_USER } }],
  };
}

function buildTshCandidate(inputs: KbCandidateInputs): KbDatasourceCandidate {
  const teleportRef = `tsh:${inputs.env}`;
  return {
    kb: inputs.kb,
    profile: datasourceProfile(inputs, {
      kind: DatasourceKind.TeleportMysql,
      connection: { database: inputs.database, target: inputs.target },
      connectors: ['teleport'],
      resolverHints: {
        teleportCredentialRef: teleportRef,
        ...(inputs.dbUser === '' ? {} : { dbUser: inputs.dbUser }),
      },
    }),
    credentialDefaults: [
      { ref: inputs.credentialRef, defaults: { dbUser: inputs.dbUser } },
      { ref: teleportRef, defaults: { statusCommand: 'tsh status' } },
    ],
  };
}

const CANDIDATE_BUILDERS: Record<AccessMethod, CandidateBuilder> = {
  [AccessMethod.KubectlPortforward]: buildKubectlPortforwardCandidate,
  [AccessMethod.Native]: buildNativeCandidate,
  [AccessMethod.Tsh]: buildTshCandidate,
};

export const KB_ACCESS_METHODS: readonly string[] = Object.keys(CANDIDATE_BUILDERS);

export function isKbAccessMethod(value: string): value is AccessMethod {
  return Object.hasOwn(CANDIDATE_BUILDERS, value);
}

export function buildKbDatasourceCandidate(accessMethod: AccessMethod, inputs: KbCandidateInputs): KbDatasourceCandidate | undefined {
  return CANDIDATE_BUILDERS[accessMethod](inputs);
}
