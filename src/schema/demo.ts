import type { FieldDef, Hierarchy, OrganismDef, Schema, SlotDef, TaxonNode } from '../lang/schema.js';

/**
 * A worked example schema, not real data. It exists so the app is usable without a backend and so
 * the conformance corpus has something concrete to resolve against. A deployment replaces it with
 * its own document — see `load()` in ./index.ts. Where a real one comes from is open question
 * §15.2 in the spec.
 *
 * It is shaped to exercise the awkward cases on purpose:
 *   - influenza A: segmented, three subtypes sharing segment names, so cross-subtype queries work;
 *   - h5n1: two references with a declared default, so the ref slot is optional but present;
 *   - SARS-CoV-2 and RSV: unsegmented, so their genome fields have no segment slot at all —
 *     which is exactly why `length` cannot be used across flu and SARS-CoV-2 together.
 */

const FLU_SEGMENTS = ['PB2', 'PB1', 'PA', 'HA', 'NP', 'NA', 'MP', 'NS'];
const FLU_CDS = ['PB2', 'PB1', 'PA', 'HA', 'NP', 'NA', 'M1', 'M2', 'NS1', 'NS2'];
const SARS2_CDS = ['ORF1a', 'ORF1b', 'S', 'ORF3a', 'E', 'M', 'ORF6', 'ORF7a', 'ORF7b', 'ORF8', 'N'];
const RSV_CDS = ['NS1', 'NS2', 'N', 'P', 'M', 'SH', 'G', 'F', 'M2', 'L'];

const NUC_PATTERN = '^[ACGTURYSWKMBDHVNacgturyswkmbdhvn-]+$';
const AA_PATTERN = '^[A-Za-z*-]+$';

interface GenomeShape {
  refs: string[];
  refDefault?: string;
  segments?: string[];
  cds: string[];
}

function slot(name: string, kind: SlotDef['kind'], values?: string[], byDefault?: string): SlotDef {
  return { name, kind, ...(values ? { values } : {}), ...(byDefault ? { default: byDefault } : {}) };
}

function genomeFields({ refs, refDefault, segments, cds }: GenomeShape): FieldDef[] {
  const ref = slot('ref', 'ref', refs, refDefault);
  const seg = segments ? [slot('seg', 'seg', segments)] : [];
  const pos = slot('pos', 'pos');
  const segOnly = segments ? [slot('seg', 'seg', segments)] : [];

  return [
    {
      family: 'length',
      type: 'integer',
      label: 'sequence length',
      slots: segOnly,
      description: 'Ungapped length of the submitted sequence.',
    },
    {
      family: 'coverage',
      type: 'number',
      label: 'coverage',
      slots: segOnly,
      description: 'Fraction of the reference covered by unambiguous bases.',
    },
    {
      family: 'nucMutationCount',
      type: 'integer',
      label: 'nucleotide mutation count',
      slots: segOnly,
      description:
        'Derived field (spec §10.3): how many positions differ from the reference, per sequence. ' +
        'To filter on a position, use the nucleotide field.',
    },
    {
      family: 'nuc',
      type: 'sequenceState',
      label: 'nucleotide',
      slots: [ref, ...seg, pos],
      description: "State at an alignment position. '-' is a deletion; ref means the reference state.",
    },
    {
      family: 'aa',
      type: 'sequenceState',
      label: 'amino acid',
      slots: [ref, slot('cds', 'cds', cds), pos],
      description: 'State at a codon position; the CDS implies the segment.',
    },
    {
      family: 'nuc_ins',
      type: 'string',
      label: 'nucleotide insertion',
      slots: [ref, ...seg, pos],
      pattern: NUC_PATTERN,
      description: 'Inserted bases following the given alignment position.',
    },
    {
      family: 'aa_ins',
      type: 'string',
      label: 'amino acid insertion',
      slots: [ref, slot('cds', 'cds', cds), pos],
      pattern: AA_PATTERN,
      description: 'Inserted residues following the given codon position.',
    },
  ];
}

function lineageField(family: string, hierarchy: string, label: string): FieldDef {
  return { family, type: 'hierarchical', hierarchy, label };
}

const organisms: OrganismDef[] = [
  {
    id: 'h5n1',
    label: 'Influenza A H5N1',
    fields: [
      ...genomeFields({
        refs: ['clade2344b', 'clade23'],
        refDefault: 'clade2344b',
        segments: FLU_SEGMENTS,
        cds: FLU_CDS,
      }),
      lineageField('cladeH5', 'h5clade', 'H5 clade'),
    ],
  },
  {
    id: 'h3n2',
    label: 'Influenza A H3N2',
    fields: [
      ...genomeFields({ refs: ['darwin2021'], segments: FLU_SEGMENTS, cds: FLU_CDS }),
      lineageField('nextcladeClade', 'fluClade', 'Nextclade clade'),
    ],
  },
  {
    id: 'h1n1pdm',
    label: 'Influenza A H1N1pdm',
    fields: [
      ...genomeFields({ refs: ['california2009'], segments: FLU_SEGMENTS, cds: FLU_CDS }),
      lineageField('nextcladeClade', 'fluClade', 'Nextclade clade'),
    ],
  },
  {
    id: 'sars2',
    label: 'SARS-CoV-2',
    fields: [
      ...genomeFields({ refs: ['wuhan1'], cds: SARS2_CDS }),
      lineageField('pangoLineage', 'pango', 'Pango lineage'),
    ],
  },
  {
    id: 'rsvA',
    label: 'RSV-A',
    fields: genomeFields({ refs: ['rsvAref'], cds: RSV_CDS }),
  },
  {
    id: 'rsvB',
    label: 'RSV-B',
    fields: genomeFields({ refs: ['rsvBref'], cds: RSV_CDS }),
  },
];

