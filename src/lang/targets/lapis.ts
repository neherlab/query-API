import type { RNode } from '../ast.js';
import { type Disjunct, fieldKey, type Term, termKey, toDnf } from '../dnf.js';
import { narrowByOrganism, type OrganismConstraint, type Schema } from '../schema.js';

/**
 * LAPIS adapter (spec §11.2). A target, not the definition of anything: it declares what it cannot
 * express and never constrains the language.
 *
 * The parameter names follow LAPIS's documented shape — conjunctive metadata filters,
 * `<field>From`/`<field>To` for ranges, mutation arrays, and a variant query for boolean structure
 * over mutations. Spec §15.2 is still open: verify these against a live instance before trusting
 * the bodies. The classification does not depend on the names being right.
 *
 * LAPIS selects the organism per request, so `organism` terms are never filters here: each plan's
 * own organism terms decide which requests it fans out to (§11.2).
 */

export type LapisClass = 'A' | 'B' | 'C' | 'D' | 'E';

export interface LapisRequest {
  organism: string;
  body: Record<string, unknown>;
}

export interface LapisTranslation {
  klass: LapisClass;
  summary: string;
  requests: LapisRequest[];
  warnings: string[];
  /** True when the query is well-formed but this backend cannot run it. */
  unsupported: boolean;
}

/** One request's worth of work: a conjunction of metadata, and a disjunction of mutation conjunctions. */
interface Plan {
  metadata: Term[];
  mutations: Term[][];
}

const MUTATION_FAMILIES = new Set(['nuc', 'aa', 'nuc_ins', 'aa_ins']);

export function toLapis(node: RNode | null, scope: string[], schema: Schema): LapisTranslation {
  const organisms = scope.length > 0 ? scope : ['*'];

  if (!node) {
    return {
      klass: 'A',
      summary: `Class A — one request${organisms.length > 1 ? ` per organism (${organisms.length})` : ''}, no filters.`,
      requests: organisms.map((organism) => ({ organism, body: {} })),
      warnings: [],
      unsupported: false,
    };
  }

  const { disjuncts, reason } = toDnf(node);
  if (!disjuncts) {
    return {
      klass: 'E',
      summary: `Class E — not expressible: ${reason}.`,
      requests: [],
      warnings: [reason ?? 'no disjunctive normal form'],
      unsupported: true,
    };
  }

  const warnings: string[] = [];
  const { klass, plans } = classify(disjuncts);

  if (klass === 'E') {
    return {
      klass,
      summary: 'Class E — the OR crosses the metadata/mutation boundary; not expressible.',
      requests: [],
      warnings: ['an OR whose branches differ in both metadata and mutations cannot be split'],
      unsupported: true,
    };
  }

  const requests: LapisRequest[] = [];
  for (const plan of plans) {
    for (const organism of planOrganisms(plan, organisms, schema, warnings)) {
      requests.push({ organism, body: buildBody(plan, warnings) });
    }
  }

  const blocked = warnings.some((w) => w.startsWith('cannot express'));
  return {
    klass: blocked ? 'E' : klass,
    summary: blocked
      ? 'Class E — well-formed, but this backend cannot express every filter.'
      : summarize(klass, requests.length, plans.length, organisms.length),
    requests: blocked ? [] : requests,
    warnings: dedupe(warnings),
    unsupported: blocked,
  };
}

/* ------------------------------ classification ------------------------------ */

