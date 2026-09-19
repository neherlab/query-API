/** Source offsets, used for every diagnostic so the UI can highlight the exact text. */
export interface Span {
  start: number;
  /** Exclusive. */
  end: number;
}

export type Phase = 'lex' | 'parse' | 'resolve';

export interface Diagnostic {
  phase: Phase;
  message: string;
  span: Span;
  /** Optional follow-up the UI can render as a hint. */
  hint?: string;
}

/** Thrown by the lexer and parser, which stop at the first error. Resolution collects instead. */
export class QueryError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(phase: Phase, message: string, span: Span, hint?: string) {
    super(message);
    this.name = 'QueryError';
    this.diagnostic = { phase, message, span, hint };
  }
}

export function span(start: number, end: number): Span {
  return { start, end };
}

export function joinSpans(a: Span, b: Span): Span {
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}
