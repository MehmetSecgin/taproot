import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { accessDenied } from '../core/error-classification.js';
import { readJsonFile, writeOwnerOnlyJsonFile } from '../core/json.js';
import { str } from '../core/strings.js';

const SERVICE_NAME = 'taproot';

interface FallbackFileShape {
  salt: string;
  iv: string;
  authTag: string;
  data: string;
}

function derivedSecret(): string {
  return `${process.env.USER || 'user'}@${process.platform}`;
}

function getMasterSecret(): string {
  return process.env.TAPROOT_MASTER_KEY || derivedSecret();
}

function encryptJson(payload: Record<string, Record<string, string>>): FallbackFileShape {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(getMasterSecret(), salt, 200000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptJson(input: FallbackFileShape, secret: string): Record<string, Record<string, string>> {
  const salt = Buffer.from(input.salt, 'base64');
  const iv = Buffer.from(input.iv, 'base64');
  const authTag = Buffer.from(input.authTag, 'base64');
  const data = Buffer.from(input.data, 'base64');
  const key = crypto.pbkdf2Sync(secret, salt, 200000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const out = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(out) as Record<string, Record<string, string>>;
}

function keychainDisabled(): boolean {
  const raw = str(process.env.TAPROOT_NO_KEYCHAIN).trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

async function tryKeychainGet(ref: string): Promise<Record<string, string> | null> {
  if (keychainDisabled()) return null;
  try {
    const keytar = await import('keytar');
    const raw = await keytar.getPassword(SERVICE_NAME, ref);
    if (!raw) return null;
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return null;
  }
}

async function tryKeychainSet(ref: string, value: Record<string, string>): Promise<boolean> {
  if (keychainDisabled()) return false;
  try {
    const keytar = await import('keytar');
    await keytar.setPassword(SERVICE_NAME, ref, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export class CredentialStore {
  constructor(private readonly encryptedFile: string) {}

  private loadFallback(): Record<string, Record<string, string>> {
    const raw = readJsonFile<unknown>(this.encryptedFile, null);
    if (!raw || typeof raw !== 'object') return {};
    try {
      return decryptJson(raw as FallbackFileShape, getMasterSecret());
    } catch {
      if (!process.env.TAPROOT_MASTER_KEY) throw this.unreadable();
    }
    try {
      const payload = decryptJson(raw as FallbackFileShape, derivedSecret());
      this.saveFallback(payload);
      return payload;
    } catch {
      throw this.unreadable();
    }
  }

  private unreadable(): Error {
    return accessDenied(
      `credential file ${this.encryptedFile} cannot be decrypted with the current key (TAPROOT_MASTER_KEY, or the default derived key when it is unset). Set the key the file was written with; TapRoot does not overwrite it while it is unreadable.`,
    );
  }

  private saveFallback(payload: Record<string, Record<string, string>>): void {
    fs.mkdirSync(path.dirname(this.encryptedFile), { recursive: true });
    writeOwnerOnlyJsonFile(this.encryptedFile, encryptJson(payload));
  }

  async get(ref: string): Promise<Record<string, string>> {
    const keychain = await tryKeychainGet(ref);
    if (keychain) return keychain;
    return this.loadFallback()[ref] || {};
  }

  async set(ref: string, value: Record<string, string>): Promise<void> {
    const saved = await tryKeychainSet(ref, value);
    if (saved) return;
    const payload = this.loadFallback();
    payload[ref] = value;
    this.saveFallback(payload);
  }

  async list(): Promise<Array<{ ref: string; keys: string[]; source: 'keychain' | 'fallback' }>> {
    const out = new Map<string, { ref: string; keys: string[]; source: 'keychain' | 'fallback' }>();
    if (!keychainDisabled()) {
      try {
        const mod = (await import('keytar')) as unknown as Record<string, unknown>;
        type FindFn = (service: string) => Promise<Array<{ account: string; password: string }>>;
        const find = (typeof (mod as { findCredentials?: FindFn }).findCredentials === 'function'
          ? (mod as { findCredentials: FindFn }).findCredentials
          : ((mod.default as { findCredentials?: FindFn } | undefined)?.findCredentials));
        if (typeof find !== 'function') throw new Error('keytar.findCredentials missing');
        const found = await find(SERVICE_NAME);
        for (const entry of found || []) {
          let keys: string[] = [];
          try {
            const parsed = JSON.parse(entry.password) as Record<string, unknown>;
            keys = Object.keys(parsed || {});
          } catch {
            keys = [];
          }
          out.set(entry.account, { ref: entry.account, keys, source: 'keychain' });
        }
      } catch {
        // keytar unavailable; fall through to fallback file
      }
    }
    const fallback = this.loadFallback();
    for (const [ref, value] of Object.entries(fallback)) {
      if (out.has(ref)) continue;
      out.set(ref, { ref, keys: Object.keys(value || {}), source: 'fallback' });
    }
    return Array.from(out.values()).sort((a, b) => a.ref.localeCompare(b.ref));
  }

  async remove(ref: string): Promise<void> {
    if (!keychainDisabled()) {
      try {
        const keytar = await import('keytar');
        await keytar.deletePassword(SERVICE_NAME, ref);
      } catch {
        // ignore
      }
    }
    const payload = this.loadFallback();
    delete payload[ref];
    this.saveFallback(payload);
  }}
