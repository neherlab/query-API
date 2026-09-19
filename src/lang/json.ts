import type { RNode, RValue } from './ast.js';

/** Bumped only by a grammar or type-system change (spec §12). */
export const LANGUAGE_VERSION = '0.2';

export interface JsonCmp {
  type: 'cmp';
  field: { family: string; slots: Record<string, string | number> };
  op: string;
  values: RValue[];
}

export type JsonNode =
  | { type: 'and' | 'or'; operands: JsonNode[] }
  | { type: 'not' | 'maybe'; operand: JsonNode }
  | JsonCmp;

export interface QueryJson {
  languageVersion: string;
  schemaVersion?: string;
  filter: JsonNode | null;
  scope: { organisms: string[] };
}

/** The canonical output (spec §11.1): lossless, versioned, backend-neutral. */
export function toJson(node: RNode | null, scope: string[], schemaVersion?: string): QueryJson {
  return {
    languageVersion: LANGUAGE_VERSION,
    ...(schemaVersion ? { schemaVersion } : {}),
    filter: node ? toJsonNode(node) : null,
    scope: { organisms: scope },
  };
}

function toJsonNode(node: RNode): JsonNode {
  switch (node.kind) {
    case 'and':
    case 'or':
      return { type: node.kind, operands: node.operands.map(toJsonNode) };
    case 'not':
    case 'maybe':
      return { type: node.kind, operand: toJsonNode(node.operand) };
    case 'cmp':
      return {
        type: 'cmp',
        field: { family: node.family, slots: node.slots },
        op: node.op,
        values: node.values,
      };
  }
}
