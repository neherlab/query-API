import { describe, expect, it } from 'vitest';
import { compile, evaluate, type RNode, type TestRecord } from '../src/lang/index.js';
import { demoSchema } from '../src/schema/demo.js';

/** Executable version of spec §9. */

function tree(input: string, organism: string | null = null): RNode {
  const result = compile(input, { schema: demoSchema, pinned: organism });
  if (!result.resolved) throw new Error(`${input}: ${result.diagnostics[0]?.message}`);
  return result.resolved;
}

function truth(input: string, record: TestRecord, organism: string | null = null) {
  return evaluate(tree(input, organism), record, demoSchema);
}

const marchRecord: TestRecord = { organism: 'sars2', values: { collectionDate: '2021-03' } };

describe('the lift: partial dates (§9.1)', () => {
  it('is true when every candidate day satisfies the predicate', () => {
    expect(truth('collectionDate=ge=2021-03-01', marchRecord)).toBe('true');
  });

  it('is maybe when only some candidate days do', () => {
    expect(truth('collectionDate=ge=2021-03-15', marchRecord)).toBe('maybe');
  });

  it('is false when none do', () => {
    expect(truth('collectionDate=ge=2021-04-01', marchRecord)).toBe('false');
  });

  it('treats a partial date in the query as an interval too (§9.2)', () => {
    expect(truth('collectionDate==2021-03', marchRecord)).toBe('true');
    expect(truth('collectionDate==2021', marchRecord)).toBe('true');
    expect(truth('collectionDate=gt=2021-03', marchRecord)).toBe('false');
    expect(truth('collectionDate=le=2021-03', marchRecord)).toBe('true');
  });
});

describe('=inRange= is the closed interval (§10)', () => {
  it('lifts like the pair of bounds it stands for', () => {
    expect(truth('collectionDate=inRange=(2021-01,2021-06)', marchRecord)).toBe('true');
    expect(truth('collectionDate=inRange=(2021-03-15,2021-06)', marchRecord)).toBe('maybe');
    expect(truth('collectionDate=inRange=(2021-04,2021-06)', marchRecord)).toBe('false');
  });

  it('agrees with the explicit conjunction, for every outcome', () => {
    for (const [range, pair] of [
      ['(2021-01,2021-06)', 'collectionDate=ge=2021-01;collectionDate=le=2021-06'],
      ['(2021-03-15,2021-06)', 'collectionDate=ge=2021-03-15;collectionDate=le=2021-06'],
      ['(2021-04,2021-06)', 'collectionDate=ge=2021-04;collectionDate=le=2021-06'],
    ]) {
      expect(truth(`collectionDate=inRange=${range}`, marchRecord), range).toBe(truth(pair!, marchRecord));
    }
  });

  it('is equality when both bounds are the same partial date (§9.2)', () => {
    expect(truth('collectionDate=inRange=(2021-03,2021-03)', marchRecord)).toBe(
      truth('collectionDate==2021-03', marchRecord),
    );
  });

  it('is inclusive on both ends for numbers', () => {
    const length = (value: number): TestRecord => ({ organism: 'h3n2', values: { 'length.HA': value } });
    expect(truth('length.HA=inRange=(1600,1700)', length(1600), 'h3n2')).toBe('true');
    expect(truth('length.HA=inRange=(1600,1700)', length(1700), 'h3n2')).toBe('true');
    expect(truth('length.HA=inRange=(1600,1700)', length(1599), 'h3n2')).toBe('false');
  });

  it('is maybe for a missing value, like any other comparison (§9.1)', () => {
    const noDate: TestRecord = { organism: 'sars2', values: {} };
    expect(truth('collectionDate=inRange=(2021-01,2021-06)', noDate)).toBe('maybe');
  });
});

