import type { Capability } from '../../types/datasource.js';
import { textUnlessFalsy } from '../../core/text-presence.js';

const READ_COMMANDS = new Set<string>([
  'GET', 'MGET', 'STRLEN', 'GETRANGE', 'EXISTS', 'TYPE', 'TTL', 'PTTL',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSCAN', 'HSTRLEN', 'HRANDFIELD',
  'LRANGE', 'LLEN', 'LINDEX', 'LPOS',
  'SORT_RO',
  'SMEMBERS', 'SCARD', 'SISMEMBER', 'SMISMEMBER', 'SRANDMEMBER', 'SINTER', 'SUNION', 'SDIFF', 'SSCAN',
  'ZRANGE', 'ZREVRANGE', 'ZRANGEBYSCORE', 'ZREVRANGEBYSCORE', 'ZRANGEBYLEX', 'ZREVRANGEBYLEX',
  'ZSCORE', 'ZMSCORE', 'ZRANK', 'ZREVRANK', 'ZCARD', 'ZCOUNT', 'ZLEXCOUNT', 'ZSCAN', 'ZRANDMEMBER',
  'SCAN', 'RANDOMKEY', 'DBSIZE',
  'XLEN', 'XRANGE', 'XREVRANGE', 'XINFO', 'XPENDING',
  'GETBIT', 'BITCOUNT', 'BITPOS',
  'PFCOUNT',
  'OBJECT', 'INFO', 'PING', 'ECHO', 'TIME', 'CONFIG', 'CLIENT', 'MEMORY', 'COMMAND', 'LATENCY', 'DUMP',
]);

const STRING_WRITES = [
  'SET', 'SETEX', 'PSETEX', 'SETNX', 'MSET', 'MSETNX', 'GETSET', 'GETDEL', 'APPEND',
  'INCR', 'DECR', 'INCRBY', 'DECRBY', 'INCRBYFLOAT', 'SETBIT', 'SETRANGE',
];
const KEYSPACE_LIFECYCLE_WRITES = [
  'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT', 'PERSIST',
  'RENAME', 'RENAMENX', 'COPY', 'MOVE', 'TOUCH', 'RESTORE',
];
const HASH_WRITES = ['HSET', 'HMSET', 'HSETNX', 'HDEL', 'HINCRBY', 'HINCRBYFLOAT'];
const LIST_WRITES = [
  'LPUSH', 'RPUSH', 'LPUSHX', 'RPUSHX', 'LPOP', 'RPOP', 'LREM', 'LSET', 'LINSERT', 'LTRIM',
  'BLPOP', 'BRPOP', 'BLMOVE', 'LMOVE', 'RPOPLPUSH',
];
const SET_WRITES = ['SADD', 'SREM', 'SPOP', 'SMOVE', 'SDIFFSTORE', 'SINTERSTORE', 'SUNIONSTORE'];
const SORTED_SET_WRITES = [
  'ZADD', 'ZREM', 'ZINCRBY', 'ZPOPMIN', 'ZPOPMAX', 'BZPOPMIN', 'BZPOPMAX',
  'ZREMRANGEBYRANK', 'ZREMRANGEBYSCORE', 'ZREMRANGEBYLEX',
  'ZUNIONSTORE', 'ZINTERSTORE', 'ZDIFFSTORE', 'ZRANGESTORE',
];
const STREAM_WRITES = ['XADD', 'XDEL', 'XTRIM', 'XGROUP', 'XACK', 'XCLAIM', 'XAUTOCLAIM', 'XSETID'];
const HYPERLOGLOG_AND_BIT_WRITES = ['PFADD', 'PFMERGE', 'BITOP', 'BITFIELD'];

const MUTATE_COMMANDS = new Set<string>([
  ...STRING_WRITES,
  ...KEYSPACE_LIFECYCLE_WRITES,
  ...HASH_WRITES,
  ...LIST_WRITES,
  ...SET_WRITES,
  ...SORTED_SET_WRITES,
  ...STREAM_WRITES,
  ...HYPERLOGLOG_AND_BIT_WRITES,
]);

const DATA_WIPING_OR_DATABASE_MOVING_COMMANDS = new Set<string>([
  'FLUSHDB', 'FLUSHALL', 'SWAPDB', 'MIGRATE',
]);

const READ_SUBCOMMANDS: Record<string, Set<string>> = {
  OBJECT: new Set(['ENCODING', 'REFCOUNT', 'IDLETIME', 'FREQ', 'HELP']),
  CONFIG: new Set(['GET', 'RESETSTAT']),
  CLIENT: new Set(['LIST', 'GETNAME', 'ID', 'INFO']),
  MEMORY: new Set(['USAGE', 'STATS', 'DOCTOR']),
  COMMAND: new Set(['', 'COUNT', 'INFO', 'LIST', 'DOCS', 'GETKEYS']),
  LATENCY: new Set(['LATEST', 'HISTORY', 'GRAPH', 'DOCTOR']),
};

export const SCAN_COUNT_MAX = 200;

