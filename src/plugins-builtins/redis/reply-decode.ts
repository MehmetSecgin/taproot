import { loadProtobufRoot } from '../../core/proto-loader.js';
import type { ProtobufRoot } from '../../core/proto-loader.js';

const TAB = 0x09;
const LINE_FEED = 0x0A;
const CARRIAGE_RETURN = 0x0D;
const BELL = 0x07;
const BACKSPACE = 0x08;
const DOUBLE_QUOTE = 0x22;
const BACKSLASH = 0x5C;
const FIRST_PRINTABLE_ASCII = 0x20;
const LAST_PRINTABLE_ASCII = 0x7E;
const HEX_RADIX = 16;
const HEX_ESCAPE_LENGTH = 4;

const SINGLE_CHARACTER_ESCAPES = new Map<string, number>([
  ['n', LINE_FEED],
  ['r', CARRIAGE_RETURN],
  ['t', TAB],
  ['a', BELL],
  ['b', BACKSPACE],
  ['\\', BACKSLASH],
  ['"', DOUBLE_QUOTE],
]);

const HEX_BYTE = /^[0-9a-f]{2}$/iu;
const MULTI_BULK_INDEX_PREFIX = /^\s*\d+\)\s*/u;
const PARTIAL_DECODE_WARNING = 'proto_decode_partial_failure';

export type ProtoDecoding = {
  protoRoot: string;
  protoMessage: string;
};

type ReplyEntry = { kind: 'bytes'; bytes: Buffer } | { kind: 'text'; text: string };

type DecodedByte = { byte: number; consumed: number };

function isQuoted(text: string): boolean {
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"');
}

function lowByteOfUtf16Unit(unit: string): number {
  const [byte = 0] = Buffer.from(unit, 'latin1');
  return byte;
}

function decodeByteAt(body: string, index: number): DecodedByte {
  if (body[index] !== '\\') {
    return { byte: lowByteOfUtf16Unit(body.slice(index, index + 1)), consumed: 1 };
  }
  const next = body[index + 1] ?? '';
  const escapedByte = SINGLE_CHARACTER_ESCAPES.get(next);
  if (escapedByte !== undefined) {
    return { byte: escapedByte, consumed: 2 };
  }
  const hex = body.slice(index + 2, index + HEX_ESCAPE_LENGTH);
  if (next === 'x' && HEX_BYTE.test(hex)) {
    return { byte: Number.parseInt(hex, HEX_RADIX), consumed: HEX_ESCAPE_LENGTH };
  }
  return { byte: BACKSLASH, consumed: 1 };
}

function parseRedisCliQuotedString(quoted: string): Buffer | null {
  if (!isQuoted(quoted)) {
    return null;
  }
  const body = quoted.slice(1, -1);
  const bytes: number[] = [];
  let index = 0;
  while (index < body.length) {
    const { byte, consumed } = decodeByteAt(body, index);
    bytes.push(byte);
    index += consumed;
  }
  return Buffer.from(bytes);
}

function splitStdoutLines(stdout: string): string[] {
  const lines = stdout.replaceAll('\r', '').split('\n');
  while (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

function splitRedisCliReplies(stdout: string): ReplyEntry[] {
  return splitStdoutLines(stdout).map((rawLine) => {
    const line = rawLine.replace(MULTI_BULK_INDEX_PREFIX, '');
    const bytes = isQuoted(line) ? parseRedisCliQuotedString(line) : null;
    return bytes === null ? { kind: 'text', text: line } : { kind: 'bytes', bytes };
  });
}

function looksPrintableAscii(bytes: Buffer): boolean {
  return bytes.every(
    (byte) => byte === TAB || byte === LINE_FEED || byte === CARRIAGE_RETURN || (byte >= FIRST_PRINTABLE_ASCII && byte <= LAST_PRINTABLE_ASCII),
  );
}

function decodeProtoMessage(root: ProtobufRoot, messageName: string, bytes: Buffer): Record<string, unknown> {
  const messageType = root.lookupType(messageName);
  return messageType.toObject(messageType.decode(bytes), {
    defaults: false,
    longs: String,
    enums: String,
    bytes: 'base64',
    oneofs: true,
  });
}

async function decodeProtoReplies(protoDecoding: ProtoDecoding, stdout: string): Promise<{ rows: unknown[][]; warnings: string[] }> {
  const { protobufRoot } = await loadProtobufRoot(protoDecoding.protoRoot);
  let undecodableCount = 0;
  const rows = splitRedisCliReplies(stdout).map((entry) => {
    if (entry.kind === 'text') {
      return [entry.text];
    }
    try {
      return [decodeProtoMessage(protobufRoot, protoDecoding.protoMessage, entry.bytes)];
    } catch {
      if (looksPrintableAscii(entry.bytes)) {
        return [entry.bytes.toString('utf8')];
      }
      undecodableCount += 1;
      return [entry.bytes.toString('base64')];
    }
  });
  return { rows, warnings: undecodableCount > 0 ? [PARTIAL_DECODE_WARNING] : [] };
}

export async function buildValueRows(stdout: string, protoDecoding: ProtoDecoding | undefined): Promise<{ rows: unknown[][]; warnings: string[] }> {
  if (protoDecoding === undefined) {
    return { rows: splitStdoutLines(stdout).map((line) => [line]), warnings: [] };
  }
  return decodeProtoReplies(protoDecoding, stdout);
}
