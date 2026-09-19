import type { RCmp, RNode, RValue } from './ast.js';
import { spell } from './operators.js';
import { coreField, leavesUnder, organismField, organismIds, type Schema, type SlotDef } from './schema.js';

/** Spec §13. `readable` is display-only and is *not* URL-safe. */
export type Style = 'strict' | 'minimal' | 'readable';

export interface RenderOptions {
  schema: Schema;
  /** The organism the app is pinned to, which `minimal` may leave implicit. */
  pinned?: string | null;
  /** Derived scope from resolution, which `strict` pins explicitly. */
  scope: string[];
}

const BARE_SAFE = /^[A-Za-z0-9._~:@*-]+$/;

const PREC = { or: 1, and: 2, unary: 3, atom: 4 } as const;

export function render(node: RNode | null, style: Style, opts: RenderOptions): string {
  if (!node) return '';
  const body = renderNode(node, style, opts, PREC.or);
  if (style !== 'strict') return body;

  // Strict is self-contained: if the string alone would not reproduce the scope it resolved
  // against, pin the scope explicitly (spec §13).
  const all = organismIds(opts.schema);
  const implied = scopeOf(node, all, opts.schema);
  if (sameSet(implied, opts.scope)) return body;
  const pin =
    opts.scope.length === 1
      ? `organism==${quote(opts.scope[0]!)}`
      : `organism=in=(${opts.scope.map(quote).join(',')})`;
  const wrapped = node.kind === 'or' ? `(${body})` : body;
  return body === '' ? pin : `${pin};${wrapped}`;
}

function renderNode(node: RNode, style: Style, opts: RenderOptions, parentPrec: number): string {
  switch (node.kind) {
    case 'and':
    case 'or': {
      const prec = node.kind === 'and' ? PREC.and : PREC.or;
      const operands = node.operands
        .filter((child) => !droppable(child, style, opts))
        .map((child) => renderNode(child, style, opts, prec));
      if (operands.length === 0) return '';
      if (operands.length === 1) return operands[0]!;
      const joined = operands.join(node.kind === 'and' ? ';' : ',');
      return prec < parentPrec ? `(${joined})` : joined;
    }
    case 'not': {
      const inner = renderNode(node.operand, style, opts, PREC.unary);
      const needsParens = node.operand.kind === 'and' || node.operand.kind === 'or';
      return `!${needsParens ? `(${inner})` : inner}`;
    }
    case 'maybe':
      return `maybe(${renderNode(node.operand, style, opts, PREC.or)})`;
    case 'cmp':
      return renderCmp(node, style, opts);
  }
}

/** Minimal drops a top-level organism pin the app context already supplies (spec §13). */
function droppable(node: RNode, style: Style, opts: RenderOptions): boolean {
  if (style === 'strict' || !opts.pinned) return false;
  return (
    node.kind === 'cmp' &&
    node.family === 'organism' &&
    node.op === 'eq' &&
    node.values.length === 1 &&
    String(node.values[0]) === opts.pinned
  );
}

function renderCmp(node: RCmp, style: Style, opts: RenderOptions): string {
  const def = fieldDef(node, opts.schema);
  const slots = def?.slots ?? [];
  const selector = renderSelector(node, slots, style);
  const op = spell(node.op, style === 'readable');
  const values = node.values.map((v) => renderValue(v, node, style));
  const arg = values.length > 1 ? `(${values.join(',')})` : values[0] ?? '';
  return `${selector}${op}${arg}`;
}

function renderSelector(node: RCmp, slots: SlotDef[], style: Style): string {
  if (slots.length === 0) return node.family;

  const kept = slots.filter((slot) => {
    if (style === 'strict') return true;
    return !inferable(slot, node.slots[slot.name]);
  });
  if (kept.length === 0) return node.family;

  // Positional form is only safe while each value belongs to exactly one slot; otherwise fall
  // back to keyword form (spec §8.1, decision 5).
  const ambiguous = kept.some((slot) => {
    const value = String(node.slots[slot.name]);
    return slots.filter((other) => accepts(other, value)).length > 1;
  });
  if (ambiguous) {
    return `${node.family}(${kept.map((slot) => `${slot.name}=${node.slots[slot.name]}`).join(',')})`;
  }
  return [node.family, ...kept.map((slot) => String(node.slots[slot.name]))].join('.');
}

function inferable(slot: SlotDef, value: string | number | undefined): boolean {
  if (value === undefined) return true;
  if (slot.default !== undefined) return String(slot.default) === String(value);
  if (slot.kind === 'pos') return false;
  const values = slot.values ?? [];
  return values.length === 1 && values[0] === String(value);
}

function accepts(slot: SlotDef, text: string): boolean {
  if (slot.kind === 'pos') return /^-?\d+$/.test(text);
  return (slot.values ?? []).includes(text);
}

function renderValue(value: RValue, node: RCmp, style: Style): string {
  if (typeof value === 'boolean') return style === 'strict' ? quote(String(value)) : String(value);
  if (typeof value === 'number') return style === 'strict' ? quote(String(value)) : String(value);
  // `ref` is a reserved bare word; quoting it would turn it into a literal (spec §10.2).
  if (node.type === 'sequenceState' && value === 'ref') return 'ref';
  if (style === 'strict') return quote(value);
  return BARE_SAFE.test(value) ? value : quote(value);
}

function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function fieldDef(node: RCmp, schema: Schema) {
  const core = coreField(schema, node.family);
  if (core) return core;
  const organism = node.scope[0];
  return organism ? organismField(schema, organism, node.family) : undefined;
}

/* --------------------------------------------------------------- */

/** Scope implied by a resolved tree on its own, mirroring resolve.ts over RNode (spec §7.2). */
export function scopeOf(node: RNode, scope: string[], schema: Schema): string[] {
  switch (node.kind) {
    case 'and': {
      const narrowed = narrow(scope, node.operands, schema);
      return node.operands.reduce((acc, child) => {
        const childScope = scopeOf(child, narrowed, schema);
        return acc.filter((id) => childScope.includes(id));
      }, narrowed);
    }
    case 'or': {
      const union = new Set<string>();
      for (const child of node.operands) for (const id of scopeOf(child, scope, schema)) union.add(id);
      return scope.filter((id) => union.has(id));
    }
    case 'not':
    case 'maybe':
      return scope;
    case 'cmp':
      return node.family === 'organism' ? narrow(scope, [node], schema) : scope;
  }
}

function narrow(scope: string[], operands: RNode[], schema: Schema): string[] {
  let out = scope;
  for (const operand of operands) {
    if (operand.kind !== 'cmp' || operand.family !== 'organism') continue;
    const values = operand.values.map(String);
    switch (operand.op) {
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
        const under = new Set(values.flatMap((v) => leavesUnder(schema.organismTaxonomy, v)));
        out = out.filter((id) => under.has(id));
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((x) => set.has(x));
}
