import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonFile } from '../core/json.js';

const SERVICE_NAME = 'telequery';

interface FallbackFileShape {
  salt: string;
  iv: string;
  authTag: string;
  data: string;
}

function getMasterSecret(): string {
  return process.env.TELEQUERY_MASTER_KEY || `${process.env.USER || 'user'}@${process.platform}`;
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

function decryptJson(input: FallbackFileShape): Record<string, Record<string, string>> {
  const salt = Buffer.from(input.salt, 'base64');
  const iv = Buffer.from(input.iv, 'base64');
  const authTag = Buffer.from(input.authTag, 'base64');
  const data = Buffer.from(input.data, 'base64');
  const key = crypto.pbkdf2Sync(getMasterSecret(), salt, 200000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const out = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(out) as Record<string, Record<string, string>>;
}

async function tryKeychainGet(ref: string): Promise<Record<string, string> | null> {
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
      return decryptJson(raw as FallbackFileShape);
    } catch {
      return {};
    }
  }

  private saveFallback(payload: Record<string, Record<string, string>>): void {
    fs.mkdirSync(path.dirname(this.encryptedFile), { recursive: true });
    writeJsonFile(this.encryptedFile, encryptJson(payload));
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

  async remove(ref: string): Promise<void> {
    try {
      const keytar = await import('keytar');
      await keytar.deletePassword(SERVICE_NAME, ref);
    } catch {
      // ignore
    }
    const payload = this.loadFallback();
    delete payload[ref];
    this.saveFallback(payload);
  }
}
