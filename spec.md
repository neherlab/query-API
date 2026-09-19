# Query-string builder — extended specification

Status: draft 0.2 · Extends [`overview.md`](overview.md), which remains the statement of intent.

Draft 0.2 removes LAPIS from the design centre: `organism` is no longer a grammar special case (§7),
cross-organism queries are supported (§7.2), and the JSON AST rather than a backend request body is
the canonical output (§11).

---

## 1. Scope

In scope: a **filter** language, and a static web app that builds, validates, and renders it.

Out of scope (confirm): result field selection, sorting, pagination, aggregation grouping, download
options. These are request parameters, not filters.

---

## 2. Design principles

Tests a proposed change has to pass.

1. **Closed grammar, open vocabulary.** Productions are fixed. Fields, operators, types, slots, and
   organisms are declared by the schema. A new lineage system, comparator, or organism must not
   require a parser release.
2. **Types carry meaning, not field names.** Operators are defined over types (§6). No operator is
   hard-wired to a named field.
3. **Parsing is schema-independent.** A string parses with no network access and no configuration;
   meaning is assigned in a separate resolution pass (§8.2). "Syntactically valid" and "meaningful
   here" are different questions with different errors.
4. **The AST is the contract.** Every backend is an adapter (§11.2).
5. **One mechanism per concept.** Partial dates, ambiguity codes, and missing values are one feature
   (§9.1). Metadata and genome fields are one namespace, differing only in whether they carry slots.

---

## 3. Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Organism | Ordinary hierarchical core field; validity via the scope rule (§7.2) |
| 2 | Cross-organism queries | Supported; scope follows from field usage |
| 3 | Canonical output | Versioned JSON AST; backend bodies are adapter output (§11) |
| 4 | Server-side parsing | Not today; parser ships standalone with a conformance corpus (§14.3) |
| 5 | Qualified selectors | Dotted positional canonical; keyword form always accepted (§8) |
| 6 | Fuzzy matching | Kleene three-valued evaluation, explicit `maybe(...)`, strict by default (§9) |
| 7 | Comparator spelling | `<` `<=` `>` `>=` are input aliases; canonical forms emit `=lt=` etc. (§5.5) |
| 8 | Insertions | Own families `nuc_ins` / `aa_ins`, not VCF-style REF/ALT (§10.2) |

---

## 4. Character set and URL safety

Queries must survive in a URL unencoded. RFC 3986 permits, in the query component: `ALPHA`, `DIGIT`,
`-` `.` `_` `~`, sub-delimiters `!` `$` `&` `'` `(` `)` `*` `+` `,` `;` `=`, and `:` `@` `/` `?`.

- **Syntax**: `; , ( ) ! = ' . * : @ -`
- **Excluded**: `{ }` `[ ]` (outside `pchar` — hence not the `length{seg=HA}` form from the
  overview), space, `%`, `"`, `\`, `^`, `|`.
- **Input-only**: `<` `>` are also outside `pchar`, so the friendly comparators are accepted but
  never emitted canonically (§5.5). Whitespace between tokens is tolerated on the same footing —
  accepted when typed or pasted, erased by the first canonicalization.
- **Excluded by convention**: `&` and `+`. The query travels as `?q=<query>`, where `&` terminates
  the value and `+` decodes to a space. A `=` inside a parameter value is safe — only the first
  splits.
- **Known risk**: `;` is AND; some legacy form-decoders treat it as a parameter separator.
  WHATWG-conformant ones do not. Accepted.

Values outside the bare-token set are single-quoted (§5.4).

---

## 5. Grammar

FIQL/RSQL shape with three extensions, flagged below. No production mentions `organism`.

### 5.1 Productions

```abnf
query       = or-expr
or-expr     = and-expr *( "," and-expr )          ; "," = OR  (loosest binding)
and-expr    = unary   *( ";" unary )              ; ";" = AND (binds tighter)
unary       = [ "!" ] primary                     ; EXTENSION: prefix NOT
primary     = "(" or-expr ")"
            / "maybe" "(" or-expr ")"             ; EXTENSION: fuzzy wrapper
            / constraint

