import crypto from 'node:crypto';
import fs from 'node:fs';

export function readJsonFile<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}). Fix or remove it; TapRoot does not overwrite it while it is unreadable.`);
  }
}

const OWNER_ONLY_FILE_MODE = 0o600;

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function replaceFile(file: string, writeTemp: (temp: string) => void): void {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    writeTemp(temp);
    fs.renameSync(temp, file);
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
