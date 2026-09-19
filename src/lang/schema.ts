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

/** Families usable across an entire scope: core fields, plus organism fields present in all of them. */
export function familiesInScope(schema: Schema, scope: string[]): FieldDef[] {
  const out = schema.coreFields.slice();
  if (scope.length === 0) return out;
  const first = schema.organisms.find((o) => o.id === scope[0]);
  if (!first) return out;
  for (const field of first.fields) {
    const everywhere = scope.every((id) => {
      const other = organismField(schema, id, field.family);
      return other !== undefined && sameShape(field, other);
    });
    if (everywhere) out.push(field);
  }
  return out;
}

/** Whether two definitions of the same family agree well enough to be used across a scope (§7.2). */
export function sameShape(a: FieldDef, b: FieldDef): boolean {
  if (a.type !== b.type) return false;
  const as = a.slots ?? [];
  const bs = b.slots ?? [];
  if (as.length !== bs.length) return false;
  return as.every((slot, i) => slot.name === bs[i]!.name && slot.kind === bs[i]!.kind);
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
