import type { Span } from './errors.js';

/* ------------------------------------------------------------------ *
 * Unresolved tree — the product of parsing. No schema has been seen,
 * so qualifiers are still an undifferentiated list (spec §5, §8.2).
 * ------------------------------------------------------------------ */

export interface UValue {
  text: string;
  quoted: boolean;
  span: Span;
}

export interface UQualifier {
  text: string;
  span: Span;
}

export interface UKwarg {
  name: string;
  value: string;
  span: Span;
}

export interface USelector {
  family: string;
  familySpan: Span;
  qualifiers: UQualifier[];
  /** Present when written in keyword form, `nuc(ref=X,seg=HA,pos=3423)`. */
  kwargs?: UKwarg[];
  span: Span;
}

export type UNode =
  | { kind: 'and' | 'or'; operands: UNode[]; span: Span }
  | { kind: 'not' | 'maybe'; operand: UNode; span: Span }
  | { kind: 'cmp'; selector: USelector; op: string; opSpan: Span; opAlias: boolean; values: UValue[]; span: Span };

/* ------------------------------------------------------------------ *
 * Resolved tree — slots assigned, types known, operators validated.
 * This is what renders, serializes, and translates (spec §8.2, §11.1).
 * ------------------------------------------------------------------ */

export type RValue = string | number | boolean;

export interface RCmp {
  kind: 'cmp';
  family: string;
  /** Resolved slot map, in the schema's declared order. */
  slots: Record<string, string | number>;
  op: string;
  values: RValue[];
  /** Field type, carried so renderers and targets need not consult the schema again. */
  type: string;
  /** Organisms this term resolved against. */
  scope: string[];
  /** Slots the writer supplied explicitly; the rest were inferred and may be dropped again. */
  explicitSlots: string[];
  source: UNode & { kind: 'cmp' };
  span: Span;
}

export type RNode =
  | { kind: 'and' | 'or'; operands: RNode[]; span: Span }
  | { kind: 'not' | 'maybe'; operand: RNode; span: Span }
  | RCmp;

export function isCmp(node: UNode): node is UNode & { kind: 'cmp' } {
  return node.kind === 'cmp';
}

/** Depth-first walk, parents before children. */
export function walk(node: RNode, visit: (n: RNode) => void): void {
  visit(node);
  if (node.kind === 'and' || node.kind === 'or') node.operands.forEach((o) => walk(o, visit));
  else if (node.kind === 'not' || node.kind === 'maybe') walk(node.operand, visit);
}
