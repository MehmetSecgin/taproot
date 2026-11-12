import fs from 'node:fs';

export function readJsonFile<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

const OWNER_ONLY_FILE_MODE = 0o600;

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeJsonFile(file: string, value: unknown): void {
  fs.writeFileSync(file, jsonText(value), 'utf8');
}

export function writeOwnerOnlyJsonFile(file: string, value: unknown): void {
  const fd = fs.openSync(file, 'w', OWNER_ONLY_FILE_MODE);
  try {
    fs.fchmodSync(fd, OWNER_ONLY_FILE_MODE);
    fs.writeFileSync(fd, jsonText(value), 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}
