import { describe, expect, it } from 'vitest';
import { compile, familiesInScope, type FieldDef, type Schema, scopedField } from '../src/lang/index.js';
import { demoSchema } from '../src/schema/demo.js';

/** Spec §7.2 and §8.2. */

/** Scope comes from the query, so an organism "context" is just a leading conjunct (§7.2). */
function run(input: string, organism: string | null = null) {
  return compile(organism ? `organism==${organism};${input}` : input, { schema: demoSchema });
}

function segmentField(segments: string[]): FieldDef {
  return { family: 'length', type: 'integer', slots: [{ name: 'seg', kind: 'seg', values: segments }] };
}

describe('available fields follow the scope (§7.1)', () => {
  it('offers only core fields when every organism is in scope', () => {
    const families = familiesInScope(demoSchema, demoSchema.organisms.map((o) => o.id)).map((f) => f.family);
    expect(families).toContain('collectionDate');
    expect(families).toContain('organism');
    expect(families).not.toContain('nuc');
    expect(families).not.toContain('length');
  });

  it('offers genome fields once the scope is a single organism', () => {
    const families = familiesInScope(demoSchema, ['sars2']).map((f) => f.family);
    expect(families).toContain('nuc');
    expect(families).toContain('pangoLineage');
  });

  it('offers fields that resolve identically across a taxon subtree', () => {
    const families = familiesInScope(demoSchema, ['h5n1', 'h3n2', 'h1n1pdm']).map((f) => f.family);
    expect(families).toContain('length'); // same segment slot for all three
    expect(families).toContain('coverage');
    expect(families).toContain('nucMutationCount');
    expect(families).not.toContain('pangoLineage'); // SARS-CoV-2 only
    expect(families).not.toContain('cladeH5'); // H5N1 only
  });

  it('withholds genotype fields across a subtree: references are declared per organism', () => {
    const families = familiesInScope(demoSchema, ['h5n1', 'h3n2', 'h1n1pdm']).map((f) => f.family);
    for (const family of ['nuc', 'aa', 'nuc_ins', 'aa_ins']) expect(families).not.toContain(family);
  });

  it('agrees with the resolver: nothing offered is unusable, nothing withheld is usable', () => {
    // The subtypes share segment names but no reference, so no spelling of a genotype filter
    // resolves — which is exactly why the field is not offered.
    expect(run('organism=descendantOf=influenzaA;length.HA=ge=1600').ok).toBe(true);
    expect(run("organism=descendantOf=influenzaA;nuc.HA.1234=='A'").ok).toBe(false);
    expect(run("organism=descendantOf=influenzaA;nuc(ref=darwin2021,seg=HA,pos=1234)=='A'").ok).toBe(false);
    expect(run("organism=descendantOf=influenzaA;aa.HA.156=='H'").ok).toBe(false);
    // Two organisms, one reference each, no overlap — same rule, shallower tree.
    expect(run('organism=descendantOf=rsv;nuc.100==A').ok).toBe(false);
    expect(familiesInScope(demoSchema, ['rsvA', 'rsvB']).map((f) => f.family)).not.toContain('nuc');
  });

  it('narrows a shared slot to the candidates the whole scope has, rather than dropping the field', () => {
    const partial: Schema = {
      ...demoSchema,
      organisms: [
        { id: 'a', label: 'a', fields: [segmentField(['HA', 'NA'])] },
        { id: 'b', label: 'b', fields: [segmentField(['HA', 'PB1'])] },
      ],
      organismTaxonomy: [{ id: 'both', children: [{ id: 'a' }, { id: 'b' }] }],
    };
    const length = scopedField(partial, 'length', ['a', 'b']);
    expect(length?.slots?.[0]!.values).toEqual(['HA']);
    expect(compile('length.HA=ge=1000', { schema: partial }).ok).toBe(true);
    expect(compile('length.NA=ge=1000', { schema: partial }).ok).toBe(false);
  });

  it('offers nothing organism-specific across a mixed scope', () => {
    const families = familiesInScope(demoSchema, ['h5n1', 'sars2']).map((f) => f.family);
    expect(families).not.toContain('nuc'); // different slots: flu has a segment, SARS-CoV-2 does not
  });
});

