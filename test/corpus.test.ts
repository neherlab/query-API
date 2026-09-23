import { describe, expect, it } from 'vitest';
import { compile } from '../src/lang/index.js';
import { demoSchema } from '../src/schema/demo.js';
import corpus from './corpus.json';

interface Case {
  name: string;
  input: string;
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
      const result = compile(entry.input, { schema: demoSchema });

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
      const result = compile(entry.input, { schema: demoSchema });
      expect(result.roundTrip.failures).toEqual([]);
      expect(result.roundTrip.ok).toBe(true);
    });
  }

  it('canonicalisation is idempotent for every rendering', () => {
    for (const entry of cases.filter((c) => !c.error)) {
      for (const style of ['strict', 'minimal', 'readable'] as const) {
        const first = compile(entry.input, { schema: demoSchema });
        const second = compile(first[style], { schema: demoSchema });
        expect(second[style], `${entry.name} / ${style}`).toBe(first[style]);
      }
    }
  });

  it('every rendering carries its own scope, so all three resolve alike', () => {
    for (const entry of cases.filter((c) => !c.error)) {
      const first = compile(entry.input, { schema: demoSchema });
      for (const style of ['strict', 'minimal', 'readable'] as const) {
        const again = compile(first[style], { schema: demoSchema });
        expect(again.scope, `${entry.name} / ${style}`).toEqual(first.scope);
        expect(again.json.filter, `${entry.name} / ${style}`).toEqual(first.json.filter);
      }
    }
  });
});
