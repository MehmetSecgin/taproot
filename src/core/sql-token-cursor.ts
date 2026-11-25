type Token = {
  text: string;
  at: number;
};

const TOKEN_PATTERN = /\s*(?<token>`(?:[^`]|``)*`|'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|[\w$\u{80}-\u{10FFFF}]+|\S)/guy;
const NAME_PATTERN = /^(?:`|[\w$\u{80}-\u{10FFFF}])/u;
const STRING_PATTERN = /^['"]/u;

export class TokenCursor {
  public readonly schemas: string[] = [];
  private readonly tokens: Token[];
  private position = 0;

  public constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  public peek(): Token | undefined {
    return this.tokens[this.position];
  }

  public take(...words: string[]): boolean {
    const next = this.peek()?.text.toLowerCase();
    if (next === undefined || !words.includes(next)) {
      return false;
    }
    this.position += 1;
    return true;
  }

  public takeString(): boolean {
    if (!STRING_PATTERN.test(this.peek()?.text ?? '')) {
      return false;
    }
    this.position += 1;
    return true;
  }

  public takeName(): string | undefined {
    const text = this.peek()?.text ?? '';
    if (!NAME_PATTERN.test(text)) {
      return undefined;
    }
    this.position += 1;
    return text.startsWith('`') ? text.slice(1, -1).replaceAll('``', '`') : text;
  }

  public takeSchemaName(): boolean {
    const schema = this.takeName();
    if (schema !== undefined) {
      this.schemas.push(schema);
    }
    return schema !== undefined;
  }

  public takeTableName(): boolean {
    const first = this.takeName();
    if (first === undefined) {
      return false;
    }
    if (!this.take('.')) {
      return true;
    }
    this.schemas.push(first);
    return this.takeName() !== undefined;
  }

  public done(): boolean {
    return this.position === this.tokens.length;
  }
}

export function tokenize(code: string): Token[] {
  const tokens = [...code.matchAll(TOKEN_PATTERN)].map((match) => {
    const text = match.groups?.token ?? '';
    return { text, at: match.index + match[0].length - text.length };
  });
  return tokens.at(-1)?.text === ';' ? tokens.slice(0, -1) : tokens;
}
