import type { RCmp, RNode, RValue } from './ast.js';
import { interval } from './dates.js';
import { coreField, isDescendantOf, organismField, type Schema } from './schema.js';

export { interval };

/**
 * Reference implementation of the semantics in spec §9. The app has no sequence data, so this is
 * not used to answer queries — it exists so the three-valued rules are executable and testable,
 * and so a backend implementer has something unambiguous to compare against.
 */
export type Truth = 'true' | 'false' | 'maybe';

export interface TestRecord {
  organism: string;
  /** Keyed by family plus slot values in declared order, e.g. `nuc.HA.1234`, `collectionDate`. */
  values: Record<string, string | number | boolean | null | undefined>;
  /** Reference states for the reserved `ref` value (spec §10.2). */
  reference?: Record<string, string>;
  /** Keys whose region is not covered, so an absent insertion is unknown rather than absent (§10.2). */
  uncovered?: string[];
}

const IUPAC: Record<string, string[]> = {
  A: ['A'], C: ['C'], G: ['G'], T: ['T'], U: ['T'],
  R: ['A', 'G'], Y: ['C', 'T'], S: ['C', 'G'], W: ['A', 'T'], K: ['G', 'T'], M: ['A', 'C'],
  B: ['C', 'G', 'T'], D: ['A', 'G', 'T'], H: ['A', 'C', 'T'], V: ['A', 'C', 'G'],
  N: ['A', 'C', 'G', 'T'],
  '-': ['-'],
};

export function matches(node: RNode, record: TestRecord, schema: Schema): boolean {
  return evaluate(node, record, schema) === 'true';
}

export function evaluate(node: RNode, record: TestRecord, schema: Schema): Truth {
  switch (node.kind) {
    case 'and': {
      const parts = node.operands.map((o) => evaluate(o, record, schema));
      if (parts.includes('false')) return 'false';
      return parts.includes('maybe') ? 'maybe' : 'true';
    }
    case 'or': {
      const parts = node.operands.map((o) => evaluate(o, record, schema));
      if (parts.includes('true')) return 'true';
      return parts.includes('maybe') ? 'maybe' : 'false';
    }
    case 'not': {
      const inner = evaluate(node.operand, record, schema);
      return inner === 'maybe' ? 'maybe' : inner === 'true' ? 'false' : 'true';
    }
    case 'maybe':
      // Collapses to a definite value, which is why it composes anywhere (spec §9.4).
      return evaluate(node.operand, record, schema) === 'false' ? 'false' : 'true';
    case 'cmp':
      return evaluateCmp(node, record, schema);
  }
}

/** Key a record's values are stored under: family plus slot values in declared order. */
export function recordKey(cmp: { family: string; slots: Record<string, string | number> }): string {
  return [cmp.family, ...Object.values(cmp.slots)].join('.');
}

function evaluateCmp(cmp: RCmp, record: TestRecord, schema: Schema): Truth {
  // An absent field is a definite non-match, not uncertainty (spec §9.1).
  if (cmp.scope.length > 0 && !cmp.scope.includes(record.organism)) return 'false';
  if (!coreField(schema, cmp.family) && !organismField(schema, record.organism, cmp.family)) return 'false';

  const key = recordKey(cmp);
  // `organism` is an ordinary field (spec §7.1), but every record structurally has one, so the
  // record's own organism stands in when it is not listed among the values.
  const stored = cmp.family === 'organism' ? (record.values.organism ?? record.organism) : record.values[key];
  const missing = stored === undefined || stored === null;

  if (cmp.op === 'isNull') return bool(missing === cmp.values[0]);
  if (cmp.op === 'isAmbiguous') {
    if (missing) return 'maybe';
    return bool(candidates(cmp, String(stored)).length > 1 === cmp.values[0]);
  }
  // A missing value's candidate set is the whole domain, so nothing is decided.
  if (missing) return 'maybe';

  switch (cmp.type) {
    case 'date':
      return dateTruth(cmp, String(stored));
    case 'sequenceState':
      return stateTruth(cmp, String(stored), record, key);
    case 'hierarchical':
      return hierarchyTruth(cmp, String(stored), schema);
    case 'integer':
    case 'number':
      return compareTruth(cmp, Number(stored));
    default:
      return stringTruth(cmp, String(stored));
  }
}

/* ----------------------------- the lift (§9.1) ----------------------------- */

/** Candidate set of a stored value: what it could be. */
function candidates(cmp: RCmp, stored: string): string[] {
  if (cmp.type === 'sequenceState') return IUPAC[stored.toUpperCase()] ?? [stored.toUpperCase()];
  if (cmp.type === 'date') {
    const [lo, hi] = interval(stored);
    return lo === hi ? [lo] : [lo, hi]; // only the size matters here
  }
  return [stored];
}