describe('the lift: ambiguity codes and missing values (§9.1)', () => {
  const at = (state: string): TestRecord => ({
    organism: 'sars2',
    values: { 'nuc.wuhan1.23403': state },
    reference: { 'nuc.wuhan1.23403': 'A' },
  });

  it('resolves an unambiguous base definitely', () => {
    expect(truth("nuc.23403=='G'", at('G'), 'sars2')).toBe('true');
    expect(truth("nuc.23403=='A'", at('G'), 'sars2')).toBe('false');
  });

  it('is maybe when the stored code could be the queried base', () => {
    expect(truth("nuc.23403=='G'", at('R'), 'sars2')).toBe('maybe'); // R is A or G
    expect(truth("nuc.23403=='C'", at('R'), 'sars2')).toBe('false');
    expect(truth("nuc.23403=='G'", at('N'), 'sars2')).toBe('maybe');
  });

  it('compares against the reference with the reserved value ref', () => {
    expect(truth('nuc.23403!=ref', at('G'), 'sars2')).toBe('true');
    expect(truth('nuc.23403!=ref', at('A'), 'sars2')).toBe('false');
  });

  it('gives maybe for a missing value, and decides it with isNull', () => {
    const empty: TestRecord = { organism: 'sars2', values: {} };
    expect(truth('collectionDate=ge=2021-03-15', empty)).toBe('maybe');
    expect(truth('collectionDate=isNull=true', empty)).toBe('true');
    expect(truth('collectionDate=isNull=false', empty)).toBe('false');
  });
});

describe('Kleene connectives (§9.3)', () => {
  it('leaves maybe unchanged under negation', () => {
    expect(truth('!collectionDate=ge=2021-03-15', marchRecord)).toBe('maybe');
  });

  it('lets a false conjunct decide an AND', () => {
    expect(truth('collectionDate=ge=2021-03-15;collectionDate=ge=2022', marchRecord)).toBe('false');
  });

  it('lets a true disjunct decide an OR', () => {
    expect(truth('collectionDate=ge=2021-03-15,collectionDate=ge=2021-01-01', marchRecord)).toBe('true');
  });
});

describe('acceptance and maybe() (§9.4)', () => {
  it('collapses maybe to a definite value', () => {
    expect(truth('maybe(collectionDate=ge=2021-03-15)', marchRecord)).toBe('true');
    expect(truth('maybe(collectionDate=ge=2021-04-01)', marchRecord)).toBe('false');
  });

  it('distinguishes maybe(!x) from !maybe(x) — the trap in §9.4', () => {
    expect(truth('maybe(!collectionDate=ge=2021-03-15)', marchRecord)).toBe('true');
    expect(truth('!maybe(collectionDate=ge=2021-03-15)', marchRecord)).toBe('false');
  });

  it('excludes uncertain records by default', () => {
    expect(truth('collectionDate=ge=2021-03-15', marchRecord)).toBe('maybe'); // not 'true' → excluded
  });
});

describe('inapplicable is not missing (§9.1)', () => {
  const sars2Record: TestRecord = {
    organism: 'sars2',
    values: { 'nuc.wuhan1.23403': 'G', collectionDate: '2021-03-04' },
  };

  it('is false, not maybe, for a field the record’s organism does not have', () => {
    expect(truth("organism==h5n1;nuc.HA.1234=='A'", sars2Record)).toBe('false');
  });

  it('makes an OR of two organism-pinned branches behave as written (§7.2)', () => {
    const query = "organism==sars2;nuc.23403=='G',organism==h5n1;nuc.HA.1234=='A'";
    expect(truth(query, sars2Record)).toBe('true');

    const h5Record: TestRecord = { organism: 'h5n1', values: { 'nuc.clade2344b.HA.1234': 'A' } };
    expect(truth(query, h5Record)).toBe('true');

    const otherRecord: TestRecord = { organism: 'rsvA', values: {} };
    expect(truth(query, otherRecord)).toBe('false');
  });
});

describe('hierarchies (§10.1)', () => {
  const record: TestRecord = { organism: 'sars2', values: { 'pangoLineage': 'JN.1', host: 'duck' } };

  it('descendantOf is inclusive and follows the hierarchy', () => {
    expect(truth('pangoLineage=descendantOf=B.1.1.529', record, 'sars2')).toBe('true');
    expect(truth('pangoLineage=descendantOf=JN.1', record, 'sars2')).toBe('true');
    expect(truth('pangoLineage=descendantOf=BA.1', record, 'sars2')).toBe('false');
  });

  it('resolves aliases before matching', () => {
    expect(truth('pangoLineage=descendantOf=omicron', record, 'sars2')).toBe('true');
    expect(truth('pangoLineage=descendantOf=alpha', record, 'sars2')).toBe('false');
  });

  it('works the same way on a core field', () => {
    expect(truth('host=descendantOf=aves', record)).toBe('true');
    expect(truth('host=descendantOf=mammalia', record)).toBe('false');
  });
});