function classify(disjuncts: Disjunct[]): { klass: LapisClass; plans: Plan[] } {
  const split = disjuncts.map((d) => ({
    metadata: d.filter((t) => !isMutation(t)),
    mutations: d.filter((t) => isMutation(t)),
  }));

  if (split.length === 1) {
    const only = split[0]!;
    return { klass: 'A', plans: [{ metadata: only.metadata, mutations: [only.mutations] }] };
  }

  const metadataSame = allEqual(split.map((s) => signature(s.metadata)));
  const mutationsSame = allEqual(split.map((s) => signature(s.mutations)));

  // Class C: the boolean structure is confined to the mutation subtree, which the variant query
  // can express — so the disjunction is kept, not flattened into a conjunction.
  if (metadataSame && !mutationsSame) {
    return {
      klass: 'C',
      plans: [{ metadata: split[0]!.metadata, mutations: split.map((s) => s.mutations) }],
    };
  }

  // Class B: identical except for one field, whose values collapse into a list.
  if (mutationsSame) {
    const merged = mergeSingleField(split.map((s) => s.metadata));
    if (merged) return { klass: 'B', plans: [{ metadata: merged, mutations: [split[0]!.mutations] }] };
  }

  if (!metadataSame && !mutationsSame) return { klass: 'E', plans: [] };

  return {
    klass: 'D',
    plans: split.map((s) => ({ metadata: s.metadata, mutations: [s.mutations] })),
  };
}

/**
 * When every disjunct is identical except for the value of one field, LAPIS's within-field OR
 * covers it. Returns the merged conjunction, or null if more than one field varies.
 */
function mergeSingleField(metadata: Term[][]): Term[] | null {
  const head = metadata[0]!;
  const varying = new Set<string>();
  for (const disjunct of metadata) {
    if (disjunct.length !== head.length) return null;
    for (const term of disjunct) {
      const twin = head.find((t) => fieldKey(t) === fieldKey(term));
      if (!twin) return null;
      if (termKey(twin) !== termKey(term)) varying.add(fieldKey(term));
    }
  }
  if (varying.size !== 1) return null;

  const key = [...varying][0]!;
  // Only equality-shaped terms fold into LAPIS's within-field OR. Bounds and ranges would change
  // meaning if their values were merged into a list, so they fall through to class D instead.
  const foldable = (term: Term) => term.cmp.op === 'eq' || term.cmp.op === 'in';
  if (metadata.some((d) => d.some((t) => fieldKey(t) === key && !foldable(t)))) return null;

  return head.map((term) => {
    if (fieldKey(term) !== key) return term;
    const values = metadata.flatMap((d) => d.filter((t) => fieldKey(t) === key).flatMap((t) => t.cmp.values));
    return { ...term, cmp: { ...term.cmp, op: 'in', values: dedupe(values.map(String)) } };
  });
}

function summarize(klass: LapisClass, requests: number, plans: number, organisms: number): string {
  const count = requests === 1 ? 'one request' : `${requests} requests`;
  const fan = organisms > 1 ? ` across ${organisms} organisms` : '';
  switch (klass) {
    case 'A':
      return `Class A — ${count}${fan}.`;
    case 'B':
      return `Class B — ${count}${fan}; the OR collapsed into a value list.`;
    case 'C':
      return `Class C — ${count}${fan}; mutation logic goes in the variant query.`;
    case 'D':
      return `Class D — ${count} (${plans} disjuncts${fan}). Correct for accession lists after de-duplication, WRONG for counts.`;
    default:
      return 'Class E — not expressible.';
  }
}

/**
 * The organisms a plan's requests go to: the query's scope, narrowed by the plan's own organism
 * terms. A negated or `maybe` organism term has no reading as a request selector — the request
 * either goes to an organism or it does not — so it is reported rather than approximated.
 */
function planOrganisms(plan: Plan, organisms: string[], schema: Schema, warnings: string[]): string[] {
  // The unresolved case, where there is no scope to narrow.
  if (organisms.length === 1 && organisms[0] === '*') return organisms;

  const constraints: OrganismConstraint[] = [];
  for (const term of plan.metadata) {
    if (term.cmp.family !== 'organism') continue;
    if (term.negated || term.maybe) {
      warnings.push(`cannot express ${term.negated ? 'a negated' : 'a maybe()'} organism filter`);
      continue;
    }
    constraints.push({ op: term.cmp.op, values: term.cmp.values.map(String) });
  }
  return narrowByOrganism(organisms, constraints, schema.organismTaxonomy);
}

/* -------------------------------- request body -------------------------------- */

