import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatasourceKind, type DatasourceProfile } from '../types/core.js';
import { str } from './strings.js';

export interface IdeaDriverSpec {
  driverRef: string;
  jdbcDriver: string;
  jdbcUrl: string;
  dbms: string;
}

export type IdeaAuthMode = 'idea-managed' | 'url-inline';

export interface IdeaSyncEntry {
  uuid: string;
  ideaName: string;
  managedName: string;
  spec: IdeaDriverSpec;
  username?: string;
  preEntryComment?: string;
  authMode: IdeaAuthMode;
}

export interface IdeaSyncSkip {
  name: string;
  reason: string;
}

export interface IdeaSyncResult {
  target: string;
  written: IdeaSyncEntry[];
  preserved: number;
  skipped: IdeaSyncSkip[];
}

const MANAGED_MARKER = 'taproot-managed';
const TAPROOT_UUID_NAMESPACE = '7f8c8a1b-2d96-4b3a-9f3b-43ad0c4b3e22';

export function stableUuidForDatasource(name: string): string {
  return uuidv5(`taproot:${name}`, TAPROOT_UUID_NAMESPACE);
}

function mysqlFamilyDriverRef(profile: DatasourceProfile): string {
  return profile.resolverHints?.ideaDriverFamily === 'mysql' ? 'mysql.8' : 'tidb';
}

interface InlineAuth {
  username: string;
  password: string;
}

function configuredInlineAuth(env?: string): InlineAuth | undefined {
  if (!env) return undefined;
  const targetEnv = process.env.TAPROOT_IDEA_INLINE_ENV?.trim();
  const user = process.env.TAPROOT_IDEA_INLINE_USER?.trim();
  if (!targetEnv || targetEnv !== env || !user) return undefined;
  return { username: user, password: process.env.TAPROOT_IDEA_INLINE_PASSWORD ?? '' };
}

function inlineAuthFor(profile: DatasourceProfile): InlineAuth | undefined {
  const configured = configuredInlineAuth(profile.env);
  if (configured) return configured;
  if (String(profile.kind).toLowerCase() === DatasourceKind.TeleportMysql) {
    const user = defaultDbUser(profile);
    if (user) return { username: user, password: '' };
  }
  return undefined;
}

function authMode(profile: DatasourceProfile): IdeaAuthMode {
  // qa pre-shared creds go straight into the JDBC URL (auth-required=false): IDEA does
  // not prompt. teleport-mysql tunnels authenticate at the tsh layer; the mysql server
  // accepts the cert-mapped user, but IDEA's mysql driver still needs to send a proper
  // handshake. Use idea-managed auth so user-name is set and IDEA prompts once for the
  // (empty) password, then caches it in the keychain.
  if (configuredInlineAuth(profile.env)) return 'url-inline';
  return 'idea-managed';
}

function withInlineAuth(jdbcUrl: string, auth: InlineAuth | undefined): string {
  if (!auth) return jdbcUrl;
  const sep = jdbcUrl.includes('?') ? '&' : '?';
  const userPart = `user=${encodeURIComponent(auth.username)}`;
  const passPart = auth.password ? `&password=${encodeURIComponent(auth.password)}` : '';
  return `${jdbcUrl}${sep}${userPart}${passPart}`;
}

export function describeDriver(profile: DatasourceProfile): IdeaDriverSpec | { skip: string } {
  const host = profile.connection?.host?.trim();
  const port = profile.connection?.port;
  const database = profile.connection?.database?.trim() || '';
  const kind = str(profile.kind).toLowerCase();

  if (kind === DatasourceKind.Mysql || kind === 'tidb') {
    if (!host || !port) return { skip: 'missing host or port' };
    const base = `jdbc:mysql://${host}:${port}/${database}?allowPublicKeyRetrieval=true&useSSL=false`;
    const auth = inlineAuthFor(profile);
    const jdbcUrl = authMode(profile) === 'url-inline' ? withInlineAuth(base, auth) : base;
    return {
      driverRef: mysqlFamilyDriverRef(profile),
      jdbcDriver: 'com.mysql.cj.jdbc.Driver',
      dbms: 'MYSQL',
      jdbcUrl,
    };
  }
  if (kind === DatasourceKind.Postgres || kind === 'postgresql') {
    if (!host || !port) return { skip: 'missing host or port' };
    return {
      driverRef: 'postgresql',
      jdbcDriver: 'org.postgresql.Driver',
      dbms: 'POSTGRES',
      jdbcUrl: `jdbc:postgresql://${host}:${port}/${database}`,
    };
  }
  if (kind === DatasourceKind.TeleportMysql) {
    const target = profile.connection?.target?.trim();
    if (!target) return { skip: 'teleport-mysql missing connection.target' };
    const localPort = deterministicLocalPort(profile.name);
    const base = `jdbc:mysql://127.0.0.1:${localPort}/${database}?allowPublicKeyRetrieval=true&useSSL=false`;
    const auth = inlineAuthFor(profile);
    const jdbcUrl = authMode(profile) === 'url-inline' ? withInlineAuth(base, auth) : base;
    return {
      driverRef: mysqlFamilyDriverRef(profile),
      jdbcDriver: 'com.mysql.cj.jdbc.Driver',
      dbms: 'MYSQL',
      jdbcUrl,
    };
  }
  return { skip: `unsupported kind '${profile.kind}'` };
}

