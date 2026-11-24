import crypto from 'node:crypto';
import { z } from 'zod';
import { isNonEmpty } from '../core/text-presence.js';

const PBKDF2_ITERATIONS = 200_000;
const AES_256_KEY_BYTES = 32;
const SALT_BYTES = 16;
const GCM_IV_BYTES = 12;

const CredentialMapSchema = z.record(z.string(), z.record(z.string(), z.string()));

const EncryptedFileSchema = z.object({
  salt: z.string(),
  iv: z.string(),
  authTag: z.string(),
  data: z.string(),
});

export type CredentialMap = z.infer<typeof CredentialMapSchema>;

export type EncryptedFile = z.infer<typeof EncryptedFileSchema>;

let lastDerivedKey: { saltAndSecret: string; key: Buffer } | null = null;

export function defaultSecret(): string {
  const user = isNonEmpty(process.env.USER) ? process.env.USER : 'user';
  return `${user}@${process.platform}`;
}

export function configuredSecret(): string {
  return isNonEmpty(process.env.TAPROOT_MASTER_KEY) ? process.env.TAPROOT_MASTER_KEY : defaultSecret();
}

export function hasConfiguredMasterKey(): boolean {
  return isNonEmpty(process.env.TAPROOT_MASTER_KEY);
}

function deriveKey(secret: string, salt: Buffer): Buffer {
  const saltAndSecret = `${salt.toString('base64')}:${secret}`;
  if (lastDerivedKey?.saltAndSecret === saltAndSecret) {
    return lastDerivedKey.key;
  }
  const key = crypto.pbkdf2Sync(secret, salt, PBKDF2_ITERATIONS, AES_256_KEY_BYTES, 'sha256');
  lastDerivedKey = { saltAndSecret, key };
  return key;
}

export function encryptCredentials(credentials: CredentialMap): EncryptedFile {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const key = deriveKey(configuredSecret(), salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decryptCredentials(encryptedFile: unknown, secret: string): CredentialMap {
  const file = EncryptedFileSchema.parse(encryptedFile);
  const salt = Buffer.from(file.salt, 'base64');
  const key = deriveKey(secret, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(file.authTag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8');
  return CredentialMapSchema.parse(JSON.parse(plaintext));
}
