import type { RCmp, RNode, RValue, UNode, USelector, UValue } from './ast.js';
import { interval } from './dates.js';
import type { Diagnostic, Span } from './errors.js';
import { allowedOperators, operator, OPERATORS, type OperatorDef } from './operators.js';
import {
  allFamilies,
  canonicalTaxon,
  coreField,
  type FieldDef,
  narrowByOrganism,
  organismField,
  organismIds,
  type Schema,
  sameShape,
  type SlotDef,
  type TaxonNode,
  taxonExists,
} from './schema.js';

export interface ResolveOptions {
  schema: Schema;
}

export interface ResolveResult {
  /** Null when the query could not be resolved; `diagnostics` then says why. */
  node: RNode | null;
  /** Organisms the query as a whole can match (spec §11.1, derived not authored). */
  scope: string[];
  diagnostics: Diagnostic[];
}

const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const INT_RE = /^-?\d+$/;
const NUM_RE = /^-?\d+(\.\d+)?$/;

export function resolveQuery(ast: UNode | null, opts: ResolveOptions): ResolveResult {
  const { schema } = opts;
  // Scope is carried by the query and nothing else: at the root, every organism in the instance.
  const rootScope = organismIds(schema);
  if (!ast) return { node: null, scope: rootScope, diagnostics: [] };

  const diagnostics: Diagnostic[] = [];
  const ctx: Ctx = { schema, diagnostics };
  const node = resolveNode(ast, rootScope, ctx);
  return { node, scope: effectiveScope(ast, rootScope, schema), diagnostics };
}

interface Ctx {
  schema: Schema;
  diagnostics: Diagnostic[];
}

function error(ctx: Ctx, message: string, span: Span, hint?: string): null {
  ctx.diagnostics.push({ phase: 'resolve', message, span, hint });
  return null;
}

/* ------------------------------------------------------------------ *
 * Scope (spec §7.2)
 * ------------------------------------------------------------------ */

/**
 * Scope is structural: an AND-group's organism constraints narrow every conjunct in that group,
 * whatever the order, and negation does not participate.
 */
function narrowScope(scope: string[], operands: UNode[], schema: Schema): string[] {
  const constraints = operands
    .filter((o) => o.kind === 'cmp' && o.selector.family === 'organism')
    .map((o) => {
      const cmp = o as UNode & { kind: 'cmp' };
      return { op: cmp.op, values: cmp.values.map((v) => v.text) };
    });
  return narrowByOrganism(scope, constraints, schema.organismTaxonomy);
}

/** The organism set the query as a whole can match; unions across OR, opaque through NOT. */
function effectiveScope(node: UNode, scope: string[], schema: Schema): string[] {
  switch (node.kind) {
    case 'and': {
      const narrowed = narrowScope(scope, node.operands, schema);
      return node.operands.reduce((acc, child) => intersect(acc, effectiveScope(child, narrowed, schema)), narrowed);
    }
    case 'or': {
      const union = new Set<string>();
      for (const child of node.operands) for (const id of effectiveScope(child, scope, schema)) union.add(id);
      return scope.filter((id) => union.has(id));
    }
    case 'not':
    case 'maybe':
      return scope;
    case 'cmp':
      return node.selector.family === 'organism' ? narrowScope(scope, [node], schema) : scope;
  }
}