export function deterministicLocalPort(key: string): number {
  // Stable per-datasource local tunnel port in 30000-39999.
  const hash = crypto.createHash('sha1').update(`taproot-tunnel:${key}`).digest();
  return 30000 + (hash.readUInt32BE(0) % 10000);
}

export function defaultDbUser(profile: DatasourceProfile): string | undefined {
  const explicit = profile.resolverHints?.dbUser?.trim();
  if (explicit) return explicit;
  const service = (profile.service || '').trim();
  if (!service) return undefined;
  return `${service.replace(/-/g, '_')}_reader`;
}

export function tshTunnelCommand(profile: DatasourceProfile): string | undefined {
  if (String(profile.kind).toLowerCase() !== 'teleport-mysql') return undefined;
  const target = profile.connection?.target?.trim();
  if (!target) return undefined;
  const port = deterministicLocalPort(profile.name);
  const dbUser = defaultDbUser(profile);
  const dbUserFlag = dbUser ? ` --db-user=${dbUser}` : '';
  return `tsh proxy db --tunnel --port=${port}${dbUserFlag} ${target}`;
}

export function renderEntry(entry: IdeaSyncEntry): string {
  const xmlName = escapeXml(entry.ideaName);
  const xmlUrl = escapeXml(entry.spec.jdbcUrl);
  const xmlUser = escapeXml(entry.username || '');
  const commentLines = entry.preEntryComment
    ? [`      <comment>${escapeXml(entry.preEntryComment)}</comment>`]
    : [];
  const authLines = entry.authMode === 'url-inline'
    ? [
        `      <auth-provider>no-auth</auth-provider>`,
        `      <auth-required>false</auth-required>`,
      ]
    : [
        // 'user-pass' is the IDEA DatabaseCredentialsAuthProvider id (verified via
        // database-plugin jar). IDEA prompts for the password on first connect
        // and stores it in the keychain referenced by <secret-storage>.
        `      <auth-provider>user-pass</auth-provider>`,
        `      <secret-storage>master_key</secret-storage>`,
        `      <auth-required>true</auth-required>`,
      ];
  return [
    `    <!-- ${MANAGED_MARKER}: ${escapeXml(entry.managedName)} -->`,
    `    <data-source source="LOCAL" name="${xmlName}" uuid="${entry.uuid}">`,
    ...commentLines,
    `      <driver-ref>${entry.spec.driverRef}</driver-ref>`,
    `      <synchronize>true</synchronize>`,
    `      <jdbc-driver>${entry.spec.jdbcDriver}</jdbc-driver>`,
    `      <jdbc-url>${xmlUrl}</jdbc-url>`,
    `      <jdbc-additional-properties>`,
    `        <property name="com.intellij.clouds.kubernetes.db.enabled" value="false" />`,
    `      </jdbc-additional-properties>`,
    ...authLines,
    `      <user-name>${xmlUser}</user-name>`,
    `      <schema-mapping>`,
    `        <introspection-scope>`,
    `          <node kind="schema" qname="@" />`,
    `        </introspection-scope>`,
    `      </schema-mapping>`,
    `      <working-dir>$ProjectFileDir$</working-dir>`,
    `    </data-source>`,
  ].join('\n');
}

