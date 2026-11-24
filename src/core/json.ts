import crypto from 'node:crypto';
import fs from 'node:fs';
import { deepFreeze } from './deep-freeze.js';
import { errorText } from './error-text.js';

const OWNER_ONLY_FILE_MODE = 0o600;

type ParsedFile = {
  mtimeMs: number;
  size: number;
  value: unknown;
};

const parsedFiles = new Map<string, ParsedFile>();

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function readTextIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function parseFrozenJson(file: string, text: string): unknown {
  try {
    return deepFreeze<unknown>(JSON.parse(text));
  } catch (error) {
    const reason = errorText(error);
    throw new Error(`${file} is not valid JSON (${reason}). Fix or remove it; TapRoot does not overwrite it while it is unreadable.`, { cause: error });
  }
}

function parseAndCache(file: string, text: string, stat: fs.Stats): unknown {
  const value = parseFrozenJson(file, text);
  parsedFiles.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

export function readJsonFile<Shape>(file: string, fallback: Shape): Shape {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat === undefined) {
    return fallback;
  }
  const cached = parsedFiles.get(file);
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.value as Shape;
  }
  const text = readTextIfExists(file);
  return text === undefined ? fallback : parseAndCache(file, text, stat) as Shape;
}

function prettyJsonWithNewline(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFileAtomically(file: string, writeTemp: (temp: string) => void): void {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    writeTemp(temp);
    fs.renameSync(temp, file);
    parsedFiles.delete(file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  writeFileAtomically(file, (temp) => {
    fs.writeFileSync(temp, prettyJsonWithNewline(value), { encoding: 'utf8', flag: 'wx' });
  });
}

export function writeOwnerOnlyJsonFile(file: string, value: unknown): void {
  writeFileAtomically(file, (temp) => {
    const fd = fs.openSync(temp, 'wx', OWNER_ONLY_FILE_MODE);
    try {
      fs.fchmodSync(fd, OWNER_ONLY_FILE_MODE);
      fs.writeFileSync(fd, prettyJsonWithNewline(value), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  });
}
