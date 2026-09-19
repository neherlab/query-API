import type { RCmp, RNode } from './ast.js';

/**
 * Disjunctive normal form, used only by backend adapters that cannot express arbitrary boolean
 * structure (spec §11.2). The language itself never needs it.
 */
export interface Term {
  cmp: RCmp;
  negated: boolean;
  /** The term sat inside a `maybe(...)`, so the adapter must widen it. */
  maybe: boolean;
}

export type Disjunct = Term[];

export interface DnfResult {
  disjuncts: Disjunct[] | null;
  /** Why DNF was not possible, when `disjuncts` is null. */
  reason?: string;
}

export function toDnf(node: RNode): DnfResult {
  try {
    return { disjuncts: convert(node, false, false) };
  } catch (err) {
    return { disjuncts: null, reason: (err as Error).message };
  }
}

function convert(node: RNode, negated: boolean, maybe: boolean): Disjunct[] {
  switch (node.kind) {
    case 'cmp':
      return [[{ cmp: node, negated, maybe }]];

    case 'not':
      return convert(node.operand, !negated, maybe);

    case 'maybe':
      // maybe() collapses three-valued to definite, so it cannot be distributed through a
      // surrounding negation without changing meaning (spec §9.4).
      if (negated) throw new Error('a negated maybe(...) has no disjunctive form');
      return convert(node.operand, false, true);

    case 'and':
    case 'or': {
      // De Morgan: under negation, AND and OR swap.
      const effective = negated ? (node.kind === 'and' ? 'or' : 'and') : node.kind;
      const parts = node.operands.map((child) => convert(child, negated, maybe));
      if (effective === 'or') return parts.flat();
      return parts.reduce((acc, part) => acc.flatMap((left) => part.map((right) => [...left, ...right])), [
        [] as Disjunct,
      ]);
    }
  }
}

/** Stable key for comparing two terms across disjuncts. */
export function termKey(term: Term): string {
  const slots = Object.entries(term.cmp.slots)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return `${term.negated ? '!' : ''}${term.maybe ? '~' : ''}${term.cmp.family}(${slots})${term.cmp.op}${JSON.stringify(term.cmp.values)}`;
}

/** Key ignoring the value, so two terms on the same field can be recognised as comparable. */
export function fieldKey(term: Term): string {
  const slots = Object.entries(term.cmp.slots)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return `${term.negated ? '!' : ''}${term.maybe ? '~' : ''}${term.cmp.family}(${slots})${term.cmp.op}`;
}
