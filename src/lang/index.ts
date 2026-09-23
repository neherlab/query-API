import type { RNode, UNode } from './ast.js';
import type { Diagnostic } from './errors.js';
import { QueryError } from './errors.js';
import { LANGUAGE_VERSION, type QueryJson, toJson } from './json.js';
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
      lapis: toLapis(null, [], opts.schema),
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
      lapis: toLapis(null, scope, opts.schema),
      roundTrip: { ok: false, failures: ['not resolved'] },
    };
  }

  const renderOpts = { schema: opts.schema };
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
    lapis: toLapis(node, scope, opts.schema),
    roundTrip: checkRoundTrip({ strict, minimal, readable }, node, scope, opts),
  };
}

/**
 * The identity from spec §13, made operational. Every style is re-read the same way, with no
 * context to supply: a query string carries its own organism scope, so the trees and the scopes
 * must match exactly.
 */
function checkRoundTrip(
  rendered: Record<Style, string>,
  node: RNode,
  scope: string[],
  opts: CompileOptions,
): RoundTripReport {
  const failures: string[] = [];
  const reference = toJson(node, scope).filter;

  for (const style of ['strict', 'minimal', 'readable'] as Style[]) {
    const text = rendered[style];
    try {
      const reparsed = parse(text);
      const result = resolveQuery(reparsed, opts);
      if (!result.node || result.diagnostics.length > 0) {
        failures.push(`${style}: does not resolve (${result.diagnostics[0]?.message ?? 'no node'})`);
        continue;
      }
      const again = render(result.node, style, { schema: opts.schema });
      if (again !== text) {
        failures.push(`${style}: not idempotent — '${text}' became '${again}'`);
      }
      if (!sameSet(result.scope, scope)) {
        failures.push(`${style}: scope drifted — ${scope.join(',')} became ${result.scope.join(',')}`);
      }
      if (JSON.stringify(toJson(result.node, result.scope).filter) !== JSON.stringify(reference)) {
        failures.push(`${style}: filter tree differs after a round trip`);
      }
    } catch (err) {
      failures.push(`${style}: ${(err as Error).message}`);
    }
  }

  return { ok: failures.length === 0, failures };
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export { LANGUAGE_VERSION };
