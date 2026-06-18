import { spawn } from 'node:child_process';
import { AccessMethod, DoctorStatus } from '../../types/core.js';
import type { DoctorCheck, QueryRequest, QueryResult, TapRootPlugin } from '../../types/core.js';
import type { RedisPluginParams } from '../../types/plugin-params.js';
import { classifyExecutorDoctorCode } from '../../core/error-classification.js';
import { queryTimeoutError } from '../../core/query-timeout.js';
import { nowIso } from '../../core/time.js';
import { loadProtobufRoot, type ProtobufRoot } from '../../core/proto-loader.js';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { str } from '../../core/strings.js';

const READ_COMMANDS = new Set<string>([
  'GET', 'MGET', 'STRLEN', 'GETRANGE', 'EXISTS', 'TYPE', 'TTL', 'PTTL',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSCAN', 'HSTRLEN', 'HRANDFIELD',
  'LRANGE', 'LLEN', 'LINDEX', 'LPOS',
  'SMEMBERS', 'SCARD', 'SISMEMBER', 'SMISMEMBER', 'SRANDMEMBER', 'SINTER', 'SUNION', 'SDIFF', 'SSCAN',
  'ZRANGE', 'ZREVRANGE', 'ZRANGEBYSCORE', 'ZREVRANGEBYSCORE', 'ZRANGEBYLEX', 'ZREVRANGEBYLEX',
  'ZSCORE', 'ZMSCORE', 'ZRANK', 'ZREVRANK', 'ZCARD', 'ZCOUNT', 'ZLEXCOUNT', 'ZSCAN', 'ZRANDMEMBER',
  'KEYS', 'SCAN', 'RANDOMKEY', 'DBSIZE',
  'XLEN', 'XRANGE', 'XREVRANGE', 'XINFO', 'XPENDING',
  'GETBIT', 'BITCOUNT', 'BITPOS',
  'PFCOUNT',
  'OBJECT', 'INFO', 'PING', 'ECHO', 'TIME', 'CONFIG', 'CLIENT', 'MEMORY', 'COMMAND', 'LATENCY', 'DUMP',
]);

const MUTATE_COMMANDS = new Set<string>([
  // strings
  'SET', 'SETEX', 'PSETEX', 'SETNX', 'MSET', 'MSETNX', 'GETSET', 'GETDEL', 'APPEND',
  'INCR', 'DECR', 'INCRBY', 'DECRBY', 'INCRBYFLOAT', 'SETBIT', 'SETRANGE',
  // keyspace lifecycle
  'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT', 'PERSIST',
  'RENAME', 'RENAMENX', 'COPY', 'MOVE', 'TOUCH', 'RESTORE',
  // hashes
  'HSET', 'HMSET', 'HSETNX', 'HDEL', 'HINCRBY', 'HINCRBYFLOAT',
  // lists
  'LPUSH', 'RPUSH', 'LPUSHX', 'RPUSHX', 'LPOP', 'RPOP', 'LREM', 'LSET', 'LINSERT', 'LTRIM',
  'BLPOP', 'BRPOP', 'BLMOVE', 'LMOVE', 'RPOPLPUSH',
  // sets
  'SADD', 'SREM', 'SPOP', 'SMOVE', 'SDIFFSTORE', 'SINTERSTORE', 'SUNIONSTORE',
  // sorted sets
  'ZADD', 'ZREM', 'ZINCRBY', 'ZPOPMIN', 'ZPOPMAX', 'BZPOPMIN', 'BZPOPMAX',
  'ZREMRANGEBYRANK', 'ZREMRANGEBYSCORE', 'ZREMRANGEBYLEX',
  'ZUNIONSTORE', 'ZINTERSTORE', 'ZDIFFSTORE', 'ZRANGESTORE',
  // streams
  'XADD', 'XDEL', 'XTRIM', 'XGROUP', 'XACK', 'XCLAIM', 'XAUTOCLAIM', 'XSETID',
  // hyperloglog + bitops
  'PFADD', 'PFMERGE', 'BITOP', 'BITFIELD',
  // server-side write-ish
  'SORT', // SORT may STORE; the no-STORE read variant is SORT_RO
]);

