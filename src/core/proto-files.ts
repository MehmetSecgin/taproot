import fs from 'node:fs';
import path from 'node:path';

const PROTO_IMPORT_PATTERN = /^\s*import\s+(?:public\s+|weak\s+)?"(?<target>[^"]+)"\s*;/gmu;
const BUNDLED_IMPORT_PREFIX = 'google/protobuf/';
const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', 'google']);
const MAX_LISTED_UNRESOLVED_IMPORTS = 20;

type UnresolvedImport = {
  importPath: string;
  importedBy: string;
};

export type ImportLookup = {
  importer: string;
  roots: string[];
  files: string[];
};

function readEntriesIfReadable(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isSkippedDirectory(name: string): boolean {
  return SKIPPED_DIRECTORY_NAMES.has(name) || name.startsWith('.');
}

function listProtoFiles(directory: string): string[] {
  return readEntriesIfReadable(directory).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return isSkippedDirectory(entry.name) ? [] : listProtoFiles(absolutePath);
    }
    return entry.isFile() && entry.name.endsWith('.proto') ? [absolutePath] : [];
  });
}

export function listAllProtoFiles(roots: string[]): string[] {
  const fileByImportPath = new Map<string, string>();
  for (const root of roots) {
    for (const file of listProtoFiles(root)) {
      const importPath = path.relative(root, file);
      if (!fileByImportPath.has(importPath)) {
        fileByImportPath.set(importPath, file);
      }
    }
  }
  const files = [...new Set(fileByImportPath.values())];
  if (files.length === 0) {
    throw new Error(`no .proto files found under '${roots.join(', ')}'`);
  }
  return files;
}

export function protoFilesStamp(files: string[]): string {
  return files
    .map((file) => {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      return `${file}:${stat?.mtimeMs}:${stat?.size}`;
    })
    .join('|');
}

export function findImport(target: string, { importer, roots, files }: ImportLookup): string | undefined {
  const direct = [path.dirname(importer), ...roots]
    .map((directory) => path.resolve(directory, target))
    .find((candidate) => fs.existsSync(candidate));
  if (direct !== undefined) {
    return direct;
  }
  const sameImportPath = files.filter((file) => file.endsWith(`${path.sep}${path.normalize(target)}`));
  return sameImportPath.length === 1 ? sameImportPath[0] : undefined;
}

function readFileIfReadable(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function importTargetsOf(file: string): string[] {
  return [...readFileIfReadable(file).matchAll(PROTO_IMPORT_PATTERN)].map(([, target]) => target);
}

function findUnresolvedImports(files: string[], roots: string[]): UnresolvedImport[] {
  const unresolvedByTargetAndFile = new Map<string, UnresolvedImport>();
  for (const file of files) {
    for (const target of importTargetsOf(file)) {
      const isBundled = target.startsWith(BUNDLED_IMPORT_PREFIX);
      if (!isBundled && findImport(target, { importer: file, roots, files }) === undefined) {
        unresolvedByTargetAndFile.set(`${target}|${file}`, { importPath: target, importedBy: file });
      }
    }
  }
  return [...unresolvedByTargetAndFile.values()];
}

function unresolvedImportsError(unresolved: UnresolvedImport[], roots: string[]): Error {
  const listedLines = unresolved
    .slice(0, MAX_LISTED_UNRESOLVED_IMPORTS)
    .map((missingImport) => `  - "${missingImport.importPath}"  (imported by ${missingImport.importedBy})`);
  const hiddenCount = unresolved.length - MAX_LISTED_UNRESOLVED_IMPORTS;
  const hiddenNote = hiddenCount > 0 ? `\n  … and ${hiddenCount} more` : '';
  const missingFiles = [...new Set(unresolved.map((missingImport) => path.basename(missingImport.importPath)))].join(', ');
  return new Error(
    `unresolved proto import(s) under proto root(s) [${roots.join(', ')}]:\n${listedLines.join('\n')}${hiddenNote}\n` +
      `Missing file(s): ${missingFiles}. These imports live in other proto modules/repos. ` +
      `Clone the repo(s) that provide them and either point --proto-root at the parent directory of your checkouts ` +
      `or add each module dir to --proto-root (comma-separated). google/protobuf/* are bundled and need no checkout.`,
  );
}

export function assertImportsResolve(files: string[], roots: string[]): void {
  const unresolved = findUnresolvedImports(files, roots);
  if (unresolved.length > 0) {
    throw unresolvedImportsError(unresolved, roots);
  }
}
