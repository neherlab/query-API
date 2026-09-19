import type { FieldDef, TypeName } from './schema.js';

export interface OperatorDef {
  name: string;
  /** Canonical spelling, the only one ever emitted (spec §5.5). */
  spell: string;
  /** Friendly spelling accepted on input but never emitted. */
  alias?: string;
  /** Takes a parenthesized value list. */
  list?: boolean;
  /** Takes exactly `true` or `false`, whatever the field type. */
  booleanArg?: boolean;
  /** Field types this applies to; '*' for all. */
  types: TypeName[] | '*';
  label: string;
}

/**
 * The initial vocabulary of spec §10 — data, not grammar. The parser accepts any alphabetic
 * comparator; an unknown one fails in resolution with "unknown operator", so adding one here (or
 * in a schema's `ops`) needs no parser change.
 */
export const OPERATORS: Record<string, OperatorDef> = {
  eq: { name: 'eq', spell: '==', types: '*', label: 'is' },
  ne: { name: 'ne', spell: '!=', types: '*', label: 'is not' },
  lt: { name: 'lt', spell: '=lt=', alias: '<', types: ['integer', 'number', 'date'], label: 'is before / less than' },
  le: { name: 'le', spell: '=le=', alias: '<=', types: ['integer', 'number', 'date'], label: 'is at most' },
  gt: { name: 'gt', spell: '=gt=', alias: '>', types: ['integer', 'number', 'date'], label: 'is after / greater than' },
  ge: { name: 'ge', spell: '=ge=', alias: '>=', types: ['integer', 'number', 'date'], label: 'is at least' },
  in: { name: 'in', spell: '=in=', list: true, types: '*', label: 'is one of' },
  out: { name: 'out', spell: '=out=', list: true, types: '*', label: 'is none of' },
  descendantOf: {
    name: 'descendantOf',
    spell: '=descendantOf=',
    types: ['hierarchical'],
    label: 'is at or below',
  },
  isNull: { name: 'isNull', spell: '=isNull=', booleanArg: true, types: '*', label: 'is missing' },
  isAmbiguous: {
    name: 'isAmbiguous',
    spell: '=isAmbiguous=',
    booleanArg: true,
    types: ['sequenceState', 'date'],
    label: 'is ambiguous',
  },
};

export function operator(name: string): OperatorDef | undefined {
  return OPERATORS[name];
}

export function allowedOperators(def: FieldDef): OperatorDef[] {
  if (def.ops) return def.ops.map((n) => OPERATORS[n]).filter((o): o is OperatorDef => o !== undefined);
  return Object.values(OPERATORS).filter((op) => op.types === '*' || op.types.includes(def.type));
}

export function spell(name: string, readable: boolean): string {
  const op = OPERATORS[name];
  if (!op) return `=${name}=`;
  return readable && op.alias ? op.alias : op.spell;
}
