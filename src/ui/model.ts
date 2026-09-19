import type { RCmp, RNode } from '../lang/ast.js';
import { operator } from '../lang/operators.js';
import { coreField, type FieldDef, organismField, type Schema } from '../lang/schema.js';

/**
 * The editable model behind the builder. The query *string* is derived from it, never the other
 * way round; importing a string goes through parse + resolve and rebuilds the model, so the two
 * can never drift (spec §14.1.1).
 */

/** Wrappers around a node, outermost first. Kept as a list so `!maybe(x)` and `maybe(!x)` stay distinct. */
export type Wrapper = 'not' | 'maybe';

export interface FilterNode {
  id: string;
  kind: 'filter';
  wrappers: Wrapper[];
  family: string;
  slots: Record<string, string>;
  op: string;
  values: string[];
}

export interface GroupNode {
  id: string;
  kind: 'group';
  wrappers: Wrapper[];
  op: 'and' | 'or';
  children: EditNode[];
}

export type EditNode = FilterNode | GroupNode;

let counter = 0;
export function nextId(): string {
  return `n${++counter}`;
}

export function emptyGroup(op: 'and' | 'or' = 'and'): GroupNode {
  return { id: nextId(), kind: 'group', wrappers: [], op, children: [] };
}

/* ------------------------------ model → text ------------------------------ */

const BARE_SAFE = /^[A-Za-z0-9._~:@*-]+$/;

export function toText(node: EditNode, schema: Schema, scope: string[], root = true): string {
  const inner = node.kind === 'group' ? groupText(node, schema, scope, root) : filterText(node, schema, scope);
  return wrap(inner, node.wrappers, node.kind === 'group' && node.children.length > 1);
}

function wrap(text: string, wrappers: Wrapper[], compound: boolean): string {
  let out = text;
  for (let i = wrappers.length - 1; i >= 0; i--) {
    const wrapper = wrappers[i]!;
    if (wrapper === 'maybe') out = `maybe(${out})`;
    else out = `!${compound || out.includes(';') || out.includes(',') ? `(${out})` : out}`;
  }
  return out;
}

function groupText(node: GroupNode, schema: Schema, scope: string[], root: boolean): string {
  const parts = node.children.map((child) => toText(child, schema, scope, false)).filter((t) => t !== '');
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  const joined = parts.join(node.op === 'and' ? ';' : ',');
  // Redundant parentheses are stripped by the canonical renderer, so being generous here is free.
  return root && node.wrappers.length === 0 ? joined : `(${joined})`;
}

function filterText(node: FilterNode, schema: Schema, scope: string[]): string {
  const def = fieldDef(schema, node.family, scope);
  const opDef = operator(node.op);
  if (!def || !opDef) return '';

  const slots = (def.slots ?? [])
    .map((slot) => node.slots[slot.name] ?? '')
    .filter((value) => value !== '');
  const selector = [node.family, ...slots].join('.');

  const values = node.values.filter((v) => v !== '').map((v) => renderValue(v, def));
  if (values.length === 0) return '';
  const arg = opDef.list ? `(${values.join(',')})` : values[0]!;
  return `${selector}${opDef.spell}${arg}`;
}

function renderValue(value: string, def: FieldDef): string {
  if (def.type === 'sequenceState' && value === 'ref') return 'ref';
  return BARE_SAFE.test(value) ? value : `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function fieldDef(schema: Schema, family: string, scope: string[]): FieldDef | undefined {
  const core = coreField(schema, family);
  if (core) return core;
  for (const organism of scope) {
    const def = organismField(schema, organism, family);
    if (def) return def;
  }
  for (const organism of schema.organisms) {
    const def = organismField(schema, organism.id, family);
    if (def) return def;
  }
  return undefined;
}

/* ------------------------------ tree → model ------------------------------ */

/** Rebuilds the model from a resolved tree, so pasting a string populates the builder. */
export function fromResolved(node: RNode): EditNode {
  const wrappers: Wrapper[] = [];
  let current = node;
  while (current.kind === 'not' || current.kind === 'maybe') {
    wrappers.push(current.kind === 'not' ? 'not' : 'maybe');
    current = current.operand;
  }

  switch (current.kind) {
    case 'cmp':
      return { ...filterFrom(current), wrappers };
    case 'and':
    case 'or':
      return {
        id: nextId(),
        kind: 'group',
        wrappers,
        op: current.kind,
        children: current.operands.map(fromResolved),
      };
    default:
      throw new Error('unreachable: wrappers were stripped above');
  }
}

function filterFrom(cmp: RCmp): FilterNode {
  const slots: Record<string, string> = {};
  for (const [name, value] of Object.entries(cmp.slots)) slots[name] = String(value);
  return {
    id: nextId(),
    kind: 'filter',
    wrappers: [],
    family: cmp.family,
    slots,
    op: cmp.op,
    values: cmp.values.map(String),
  };
}

/* ------------------------------- mutation -------------------------------- */

export function findParent(root: EditNode, id: string): GroupNode | null {
  if (root.kind !== 'group') return null;
  for (const child of root.children) {
    if (child.id === id) return root;
    const hit = findParent(child, id);
    if (hit) return hit;
  }
  return null;
}

export function find(root: EditNode, id: string): EditNode | null {
  if (root.id === id) return root;
  if (root.kind !== 'group') return null;
  for (const child of root.children) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}

export function remove(root: EditNode, id: string): void {
  const parent = findParent(root, id);
  if (!parent) return;
  parent.children = parent.children.filter((child) => child.id !== id);
}

/** The four wrapper combinations the UI offers by name; anything else shows as "custom". */
export const MATCH_MODES: Array<{ value: string; label: string; wrappers: Wrapper[]; hint: string }> = [
  { value: 'must', label: 'must match', wrappers: [], hint: 'excludes records whose value is uncertain' },
  { value: 'might', label: 'might match', wrappers: ['maybe'], hint: 'maybe(x) — includes uncertain values' },
  { value: 'mustnot', label: 'must not match', wrappers: ['not'], hint: '!x' },
  { value: 'mightnot', label: 'might not match', wrappers: ['maybe', 'not'], hint: 'maybe(!x) — includes uncertain values' },
];

export function modeOf(wrappers: Wrapper[]): string {
  const key = wrappers.join('+');
  return MATCH_MODES.find((mode) => mode.wrappers.join('+') === key)?.value ?? 'custom';
}

export function wrappersFor(mode: string): Wrapper[] {
  return MATCH_MODES.find((m) => m.value === mode)?.wrappers ?? [];
}
