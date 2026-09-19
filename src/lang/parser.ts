import type { UKwarg, UNode, UQualifier, USelector, UValue } from './ast.js';
import { QueryError, joinSpans, type Span, span } from './errors.js';
import { lex, type Token } from './lexer.js';

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Recursive descent over spec §5.1. Precedence: `!` tightest, then `;`, then `,` (§5.3).
 *
 * Same-kind chains are flattened, including across parentheses, so `a;(b;c)` and `a;b;c` produce
 * the same tree. AND and OR are associative, and the scope rule (§7.2) is defined over an
 * AND-group rather than over a particular parenthesization.
 *
 * Returns null for an empty string, which the app treats as "no filter" rather than an error.
 */
export function parse(input: string): UNode | null {
  if (input.trim() === '') return null;
  return new Parser(lex(input)).parseQuery();
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  parseQuery(): UNode {
    const node = this.parseOr();
    const tok = this.peek();
    if (tok.kind !== 'eof') {
      throw new QueryError('parse', `unexpected ${describe(tok)}`, tok.span);
    }
    return node;
  }

  private parseOr(): UNode {
    const first = this.parseAnd();
    if (this.peek().kind !== 'comma') return first;
    const operands = flatten('or', [first]);
    while (this.eat('comma')) operands.push(...flatten('or', [this.parseAnd()]));
    return { kind: 'or', operands, span: coverAll(operands) };
  }

  private parseAnd(): UNode {
    const first = this.parseUnary();
    if (this.peek().kind !== 'and') return first;
    const operands = flatten('and', [first]);
    while (this.eat('and')) operands.push(...flatten('and', [this.parseUnary()]));
    return { kind: 'and', operands, span: coverAll(operands) };
  }

  private parseUnary(): UNode {
    const bang = this.eat('bang');
    if (!bang) return this.parsePrimary();
    const operand = this.parseUnary();
    return { kind: 'not', operand, span: joinSpans(bang.span, operand.span) };
  }

  private parsePrimary(): UNode {
    const tok = this.peek();

    if (tok.kind === 'lparen') {
      this.next();
      const inner = this.parseOr();
      this.expect('rparen', "expected ')'");
      return inner;
    }

    if (tok.kind === 'word') {
      // `maybe` is the language's only reserved word (§5.2).
      if (tok.text === 'maybe' && this.peekAt(1).kind === 'lparen') {
        this.next();
        this.next();
        const operand = this.parseOr();
        const close = this.expect('rparen', "expected ')' to close maybe(...)");
        return { kind: 'maybe', operand, span: joinSpans(tok.span, close.span) };
      }
      return this.parseConstraint();
    }

    throw new QueryError('parse', `expected a filter, found ${describe(tok)}`, tok.span);
  }

  private parseConstraint(): UNode {
    const selector = this.parseSelector();
    const opTok = this.peek();
    if (opTok.kind !== 'op') {
      throw new QueryError(
        'parse',
        `expected a comparator, found ${describe(opTok)}`,
        opTok.span,
        'comparators are ==, !=, =ge=, =in=, =descendantOf= and so on; <= and >= are accepted too',
      );
    }
    this.next();
    const values = this.parseArgument();
    return {
      kind: 'cmp',
      selector,
      op: opTok.text,
      opSpan: opTok.span,
      opAlias: opTok.alias === true,
      values,
      span: joinSpans(selector.span, values[values.length - 1]?.span ?? opTok.span),
    };
  }

  /**
   * A selector lexes as one `word`, because dots are bare-token characters. Splitting here keeps
   * the lexer context-free and still yields per-qualifier spans for error reporting.
   */
  private parseSelector(): USelector {
    const tok = this.expect('word', 'expected a field name');
    const parts = tok.text.split('.');
    const family = parts[0]!;
    if (!IDENT.test(family)) {
      throw new QueryError('parse', `'${family}' is not a valid field name`, span(tok.span.start, tok.span.start + family.length));
    }

    const qualifiers: UQualifier[] = [];
    let offset = tok.span.start + family.length;
    for (const part of parts.slice(1)) {
      offset += 1; // the dot
      if (part === '') {
        throw new QueryError('parse', 'empty qualifier', span(offset - 1, offset));
      }
      qualifiers.push({ text: part, span: span(offset, offset + part.length) });
      offset += part.length;
    }

    const familySpan = span(tok.span.start, tok.span.start + family.length);
    let kwargs: UKwarg[] | undefined;
    let end = tok.span.end;

    // `IDENT(` is one unit: keyword-argument form, never a group (§5.2).
    if (this.peek().kind === 'lparen') {
      this.next();
      kwargs = [];
      for (;;) {
        const name = this.expect('word', 'expected a slot name');
        this.expect('eq', "expected '=' after the slot name");
        const value = this.peek();
        if (value.kind !== 'word' && value.kind !== 'quoted') {
          throw new QueryError('parse', `expected a slot value, found ${describe(value)}`, value.span);
        }
        this.next();
        kwargs.push({ name: name.text, value: value.text, span: joinSpans(name.span, value.span) });
        if (this.eat('comma')) continue;
        end = this.expect('rparen', "expected ')' to close the slot list").span.end;
        break;
      }
      if (qualifiers.length > 0) {
        throw new QueryError(
          'parse',
          'a selector cannot mix dotted and keyword slots',
          span(tok.span.start, end),
          `write either ${family}.${qualifiers.map((q) => q.text).join('.')} or ${family}(...)`,
        );
      }
    }

    return { family, familySpan, qualifiers, kwargs, span: span(tok.span.start, end) };
  }

  /** A single value, or a parenthesized list for `=in=` / `=out=`. */
  private parseArgument(): UValue[] {
    if (this.eat('lparen')) {
      const values: UValue[] = [];
      for (;;) {
        values.push(this.parseValue());
        if (this.eat('comma')) continue;
        this.expect('rparen', "expected ')' to close the value list");
        break;
      }
      return values;
    }
    return [this.parseValue()];
  }

  private parseValue(): UValue {
    const tok = this.peek();
    if (tok.kind !== 'word' && tok.kind !== 'quoted') {
      throw new QueryError('parse', `expected a value, found ${describe(tok)}`, tok.span);
    }
    this.next();
    return { text: tok.text, quoted: tok.kind === 'quoted', span: tok.span };
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private peekAt(offset: number): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private eat(kind: Token['kind']): Token | null {
    if (this.peek().kind === kind) return this.next();
    return null;
  }

  private expect(kind: Token['kind'], message: string): Token {
    const tok = this.peek();
    if (tok.kind !== kind) {
      throw new QueryError('parse', `${message}, found ${describe(tok)}`, tok.span);
    }
    return this.next();
  }
}

function flatten(kind: 'and' | 'or', nodes: UNode[]): UNode[] {
  const out: UNode[] = [];
  for (const node of nodes) {
    if (node.kind === kind) out.push(...node.operands);
    else out.push(node);
  }
  return out;
}

function coverAll(nodes: UNode[]): Span {
  return nodes.slice(1).reduce((acc, n) => joinSpans(acc, n.span), nodes[0]!.span);
}

function describe(tok: Token): string {
  switch (tok.kind) {
    case 'eof':
      return 'end of query';
    case 'word':
    case 'quoted':
      return `'${tok.text}'`;
    case 'op':
      return `comparator '${tok.text}'`;
    case 'and':
      return "';'";
    case 'comma':
      return "','";
    default:
      return `'${tok.text}'`;
  }
}