constraint  = selector comparison argument
comparison  = "==" / "!=" / ( "=" 1*ALPHA "=" )   ; FIQL: custom operators are alphabetic only
            / "<=" / ">=" / "<" / ">"             ; EXTENSION: input aliases, never emitted (§5.5)
argument    = value / "(" value *( "," value ) ")"

selector    = ident *( "." qualifier ) [ "(" kwarg *( "," kwarg ) ")" ]   ; EXTENSION: kwargs
kwarg       = ident "=" value
qualifier   = ident / 1*DIGIT

value       = bare / quoted
bare        = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / ":" / "@" / "*" )
quoted      = "'" *( %x20-26 / %x28-5B / %x5D-7E / "\'" / "\\" ) "'"
ident       = ALPHA *( ALPHA / DIGIT / "_" )      ; "_" composes a family: nuc_ins, aa_ins (§5.6)
```

The parser does not know the operator set; any alphabetic comparator parses and resolution validates
it (principle 1).

### 5.2 Lexing

- `IDENT` immediately followed by `(` lexes as one token — selector-with-kwargs, or `maybe`.
- `(` after a comparator opens a value list; `(` where a term is expected opens a group.
- `!` is prefix NOT only where a term is expected; elsewhere `!=` lexes as a comparator.
- Comparators lex by maximal munch, so `<=` never lexes as `<` plus a value. `<` and `>` are unused
  elsewhere, so the aliases add no ambiguity.

`maybe` is the only reserved word and may not be a field name.

### 5.3 Precedence

`!` binds tightest, then `;`, then `,`; all left-associative. Canonical rendering emits only the
parentheses precedence requires.

### 5.4 Values

- Bare tokens cover identifiers, numbers, ISO dates, lineage names, wildcards.
- Anything else is single-quoted, with `\'` and `\\` as the only escapes. Free-text fields such as
  `authors` routinely contain `,` and `;`.
- `*` is a wildcard on string equality. **OPEN**: escape for a literal asterisk, proposed `\*`.
- **OPEN**: case sensitivity. Proposal — the schema declares it per type (principle 2): enumerated
  metadata case-insensitive, identifiers and sequence states case-sensitive.

### 5.5 Comparator aliases

`<` `<=` `>` `>=` mean exactly `=lt=` `=le=` `=gt=` `=ge=`, because `length.HA>=1600` is what people
type.

They are **input-only**: `<` and `>` are outside `pchar` and get percent-encoded on the wire, which
is what §4 exists to avoid. No canonical rendering emits them, and the first canonicalization erases
them — `canon("length.HA>=1600")` is `length.HA=ge=1600`. Round-trip idempotence (§13) is unaffected,
since canonical output is already in the URL-safe subset. For a deliberately human-facing string, see
the readable rendering in §13.

Not adopted: bare `=` for equality. It is lexable, since an unquoted value cannot contain `=`, but it
saves one character and blurs the distinction between a comparator and a keyword argument.

### 5.6 Field naming

`_` composes a family from a base plus a modifier (`nuc_ins`, `aa_ins`); ordinary multi-word fields
are camelCase (`collectionDate`, `nucMutationCount`). Operators stay alphabetic-only, a FIQL
constraint. **OPEN** — confirm rather than going snake_case throughout.

---

## 6. Type system

Every field has a type; operators are defined over types. This is the extension point that keeps the
grammar closed.

| Type | Examples | Notes |
|---|---|---|
| `string` | isolate name, submitter | Wildcards; case sensitivity per §5.4 |
| `enum` | host, country, sex | Schema supplies values for validation and autocomplete |
| `integer`, `number` | segment length, coverage | |
| `date` | collection date, submission date | Values may be partial (§9.2) |
| `boolean` | flags | |
| `hierarchical` | Pango lineage, Nextclade clade, host taxonomy, geography, **organism** | Schema supplies hierarchy and alias map |
| `sequenceState` | nucleotide, amino acid | Candidate-set semantics (§9.1) |
| `set<T>` | multi-valued fields | **OPEN**, §15 |

Adding a type bumps the language version. Adding a field of an existing type, or applying an existing
operator to another type, is a schema change and bumps nothing.

---

## 7. Fields, scope, and cross-organism queries

### 7.1 Core and organism-scoped fields

The schema partitions the namespace:

- **Core fields** are defined identically for every organism — accession, version, collection date,
  submission date, host, geography, submitter. Same name, type, units, and meaning everywhere.
- **Organism-scoped fields** depend on a genome or organism-specific annotation — segment length,
  nucleotide and amino acid states, insertions, lineage systems, subtype-specific metadata.

`organism` is a core field of type `hierarchical`. It gets no special grammar, but it does get a
taxonomy, so `organism=descendantOf=influenzaA` is an ordinary query and the species/subtype
filtering in the overview needs no dedicated syntax.

### 7.2 The scope rule

For a node *n*, its **organism scope** `O(n)` is the set of organisms not excluded by organism
constraints in the AND-group containing *n*, intersected with those of enclosing AND-groups:

- at the root, `O` is every organism in the instance, or the one the app is pinned to;
- within an AND-group, each conjunct's scope is narrowed by every *sibling* conjunct constraining
  `organism` via `==`, `!=`, `=in=`, `=out=`, or `=descendantOf=` — so conjunct order is irrelevant;
- each branch of an OR inherits the enclosing scope independently;
- `!` does not affect scope. Scoping is structural; negation is semantic.

**Validity**: every constraint on an organism-scoped field must resolve *identically* — same slots,
type, and meaning — for every organism in `O`. Otherwise the query is invalid and the error names the
term and the conflicting organisms.

```
host=='duck';collectionDate=ge=2024                   valid — core fields only, all organisms
organism=descendantOf=influenzaA;length.HA=ge=1600    valid — HA resolves identically across influenza A
organism==sars2;nuc.23403=='G'                        valid — scope pinned to one organism
nuc.23403=='G';organism==sars2                        valid — order is irrelevant
organism==sars2;nuc.23403=='G' , organism==h5n1;nuc.1234=='A'
                                                      valid — each OR branch scopes independently
nuc.23403=='G'                                        invalid — nuc does not resolve identically across all organisms
```

The invalid case fails with a reason the UI can act on: this filter needs an organism, or a narrower
organism filter.

### 7.3 Consequences

- A query spanning more than one organism may only reference, return, and sort by core fields.
- Narrowing the taxonomy is a legitimate way to make an organism-scoped filter valid; pinning one
  organism is the special case, not the requirement.
- **Hazard**: adding an organism can invalidate a previously valid cross-organism query, if it joins
  a taxon subtree without a segment its siblings have. Mitigation: strict rendering pins the organism
  set (§13), and the failure is an explicit resolution error, not a silent change in results.

---

## 8. Selectors and resolution

### 8.1 Slots

A selector is a family plus a **named slot map**; dotted positional form is a rendering of that map.

| Family | Strict form | Slots | Notes |
|---|---|---|---|
| Core / metadata | `country` | — | The zero-slot case |
| Segment-scoped | `length.<seg>` | segment | Omitted for non-segmented organisms |
| Nucleotide | `nuc.<ref>.<seg>.<pos>` | reference, segment, position | 1-based, alignment coordinates of `<ref>` |
| Amino acid | `aa.<ref>.<cds>.<pos>` | reference, CDS, position | CDS implies the segment |
| Nucleotide insertion | `nuc_ins.<ref>.<seg>.<pos>` | reference, segment, position | Value is the inserted sequence (§10.2) |
| Amino acid insertion | `aa_ins.<ref>.<cds>.<pos>` | reference, CDS, position | Mirrors `aa` |

### 8.2 Resolution

Parsing yields unresolved qualifiers: `nuc.3423` → `{family: "nuc", qualifiers: ["3423"]}`.
Resolution assigns them to slots, right to left:

1. The final qualifier is the position, for families that have one.
2. Remaining qualifiers match the schema's declared slot order, skipping slots with exactly one
   candidate in scope.
3. A slot with one possible value in scope may be omitted; a slot with several may not, unless the
   schema declares a default.
4. If a qualifier is ambiguous — it names both a reference and a segment, or two slots remain for one
   qualifier — resolution **fails**. It never guesses; the UI offers the keyword form.

Keyword form `nuc(ref=X,seg=HA,pos=3423)` needs no schema to disambiguate.

### 8.3 Slot extensibility

Positional order is declared by the schema, not the language. **A new slot may be added to a family
only with a declared default**, so existing strings keep resolving. Positional form is defined only
for slot sets whose order the schema declares; anything else uses keyword form. This admits a new
dimension — a second coordinate system, a time-resolved reference — without a flag day.

---

## 9. Semantics

### 9.1 The lift: partial dates, ambiguity, and missing values

Every stored value denotes a **candidate set** — the values it could be:

| Stored | Candidate set |
|---|---|
| `2021-03-15` | that day |
| `2021-03` | the 31 days of March 2021 |
| `2021` | the 365 days of 2021 |
| missing / null | the whole domain |
| nucleotide `A` | `{A}` |
| nucleotide `R` | `{A,G}` |
| nucleotide `N` | `{A,C,G,T}` |
| nucleotide `-` | `{-}` — deletion is a state, not an ambiguity |

Each comparison defines a pointwise predicate `P`. Lifted to a candidate set `R`:

- **true** if `P(d)` holds for every `d` in `R`;
- **false** if it holds for no `d` in `R`;
- **maybe** otherwise.

A record dated `2021-03` is *true* for `date=ge=2021-03-01`, *maybe* for `date=ge=2021-03-15`,
*false* for `date=ge=2021-04-01`.

**Inapplicable is not missing.** A term on a field the record's organism does not have is **false**
(its negation true), not maybe. Missing data is uncertainty; an absent field is a definite non-match.
This is what makes the OR of two organism-pinned branches in §7.2 behave as written.

### 9.2 Partial dates in the query

A partial date in the query denotes an interval; ordered comparators take the relevant bound:

| Query | Threshold |
|---|---|
| `date=ge=2021-03` | `d >= 2021-03-01` |
| `date=gt=2021-03` | `d > 2021-03-31` |
| `date=le=2021-03` | `d <= 2021-03-31` |
| `date=lt=2021-03` | `d < 2021-03-01` |
| `date==2021-03` | `d` within March 2021 |

### 9.3 Connectives

Kleene three-valued logic. `AND`: true only if both are true, false if either is false, else maybe.
`OR`: true if either is true, false only if both are false, else maybe. `NOT` swaps true and false
and **leaves maybe unchanged**.

### 9.4 Acceptance and `maybe(...)`

A record is included iff the root evaluates to **true**. `maybe(X)` evaluates `X` three-valued and
collapses it: true or maybe → true, false → false. It returns a definite value, so it composes
anywhere.

```
maybe(!(date=ge=2021-03-15))    ≠    !maybe(date=ge=2021-03-15)
```

For a record dated `2021-03` the left is **true** (it might be before the 15th), the right **false**
(it might be on or after). Both answer real questions; the UI must show which is being built.

Strict is the default: outside a `maybe(...)`, a maybe result excludes the record.

---

## 10. Operator vocabulary

The schema declares which operators apply to which types. This is the **initial vocabulary**, not a
grammar feature.

| Operator | Types | Meaning |
|---|---|---|
| `==` `!=` | all | Equality; `*` wildcard on `string` |
| `=gt=` `=ge=` `=lt=` `=le=` | `integer`, `number`, `date` | Ordered comparison, lifted per §9.1 |
| `=in=` `=out=` | all | Membership in a value list |
| `=descendantOf=` | `hierarchical` | **Inclusive**: the named node and everything below it |
| `=isNull=` | all | `true`/`false` — the only way to select on missing data |
| `=isAmbiguous=` | `sequenceState`, `date` | `true`/`false` — candidate set has more than one member |

### 10.1 Hierarchical fields

- Aliases resolve before matching (`BA` ≡ `B.1.1.529`); query and stored value need not agree in form.
- An organism may carry several independent hierarchies (Pango, Nextclade clade, subclade), each its
  own field. So do host taxonomy and geography: `geography=descendantOf=westAfrica` needs no new
  syntax.
- **OPEN**: recombinants have multiple parents. Proposed default — `=descendantOf=` does not traverse
  recombinant edges. Needs a decision from whoever owns the lineage definitions; it may differ per
  hierarchy, which the schema can express.

### 10.2 Sequence states and insertions

- `nuc.3423=='A'` — state at an alignment position, lifted per §9.1.
- `'-'` is deletion. Query-side IUPAC codes expand to sets: `=='R'` means A or G.
- `nuc.3423!=ref` — `ref` is a reserved value meaning the reference state at that position, so this
  selects any mutation there.
- `aa.S.501=='Y'` for amino acids.
- `nuc_ins.1234=='ATG'` — an insertion of `ATG` following alignment position 1234; `aa_ins.S.144=='KV'`
  likewise. The position names the aligned position the insertion *follows*; insertions do not
  consume a coordinate.
- `*` applies to the inserted sequence: `nuc_ins.1234=='A*'` matches any insertion there beginning
  with A, `nuc_ins.1234=='*'` any insertion at all.
- **Absent is not unknown**: at a covered, aligned position with no insertion the term is **false**;
  where the region is not covered the candidate set is unconstrained and the term is **maybe**. Same
  rule as dates and ambiguity codes (§9.1).

*Rejected — VCF convention.* A REF/ALT pair at a position (`A` → `ATTG`) folds insertions into the
substitution namespace, forces the value to carry reference context the builder would have to look
up, and makes "any insertion here" awkward. Separate families reuse the slot machinery unchanged
(principle 5); a VCF-consuming tool translates in its adapter.

### 10.3 Derived fields

Counts and summary statistics — `nucMutationCount`, `ambiguityFraction`, `coverage` — are ordinary
schema-declared numeric fields, not language features: `nucMutationCount.HA=ge=10` needs no new
syntax. Whether a backend can compute them is an adapter question. This is the intended shape of most
future growth.

---

## 11. Output

### 11.1 The AST is canonical

Lossless, versioned, backend-neutral:

```json
{
  "languageVersion": "0.2",
  "filter": {
    "type": "and",
    "operands": [
      { "type": "cmp", "field": { "family": "organism", "slots": {} },
        "op": "descendantOf", "values": ["influenzaA"] },
      { "type": "cmp", "field": { "family": "length", "slots": { "seg": "HA" } },
        "op": "ge", "values": [1600] },
      { "type": "maybe", "operand":
        { "type": "cmp", "field": { "family": "collectionDate", "slots": {} },
          "op": "ge", "values": ["2021-03"] } }
    ]
  },
  "scope": { "organisms": ["h5n1", "h3n2", "h1n1pdm"] }
}
```

Node types: `and`, `or`, `not`, `maybe`, `cmp`. Slots are resolved, so the AST is schema-independent
downstream. `scope` is derived, not authored, and makes the §7.3 hazard detectable after the fact.

### 11.2 Targets

A target adapts the AST to a backend's request format and declares what it cannot express. None
constrains the language. Target #1 is LAPIS, because it is what exists.

**LAPIS adapter.** Metadata filters there are conjunctive: distinct fields AND, values within a field
OR, ranges via `<field>From`/`<field>To`. Boolean structure is available for mutations, not metadata.
Normalize to DNF and classify:

| Class | Condition | Output |
|---|---|---|
| A | One disjunct | One request |
| B | Disjuncts differ in exactly one field | One request, that field as an array |
| C | Boolean structure confined to the mutation subtree | One request with a variant query |
| D | Otherwise | N requests, with a warning |
| E | OR crosses the metadata/mutation boundary | No request; diagnostic |

Cross-organism queries fan out across per-organism endpoints and merge on core fields — a further
multiplier on class D.

Class D is correct for accession lists after deduplication and **wrong for aggregated counts**
(records matching two disjuncts are double-counted). The app must never silently emit a D-class
aggregation.

The classification is user-facing: well-formed but not currently executable is different from
invalid, and it is the signal that would justify a server-side `?query=` parameter.

---

## 12. Extensibility guarantees

What may change without invalidating existing query strings:

| Change | Safe? |
|---|---|
| Add a field of an existing type | Yes |
| Add an operator, or apply an existing one to another type | Yes — parser is operator-agnostic |
| Add a value to an enum or a node to a hierarchy | Yes |
| Add a qualifier slot **with a declared default** | Yes (§8.3) |
| Add a derived field (§10.3) | Yes |
| Add an organism | Yes for pinned queries; **may invalidate a cross-organism query** (§7.3) |
| Add a type | No — language version bump |
| Change the grammar | No — language version bump |
| Rename a field | No — needs a schema alias table; the app rewrites on load |

Language version and schema version are independent and both travel in the AST.

---

## 13. Canonical forms

**Strict** — unambiguous and self-contained: organism scope pinned, every slot filled, every value
quoted, only precedence-required parentheses.

**Minimal** — shortest faithful rendering given the schema: scope terms dropped where the app's
context supplies them, inferable slots dropped, quotes dropped where the bare-token rule allows,
redundant parentheses dropped.

Both are URL-safe and both erase comparator aliases (§5.5).

**Readable** (recommended, display only) — minimal, spelled with `<=` `>=` `<` `>`, for prose and
documentation. Parses back to the identical AST, but is **not** URL-safe: the UI must label it and
must not use it for permalinks.

Operand order is **never** rewritten; determinism comes from source order.

**Round-trip requirement** (requirement 2 of the overview):

```
canon(parse(canon(parse(s)))) == canon(parse(s))
```

for each rendering, and `resolve(parse(strict(q))) == resolve(parse(minimal(q)))` as ASTs — with one
qualification. Strict pins the organism scope and minimal leaves it to the app context, so when the
pin comes from context rather than from the user's text the two trees differ by exactly that term.
The check therefore factors top-level organism terms out of both sides and compares the derived
scopes separately. Strict is also re-read without the app context, since it is self-contained.

The app checks this on every render; a failure is a bug, not user error.

---

## 14. Application

### 14.1 Requirements

From the overview: build queries as groups of filters combined with AND/OR, with nesting and
negation; validate by parsing, resolving, and checking the round-trip identity; display strict and
minimal renderings; emit JSON; static, deployable to GitHub Pages.

Added:

1. **Import** — paste a query string and populate the UI. Without it, shared strings are read-only
   and the round-trip check has no user-visible purpose.
2. **Permalink** — full app state in the URL.
3. **Errors with offsets** — parse and resolve errors point at a character range.
4. **Scope indicator** — which organisms the current query applies to, live. With cross-organism
   queries this is the key feedback: it explains why an organism-scoped field is unavailable and what
   filter would make it available.
5. **Live check** (recommended) — run the query and show a hit count, making validation more than
   syntactic.

### 14.2 Schema sourcing

Static and cross-origin, so the app needs a CORS-enabled configurable instance URL. Per organism:
field names, types, enum values; reference, segment, and CDS names; which fields are hierarchical,
plus hierarchies and alias maps. Across organisms: the core field list and the organism taxonomy.

**OPEN — verify against a live instance** which of these the deployment exposes and in what shape.
Some may have to be bundled with the app or served as a static schema document. Do not design around
remembered endpoint names.

The core field registry and organism taxonomy are governance artifacts as much as technical ones:
someone must own which fields are harmonized and what the taxonomy is. The language depends on that
decision existing, not on which way it goes.

### 14.3 Packaging

Parser, resolver, renderers, and target adapters ship as a standalone dependency-free package; the
web app is one consumer. With it, a **conformance corpus** in JSON: input → strict → minimal → AST →
target output or diagnostic, including error cases with offsets and the scope-rule cases in §7.2.
This is what a second implementation would be tested against.

---

## 15. Open questions

1. **Core field registry and organism taxonomy** — who owns them, what is in them (§14.2). Blocks
   cross-organism search more than anything technical.
2. **Schema endpoints** — verify against a live instance (§14.2).
3. **Segment and CDS identity across organisms** — the scope rule needs "the HA segment" to mean the
   same thing across influenza A subtypes. Declared, or inferred from name equality? (§7.2)
4. **Recombinant traversal** in `=descendantOf=` (§10.1).
5. **`set<T>` semantics** — does `==` mean "contains" or "equals the set"? Proposal: `=in=` for
   membership, `==` for set equality; needs a real use case first.
6. **Field naming convention** (§5.6) — `_` for family composition with camelCase elsewhere, or
   snake_case throughout?
7. **Literal `*` escaping** and **case sensitivity as a type property** (§5.4).
8. **Maximum practical query length** before a permalink cannot carry the query.
9. Confirm sort/fields/limit are out of scope (§1).
10. Confirm the readable rendering (§13) is wanted — a third string for users to choose between.