function buildBody(plan: Plan, warnings: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  for (const term of plan.metadata) {
    const { cmp, negated, maybe } = term;
    // Consumed by the request's organism selector, not a filter (see planOrganisms).
    if (cmp.family === 'organism') continue;
    if (negated) {
      warnings.push(`cannot express a negated filter on '${cmp.family}'`);
      continue;
    }
    const field = cmp.family;
    switch (cmp.op) {
      case 'eq':
        body[field] = cmp.values[0];
        break;
      case 'in':
        body[field] = cmp.values;
        break;
      case 'ge':
        body[`${field}From`] = cmp.values[0];
        break;
      case 'le':
        body[`${field}To`] = cmp.values[0];
        break;
      case 'inRange':
        body[`${field}From`] = cmp.values[0];
        body[`${field}To`] = cmp.values[1];
        break;
      case 'gt':
        body[`${field}From`] = cmp.values[0];
        warnings.push(`'${field}' uses an exclusive bound, approximated by an inclusive From`);
        break;
      case 'lt':
        body[`${field}To`] = cmp.values[0];
        warnings.push(`'${field}' uses an exclusive bound, approximated by an inclusive To`);
        break;
      case 'descendantOf':
        body[field] = `${cmp.values[0]}*`;
        break;
      default:
        warnings.push(`cannot express '${field}' with ${cmp.op}`);
        break;
    }
    if (maybe) {
      warnings.push(`maybe() on '${field}' is not expressible; the request is stricter than the query`);
    }
  }

  const conjunctions = plan.mutations.filter((terms) => terms.length > 0);
  if (conjunctions.length === 0) return body;

  // A single conjunction of plain mutations fits the dedicated arrays; anything else — a
  // disjunction, a negation, or maybe() — needs the variant query.
  const plain =
    conjunctions.length === 1 && conjunctions[0]!.every((t) => !t.negated && !t.maybe && mutationText(t) !== null);

  if (plain) {
    for (const term of conjunctions[0]!) {
      const key = arrayFor(term.cmp.family);
      const existing = (body[key] as string[] | undefined) ?? [];
      existing.push(mutationText(term)!);
      body[key] = existing;
    }
    return body;
  }

  const parts: string[] = [];
  for (const conjunction of conjunctions) {
    const literals: string[] = [];
    for (const term of conjunction) {
      const text = mutationText(term);
      if (!text) {
        warnings.push(`cannot express ${term.cmp.family} with ${term.cmp.op}`);
        continue;
      }
      literals.push(`${term.negated ? '!' : ''}${term.maybe ? `maybe(${text})` : text}`);
    }
    if (literals.length > 0) parts.push(literals.length > 1 ? `(${literals.join(' & ')})` : literals[0]!);
  }
  if (parts.length > 0) body.variantQuery = parts.join(' | ');
  return body;
}

function arrayFor(family: string): string {
  switch (family) {
    case 'nuc':
      return 'nucleotideMutations';
    case 'aa':
      return 'aminoAcidMutations';
    case 'nuc_ins':
      return 'nucleotideInsertions';
    default:
      return 'aminoAcidInsertions';
  }
}

function mutationText(term: Term): string | null {
  const { cmp } = term;
  if (cmp.op !== 'eq') return null;
  const value = String(cmp.values[0]);
  if (value === 'ref') return null;
  const pos = cmp.slots.pos;
  const context = cmp.slots.cds ?? cmp.slots.seg;
  if (cmp.family === 'nuc' || cmp.family === 'aa') {
    return context ? `${context}:${pos}${value}` : `${pos}${value}`;
  }
  return context ? `ins_${context}:${pos}:${value}` : `ins_${pos}:${value}`;
}

/* ---------------------------------- helpers ---------------------------------- */

function isMutation(term: Term): boolean {
  return MUTATION_FAMILIES.has(term.cmp.family);
}

function signature(terms: Term[]): string {
  return terms.map(termKey).sort().join('&');
}

function allEqual(items: string[]): boolean {
  return items.every((item) => item === items[0]);
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