function dateTruth(cmp: RCmp, stored: string): Truth {
  const [lo, hi] = interval(stored);
  const query = String(cmp.values[0]);
  const [qlo, qhi] = interval(query);

  switch (cmp.op) {
    case 'eq':
      if (lo >= qlo && hi <= qhi) return 'true';
      if (hi < qlo || lo > qhi) return 'false';
      return 'maybe';
    case 'ne':
      return flip(dateTruth({ ...cmp, op: 'eq' }, stored));
    case 'ge':
      return lo >= qlo ? 'true' : hi < qlo ? 'false' : 'maybe';
    case 'gt':
      return lo > qhi ? 'true' : hi <= qhi ? 'false' : 'maybe';
    case 'le':
      return hi <= qhi ? 'true' : lo > qhi ? 'false' : 'maybe';
    case 'lt':
      return hi < qlo ? 'true' : lo >= qlo ? 'false' : 'maybe';
    case 'inRange': {
      // Closed interval: the lower bound takes its own lower edge, the upper bound its upper one,
      // so a range of two partial dates spans from the first to the end of the second (§9.2).
      const from = interval(String(cmp.values[0]))[0];
      const to = interval(String(cmp.values[1]))[1];
      if (lo >= from && hi <= to) return 'true';
      if (hi < from || lo > to) return 'false';
      return 'maybe';
    }
    case 'in':
      return anyOf(cmp, (value) => dateTruth({ ...cmp, op: 'eq', values: [value] }, stored));
    case 'out':
      return flip(anyOf(cmp, (value) => dateTruth({ ...cmp, op: 'eq', values: [value] }, stored)));
    default:
      return 'maybe';
  }
}

function stateTruth(cmp: RCmp, stored: string, record: TestRecord, key: string): Truth {
  const observed = IUPAC[stored.toUpperCase()] ?? [stored.toUpperCase()];
  const queryValues = cmp.values.map((v) => {
    if (v === 'ref') return record.reference?.[key];
    return String(v);
  });
  if (queryValues.some((v) => v === undefined)) return 'maybe';
  const query = new Set(queryValues.flatMap((v) => IUPAC[v!.toUpperCase()] ?? [v!.toUpperCase()]));

  const all = observed.every((c) => query.has(c));
  const none = observed.every((c) => !query.has(c));
  switch (cmp.op) {
    case 'eq':
    case 'in':
      return all ? 'true' : none ? 'false' : 'maybe';
    case 'ne':
    case 'out':
      return none ? 'true' : all ? 'false' : 'maybe';
    default:
      return 'maybe';
  }
}

function hierarchyTruth(cmp: RCmp, stored: string, schema: Schema): Truth {
  const def = coreField(schema, cmp.family) ?? organismField(schema, cmp.scope[0] ?? '', cmp.family);
  const hierarchy = schema.hierarchies[def?.hierarchy ?? ''];
  switch (cmp.op) {
    case 'descendantOf':
      if (!hierarchy) return 'maybe';
      return bool(cmp.values.some((v) => isDescendantOf(hierarchy, stored, String(v))));
    case 'eq':
      return bool(stored === String(cmp.values[0]));
    case 'ne':
      return bool(stored !== String(cmp.values[0]));
    case 'in':
      return bool(cmp.values.map(String).includes(stored));
    case 'out':
      return bool(!cmp.values.map(String).includes(stored));
    default:
      return 'maybe';
  }
}

function compareTruth(cmp: RCmp, stored: number): Truth {
  const value = Number(cmp.values[0]);
  switch (cmp.op) {
    case 'eq':
      return bool(stored === value);
    case 'ne':
      return bool(stored !== value);
    case 'lt':
      return bool(stored < value);
    case 'le':
      return bool(stored <= value);
    case 'gt':
      return bool(stored > value);
    case 'ge':
      return bool(stored >= value);
    case 'inRange':
      return bool(stored >= Number(cmp.values[0]) && stored <= Number(cmp.values[1]));
    case 'in':
      return bool(cmp.values.map(Number).includes(stored));
    case 'out':
      return bool(!cmp.values.map(Number).includes(stored));
    default:
      return 'maybe';
  }
}

function stringTruth(cmp: RCmp, stored: string): Truth {
  const test = (value: RValue) => wildcard(String(value)).test(stored);
  switch (cmp.op) {
    case 'eq':
      return bool(test(cmp.values[0]!));
    case 'ne':
      return bool(!test(cmp.values[0]!));
    case 'in':
      return bool(cmp.values.some(test));
    case 'out':
      return bool(!cmp.values.some(test));
    default:
      return 'maybe';
  }
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? ' ' : `\\${c}`));
  return new RegExp(`^${escaped.replace(/ /g, '.*')}$`, 'i');
}

function anyOf(cmp: RCmp, test: (value: RValue) => Truth): Truth {
  const parts = cmp.values.map(test);
  if (parts.includes('true')) return 'true';
  return parts.includes('maybe') ? 'maybe' : 'false';
}

function bool(value: boolean): Truth {
  return value ? 'true' : 'false';
}

function flip(truth: Truth): Truth {
  return truth === 'maybe' ? 'maybe' : truth === 'true' ? 'false' : 'true';
}
