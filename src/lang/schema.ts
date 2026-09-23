/**
 * Schema model (spec §6, §7.1, §8.1).
 *
 * The language knows nothing about any particular field, operator, or organism; everything here is
 * data. A deployment supplies its own schema document — see `src/schema/` for the bundled demo and
 * for the loader. Where this comes from in production is open question §15.2.
 */

export type TypeName =
  | 'string'
  | 'enum'
  | 'integer'
  | 'number'
  | 'date'
  | 'boolean'
  | 'hierarchical'
  | 'sequenceState';

export type SlotKind = 'ref' | 'seg' | 'cds' | 'pos';

export interface SlotDef {
  name: string;
  kind: SlotKind;
  /** Permitted values, for everything except `pos`. */
  values?: string[];
  /** When present, the slot may always be omitted (spec §8.3). */
  default?: string;
}

export interface FieldDef {
  family: string;
  type: TypeName;
  label?: string;
  description?: string;
  /** Ordered; positional form renders and resolves in this order (spec §8.1). */
  slots?: SlotDef[];
  /** For `enum`. */
  values?: string[];
  /** For `hierarchical`: a key into `Schema.hierarchies`. */
  hierarchy?: string;
  /** Defaults to false for `enum`, true for identifiers and sequence states (spec §5.4). */
  caseSensitive?: boolean;
  /** Extra value constraint, e.g. the inserted sequence of `nuc_ins`. */
  pattern?: string;
  /** Overrides the type's default operator set (spec §10). */
  ops?: string[];
}

export interface TaxonNode {
  id: string;
  label?: string;
  children?: TaxonNode[];
}

export interface Hierarchy {
  id: string;
  label?: string;
  roots: TaxonNode[];
  /** Alias → canonical id, resolved before matching (spec §10.1). */
  aliases?: Record<string, string>;
}

export interface OrganismDef {
  id: string;
  label: string;
  fields: FieldDef[];
}

export interface Schema {
  schemaVersion: string;
  label?: string;
  coreFields: FieldDef[];
  organisms: OrganismDef[];
  /** Leaves must be organism ids; internal nodes are groups usable with `=descendantOf=`. */
  organismTaxonomy: TaxonNode[];
  hierarchies: Record<string, Hierarchy>;
}

/* ------------------------------------------------------------------ */

export function organismIds(schema: Schema): string[] {
  return schema.organisms.map((o) => o.id);
}

export function coreField(schema: Schema, family: string): FieldDef | undefined {
  return schema.coreFields.find((f) => f.family === family);
}

export function organismField(schema: Schema, organism: string, family: string): FieldDef | undefined {
  return schema.organisms.find((o) => o.id === organism)?.fields.find((f) => f.family === family);
}

/** Every family the schema defines anywhere, for "unknown field" diagnostics and autocomplete. */
export function allFamilies(schema: Schema): string[] {
  const names = new Set(schema.coreFields.map((f) => f.family));
  for (const org of schema.organisms) for (const f of org.fields) names.add(f.family);
  return [...names].sort();
}

/** Families usable across an entire scope: core fields, plus organism fields usable in all of them. */
export function familiesInScope(schema: Schema, scope: string[]): FieldDef[] {
  const out = schema.coreFields.slice();
  if (scope.length === 0) return out;
  const first = schema.organisms.find((o) => o.id === scope[0]);
  if (!first) return out;
  for (const field of first.fields) {
    const scoped = scopedField(schema, field.family, scope);
    if (scoped) out.push(scoped);
  }
  return out;
}

/**
 * A field as it can be used across a whole scope, with each slot narrowed to the candidates the
 * scope shares — or undefined when no constraint on it could resolve identically (spec §7.2).
 *
 * Matching slot names are not enough: a genome field needs a reference, and references are declared
 * per organism, so `nuc` drops out of a multi-subtype scope even though every subtype has it. A
 * segment slot whose values merely differ survives on the intersection, since `length.HA` resolves
 * identically wherever HA exists.
 */