const organismTaxonomy: TaxonNode[] = [
  {
    id: 'viruses',
    label: 'all viruses',
    children: [
      {
        id: 'influenzaA',
        label: 'Influenza A',
        children: [{ id: 'h5n1' }, { id: 'h3n2' }, { id: 'h1n1pdm' }],
      },
      { id: 'sars2' },
      { id: 'rsv', label: 'RSV', children: [{ id: 'rsvA' }, { id: 'rsvB' }] },
    ],
  },
];

const hierarchies: Record<string, Hierarchy> = {
  organism: { id: 'organism', label: 'organism taxonomy', roots: organismTaxonomy },
  host: {
    id: 'host',
    label: 'host taxonomy',
    roots: [
      {
        id: 'animalia',
        children: [
          {
            id: 'aves',
            children: [
              { id: 'anseriformes', children: [{ id: 'duck' }, { id: 'goose' }, { id: 'swan' }] },
              { id: 'galliformes', children: [{ id: 'chicken' }, { id: 'turkey' }] },
            ],
          },
          {
            id: 'mammalia',
            children: [
              { id: 'human' },
              { id: 'swine' },
              { id: 'bovine' },
              { id: 'carnivora', children: [{ id: 'cat' }, { id: 'fox' }, { id: 'seal' }] },
            ],
          },
        ],
      },
    ],
    aliases: { 'homo_sapiens': 'human', 'Homo-sapiens': 'human', cattle: 'bovine' },
  },
  geography: {
    id: 'geography',
    label: 'geography',
    roots: [
      {
        id: 'world',
        children: [
          { id: 'europe', children: [{ id: 'Switzerland' }, { id: 'Germany' }, { id: 'France' }] },
          { id: 'asia', children: [{ id: 'Cambodia' }, { id: 'Vietnam' }, { id: 'China' }] },
          { id: 'northAmerica', children: [{ id: 'USA' }, { id: 'Canada' }] },
          { id: 'africa', children: [{ id: 'Egypt' }, { id: 'Nigeria' }] },
        ],
      },
    ],
  },
  pango: {
    id: 'pango',
    label: 'Pango lineage',
    roots: [
      {
        id: 'B',
        children: [
          {
            id: 'B.1',
            children: [
              {
                id: 'B.1.1',
                children: [
                  { id: 'B.1.1.7' },
                  {
                    id: 'B.1.1.529',
                    children: [
                      { id: 'BA.1' },
                      { id: 'BA.2', children: [{ id: 'BA.2.86', children: [{ id: 'JN.1' }] }] },
                      { id: 'BA.5' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    // Aliases resolve before matching, so a query need not use the same form as the data (§10.1).
    aliases: { BA: 'B.1.1.529', omicron: 'B.1.1.529', alpha: 'B.1.1.7' },
  },
  h5clade: {
    id: 'h5clade',
    label: 'H5 clade',
    roots: [
      {
        id: '2',
        children: [
          {
            id: '2.3',
            children: [
              { id: '2.3.2.1' },
              { id: '2.3.4.4', children: [{ id: '2.3.4.4b' }, { id: '2.3.4.4c' }] },
            ],
          },
        ],
      },
    ],
  },
  fluClade: {
    id: 'fluClade',
    label: 'Nextclade clade',
    roots: [
      {
        id: '3C',
        children: [
          {
            id: '3C.2a',
            children: [{ id: '3C.2a1b', children: [{ id: 'J.1' }, { id: 'J.2', children: [{ id: 'J.2.2' }] }] }],
          },
        ],
      },
    ],
  },
};

const coreFields: FieldDef[] = [
  { family: 'accession', type: 'string', label: 'accession', caseSensitive: true },
  { family: 'version', type: 'integer', label: 'version' },
  {
    family: 'organism',
    type: 'hierarchical',
    hierarchy: 'organism',
    label: 'organism',
    description: 'Ordinary core field; scope follows from it (spec §7.2).',
  },
  { family: 'collectionDate', type: 'date', label: 'collection date' },
  { family: 'submissionDate', type: 'date', label: 'submission date' },
  { family: 'host', type: 'hierarchical', hierarchy: 'host', label: 'host' },
  { family: 'geography', type: 'hierarchical', hierarchy: 'geography', label: 'geography' },
  {
    family: 'country',
    type: 'enum',
    label: 'country',
    values: ['Switzerland', 'Germany', 'France', 'Cambodia', 'Vietnam', 'China', 'USA', 'Canada', 'Egypt', 'Nigeria'],
  },
  { family: 'submitter', type: 'string', label: 'submitter' },
  { family: 'isolateName', type: 'string', label: 'isolate name' },
];

export const demoSchema: Schema = {
  schemaVersion: 'demo-1',
  label: 'Demonstration schema',
  coreFields,
  organisms,
  organismTaxonomy,
  hierarchies,
};
