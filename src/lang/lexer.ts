import { QueryError, type Span, span } from './errors.js';

export type TokenKind =
  | 'word' // bare token run, including dots: `nuc.3423`, `B.1.1.7`, `2021-03`
  | 'quoted'
  | 'op' // a comparator
  | 'eq' // a single `=`, only legal inside keyword arguments
  | 'and' // ;
  | 'comma' // , — OR, or a value-list separator
  | 'lparen'
  | 'rparen'
  | 'bang'
  | 'eof';

export interface Token {
  kind: TokenKind;
  /** For `word`/`quoted`: the text (quoted values are already unescaped). For `op`: the canonical name. */
  text: string;
  span: Span;
  /** Set on `op` when written with a friendly alias (`<=` etc.); see spec §5.5. */
  alias?: boolean;
}

/** Canonical names for the built-in comparators. Custom operators keep their spelling. */
const SYMBOLIC_OPS: Record<string, string> = { '==': 'eq', '!=': 'ne' };
const ALIAS_OPS: Record<string, string> = { '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };

const BARE = /[A-Za-z0-9._~:@*-]/;
const ALPHA = /[A-Za-z]/;
const WS = /\s/;

/**
 * Characters ruled out by spec §4. Reported specifically, because the reason differs per
 * character and a bare "unexpected character" would send people looking for a typo.
 */
const EXCLUDED: Record<string, string> = {
  '{': 'braces must be percent-encoded in a URL; use keyword form nuc(seg=HA,pos=1) instead',
  '}': 'braces must be percent-encoded in a URL; use keyword form nuc(seg=HA,pos=1) instead',
  '[': 'square brackets must be percent-encoded in a URL',
  ']': 'square brackets must be percent-encoded in a URL',
  '%': 'percent must be encoded; the query is written unencoded',
  '"': 'use single quotes for values',
  '\\': 'backslash is only legal inside a quoted value',
  '^': 'not part of the query language',
  '|': 'not part of the query language; OR is written with a comma',
  '&': 'not part of the query language; AND is written with a semicolon',
  '+': 'a plus decodes to a space in a URL; it is not part of the query language',
};

export function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const push = (kind: TokenKind, text: string, start: number, end: number, alias?: boolean) => {
    tokens.push({ kind, text, span: span(start, end), ...(alias ? { alias } : {}) });
  };

  while (i < input.length) {
    const c = input[i]!;

    // Whitespace is not part of the language (§4) but is tolerated on input and erased by
    // canonicalization, on the same footing as the comparator aliases (§5.5).
    if (WS.test(c)) {
      i++;
      continue;
    }

    if (c in EXCLUDED) {
      throw new QueryError('lex', `'${c}' is not allowed here`, span(i, i + 1), EXCLUDED[c]);
    }

    switch (c) {
      case ';':
        push('and', ';', i, i + 1);
        i++;
        continue;
      case ',':
        push('comma', ',', i, i + 1);
        i++;
        continue;
      case '(':
        push('lparen', '(', i, i + 1);
        i++;
        continue;
      case ')':
        push('rparen', ')', i, i + 1);
        i++;
        continue;
    }

    // `!=` is a comparator; a bare `!` is prefix NOT (§5.2).
    if (c === '!') {
      if (input[i + 1] === '=') {
        push('op', SYMBOLIC_OPS['!=']!, i, i + 2);
        i += 2;
      } else {
        push('bang', '!', i, i + 1);
        i++;
      }
      continue;
    }

    // Maximal munch, so `<=` never lexes as `<` followed by a value (§5.2).
    if (c === '<' || c === '>') {
      const two = input.slice(i, i + 2);
      const sym = two in ALIAS_OPS ? two : c;
      push('op', ALIAS_OPS[sym]!, i, i + sym.length, true);
      i += sym.length;
      continue;
    }

    if (c === '=') {
      if (input[i + 1] === '=') {
        push('op', SYMBOLIC_OPS['==']!, i, i + 2);
        i += 2;
        continue;
      }
      // `=name=` is a custom comparator; a lone `=` separates a keyword argument. Distinguished
      // by scanning the alphabetic run and checking for the closing `=`.
      let j = i + 1;
      while (j < input.length && ALPHA.test(input[j]!)) j++;
      if (j > i + 1 && input[j] === '=') {
        push('op', input.slice(i + 1, j), i, j + 1);
        i = j + 1;
      } else {
        push('eq', '=', i, i + 1);
        i++;
      }
      continue;
    }

    if (c === "'") {
      const start = i;
      i++;
      let text = '';
      let closed = false;
      while (i < input.length) {
        const ch = input[i]!;
        if (ch === '\\') {
          const next = input[i + 1];
          if (next === "'" || next === '\\') {
            text += next;
            i += 2;
            continue;
          }
          throw new QueryError(
            'lex',
            'invalid escape',
            span(i, i + 2),
            "only \\' and \\\\ are escapes inside a quoted value",
          );
        }
        if (ch === "'") {
          i++;
          closed = true;
          break;
        }
        text += ch;
        i++;
      }
      if (!closed) {
        throw new QueryError('lex', 'unterminated quoted value', span(start, input.length));
      }
      push('quoted', text, start, i);
      continue;
    }

    if (BARE.test(c)) {
      const start = i;
      while (i < input.length && BARE.test(input[i]!)) i++;
      push('word', input.slice(start, i), start, i);
      continue;
    }

    throw new QueryError('lex', `unexpected character '${c}'`, span(i, i + 1));
  }

  push('eof', '', input.length, input.length);
  return tokens;
}
