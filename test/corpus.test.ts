import { describe, expect, it } from 'vitest';
import { compile } from '../src/lang/index.js';
import { demoSchema } from '../src/schema/demo.js';
import corpus from './corpus.json';

interface Case {
  name: string;
  input: string;
  organism: string | null;
  strict?: string;
  minimal?: string;
  readable?: string;
  scope?: string[];
  error?: { phase: string; message: string; start: number; end: number };
}

const cases = corpus.cases as Case[];

describe('conformance corpus', () => {
  for (const entry of cases) {
    it(entry.name, () => {
      const result = compile(entry.input, { schema: demoSchema, pinned: entry.organism });

      if (entry.error) {
        expect(result.ok).toBe(false);
        const first = result.diagnostics[0];
        expect(first).toBeDefined();
        expect(first!.phase).toBe(entry.error.phase);
        expect(first!.message).toBe(entry.error.message);
        expect(first!.span).toEqual({ start: entry.error.start, end: entry.error.end });
        return;
      }

      expect(result.diagnostics).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.strict).toBe(entry.strict);
      expect(result.minimal).toBe(entry.minimal);
      expect(result.readable).toBe(entry.readable);
      expect(result.scope).toEqual(entry.scope);
    });
  }
});

describe('round-trip identity (spec §13)', () => {
  for (const entry of cases.filter((c) => !c.error)) {
    it(entry.name, () => {
      const result = compile(entry.input, { schema: demoSchema, pinned: entry.organism });
      expect(result.roundTrip.failures).toEqual([]);
      expect(result.roundTrip.ok).toBe(true);
    });
  }

  it('canonicalisation is idempotent for every rendering', () => {
    for (const entry of cases.filter((c) => !c.error)) {
      for (const style of ['strict', 'minimal', 'readable'] as const) {
        const first = compile(entry.input, { schema: demoSchema, pinned: entry.organism });
        // Strict is self-contained, so it is re-read without the app's organism context.
        const pinned = style === 'strict' ? null : entry.organism;
        const second = compile(first[style], { schema: demoSchema, pinned });
        expect(second[style], `${entry.name} / ${style}`).toBe(first[style]);
      }
    }
  });

  it('strict and minimal resolve to the same filter', () => {
    for (const entry of cases.filter((c) => !c.error)) {
      const first = compile(entry.input, { schema: demoSchema, pinned: entry.organism });
      const strict = compile(first.strict, { schema: demoSchema, pinned: null });
      const minimal = compile(first.minimal, { schema: demoSchema, pinned: entry.organism });
      expect(strict.scope, entry.name).toEqual(minimal.scope);
    }
  });
});
