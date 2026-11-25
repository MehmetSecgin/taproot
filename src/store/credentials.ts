import fs from 'node:fs';
import path from 'node:path';
import { accessDenied } from '../core/taproot-error.js';
import { readJsonFile, writeOwnerOnlyJsonFile } from '../core/json.js';
import { configuredSecret, decryptCredentials, defaultSecret, encryptCredentials, hasConfiguredMasterKey } from './credential-crypto.js';
import type { CredentialMap } from './credential-crypto.js';
import { deleteKeychainSecret, isKeychainDisabledByEnv, listKeychainSummaries, readKeychainSecret, writeKeychainSecret } from './keychain.js';
import type { CredentialSummary } from './keychain.js';
import { isRecord } from '../core/json-shapes.js';

export class CredentialStore {
  private readonly encryptedFile: string;
  private readonly useKeychain: boolean;

  public constructor(encryptedFile: string, useKeychain: boolean) {
    this.encryptedFile = encryptedFile;
    this.useKeychain = useKeychain;
  }

  public async get(ref: string): Promise<Record<string, string>> {
    const keychainSecret = this.isKeychainEnabled() ? await readKeychainSecret(ref) : null;
    if (keychainSecret !== null) {
      return keychainSecret;
    }
    return this.readEncryptedFile()[ref] ?? {};
  }

  public async set(ref: string, value: Record<string, string>): Promise<void> {
    const savedInKeychain = this.isKeychainEnabled() && (await writeKeychainSecret(ref, value));
    if (savedInKeychain) {
      return;
    }
    this.writeEncryptedFile({ ...this.readEncryptedFile(), [ref]: value });
  }

  public async list(): Promise<CredentialSummary[]> {
    const summariesByRef = new Map<string, CredentialSummary>();
    if (this.isKeychainEnabled()) {
      for (const summary of await listKeychainSummaries()) {
        summariesByRef.set(summary.ref, summary);
      }
    }
    for (const [ref, secret] of Object.entries(this.readEncryptedFile())) {
      if (!summariesByRef.has(ref)) {
        summariesByRef.set(ref, { ref, keys: Object.keys(secret), source: 'fallback' });
      }
    }
    return [...summariesByRef.values()].toSorted((first, second) => first.ref.localeCompare(second.ref));
  }

  public async remove(ref: string): Promise<void> {
    if (this.isKeychainEnabled()) {
      await deleteKeychainSecret(ref);
    }
    const remaining = Object.entries(this.readEncryptedFile()).filter(([storedRef]) => storedRef !== ref);
    this.writeEncryptedFile(Object.fromEntries(remaining));
  }

  private isKeychainEnabled(): boolean {
    return this.useKeychain && !isKeychainDisabledByEnv();
  }

  private readEncryptedFile(): CredentialMap {
    const raw = readJsonFile<unknown>(this.encryptedFile, null);
    if (!isRecord(raw)) {
      return {};
    }
    try {
      return decryptCredentials(raw, configuredSecret());
    } catch {
      if (!hasConfiguredMasterKey()) {
        throw this.unreadableError();
      }
    }
    return this.migrateFromDefaultSecret(raw);
  }

  private migrateFromDefaultSecret(raw: Record<string, unknown>): CredentialMap {
    try {
      const credentials = decryptCredentials(raw, defaultSecret());
      this.writeEncryptedFile(credentials);
      return credentials;
    } catch {
      throw this.unreadableError();
    }
  }

  private unreadableError(): Error {
    return accessDenied(
      `credential file ${this.encryptedFile} cannot be decrypted with the current key (TAPROOT_MASTER_KEY, or the default derived key when it is unset). Set the key the file was written with; TapRoot does not overwrite it while it is unreadable.`,
    );
  }

  private writeEncryptedFile(credentials: CredentialMap): void {
    fs.mkdirSync(path.dirname(this.encryptedFile), { recursive: true });
    writeOwnerOnlyJsonFile(this.encryptedFile, encryptCredentials(credentials));
  }
}