function intersect(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((x) => set.has(x));
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

function resolveNode(node: UNode, scope: string[], ctx: Ctx): RNode | null {
  switch (node.kind) {
    case 'and': {
      const narrowed = narrowScope(scope, node.operands, ctx.schema);
      if (narrowed.length === 0 && scope.length > 0) {
        error(
          ctx,
          'these organism filters cannot be satisfied together',
          node.span,
          'no organism in the instance matches all of them',
        );
      }
      const operands = node.operands.map((o) => resolveNode(o, narrowed, ctx));
      if (operands.some((o) => o === null)) return null;
      return { kind: 'and', operands: operands as RNode[], span: node.span };
    }
    case 'or': {
      const operands = node.operands.map((o) => resolveNode(o, scope, ctx));
      if (operands.some((o) => o === null)) return null;
      return { kind: 'or', operands: operands as RNode[], span: node.span };
    }
    case 'not':
    case 'maybe': {
      const operand = resolveNode(node.operand, scope, ctx);
      if (!operand) return null;
      return { kind: node.kind, operand, span: node.span };
    }
    case 'cmp':
      return resolveCmp(node, scope, ctx);
  }
}

function resolveCmp(node: UNode & { kind: 'cmp' }, scope: string[], ctx: Ctx): RCmp | null {
  const { schema } = ctx;
  const { selector } = node;
  const core = coreField(schema, selector.family);

  let def: FieldDef;
  let slots: Record<string, string | number>;
  let explicitSlots: string[];

  if (core) {
    def = core;
    const assigned = assignSlots(core, selector, scope[0] ?? null, ctx);
    if (!assigned) return null;
    ({ slots, explicitSlots } = assigned);
  } else {
    // Organism-scoped: the field must exist and resolve identically for every organism in
    // scope (spec §7.2). This is the whole cross-organism rule.
    if (scope.length === 0) {
      return error(ctx, `'${selector.family}' needs at least one organism in scope`, selector.span);
    }
    const missing = scope.filter((id) => !organismField(schema, id, selector.family));
    if (missing.length === scope.length) {
      const known = allFamilies(schema).includes(selector.family);
      return error(
        ctx,
        known
          ? `'${selector.family}' is not defined for ${list(scope)}`
          : `unknown field '${selector.family}'`,
        selector.familySpan,
        known ? 'add an organism filter that selects organisms which have it' : suggest(selector.family, allFamilies(schema)),
      );
    }
    if (missing.length > 0) {
      return error(
        ctx,
        `'${selector.family}' is not defined for ${list(missing)}`,
        selector.familySpan,
        `it exists for ${list(scope.filter((id) => !missing.includes(id)))}; narrow the organism filter`,
      );
    }

    const perOrganism = scope.map((id) => ({ id, def: organismField(schema, id, selector.family)! }));
    const head = perOrganism[0]!;
    const divergent = perOrganism.find((o) => !sameShape(head.def, o.def));
    if (divergent) {
      return error(
        ctx,
        `'${selector.family}' does not mean the same thing for ${head.id} and ${divergent.id}`,
        selector.familySpan,
        'narrow the organism filter so the field resolves the same way everywhere',
      );
    }

    const assignments = perOrganism.map((o) => assignSlots(o.def, selector, o.id, ctx));
    if (assignments.some((a) => a === null)) return null;
    const first = assignments[0]!;
    for (let i = 1; i < assignments.length; i++) {
      const other = assignments[i]!;
      if (JSON.stringify(other.slots) !== JSON.stringify(first.slots)) {
        return error(
          ctx,
          `'${selector.family}' resolves differently for ${perOrganism[0]!.id} and ${perOrganism[i]!.id}`,
          selector.span,
          `${describeSlots(first.slots)} vs ${describeSlots(other.slots)}; name the slots explicitly or narrow the organism filter`,
        );
      }
    }
    def = head.def;
    slots = first.slots;
    explicitSlots = first.explicitSlots;
  }

  const opDef = operator(node.op);
  if (!opDef) {
    return error(ctx, `unknown operator '${node.op}'`, node.opSpan, suggest(node.op, Object.keys(OPERATORS)));
  }
  const allowed = allowedOperators(def);
  if (!allowed.some((o) => o.name === opDef.name)) {
    return error(
      ctx,
      `${opDef.spell} does not apply to ${def.type} field '${def.family}'`,
      node.opSpan,
      `try ${allowed.map((o) => o.spell).join(', ')}`,
    );
  }
  if (opDef.list && node.values.length < 1) {
    return error(ctx, `${opDef.spell} needs a value list`, node.span);
  }
  if (!opDef.list && node.values.length > 1) {
    return error(ctx, `${opDef.spell} takes a single value`, node.span, `use ${def.family}=in=(...) for several`);
  }
  if (opDef.arity !== undefined && node.values.length !== opDef.arity) {
    return error(
      ctx,
      `${opDef.spell} takes exactly ${opDef.arity} values`,
      node.span,
      `write ${def.family}${opDef.spell}(low,high)`,
    );
  }

  const values: RValue[] = [];
  for (const raw of node.values) {
    const value = checkValue(def, opDef, raw, ctx);
    if (value === null) return null;
    values.push(value);
  }

  if (opDef.name === 'inRange' && emptyRange(values, def.type)) {
    return error(
      ctx,
      'the lower bound is above the upper bound, so the range is empty',
      node.span,
      `write ${def.family}=inRange=(${String(values[1])},${String(values[0])}) for that span`,
    );
  }

  return {
    kind: 'cmp',
    family: def.family,
    slots,
    op: opDef.name,
    values,
    type: def.type,
    scope: core ? [] : scope.slice(),
    explicitSlots,
    source: node,
    span: node.span,
  };
}

/* ------------------------------------------------------------------ *
 * Slots (spec §8.2)
 * ------------------------------------------------------------------ */

interface Assignment {
  slots: Record<string, string | number>;
  explicitSlots: string[];
}

function candidates(slot: SlotDef): string[] | null {
  return slot.kind === 'pos' ? null : (slot.values ?? []);
}

function accepts(slot: SlotDef, text: string): boolean {
  if (slot.kind === 'pos') return INT_RE.test(text);
  return (slot.values ?? []).includes(text);
}

function assignSlots(def: FieldDef, selector: USelector, organism: string | null, ctx: Ctx): Assignment | null {
  const slots = def.slots ?? [];

  if (selector.kwargs) {
    const out: Record<string, string | number> = {};
    const explicit: string[] = [];
    for (const kw of selector.kwargs) {
      const slot = slots.find((s) => s.name === kw.name);
      if (!slot) {
        return error(
          ctx,
          `'${def.family}' has no slot '${kw.name}'`,
          kw.span,
          slots.length ? `slots are ${slots.map((s) => s.name).join(', ')}` : 'it takes no slots',
        );
      }
      if (!accepts(slot, kw.value)) {
        return error(ctx, `'${kw.value}' is not a valid ${kw.name}${forOrganism(organism)}`, kw.span, validValues(slot));
      }
      out[slot.name] = slot.kind === 'pos' ? Number(kw.value) : kw.value;
      explicit.push(slot.name);
    }
    for (const slot of slots) {
      if (slot.name in out) continue;
      const implied = implicitValue(slot);
      if (implied === null) {
        return error(ctx, `'${def.family}' needs a ${slot.name}${forOrganism(organism)}`, selector.span, validValues(slot));
      }
      out[slot.name] = implied;
    }
    return { slots: order(slots, out), explicitSlots: explicit };
  }

  const quals = selector.qualifiers;
  if (slots.length === 0 && quals.length > 0) {
    return error(ctx, `'${def.family}' takes no slots`, quals[0]!.span);
  }

  // Rule 4: never guess. A qualifier that could fill more than one slot is an error, and so is one
  // that fills none.
  for (const q of quals) {
    const fits = slots.filter((s) => accepts(s, q.text));
    if (fits.length === 0) {
      return error(
        ctx,
        `'${q.text}' is not a valid ${slots.map((s) => s.name).join(' or ')}${forOrganism(organism)}`,
        q.span,
        slots.map(validValues).filter(Boolean).join(' · ') || undefined,
      );
    }
    if (fits.length > 1) {
      return error(
        ctx,
        `'${q.text}' is ambiguous: it could be the ${fits.map((s) => s.name).join(' or the ')}`,
        q.span,
        `name the slots: ${def.family}(${fits.map((s) => `${s.name}=${q.text}`).join(' / ')}, ...)`,
      );
    }
  }

  const out: Record<string, string | number> = {};
  const explicit: string[] = [];
  let qi = quals.length - 1;
  for (let si = slots.length - 1; si >= 0; si--) {
    const slot = slots[si]!;
    const q = qi >= 0 ? quals[qi]! : undefined;
    if (q && accepts(slot, q.text)) {
      out[slot.name] = slot.kind === 'pos' ? Number(q.text) : q.text;
      explicit.push(slot.name);
      qi--;
      continue;
    }
    const implied = implicitValue(slot);
    if (implied === null) {
      return error(
        ctx,
        `'${def.family}' needs a ${slot.name}${forOrganism(organism)}`,
        selector.span,
        validValues(slot) ?? `write ${def.family}(${slot.name}=...,...)`,
      );
    }
    out[slot.name] = implied;
  }
  if (qi >= 0) {
    return error(ctx, `too many slots for '${def.family}'`, quals[qi]!.span, `it takes ${slots.map((s) => s.name).join(', ')}`);
  }
  return { slots: order(slots, out), explicitSlots: explicit };
}

/** A slot may be omitted when it has a declared default, or exactly one candidate (spec §8.2). */
function implicitValue(slot: SlotDef): string | number | null {
  if (slot.default !== undefined) return slot.kind === 'pos' ? Number(slot.default) : slot.default;
  const cands = candidates(slot);
  if (cands && cands.length === 1) return cands[0]!;
  return null;
}

function order(slots: SlotDef[], values: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const slot of slots) if (slot.name in values) out[slot.name] = values[slot.name]!;
  return out;
}