export function scopedField(schema: Schema, family: string, scope: string[]): FieldDef | undefined {
  const core = coreField(schema, family);
  if (core) return core;
  if (scope.length === 0) return undefined;

  const defs: FieldDef[] = [];
  for (const id of scope) {
    const def = organismField(schema, id, family);
    if (!def) return undefined;
    defs.push(def);
  }
  const head = defs[0]!;
  if (!defs.every((def) => sameShape(head, def))) return undefined;
  if (!head.slots) return head;

  const slots: SlotDef[] = [];
  for (const [i, slot] of head.slots.entries()) {
    const candidates = defs.map((def) => def.slots![i]!.values);
    if (slot.kind === 'pos' || candidates.some((values) => values === undefined)) {
      slots.push(slot);
      continue;
    }
    const shared = candidates[0]!.filter((value) => candidates.every((values) => values!.includes(value)));
    if (shared.length === 0) return undefined;
    const next: SlotDef = { name: slot.name, kind: slot.kind, values: shared };
    // A default only survives if every organism declares the same one, and it is still a candidate.
    if (
      slot.default !== undefined &&
      shared.includes(slot.default) &&
      defs.every((def) => def.slots![i]!.default === slot.default)
    ) {
      next.default = slot.default;
    }
    slots.push(next);
  }
  return { ...head, slots };
}

/** Whether two definitions of the same family agree well enough to be used across a scope (§7.2). */
export function sameShape(a: FieldDef, b: FieldDef): boolean {
  if (a.type !== b.type) return false;
  const as = a.slots ?? [];
  const bs = b.slots ?? [];
  if (as.length !== bs.length) return false;
  return as.every((slot, i) => slot.name === bs[i]!.name && slot.kind === bs[i]!.kind);
}

/* ------------------------------ the scope rule ------------------------------ */

/** One organism constraint, normalised away from whichever tree it came out of. */
export interface OrganismConstraint {
  op: string;
  values: string[];
}

/**
 * The narrowing step of the scope rule (spec §7.2): the organism constraints of a single
 * AND-group, applied to the scope that group inherits. Operators that do not constrain
 * membership — `isNull` and friends — narrow nothing.
 *
 * The one implementation of the rule. Resolution, and any target that has to decide which
 * organisms a request covers, go through here.
 */
export function narrowByOrganism(
  scope: string[],
  constraints: OrganismConstraint[],
  taxonomy: TaxonNode[],
): string[] {
  let out = scope;
  for (const { op, values } of constraints) {
    switch (op) {
      case 'eq':
        out = out.filter((id) => id === values[0]);
        break;
      case 'ne':
        out = out.filter((id) => id !== values[0]);
        break;
      case 'in':
        out = out.filter((id) => values.includes(id));
        break;
      case 'out':
        out = out.filter((id) => !values.includes(id));
        break;
      case 'descendantOf': {
        const under = new Set(values.flatMap((v) => leavesUnder(taxonomy, v)));
        out = out.filter((id) => under.has(id));
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/* --------------------------- taxonomy/hierarchy --------------------------- */

export function findTaxon(roots: TaxonNode[], id: string): TaxonNode | undefined {
  for (const node of roots) {
    if (node.id === id) return node;
    const hit = node.children ? findTaxon(node.children, id) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

export function taxonExists(roots: TaxonNode[], id: string): boolean {
  return findTaxon(roots, id) !== undefined;
}

/** Leaves at or below `id`. For the organism taxonomy these are the organisms holding data. */
export function leavesUnder(roots: TaxonNode[], id: string): string[] {
  const node = findTaxon(roots, id);
  if (!node) return [];
  const out: string[] = [];
  const visit = (n: TaxonNode) => {
    if (!n.children || n.children.length === 0) out.push(n.id);
    else n.children.forEach(visit);
  };
  visit(node);
  return out;
}

export function allTaxa(roots: TaxonNode[]): string[] {
  const out: string[] = [];
  const visit = (n: TaxonNode) => {
    out.push(n.id);
    n.children?.forEach(visit);
  };
  roots.forEach(visit);
  return out;
}

/** Aliases resolve before matching, so query and stored value need not agree in form (§10.1). */
export function canonicalTaxon(hierarchy: Hierarchy, id: string): string {
  return hierarchy.aliases?.[id] ?? id;
}

/** Inclusive, per spec §10: a node is its own descendant. */
export function isDescendantOf(hierarchy: Hierarchy, candidate: string, ancestor: string): boolean {
  const from = canonicalTaxon(hierarchy, ancestor);
  const target = canonicalTaxon(hierarchy, candidate);
  const node = findTaxon(hierarchy.roots, from);
  if (!node) return false;
  let found = false;
  const visit = (n: TaxonNode) => {
    if (n.id === target) found = true;
    n.children?.forEach(visit);
  };
  visit(node);
  return found;
}