// FLUSH-tier commands wipe data or move databases. Gated by an extra --allow-flush
// flag on top of executeMutate. Reject these even when the datasource policy
// otherwise allows mutate.
const FLUSH_COMMANDS = new Set<string>([
  'FLUSHDB', 'FLUSHALL', 'SWAPDB', 'MIGRATE',
]);

const SUBCOMMAND_ALLOW: Record<string, Set<string>> = {
  OBJECT: new Set(['ENCODING', 'REFCOUNT', 'IDLETIME', 'FREQ', 'HELP']),
  CONFIG: new Set(['GET', 'RESETSTAT']),
  CLIENT: new Set(['LIST', 'GETNAME', 'ID', 'INFO']),
  MEMORY: new Set(['USAGE', 'STATS', 'DOCTOR']),
  COMMAND: new Set(['', 'COUNT', 'INFO', 'LIST', 'DOCS', 'GETKEYS']),
  LATENCY: new Set(['LATEST', 'HISTORY', 'GRAPH', 'DOCTOR']),
};

type CommandTier = 'read' | 'mutate' | 'flush';

function classifyCommand(verb: string): CommandTier | 'unknown' {
  const v = verb.toUpperCase();
  if (FLUSH_COMMANDS.has(v)) return 'flush';
  if (MUTATE_COMMANDS.has(v)) return 'mutate';
  if (READ_COMMANDS.has(v)) return 'read';
  return 'unknown';
}

function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (m[1] !== undefined) out.push(m[1].replace(/\\(.)/g, '$1'));
    else if (m[2] !== undefined) out.push(m[2].replace(/\\(.)/g, '$1'));
    else if (m[3] !== undefined) out.push(m[3]);
  }
  return out;
}

interface GateOptions {
  capability: 'executeRead' | 'executeMutate';
  allowMutatePolicy: boolean;
  allowedCapabilities: string[];
  allowFlush: boolean;
}

function assertCommandAllowed(tokens: string[], opts: GateOptions): CommandTier {
  if (!tokens.length) throw new Error('empty redis command');
  const verb = str(tokens[0]).toUpperCase();
  const tier = classifyCommand(verb);
  if (tier === 'unknown') {
    throw new Error(`redis command '${verb}' not in allow-list; reject by default.`);
  }
  // SORT with STORE clause is a mutate even though SORT itself can be read-only.
  if (verb === 'SORT' && !tokens.slice(1).some((t) => t.toUpperCase() === 'STORE')) {
    // SORT without STORE = read. Use SORT_RO for explicit read on replicas.
    return 'read';
  }
  // Subcommand allow-list applies only to read-tier composite commands.
  const subAllow = SUBCOMMAND_ALLOW[verb];
  if (subAllow && tier === 'read') {
    const sub = str(tokens[1]).toUpperCase();
    if (!subAllow.has(sub)) {
      throw new Error(`redis ${verb} subcommand '${sub || '(none)'}' not in allow-list.`);
    }
  }
  if (tier === 'read') return tier;
  if (opts.capability !== 'executeMutate') {
    throw new Error(`redis command '${verb}' is a ${tier} operation; re-run with --allow-mutate.`);
  }
  if (!opts.allowMutatePolicy) {
    throw new Error(`datasource policy disallows mutate queries (allowMutate=false). Update the profile with 'taproot datasource add ... --allow-mutate'.`);
  }
  if (!opts.allowedCapabilities.includes('executeMutate')) {
    throw new Error(`datasource capability policy disallows executeMutate.`);
  }
  if (tier === 'flush' && !opts.allowFlush) {
    throw new Error(`redis FLUSH-tier command '${verb}' requires --allow-flush in addition to --allow-mutate.`);
  }
  return tier;
}

