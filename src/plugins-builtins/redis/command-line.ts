const COMMAND_LINE_PART = /"(?<double>(?:[^"\\]|\\.)*)"|'(?<single>(?:[^'\\]|\\.)*)'|(?<bare>\S+)/gu;
const BACKSLASH_ESCAPE = /\\(?<escaped>.)/gu;

function unescapeQuoted(text: string): string {
  return text.replaceAll(BACKSLASH_ESCAPE, '$<escaped>');
}

export function splitRedisCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  for (const { groups } of commandLine.matchAll(COMMAND_LINE_PART)) {
    if (groups?.double !== undefined) {
      tokens.push(unescapeQuoted(groups.double));
    } else if (groups?.single !== undefined) {
      tokens.push(unescapeQuoted(groups.single));
    } else if (groups?.bare !== undefined) {
      tokens.push(groups.bare);
    }
  }
  return tokens;
}
