import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJson } from './parse-json.js';

export type InitCheck = {
  check: string;
  status: string;
  detail?: string;
};

export type InitSummary = {
  checks: InitCheck[];
  readiness: string;
  savedKbDir: string;
};

export type InitDatasourceResult = {
  source: string;
  profile: {
    kind: string;
    credentialRef: string;
    connection: { port: number; target: string };
  };
};

export type SavedDatasource = {
  name: string;
  kind: string;
  namespace: string;
};

type CliFailure = {
  code: string;
  message: string;
};

const TEST_MASTER_KEY = 'test-key';

export function cliEnv(stateRoot: string, kbDir: string): Record<string, string> {
  return { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: TEST_MASTER_KEY, TAPROOT_KB_DIR: kbDir };
}

export function createEmptyKbDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-init-kb-'));
}

export function writeServicesJson(kbDir: string, services: Record<string, unknown>[]): string {
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'services.json'), JSON.stringify(services));
  return kbDir;
}

export function createOrdersKbDir(): string {
  return writeServicesJson(createEmptyKbDir(), [
    {
      service: 'orders',
      connections: [
        {
          env: 'qa',
          engine: 'mysql',
          database: 'orders',
          db_user: 'reader',
          access_method: 'kubectl-portforward',
          namespace: 'develop',
          target: 'orders-db',
          status: 'active',
          verified_at_utc: '2026-03-01T00:00:00Z',
        },
      ],
    },
  ]);
}

export function readJsonFileAsUnknown(file: string): unknown {
  return parseJson(fs.readFileSync(file, 'utf8'));
}

export function parseInitOutput(stdout: string): { data: InitSummary };
export function parseInitOutput(stdout: string): unknown {
  return parseJson(stdout);
}

export function parseInitDatasourceOutput(stdout: string): { data: InitDatasourceResult };
export function parseInitDatasourceOutput(stdout: string): unknown {
  return parseJson(stdout);
}

export function parseFailureOutput(stdout: string): { error: CliFailure };
export function parseFailureOutput(stdout: string): unknown {
  return parseJson(stdout);
}

export function parseServiceListOutput(stdout: string): { data: string[] };
export function parseServiceListOutput(stdout: string): unknown {
  return parseJson(stdout);
}

export function parseCredsShowOutput(stdout: string): { data: { values: { dbUser: string } } };
export function parseCredsShowOutput(stdout: string): unknown {
  return parseJson(stdout);
}

export function readSavedDatasources(configDir: string): SavedDatasource[];
export function readSavedDatasources(configDir: string): unknown {
  return readJsonFileAsUnknown(path.join(configDir, 'datasources.json'));
}

export function readSavedKbDir(stateRoot: string): string;
export function readSavedKbDir(stateRoot: string): unknown {
  const config = readJsonFileAsUnknown(path.join(stateRoot, 'config', 'deterministic-config.json'));
  return typeof config === 'object' && config !== null && 'kbDir' in config ? config.kbDir : undefined;
}

export function findCheck(summary: InitSummary, checkName: string): InitCheck | undefined {
  return summary.checks.find((check) => check.check === checkName);
}