function cliArgs(ds: QueryRequest['datasource'], creds: Record<string, string>, decode: boolean): string[] {
  const args: string[] = [
    '-h', String(ds.connection.host || '127.0.0.1'),
    '-p', String(ds.connection.port || RUNTIME_CONSTANTS.defaultPorts.redis),
    '--no-auth-warning',
  ];
  if (decode) args.push('--no-raw');
  const db = ds.connection.database;
  if (db !== undefined && db !== null && String(db) !== '') {
    args.push('-n', String(db));
  }
  if (creds.user) args.push('--user', String(creds.user));
  if (creds.password) args.push('-a', String(creds.password));
  if (ds.connection.ssl) args.push('--tls');
  return args;
}

interface RunResult { stdout: string; stderr: string; code: number; timedOut: boolean }

async function runRedis(args: string[], tokens: string[], timeoutMs?: number): Promise<RunResult> {
  return await new Promise((resolve) => {
    const proc = spawn('redis-cli', [...args, ...tokens], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }, timeoutMs)
      : null;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    proc.stdout.on('data', (c) => { stdout += String(c); });
    proc.stderr.on('data', (c) => { stderr += String(c); });
    proc.once('error', (e) => {
      finish({ stdout, stderr: String((e as Error).message || 'spawn error'), code: -1, timedOut });
    });
    proc.once('exit', (code) => {
      finish({ stdout, stderr, code: code ?? -1, timedOut });
    });
  });
}

// Parse a single redis-cli `--no-raw` quoted string into raw bytes.
// Format mirrors sds.c sdscatrepr: surrounding double quotes, with escapes
// `\n \r \t \a \b \\ \"` and `\xHH` for non-printables. Plain bytes pass through.
function parseQuotedBytes(quoted: string): Buffer | null {
  if (quoted.length < 2 || quoted[0] !== '"' || quoted[quoted.length - 1] !== '"') return null;
  const body = quoted.slice(1, -1);
  const out: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      out.push(body.charCodeAt(i));
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) { out.push(0x5c); continue; }
    if (next === 'n') { out.push(0x0a); i += 1; continue; }
    if (next === 'r') { out.push(0x0d); i += 1; continue; }
    if (next === 't') { out.push(0x09); i += 1; continue; }
    if (next === 'a') { out.push(0x07); i += 1; continue; }
    if (next === 'b') { out.push(0x08); i += 1; continue; }
    if (next === '\\') { out.push(0x5c); i += 1; continue; }
    if (next === '"') { out.push(0x22); i += 1; continue; }
    if (next === 'x') {
      const hex = body.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    out.push(0x5c);
  }
  return Buffer.from(out);
}

// Split redis-cli `--no-raw` output into per-reply entries. Multi-bulk replies
// prefix lines with ` N) `; bulk strings are quoted; everything else (integers,
// simple status replies, `(nil)`) passes through as a plain text entry.
interface ReplyEntry { kind: 'bytes' | 'text'; bytes?: Buffer; text?: string }

function splitReplies(stdout: string): ReplyEntry[] {
  const trimmed = stdout.replace(/\r/g, '');
  const lines = trimmed.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const entries: ReplyEntry[] = [];
  for (const raw of lines) {
    const line = raw.replace(/^\s*\d+\)\s*/, ''); // strip ` N) ` multi-bulk prefix
    if (line.length >= 2 && line.startsWith('"') && line.endsWith('"')) {
      const bytes = parseQuotedBytes(line);
      if (bytes) {
        entries.push({ kind: 'bytes', bytes });
        continue;
      }
    }
    entries.push({ kind: 'text', text: line });
  }
  return entries;
}

type ProtoRoot = ProtobufRoot;

function looksPrintableAscii(buf: Buffer): boolean {
  if (!buf.length) return true;
  for (const b of buf) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b > 0x7e) return false;
  }
  return true;
}

function decodeWith(root: ProtoRoot, message: string, buf: Buffer): Record<string, unknown> {
  const Type = root.lookupType(message);
  const decoded = Type.decode(buf);
  return Type.toObject(decoded, {
    defaults: false,
    longs: String,
    enums: String,
    bytes: 'base64',
    oneofs: true,
  });
}