/* ------------------------------------------------------------------ *
 * Values
 * ------------------------------------------------------------------ */

function checkValue(def: FieldDef, opDef: OperatorDef, raw: UValue, ctx: Ctx): RValue | null {
  const text = raw.text;

  if (opDef.booleanArg) {
    if (text !== 'true' && text !== 'false') {
      return error(ctx, `${opDef.spell} takes true or false`, raw.span);
    }
    return text === 'true';
  }

  if (def.pattern && !new RegExp(def.pattern).test(text)) {
    return error(ctx, `'${text}' is not a valid value for '${def.family}'`, raw.span, `expected ${def.pattern}`);
  }

  switch (def.type) {
    case 'integer':
      if (!INT_RE.test(text)) return error(ctx, `'${text}' is not a whole number`, raw.span);
      return Number(text);
    case 'number':
      if (!NUM_RE.test(text)) return error(ctx, `'${text}' is not a number`, raw.span);
      return Number(text);
    case 'boolean':
      if (text !== 'true' && text !== 'false') return error(ctx, `'${text}' is not true or false`, raw.span);
      return text === 'true';
    case 'date':
      if (!validDate(text)) {
        return error(ctx, `'${text}' is not a date`, raw.span, 'dates are YYYY, YYYY-MM, or YYYY-MM-DD');
      }
      return text;
    case 'enum': {
      if (text.includes('*')) return text; // wildcards bypass the value list
      const values = def.values ?? [];
      const hit = def.caseSensitive
        ? values.find((v) => v === text)
        : values.find((v) => v.toLowerCase() === text.toLowerCase());
      if (!hit) return error(ctx, `'${text}' is not a known ${def.family}`, raw.span, suggest(text, values));
      return hit;
    }
    case 'hierarchical': {
      const hierarchy = ctx.schema.hierarchies[def.hierarchy ?? ''];
      if (!hierarchy) return text;
      const canonical = canonicalTaxon(hierarchy, text);
      if (!taxonExists(hierarchy.roots, canonical)) {
        return error(ctx, `'${text}' is not a known ${def.family}`, raw.span, suggest(text, Object.keys(hierarchy.aliases ?? {})));
      }
      // `==` on a taxon group would match nothing, since records carry leaves.
      if ((opDef.name === 'eq' || opDef.name === 'in') && hasChildren(hierarchy.roots, canonical)) {
        error(
          ctx,
          `'${text}' is a group, not a single ${def.family}`,
          raw.span,
          `use ${def.family}=descendantOf=${text} to include everything below it`,
        );
        return null;
      }
      return canonical;
    }
    case 'sequenceState': {
      if (!raw.quoted && text === 'ref') return 'ref'; // reserved value (spec §10.2)
      if (!/^[A-Za-z*-]$/.test(text)) {
        return error(ctx, `'${text}' is not a single sequence state`, raw.span, "one letter, '-' for a deletion, or ref");
      }
      return text.toUpperCase();
    }
    default:
      return text;
  }
}

