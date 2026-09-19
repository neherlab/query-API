import type { RNode, UNode } from './ast.js';
import type { Diagnostic } from './errors.js';
import { QueryError } from './errors.js';
import { type JsonNode, LANGUAGE_VERSION, type QueryJson, toJson } from './json.js';
import { parse } from './parser.js';
import { render, type Style } from './render.js';
import { resolveQuery } from './resolve.js';
import type { Schema } from './schema.js';
import { type LapisTranslation, toLapis } from './targets/lapis.js';

export * from './ast.js';
export * from './errors.js';
export * from './json.js';
export * from './operators.js';
export * from './parser.js';
export * from './render.js';
export * from './resolve.js';
export * from './schema.js';
export * from './dnf.js';
export * from './eval.js';
export * from './targets/lapis.js';

export interface CompileOptions {
  schema: Schema;
  /** Organism context; null means the instance's whole collection. */
  pinned?: string | null;
}

export interface RoundTripReport {
  ok: boolean;
  failures: string[];
}

export interface CompileResult {
  input: string;
  ast: UNode | null;
  resolved: RNode | null;
  scope: string[];
  diagnostics: Diagnostic[];
  ok: boolean;
  strict: string;
  minimal: string;
  readable: string;
  json: QueryJson;
  lapis: LapisTranslation;
  roundTrip: RoundTripReport;
}

/**
 * Parse → resolve → render → serialize → translate, plus the round-trip check the app runs on
 * every render (spec §13). This is the whole public API the UI needs.
 */
export function compile(input: string, opts: CompileOptions): CompileResult {
  const base = {
    input,
    ast: null,
    resolved: null,
    scope: [] as string[],
    strict: '',
    minimal: '',
    readable: '',
  };

  let ast: UNode | null;
  try {
    ast = parse(input);
  } catch (err) {
    if (!(err instanceof QueryError)) throw err;
    return {
      ...base,
      diagnostics: [err.diagnostic],
      ok: false,
      json: toJson(null, [], opts.schema.schemaVersion),
      lapis: toLapis(null, []),
      roundTrip: { ok: false, failures: ['not parsed'] },
    };
  }

  const { node, scope, diagnostics } = resolveQuery(ast, opts);
  const ok = node !== null && diagnostics.length === 0;
  if (!ok) {
    return {
      ...base,
      ast,
      scope,
      diagnostics,
      ok: false,
      json: toJson(null, scope, opts.schema.schemaVersion),
      lapis: toLapis(null, scope),
      roundTrip: { ok: false, failures: ['not resolved'] },
    };
  }

  const renderOpts = { schema: opts.schema, pinned: opts.pinned ?? null, scope };
  const strict = render(node, 'strict', renderOpts);
  const minimal = render(node, 'minimal', renderOpts);
  const readable = render(node, 'readable', renderOpts);

  return {
    input,
    ast,
    resolved: node,
    scope,
    diagnostics,
    ok: true,
    strict,
    minimal,
    readable,
    json: toJson(node, scope, opts.schema.schemaVersion),
    lapis: toLapis(node, scope),
    roundTrip: checkRoundTrip({ strict, minimal, readable }, node, scope, opts),
  };
}

/**
 * The identity from spec §13, made operational.
 *
 * Note the qualification on the second half: strict pins the organism scope and minimal leaves it
 * to the app context, so the two trees are not literally identical when the pin was supplied by
 * context rather than written by the user. Top-level organism terms are therefore factored out of
 * both before comparison, and the scopes are compared separately.
 */
function checkRoundTrip(
  rendered: Record<Style, string>,
  node: RNode,
  scope: string[],
  opts: CompileOptions,
): RoundTripReport {
  const failures: string[] = [];
  const reference = stripScopeTerms(toJson(node, scope).filter);

  for (const style of ['strict', 'minimal', 'readable'] as Style[]) {
    const text = rendered[style];
    // Strict is self-contained by construction, so it is re-read without the app's context.
    const context: CompileOptions = style === 'strict' ? { schema: opts.schema, pinned: null } : opts;
    try {
      const reparsed = parse(text);
      const result = resolveQuery(reparsed, context);
      if (!result.node || result.diagnostics.length > 0) {
        failures.push(`${style}: does not resolve (${result.diagnostics[0]?.message ?? 'no node'})`);
        continue;
      }
      const again = render(result.node, style, { schema: opts.schema, pinned: context.pinned ?? null, scope: result.scope });
      if (again !== text) {
        failures.push(`${style}: not idempotent — '${text}' became '${again}'`);
      }
      if (!sameSet(result.scope, scope)) {
        failures.push(`${style}: scope drifted — ${scope.join(',')} became ${result.scope.join(',')}`);
      }
      const roundTripped = stripScopeTerms(toJson(result.node, result.scope).filter);
      if (JSON.stringify(roundTripped) !== JSON.stringify(reference)) {
        failures.push(`${style}: filter tree differs after a round trip`);
      }
    } catch (err) {
      failures.push(`${style}: ${(err as Error).message}`);
    }
  }

  return { ok: failures.length === 0, failures };
}

/** Drops top-level organism terms, which strict writes explicitly and minimal takes from context. */
function stripScopeTerms(filter: JsonNode | null): JsonNode | null {
  if (!filter) return null;
  if (filter.type === 'cmp') return filter.field.family === 'organism' ? null : filter;
  if (filter.type !== 'and') return filter;
  const operands = filter.operands.filter((o) => !(o.type === 'cmp' && o.field.family === 'organism'));
  if (operands.length === 0) return null;
  if (operands.length === 1) return operands[0]!;
  return { type: 'and', operands };
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export { LANGUAGE_VERSION };