function resolveProtoParams(request: QueryRequest): { protoRoot?: string; protoMessage?: string } {
  const pp = (request.pluginParams || {}) as RedisPluginParams;
  const hints = (request.datasource.resolverHints || {}) as Record<string, string>;
  const protoRoot = str(pp.protoRoot || hints.protoRoot).trim() || undefined;
  const protoMessage = str(pp.protoMessage || hints.protoMessage).trim() || undefined;
  return { protoRoot, protoMessage };
}

export const redisPlugin: TapRootPlugin = {
  manifest: {
    name: 'redis',
    version: '0.3.0',
    kind: 'executor',
    capabilities: ['doctor', 'executeRead', 'executeMutate'],
    accessMethods: [AccessMethod.Native, AccessMethod.QaPortforward],
    priority: 100,
  },

  async doctor(input): Promise<DoctorCheck[]> {
    const args = cliArgs(input.datasource, input.credentials, false);
    const r = await runRedis(args, ['PING'], RUNTIME_CONSTANTS.plugin.dbConnectTimeoutMs + 2000);
    if (r.code === 0 && /PONG/i.test(r.stdout)) {
      return [{ check: 'redis ping', status: DoctorStatus.Ok, detail: 'PING -> PONG' }];
    }
    const detail = (r.stderr || r.stdout || `exit=${r.code}`).trim().slice(0, 400) || 'redis-cli failed';
    return [{ check: 'redis ping', status: DoctorStatus.Fail, detail, code: classifyExecutorDoctorCode(detail) }];
  },

  async execute(request, creds): Promise<QueryResult> {
    const startedAt = nowIso();
    const start = Date.now();
    const tokens = tokenize(request.query);
    const pp = (request.pluginParams || {}) as RedisPluginParams;
    const policy = request.datasource.policy;
    const tier = assertCommandAllowed(tokens, {
      capability: request.capability,
      allowMutatePolicy: Boolean(policy?.allowMutate),
      allowedCapabilities: (policy?.allowedCapabilities || []) as string[],
      allowFlush: Boolean(pp.allowFlush),
    });
    const { protoRoot, protoMessage } = resolveProtoParams(request);
    const decode = Boolean(protoMessage) && tier === 'read';
    if (Boolean(protoMessage) && !protoRoot) {
      throw new Error("proto decoding requested but no proto root. Pass --proto-root <dir> or set resolverHints.protoRoot on the datasource.");
    }
    const args = cliArgs(request.datasource, creds, decode);
    const r = await runRedis(args, tokens, request.timeoutMs);
    if (r.timedOut) throw queryTimeoutError(request.timeoutMs || 0);
    if (r.code !== 0) {
      throw new Error((r.stderr || r.stdout || `redis-cli exit ${r.code}`).trim());
    }
    if (/^\(error\)/im.test(r.stdout)) {
      throw new Error(r.stdout.trim());
    }
    const warnings: string[] = [];
    let columns: string[] = ['value'];
    let rows: Array<Record<string, unknown>> = [];
    if (decode) {
      const root = (await loadProtobufRoot(protoRoot as string)).protobufRoot;
      const entries = splitReplies(r.stdout);
      rows = entries.map((entry) => {
        if (entry.kind === 'text') return { value: entry.text };
        const bytes = entry.bytes as Buffer;
        try {
          const obj = decodeWith(root, protoMessage as string, bytes);
          return { value: obj };
        } catch (err) {
          if (looksPrintableAscii(bytes)) return { value: bytes.toString('utf8') };
          return {
            value: bytes.toString('base64'),
            _decodeError: (err as Error).message,
            _encoding: 'base64',
          };
        }
      });
      if (rows.some((r) => '_decodeError' in r)) warnings.push('proto_decode_partial_failure');
    } else {
      const trimmed = r.stdout.replace(/\r/g, '');
      const lines = trimmed.split('\n');
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      rows = lines.map((line) => ({ value: line }));
    }
    return {
      runId: '',
      datasource: request.datasource.name,
      plugin: 'redis',
      capability: request.capability,
      query: { native: request.query },
      result: { columns, rows },
      timings: {
        startedAt,
        endedAt: nowIso(),
        durationMs: Date.now() - start,
      },
      warnings,
      classification: 'success',
    };
  },
};