export function splitForeignEntries(xml: string, managedUuids: Set<string> = new Set()): string[] {
  // Match a <data-source ...>...</data-source> block, optionally preceded by an XML
  // comment line. An entry is foreign unless (a) the marker comment is present, or
  // (b) its uuid matches one of the managed UUIDs derived from current taproot profiles.
  const re = /(?:[ \t]*<!--[\s\S]*?-->\s*)?<data-source\b[\s\S]*?<\/data-source>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[0];
    if (block.includes(MANAGED_MARKER)) continue;
    const uuidMatch = block.match(/<data-source\b[^>]*\buuid="([^"]+)"/);
    if (uuidMatch && managedUuids.has(uuidMatch[1])) continue;
    out.push(block.trim());
  }
  return out;
}

export function mergeIntoHistory(existingXml: string | null, entries: IdeaSyncEntry[]): string {
  const managedUuids = new Set(entries.map((e) => e.uuid));
  const foreign = existingXml ? splitForeignEntries(existingXml, managedUuids) : [];
  const indentedForeign = foreign.map((block) => block.split('\n').map((line) => (line ? `    ${line}` : line)).join('\n'));
  const rendered = entries.map(renderEntry);
  const body = [...indentedForeign, ...rendered].join('\n');
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<project version="4">`,
    `  <component name="DataSourceManagerImpl" format="xml" multifile-model="false">`,
    body,
    `  </component>`,
    `</project>`,
    ``,
  ].join('\n');
}

export interface SyncOptions {
  target: string;
  profiles: DatasourceProfile[];
  fs?: Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'existsSync' | 'mkdirSync'>;
  credentialLookup?: (ref: string) => { username?: string };
}

export function syncToHistoryFile(opts: SyncOptions): IdeaSyncResult {
  const fsi = opts.fs || fs;
  const written: IdeaSyncEntry[] = [];
  const skipped: IdeaSyncSkip[] = [];

  for (const profile of opts.profiles) {
    const driver = describeDriver(profile);
    if ('skip' in driver) {
      skipped.push({ name: profile.name, reason: driver.skip });
      continue;
    }
    const creds = opts.credentialLookup ? opts.credentialLookup(profile.credentialRef) : {};
    const inline = inlineAuthFor(profile);
    const tshCmd = tshTunnelCommand(profile);
    written.push({
      uuid: stableUuidForDatasource(profile.name),
      ideaName: ideaDisplayName(profile),
      managedName: profile.name,
      spec: driver,
      username: inline?.username || creds?.username,
      preEntryComment: tshCmd ? `tunnel: ${tshCmd}` : undefined,
      authMode: authMode(profile),
    });
  }

  written.sort((a, b) => a.ideaName.localeCompare(b.ideaName));

  const existing = fsi.existsSync(opts.target) ? fsi.readFileSync(opts.target, 'utf8') : null;
  const managedUuids = new Set(written.map((w) => w.uuid));
  const preserved = existing ? splitForeignEntries(existing, managedUuids).length : 0;
  const merged = mergeIntoHistory(existing, written);

  fsi.mkdirSync(path.dirname(opts.target), { recursive: true });
  fsi.writeFileSync(opts.target, merged);

  pruneMultifileLeftovers(path.dirname(opts.target), managedUuids);

  const localTarget = path.join(path.dirname(opts.target), 'dataSources.local.xml');
  fsi.writeFileSync(localTarget, renderLocalXml(written));

  return { target: opts.target, written, preserved, skipped };
}

function renderLocalXml(entries: IdeaSyncEntry[]): string {
  const blocks = entries.map((entry) => {
    const providerLine = entry.authMode === 'url-inline'
      ? `      <auth-provider>no-auth</auth-provider>`
      : `      <auth-provider>user-pass</auth-provider>`;
    return [
      `    <data-source name="${escapeXml(entry.ideaName)}" uuid="${entry.uuid}">`,
      `      <database-info product="" version="" jdbc-version="" driver-name="" driver-version="" dbms="${entry.spec.dbms}" />`,
      providerLine,
      `      <user-name>${escapeXml(entry.username || '')}</user-name>`,
      `      <schema-mapping>`,
      `        <introspection-scope>`,
      `          <node kind="schema" qname="@" />`,
      `        </introspection-scope>`,
      `      </schema-mapping>`,
      `    </data-source>`,
    ].join('\n');
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<project version="4">`,
    `  <component name="dataSourceStorageLocal" created-in="taproot-idea-sync">`,
    blocks.join('\n'),
    `  </component>`,
    `</project>`,
    ``,
  ].join('\n');
}