export const KEY_NAME_REPLY_COMMANDS = new Set<string>(['KEYS', 'SCAN', 'RANDOMKEY', 'HKEYS']);

type CommandTier = 'read' | 'keys' | 'mutate' | 'flush';

export type GateOptions = {
  capability: 'executeRead' | 'executeMutate';
  policyAllowsMutate: boolean;
  allowedCapabilities: Capability[];
  allowFlush: boolean;
  allowKeys: boolean;
  strictKeyspace: boolean;
};

type AllowedCommand = {
  verb: string;
  tier: CommandTier;
};

function upperCaseToken(tokens: string[], index: number): string {
  return textUnlessFalsy(tokens[index]).toUpperCase();
}

function commandTierOf(verb: string, tokens: string[]): CommandTier | 'unknown' {
  if (DATA_WIPING_OR_DATABASE_MOVING_COMMANDS.has(verb)) {
    return 'flush';
  }
  if (verb === 'SORT') {
    return tokens.slice(1).some((token) => token.toUpperCase() === 'STORE') ? 'mutate' : 'read';
  }
  if (MUTATE_COMMANDS.has(verb)) {
    return 'mutate';
  }
  if (verb === 'KEYS') {
    return 'keys';
  }
  return READ_COMMANDS.has(verb) ? 'read' : 'unknown';
}

function assertSubcommandAllowed(verb: string, tokens: string[]): void {
  const allowedSubcommands = READ_SUBCOMMANDS[verb];
  if (allowedSubcommands === undefined) {
    return;
  }
  const subcommand = upperCaseToken(tokens, 1);
  if (!allowedSubcommands.has(subcommand)) {
    throw new Error(`redis ${verb} subcommand '${subcommand === '' ? '(none)' : subcommand}' not in allow-list.`);
  }
}

function lastScanCount(tokens: string[]): string | undefined {
  const keywordIndexes = tokens.flatMap((token, index) => (index >= 2 && index % 2 === 0 && token.toUpperCase() === 'COUNT' ? [index] : []));
  const lastKeywordIndex = keywordIndexes.at(-1);
  return lastKeywordIndex === undefined ? undefined : tokens[lastKeywordIndex + 1];
}

function assertScanBounded(tokens: string[]): void {
  const countArg = lastScanCount(tokens);
  if (countArg === undefined) {
    throw new Error(`redis SCAN needs an explicit COUNT (at most ${SCAN_COUNT_MAX}), e.g. SCAN 0 MATCH user:* COUNT 100.`);
  }
  const count = Number(countArg);
  if (!Number.isInteger(count) || count < 1 || count > SCAN_COUNT_MAX) {
    throw new Error(`redis SCAN COUNT must be an integer from 1 to ${SCAN_COUNT_MAX}.`);
  }
}

function assertReadAllowed(verb: string, tokens: string[], options: GateOptions): void {
  assertSubcommandAllowed(verb, tokens);
  if (verb === 'SCAN' && options.strictKeyspace) {
    assertScanBounded(tokens);
  }
}

function assertMutateAllowed(verb: string, tier: 'mutate' | 'flush', options: GateOptions): void {
  if (options.capability !== 'executeMutate') {
    throw new Error(`redis command '${verb}' is a ${tier} operation; re-run with --allow-mutate.`);
  }
  if (!options.policyAllowsMutate) {
    throw new Error(`datasource policy disallows mutate queries (allowMutate=false). Update the profile with 'taproot datasource add ... --allow-mutate'.`);
  }
  if (!options.allowedCapabilities.includes('executeMutate')) {
    throw new Error(`datasource capability policy disallows executeMutate.`);
  }
  if (tier === 'flush' && !options.allowFlush) {
    throw new Error(`redis FLUSH-tier command '${verb}' requires --allow-flush in addition to --allow-mutate.`);
  }
}

function requireKnownCommand(tokens: string[]): AllowedCommand {
  if (tokens.length === 0) {
    throw new Error('empty redis command');
  }
  const verb = upperCaseToken(tokens, 0);
  const tier = commandTierOf(verb, tokens);
  if (tier === 'unknown') {
    throw new Error(`redis command '${verb}' not in allow-list; reject by default.`);
  }
  return { verb, tier };
}

function assertKeysAllowed(verb: string, options: GateOptions): void {
  if (options.strictKeyspace && !options.allowKeys) {
    throw new Error(`redis ${verb} is O(N) and blocks the whole instance; use SCAN <cursor> MATCH <pattern> COUNT <n>, or re-run with --allow-keys.`);
  }
}

export function assertCommandAllowed(tokens: string[], options: GateOptions): AllowedCommand {
  const command = requireKnownCommand(tokens);
  const { verb, tier } = command;
  if (tier === 'keys') {
    assertKeysAllowed(verb, options);
    return { verb, tier: 'read' };
  }
  if (tier === 'read') {
    assertReadAllowed(verb, tokens, options);
    return command;
  }
  assertMutateAllowed(verb, tier, options);
  return command;
}