describe('scope narrowing (§7.2)', () => {
  it('narrows through descendantOf', () => {
    expect(run('organism=descendantOf=rsv;length=ge=14000').scope).toEqual(['rsvA', 'rsvB']);
  });

  it('narrows through a value list', () => {
    expect(run('organism=in=(h5n1,sars2)').scope).toEqual(['h5n1', 'sars2']);
  });

  it('narrows by exclusion', () => {
    expect(run('organism=out=(h5n1,h3n2,h1n1pdm),host==duck').scope.length).toBeGreaterThan(0);
    expect(run('organism!=sars2;host==duck').scope).not.toContain('sars2');
  });

  it('unions across an OR', () => {
    expect(run('organism==sars2,organism==rsvA').scope).toEqual(['sars2', 'rsvA']);
  });

  it('applies `;` more tightly than `,`, so an unbracketed organism filter scopes one branch only', () => {
    const loose = run('organism==sars2;country==France,country==Germany');
    expect(loose.scope).toEqual(demoSchema.organisms.map((o) => o.id));
    const tight = run('organism==sars2;(country==France,country==Germany)');
    expect(tight.scope).toEqual(['sars2']);
  });

  it('does not narrow through a negation', () => {
    // `!` is semantic, not structural: the genome field still sees every organism, so it fails.
    expect(run("!organism==sars2;nuc.23403=='G'").ok).toBe(false);
  });

  it('accepts a field that resolves identically across the scope', () => {
    const result = run('organism=descendantOf=influenzaA;length.HA=ge=1600');
    expect(result.ok).toBe(true);
    expect(result.scope).toEqual(['h5n1', 'h3n2', 'h1n1pdm']);
  });

  it('rejects a field that resolves differently across the scope', () => {
    const result = run('organism=descendantOf=viruses;length=ge=1000');
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.message).toMatch(/does not mean the same thing/);
  });
});

describe('slot resolution (§8.2)', () => {
  it('infers a slot with exactly one candidate', () => {
    expect(run("nuc.23403=='G'", 'sars2').ok).toBe(true);
  });

  it('infers a slot with a declared default', () => {
    const result = run("nuc.HA.1234=='A'", 'h5n1');
    expect(result.ok).toBe(true);
    expect(result.strict).toContain('clade2344b');
  });

  it('requires a slot with several candidates and no default', () => {
    const result = run("nuc.1234=='A'", 'h5n1');
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.message).toBe("'nuc' needs a seg for h5n1");
  });

  it('rejects a qualifier that fits no slot', () => {
    const result = run("nuc.XX.1234=='A'", 'h5n1');
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.message).toMatch(/is not a valid/);
  });

  it('never guesses between two slots that accept the same name', () => {
    // A reference and a segment sharing a name is the case rule 4 exists for.
    const ambiguous: Schema = {
      ...demoSchema,
      organisms: [
        {
          id: 'toy',
          label: 'toy',
          fields: [
            {
              family: 'nuc',
              type: 'sequenceState',
              slots: [
                { name: 'seg', kind: 'seg', values: ['HA', 'NA'] },
                { name: 'ref', kind: 'ref', values: ['HA', 'other'] },
                { name: 'pos', kind: 'pos' },
              ],
            },
          ],
        },
      ],
      organismTaxonomy: [{ id: 'toy' }],
    };
    const result = compile("nuc.HA.5=='A'", { schema: ambiguous });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.message).toMatch(/ambiguous/);
    expect(result.diagnostics[0]!.hint).toMatch(/name the slots/);
  });

  it('accepts the keyword form where positional is ambiguous', () => {
    const ambiguous: Schema = {
      ...demoSchema,
      organisms: [
        {
          id: 'toy',
          label: 'toy',
          fields: [
            {
              family: 'nuc',
              type: 'sequenceState',
              slots: [
                { name: 'seg', kind: 'seg', values: ['HA', 'NA'] },
                { name: 'ref', kind: 'ref', values: ['HA', 'other'] },
                { name: 'pos', kind: 'pos' },
              ],
            },
          ],
        },
      ],
      organismTaxonomy: [{ id: 'toy' }],
    };
    const result = compile("nuc(ref=HA,seg=NA,pos=5)=='A'", { schema: ambiguous });
    expect(result.ok).toBe(true);
    // Positional would be ambiguous, so the renderer keeps the keyword form.
    expect(result.minimal).toContain('nuc(');
    expect(result.roundTrip.ok).toBe(true);
  });
});
