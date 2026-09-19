import type { Schema } from '../lang/schema.js';
import { demoSchema } from './demo.js';

export { demoSchema };

export interface SchemaSource {
  schema: Schema;
  /** Where it came from, for the UI to show. */
  origin: string;
  /** Set when a requested schema could not be loaded and the demo was used instead. */
  error?: string;
}

/**
 * A deployment points the app at its own schema document with `?schema=<url>`. The endpoint that
 * should serve it is open question §15.2 — until that is settled, a static JSON file works and is
 * what the demo uses.
 */
export async function loadSchema(url: string | null): Promise<SchemaSource> {
  if (!url) return { schema: demoSchema, origin: 'bundled demo schema' };
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = (await response.json()) as Schema;
    const problem = validate(parsed);
    if (problem) throw new Error(problem);
    return { schema: parsed, origin: url };
  } catch (err) {
    return {
      schema: demoSchema,
      origin: 'bundled demo schema',
      error: `could not load ${url}: ${(err as Error).message}`,
    };
  }
}

function validate(schema: Schema): string | null {
  if (!Array.isArray(schema?.coreFields)) return 'missing coreFields';
  if (!Array.isArray(schema?.organisms)) return 'missing organisms';
  if (!Array.isArray(schema?.organismTaxonomy)) return 'missing organismTaxonomy';
  if (typeof schema?.hierarchies !== 'object' || schema.hierarchies === null) return 'missing hierarchies';
  return null;
}
