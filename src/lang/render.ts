import type { RCmp, RNode, RValue } from './ast.js';
import { spell } from './operators.js';
import { coreField, organismField, type Schema, type SlotDef } from './schema.js';

/** Spec §13. `readable` is display-only and is *not* URL-safe. */
export type Style = 'strict' | 'minimal' | 'readable';

export interface RenderOptions {
  schema: Schema;
}

const BARE_SAFE = /^[A-Za-z0-9._~:@*-]+$/;

const PREC = { or: 1, and: 2, unary: 3, atom: 4 } as const;

/**
 * Every rendering is self-contained: organism scope lives in the query as ordinary `organism`
 * terms (spec §7.2), so no style has to reconstruct a context it was rendered under.
 */
export function render(node: RNode | null, style: Style, opts: RenderOptions): string {
  if (!node) return '';
  return renderNode(node, style, opts, PREC.or);
}

function renderNode(node: RNode, style: Style, opts: RenderOptions, parentPrec: number): string {
  switch (node.kind) {
    case 'and':
    case 'or': {
      const prec = node.kind === 'and' ? PREC.and : PREC.or;
      const operands = node.operands.map((child) => renderNode(child, style, opts, prec));
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
