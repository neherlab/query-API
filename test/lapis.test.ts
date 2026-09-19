import { describe, expect, it } from 'vitest';
import { compile } from '../src/lang/index.js';
import { demoSchema } from '../src/schema/demo.js';

/** Spec §11.2 — the adapter's expressibility classes. */

function lapis(input: string, organism: string | null = null) {
  const result = compile(input, { schema: demoSchema, pinned: organism });
  expect(result.ok, result.diagnostics[0]?.message).toBe(true);
  return result.lapis;
}

describe('class A — one request', () => {
  it('translates a plain conjunction', () => {
    const out = lapis("host=='duck';collectionDate=ge=2024", 'h5n1');
    expect(out.klass).toBe('A');
    expect(out.requests).toHaveLength(1);
    expect(out.requests[0]!.body).toEqual({ host: 'duck', collectionDateFrom: '2024' });
  });

  it('puts a single conjunction of mutations in the dedicated arrays', () => {
    const out = lapis("nuc.23403=='G';aa.S.501=='Y'", 'sars2');
    expect(out.klass).toBe('A');
    expect(out.requests[0]!.body.nucleotideMutations).toEqual(['23403G']);
    expect(out.requests[0]!.body.aminoAcidMutations).toEqual(['S:501Y']);
  });
});

describe('class B — the OR collapses into a value list', () => {
  it('merges disjuncts that differ in one field', () => {
    const out = lapis('host==duck;(country==France,country==Germany)', 'sars2');
    expect(out.klass).toBe('B');
    expect(out.requests).toHaveLength(1);
    expect(out.requests[0]!.body).toEqual({ host: 'duck', country: ['France', 'Germany'] });
  });
});

describe('class C — boolean structure confined to mutations', () => {
  it('keeps the disjunction in the variant query rather than ANDing it', () => {
    const out = lapis("host==duck;(nuc.23403=='G',nuc.23404=='T')", 'sars2');
    expect(out.klass).toBe('C');
    expect(out.requests).toHaveLength(1);
    expect(out.requests[0]!.body.host).toBe('duck');
    expect(out.requests[0]!.body.variantQuery).toBe('23403G | 23404T');
    expect(out.requests[0]!.body.nucleotideMutations).toBeUndefined();
  });

  it('spells maybe() and negation in the variant query', () => {
    const out = lapis("maybe(nuc.23403=='G'),nuc.23404=='T'", 'sars2');
    expect(out.requests[0]!.body.variantQuery).toBe('maybe(23403G) | 23404T');
  });
});

describe('class D — several requests', () => {
  it('warns that counts would be wrong', () => {
    const out = lapis('(country==France;host==duck),(country==Germany;host==chicken)', 'sars2');
    expect(out.klass).toBe('D');
    expect(out.requests).toHaveLength(2);
    expect(out.summary).toMatch(/WRONG for counts/);
  });

  it('fans out across organisms in scope', () => {
    // Note the outer parentheses: `;` binds tighter than `,`, so without them the organism
    // filter would apply to the first branch only and the scope would union back to everything.
    const out = lapis(
      'organism=descendantOf=influenzaA;((country==France;host==duck),(country==Germany;host==chicken))',
    );
    // 2 disjuncts × 3 organisms
    expect(out.requests).toHaveLength(6);
    expect(new Set(out.requests.map((r) => r.organism))).toEqual(new Set(['h5n1', 'h3n2', 'h1n1pdm']));
  });
});

describe('class E — not expressible', () => {
  it('rejects an OR that crosses the metadata/mutation boundary', () => {
    const out = lapis("country==France,nuc.23403=='G'", 'sars2');
    expect(out.klass).toBe('E');
    expect(out.unsupported).toBe(true);
    expect(out.requests).toHaveLength(0);
  });

  it('reports a filter the backend cannot express at all', () => {
    const out = lapis('!country==France', 'sars2');
    expect(out.klass).toBe('E');
    expect(out.warnings.join(' ')).toMatch(/negated filter/);
  });

  it('reports a negated maybe, which has no disjunctive form', () => {
    const out = lapis('!maybe(collectionDate=ge=2021-03-15)', 'sars2');
    expect(out.klass).toBe('E');
    expect(out.warnings.join(' ')).toMatch(/negated maybe/);
  });
});

describe('the language is not constrained by the target', () => {
  it('accepts queries the adapter cannot run', () => {
    const result = compile("country==France,nuc.23403=='G'", { schema: demoSchema, pinned: 'sars2' });
    expect(result.ok).toBe(true);
    expect(result.roundTrip.ok).toBe(true);
    expect(result.lapis.unsupported).toBe(true);
  });
});