/** `=inRange=` is the closed interval `a =le= x =le= b`, so bounds in the wrong order match nothing. */
function emptyRange(values: RValue[], type: FieldDef['type']): boolean {
  const [low, high] = values;
  if (low === undefined || high === undefined) return false;
  if (type === 'date') return interval(String(low))[0] > interval(String(high))[1];
  return Number(low) > Number(high);
}

function validDate(text: string): boolean {
  const m = DATE_RE.exec(text);
  if (!m) return false;
  const [, y, mo, d] = m;
  if (mo !== undefined) {
    const month = Number(mo);
    if (month < 1 || month > 12) return false;
    if (d !== undefined) {
      const day = Number(d);
      const last = new Date(Date.UTC(Number(y), month, 0)).getUTCDate();
      if (day < 1 || day > last) return false;
    }
  }
  return true;
}

function hasChildren(roots: TaxonNode[], id: string): boolean {
  const find = (nodes: TaxonNode[]): boolean => {
    for (const n of nodes) {
      if (n.id === id) return (n.children?.length ?? 0) > 0;
      if (n.children && find(n.children)) return true;
    }
    return false;
  };
  return find(roots);
}

/* ------------------------------------------------------------------ */

function list(ids: string[]): string {
  if (ids.length <= 2) return ids.join(' and ');
  return `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
}

function forOrganism(organism: string | null): string {
  return organism ? ` for ${organism}` : '';
}

function validValues(slot: SlotDef): string | undefined {
  const cands = candidates(slot);
  if (!cands || cands.length === 0) return undefined;
  const shown = cands.slice(0, 8).join(', ');
  return `${slot.name} is one of ${shown}${cands.length > 8 ? ', …' : ''}`;
}

function describeSlots(slots: Record<string, string | number>): string {
  const entries = Object.entries(slots);
  return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(',') : 'no slots';
}

/** Cheap edit-distance suggestion, for typos. */
function suggest(input: string, options: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const option of options) {
    const score = distance(input.toLowerCase(), option.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = option;
    }
  }
  if (best === undefined || bestScore > Math.max(2, Math.floor(input.length / 3))) return undefined;
  return `did you mean '${best}'?`;
}

function distance(a: string, b: string): number {
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        rows[i - 1]![j]! + 1,
        row[j - 1]! + 1,
        rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    rows.push(row);
  }
  return rows[a.length]![b.length]!;
}
