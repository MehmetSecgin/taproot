import crypto from 'node:crypto';
import fs from 'node:fs';

const OWNER_ONLY_FILE_MODE = 0o600;

interface ParsedFile {
  mtimeMs: number;
  size: number;
  value: unknown;
}

const parsedFiles = new Map<string, ParsedFile>();

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export function readJsonFile<T>(file: string, fallback: T): T {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return fallback;
  const cached = parsedFiles.get(file);
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value as T;
  const text = readText(file);
  if (text === undefined) return fallback;
  let value: T;
  try {
    value = deepFreeze(JSON.parse(text) as T);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}). Fix or remove it; TapRoot does not overwrite it while it is unreadable.`);
  }
  parsedFiles.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function replaceFile(file: string, writeTemp: (temp: string) => void): void {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    writeTemp(temp);
    fs.renameSync(temp, file);
    parsedFiles.delete(file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  replaceFile(file, (temp) => fs.writeFileSync(temp, jsonText(value), { encoding: 'utf8', flag: 'wx' }));
}

export function writeOwnerOnlyJsonFile(file: string, value: unknown): void {
  replaceFile(file, (temp) => {
    const fd = fs.openSync(temp, 'wx', OWNER_ONLY_FILE_MODE);
    try {
      fs.fchmodSync(fd, OWNER_ONLY_FILE_MODE);
      fs.writeFileSync(fd, jsonText(value), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  });
}