function pruneMultifileLeftovers(ideaDir: string, managedUuids: Set<string>): void {
  // When DataSourceManagerImpl was previously in multifile mode, IDEA stored each
  // datasource in `<ideaDir>/dataSources/<uuid>.xml`. We are now writing the single-file
  // form; the per-uuid files would otherwise shadow our consolidated entries.
  const subdir = path.join(ideaDir, 'dataSources');
  if (!fs.existsSync(subdir)) return;
  for (const entry of fs.readdirSync(subdir)) {
    if (!entry.endsWith('.xml')) continue;
    const uuid = entry.replace(/\.xml$/, '');
    if (managedUuids.has(uuid)) {
      try { fs.unlinkSync(path.join(subdir, entry)); } catch { /* ignore */ }
    }
  }
}

export function ideaDisplayName(profile: DatasourceProfile): string {
  const service = profile.service || profile.name;
  const env = profile.env || '';
  const ns = profile.namespace || '';
  const parts = [ns, env, service].filter(Boolean);
  return parts.join('.');
}

export interface IdeaConfigRoots {
  configRoots: string[];
  selected?: string;
  candidates: Array<{ root: string; latestMTime: number }>;
}

export function discoverIdeaConfigRoots(): IdeaConfigRoots {
  const home = os.homedir();
  const platforms: string[] = [];
  if (process.platform === 'darwin') {
    platforms.push(path.join(home, 'Library', 'Application Support', 'JetBrains'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) platforms.push(path.join(appData, 'JetBrains'));
  } else {
    platforms.push(path.join(home, '.config', 'JetBrains'));
  }

  const candidates: Array<{ root: string; latestMTime: number }> = [];
  for (const base of platforms) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base)) {
      if (!/^IntelliJIdea/i.test(entry)) continue;
      const root = path.join(base, entry);
      let latest = 0;
      try {
        latest = fs.statSync(root).mtimeMs;
      } catch {
        continue;
      }
      candidates.push({ root, latestMTime: latest });
    }
  }
  candidates.sort((a, b) => b.latestMTime - a.latestMTime);
  return {
    configRoots: candidates.map((c) => c.root),
    selected: candidates[0]?.root,
    candidates,
  };
}

export function resolveProjectTarget(projectDir: string): string {
  return path.join(projectDir, '.idea', 'dataSources.xml');
}

export function findProjectDirUp(start: string): string | undefined {
  let cur = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(cur, '.idea'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

export interface StatusDiff {
  target: string;
  matched: string[];
  taprootOnly: string[];
  ideaOnly: string[];
}

export function diffStatus(targetXml: string | null, profiles: DatasourceProfile[]): Omit<StatusDiff, 'target'> {
  const ideaManaged = new Set<string>();
  const taprootUuidToName = new Map<string, string>(profiles.map((p) => [stableUuidForDatasource(p.name), p.name]));
  if (targetXml) {
    const markerRe = new RegExp(`<!--\\s*${MANAGED_MARKER}:\\s*([^\\s]+)\\s*-->`, 'g');
    let m: RegExpExecArray | null;
    while ((m = markerRe.exec(targetXml)) !== null) ideaManaged.add(m[1]);
    const uuidRe = /<data-source\b[^>]*\buuid="([^"]+)"/g;
    while ((m = uuidRe.exec(targetXml)) !== null) {
      const name = taprootUuidToName.get(m[1]);
      if (name) ideaManaged.add(name);
    }
  }
  const tap = new Set(profiles.map((p) => p.name));
  const matched: string[] = [];
  const taprootOnly: string[] = [];
  const ideaOnly: string[] = [];
  for (const name of tap) {
    if (ideaManaged.has(name)) matched.push(name);
    else taprootOnly.push(name);
  }
  for (const name of ideaManaged) {
    if (!tap.has(name)) ideaOnly.push(name);
  }
  return {
    matched: matched.sort(),
    taprootOnly: taprootOnly.sort(),
    ideaOnly: ideaOnly.sort(),
  };
}

function escapeXml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function uuidv5(name: string, namespace: string): string {
  const nsBytes = uuidToBytes(namespace);
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = crypto.createHash('sha1').update(Buffer.concat([nsBytes, nameBytes])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}
