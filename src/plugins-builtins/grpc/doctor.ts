import { promisify } from 'node:util';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { classifyExecutorDoctorCode } from '../../core/executor-errors.js';
import { listServices } from '../../core/grpc-introspect.js';
import { loadGrpcPackage, lookupServiceCtor, resolveProtoRoot } from '../../core/proto-loader.js';
import type { ProtobufRoot } from '../../core/proto-loader.js';
import { DoctorStatus } from '../../types/plugin.js';
import type { DoctorCheck, TapRootPlugin } from '../../types/plugin.js';
import { emptyToUndefined, isNonEmpty } from '../../core/text-presence.js';
import { buildClient } from './client-cache.js';
import { errorText } from '../../core/error-text.js';

type DoctorInput = Parameters<NonNullable<TapRootPlugin['doctor']>>[0];

function probeServiceOf(input: DoctorInput, protobufRoot: ProtobufRoot): string | undefined {
  const configured = input.datasource.resolverHints?.probeService;
  return isNonEmpty(configured) ? configured : emptyToUndefined(listServices(protobufRoot)[0]?.name);
}

async function openChannel(input: DoctorInput, protoRoot: string): Promise<DoctorCheck[]> {
  const { datasource } = input;
  const bundle = await loadGrpcPackage(protoRoot);
  const probe = probeServiceOf(input, bundle.protobufRoot);
  if (probe === undefined) {
    return [{ check: 'grpc proto load', status: DoctorStatus.Warn, detail: `loaded proto root ${protoRoot} but no service found to probe`, code: 'executor_configuration_missing' }];
  }
  const client = buildClient(bundle.grpcModule, lookupServiceCtor(bundle.grpcPackage, probe), datasource);
  try {
    await promisify(client.waitForReady.bind(client))(Date.now() + RUNTIME_CONSTANTS.plugin.dbConnectTimeoutMs);
    return [{ check: 'grpc channel', status: DoctorStatus.Ok, detail: `connected to ${datasource.connection.host}:${datasource.connection.port} (${probe})` }];
  } finally {
    client.close();
  }
}

export async function checkGrpcChannel(input: DoctorInput): Promise<DoctorCheck[]> {
  const protoRoot = resolveProtoRoot(undefined, input.datasource.resolverHints);
  if (protoRoot === undefined) {
    return [{ check: 'grpc proto-root', status: DoctorStatus.Warn, detail: "no resolverHints.protoRoot configured; doctor can only open a channel, not exercise a real method.", code: 'executor_configuration_missing' }];
  }
  try {
    return await openChannel(input, protoRoot);
  } catch (error) {
    const message = errorText(error);
    const detail = message === '' ? 'unknown grpc doctor error' : message;
    return [{ check: 'grpc channel', status: DoctorStatus.Fail, detail, code: classifyExecutorDoctorCode(detail) }];
  }
}
