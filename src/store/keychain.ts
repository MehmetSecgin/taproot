import { z } from 'zod';
import { textUnlessFalsy } from '../core/text-presence.js';
import { isRecord } from '../core/json-shapes.js';

const KEYCHAIN_SERVICE_NAME = 'taproot';
const KEYCHAIN_DISABLING_VALUES = new Set(['1', 'true', 'yes']);

const KeychainSecretSchema = z.record(z.string(), z.string());

export type CredentialSummary = {
  ref: string;
  keys: string[];
  source: 'keychain' | 'fallback';
};

type FindCredentials = (service: string) => Promise<{ account: string; password: string }[]>;

function isFindCredentials(value: unknown): value is FindCredentials {
  return typeof value === 'function';
}

function findCredentialsOf(keytarModule: Record<string, unknown>): FindCredentials | undefined {
  const defaultExport = keytarModule.default;
  const candidates = [keytarModule.findCredentials, isRecord(defaultExport) ? defaultExport.findCredentials : undefined];
  return candidates.find((candidate) => isFindCredentials(candidate));
}

function secretKeys(password: string): string[] {
  try {
    const parsed: unknown = JSON.parse(password);
    return isRecord(parsed) ? Object.keys(parsed) : [];
  } catch {
    return [];
  }
}

export function isKeychainDisabledByEnv(): boolean {
  return KEYCHAIN_DISABLING_VALUES.has(textUnlessFalsy(process.env.TAPROOT_NO_KEYCHAIN).trim().toLowerCase());
}

export async function readKeychainSecret(ref: string): Promise<Record<string, string> | null> {
  try {
    const keytar = await import('keytar');
    const raw = await keytar.getPassword(KEYCHAIN_SERVICE_NAME, ref);
    return raw === null || raw === '' ? null : KeychainSecretSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function writeKeychainSecret(ref: string, value: Record<string, string>): Promise<boolean> {
  try {
    const keytar = await import('keytar');
    await keytar.setPassword(KEYCHAIN_SERVICE_NAME, ref, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export async function deleteKeychainSecret(ref: string): Promise<boolean> {
  try {
    const keytar = await import('keytar');
    return await keytar.deletePassword(KEYCHAIN_SERVICE_NAME, ref);
  } catch {
    return false;
  }
}

export async function listKeychainSummaries(): Promise<CredentialSummary[]> {
  try {
    const find = findCredentialsOf(await import('keytar'));
    if (find === undefined) {
      return [];
    }
    const entries = await find(KEYCHAIN_SERVICE_NAME);
    return entries.map((entry) => ({ ref: entry.account, keys: secretKeys(entry.password), source: 'keychain' }));
  } catch {
    return [];
  }
}
