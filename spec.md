# Query-string builder — extended specification

Status: draft 0.2 · Extends [`overview.md`](overview.md), which remains the statement of intent.

Draft 0.2 removes LAPIS from the design centre. The language is defined on its own terms; LAPIS is
one execution target among possible others. The visible consequences are that `organism` is no longer
a grammar special case (§7), cross-organism queries are supported (§7.2), and the JSON AST rather
than a backend request body is the canonical output (§11).

---

## 1. Scope

In scope: a **filter** language and a static web app that builds, validates, and renders it.

Out of scope (confirm): result field selection, sorting, pagination, aggregation grouping,
download/format options. These are request parameters, not filters, and travel alongside the query.

---

## 2. Design principles

These are the tests a proposed change to the language has to pass.

1. **Closed grammar, open vocabulary.** The set of productions is fixed and small. Fields,
   operators, types, qualifier slots, and organisms are all *declared by the schema*, never by the
   grammar. Adding a lineage system, a new comparator, or a new organism must not require a parser
   release.
2. **Types carry meaning, not field names.** An operator is defined on a type. `=descendantOf=`
   works on anything the schema marks hierarchical — Pango lineage, Nextclade clade, host taxonomy,
   geography, and the organism field itself. No operator is hard-wired to a named field.
3. **Parsing is schema-independent.** A string parses into an unresolved tree with no network access
   and no configuration. Meaning is assigned in a separate resolution pass. This keeps the parser
   portable and makes "is this syntactically valid" and "is this meaningful here" different
   questions with different error messages.
4. **The AST is the contract.** Every backend is an adapter. Nothing about a particular backend's
   request format is permitted to shape the language.
5. **One mechanism per concept.** Incomplete dates, ambiguous nucleotides, and missing values are
   not three features; they are one (§9.1). Metadata fields and genome fields are not two namespaces;
   they are one, differing only in whether they carry qualifiers (§6).

---

## 3. Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Organism | An ordinary hierarchical core field; validity governed by the scope rule (§7) |
| 2 | Cross-organism queries | Supported; a query's scope is whatever its field usage permits |
| 3 | Canonical output | Versioned JSON AST; backend request bodies are adapter output (§11) |
| 4 | Server-side parsing | Not today; parser ships standalone with a conformance corpus so it stays possible |
| 5 | Qualified selectors | Dotted positional canonical, keyword form always accepted and used where positional is ambiguous or undefined |
| 6 | Fuzzy matching | Three-valued (Kleene) evaluation, explicit `maybe(...)`, strict by default |
| 7 | Comparator spelling | `<` `<=` `>` `>=` accepted as input aliases; canonical forms emit only the URL-safe `=lt=` family (§5.5) |
| 8 | Insertions | Own field families `nuc_ins` / `aa_ins`, not VCF-style REF/ALT (§10.2) |

---

## 4. Character set and URL safety

Queries must survive in a URL unencoded. RFC 3986 permits, in the query component: `ALPHA`, `DIGIT`,
`-` `.` `_` `~`, the sub-delimiters `!` `$` `&` `'` `(` `)` `*` `+` `,` `;` `=`, and `:` `@` `/` `?`.

- **Used as syntax**: `; , ( ) ! = ' . * : @ -`
- **Excluded**: `{ }` and `[ ]` (outside `pchar`; this is why the `length{seg=HA}` form from the
  overview is not used), plus space, `%`, `"`, `\`, `^`, `|`.
- **Input-only**: `<` and `>` are also outside `pchar`, so the friendly comparators `<=` `>=` `<` `>`
  are accepted when typed or pasted but never emitted in a canonical rendering (§5.5).
- **Excluded by convention**: `&` and `+`, since the query normally travels as `?q=<query>`, where
  `&` terminates the value and `+` decodes to a space in form-decoders. A `=` inside a parameter
  value is safe — only the first one splits.
- **Noted risk**: `;` is AND. A few legacy form-decoders treat it as a parameter separator; WHATWG-
  conformant ones do not. Accepted, recorded so it is not rediscovered.

Values outside the bare-token set are single-quoted (§5.4).

---

## 5. Grammar

FIQL/RSQL shape, with three extensions, each flagged. Note there is no production mentioning
`organism`: it is an ordinary field.

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
ident       = ALPHA *( ALPHA / DIGIT / "_" )      ; "_" composes a family: nuc_ins, aa_ins (§8.1)
```

The comparison production accepts **any** alphabetic operator. The parser does not know the operator
set; resolution validates it against the schema (principle 1).

### 5.2 Lexing

Three uses of `(` , all resolved with one character of lookahead:

- `IDENT` immediately followed by `(` lexes as one token — selector-with-kwargs, or the reserved
  word `maybe`.
- `(` after a comparator opens a value list; `(` where a term is expected opens a group.
- `!` is prefix NOT only where a term is expected; elsewhere `!=` lexes as a comparator.

Comparators lex by maximal munch, so `<=` never lexes as `<` followed by a value. `<` and `>` are
unused elsewhere in the grammar, so the aliases introduce no ambiguity.

`maybe` is the language's single reserved word and may not be a field name.

### 5.3 Precedence

`!` binds tightest, then `;`, then `,`; all left-associative. Canonical rendering emits only the
parentheses precedence requires.

### 5.4 Values

- Bare tokens cover identifiers, numbers, ISO dates, lineage names, wildcards.
- Anything else is single-quoted, with `\'` and `\\` as the only escapes. This matters: harmonized
  free-text fields such as `authors` routinely contain `,` and `;`.
- `*` is a wildcard on string equality. A literal asterisk must be quoted and escaped — **OPEN**:
  settle on `\*`.
- **OPEN**: case sensitivity. Proposal — the *schema* declares it per type, rather than the language
  fixing it (principle 2): enumerated metadata case-insensitive, identifiers and sequence states
  case-sensitive.

### 5.5 Comparator aliases

`<` `<=` `>` `>=` are accepted wherever `=lt=` `=le=` `=ge=` `=gt=` are and mean exactly the same
thing, because `length.HA>=1600` is what people actually type.

They are **input-only**, and this is a real constraint rather than a stylistic preference: `<` and
`>` are outside `pchar` and must be percent-encoded in a URL, which is precisely what §4 exists to
avoid. Browsers will encode them on the wire even when the address bar displays them. So no canonical
rendering emits them, and the alias is erased by the first canonicalization:

```
canon("length.HA>=1600")  ==  "length.HA=ge=1600"
```

Round-trip idempotence (§13) is unaffected, since canonical output already lives in the URL-safe
subset. The builder can show `>=` in the UI while copying `=ge=` to the clipboard; see the readable
rendering in §13 for the case where a human-facing string is wanted deliberately.

Not adopted: bare `=` for equality. It is lexable — an unquoted value cannot contain `=`, so bounded
lookahead separates `x=5` from `x=le=5` — but it saves one character and costs the reader the visual
distinction between a comparator and a keyword argument (§5.1).

### 5.6 Field naming

`_` composes a field family from a base family and a modifier: `nuc_ins`, `aa_ins`. Ordinary
multi-word field names stay camelCase: `collectionDate`, `nucMutationCount`. Custom comparators
remain alphabetic-only, a FIQL constraint, so no operator can contain `_`. **OPEN** — confirm this
split rather than going all-snake_case (§15).

---

## 6. Type system

Every field has a type; every operator is defined over types. This is the extension point that keeps
the grammar closed.

| Type | Examples | Notes |
|---|---|---|
| `string` | isolate name, submitter | Wildcards; case sensitivity per §5.4 |
| `enum` | host, country, sex | Schema supplies the value set for validation and autocomplete |
| `integer`, `number` | segment length, coverage | |
| `date` | collection date, submission date | Values may be partial (§9.2) |
| `boolean` | flags | |
| `hierarchical` | Pango lineage, Nextclade clade, host taxonomy, geography, **organism** | Schema supplies the hierarchy and alias map |
| `sequenceState` | nucleotide, amino acid | Candidate-set semantics (§9.1) |
| `set<T>` | multi-valued fields | Membership semantics; **OPEN**, see §14 |

Adding a type is a language change and bumps the language version. Adding a *field* of an existing
type, or declaring an existing operator applicable to a new type, is a schema change and bumps
nothing.

---

## 7. Fields, scope, and cross-organism queries

### 7.1 Core and organism-scoped fields

The field namespace is partitioned by the schema, not by the language:

- **Core fields** are defined identically for every organism — accession, version, collection date,
  submission date, host, geography, submitter, and so on. They are harmonized: same name, same type,
  same units, same meaning everywhere.
- **Organism-scoped fields** depend on a genome or an organism-specific annotation — segment length,
  nucleotide and amino acid states, insertions, lineage systems, subtype-specific metadata.

`organism` is itself a core field of type `hierarchical`. It gets no special grammar. It does get a
taxonomy, which means `organism=descendantOf=influenzaA` is an ordinary query, and species/subtype
filtering from the overview needs no dedicated syntax.

### 7.2 The scope rule

For any node *n*, its **organism scope** `O(n)` is the set of organisms not excluded by the organism
constraints appearing in the AND-group containing *n*, intersected with those of enclosing AND-groups:

- at the root, `O` is every organism in the instance (or the single organism the app is pinned to);
- within an AND-group, every conjunct's scope is narrowed by every *sibling* conjunct that constrains
  `organism` via `==`, `!=`, `=in=`, `=out=`, or `=descendantOf=` — so conjunct order is irrelevant;
- each branch of an OR inherits the enclosing scope independently;
- `!` does not affect scope. Scoping is structural; negation is semantic.

**Validity**: for every constraint referencing an organism-scoped field, that field must resolve
*identically* — same qualifier slots, same type, same meaning — for every organism in `O`. Otherwise
the query is invalid, and the error names the term and the conflicting organisms.

This is one static check, and it subsumes what draft 0.1 spent a special grammar rule on:

```
host=='duck';collectionDate=ge=2024                      valid — core fields only, all organisms
organism=descendantOf=influenzaA;length.HA=ge=1600       valid — HA resolves identically across influenza A
organism==sars2;nuc.23403=='G'                           valid — scope pinned to one organism
nuc.23403=='G';organism==sars2                           valid — order is irrelevant
organism==sars2;nuc.23403=='G' , organism==h5n1;nuc.1234=='A'
                                                         valid — each OR branch scopes independently
nuc.23403=='G'                                           invalid — nuc does not resolve identically across all organisms
```

The last line is the whole design in miniature: it is rejected for a stated reason the UI can act on
("this filter needs an organism, or a narrower organism filter"), rather than by a rule about where
`organism` is allowed to appear.

### 7.3 Consequences

- A query whose scope spans more than one organism may only reference core fields, and may only
  return and sort by core fields.
- Narrowing the taxonomy is a legitimate way to make an organism-scoped filter valid — pinning a
  single organism is the special case, not the requirement.
- **Hazard, stated plainly**: adding an organism to the instance can invalidate a previously valid
  cross-organism query, if it joins a taxon subtree without a segment its siblings have. Mitigation:
  strict rendering can pin the organism set explicitly, and the failure is a clear resolution error
  rather than a silent change in results. See §13.

---

## 8. Selectors and resolution

### 8.1 Slots

A selector is a field family plus a **named slot map**. Dotted positional form is a rendering of that
map, not the underlying model.

| Family | Strict form | Slots | Notes |
|---|---|---|---|
| Core / metadata | `country` | — | The zero-slot case; no special treatment |
| Segment-scoped | `length.<seg>` | segment | Omitted for non-segmented organisms |
| Nucleotide | `nuc.<ref>.<seg>.<pos>` | reference, segment, position | 1-based, in alignment coordinates of `<ref>` |
| Amino acid | `aa.<ref>.<cds>.<pos>` | reference, CDS, position | CDS implies the segment |
| Nucleotide insertion | `nuc_ins.<ref>.<seg>.<pos>` | reference, segment, position | Value is the inserted sequence (§10.2) |
| Amino acid insertion | `aa_ins.<ref>.<cds>.<pos>` | reference, CDS, position | Mirrors `aa` exactly |

### 8.2 Resolution

Parsing yields unresolved qualifiers: `nuc.3423` → `{family: "nuc", qualifiers: ["3423"]}`.
Resolution assigns them to slots, right to left:

1. The final qualifier is the position, for families that have one.
2. Remaining qualifiers are matched against the schema's declared slot order, skipping slots with
   exactly one candidate in scope.
3. A slot with one possible value in scope may be omitted. A slot with several may not, unless the
   schema declares a default.
4. If a qualifier is ambiguous — it names both a reference and a segment, or two slots remain for one
   qualifier — resolution **fails**. It never guesses. The UI offers the keyword form.

Keyword form `nuc(ref=X,seg=HA,pos=3423)` bypasses all of it and needs no schema to disambiguate.

### 8.3 Slot extensibility

Positional order is declared by the schema, not the language. The guarantee: **a new slot may be
added to an existing family only if it declares a default**, so every existing string keeps
resolving. Positional form is defined only for slot sets whose order the schema declares; anything
else must use keyword form. This is what lets a new dimension — a second alignment coordinate system,
a time-resolved reference — be added without a flag day.

---

## 9. Semantics

### 9.1 The lift: one rule for partial dates, ambiguity, and missing values

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

Every comparison defines a pointwise predicate `P`. Lifted to a candidate set `R`:

- **true** if `P(d)` holds for every `d` in `R`;
- **false** if it holds for no `d` in `R`;
- **maybe** otherwise.

Fuzzy dates, IUPAC ambiguity, and nulls are consequences of this one rule. A record dated `2021-03`
is *true* for `date=ge=2021-03-01`, *maybe* for `date=ge=2021-03-15`, *false* for
`date=ge=2021-04-01`.

**Inapplicable is not missing.** A term referencing a field the record's organism does not have
evaluates to **false** (and its negation to true) — not *maybe*. Missing *data* is uncertainty; an
absent *field* is a definite non-match. Keeping these apart is what makes the OR of two
organism-pinned branches in §7.2 behave as written.

### 9.2 Partial dates in the query

A partial date in the query also denotes an interval; ordered comparators take the relevant bound:

| Query | Threshold |
|---|---|
| `date=ge=2021-03` | `d >= 2021-03-01` |
| `date=gt=2021-03` | `d > 2021-03-31` |
| `date=le=2021-03` | `d <= 2021-03-31` |
| `date=lt=2021-03` | `d < 2021-03-01` |
| `date==2021-03` | `d` within March 2021 |

### 9.3 Connectives

Kleene three-valued logic: `AND` is true only if both are true, false if either is false, else maybe.
`OR` is true if either is true, false only if both are false, else maybe. `NOT` swaps true and false
and **leaves maybe unchanged**.

### 9.4 Acceptance and `maybe(...)`

A record is included iff the root evaluates to **true**. `maybe(X)` evaluates `X` three-valued and
collapses it: true or maybe → true, false → false. It returns a definite value, so it composes
anywhere.

The consequence worth stating, because it is the trap that "treat maybe as true" falls into:

```
maybe(!(date=ge=2021-03-15))    ≠    !maybe(date=ge=2021-03-15)
```

For a record dated `2021-03` the left is **true** (it might be before the 15th) and the right is
**false** (it might be on or after). Both answer real questions; the UI must make clear which is
being built.

Strict is the default: outside a `maybe(...)`, a maybe result excludes the record.

---

## 10. Operator vocabulary

The schema declares which operators apply to which types. The list below is the **initial
vocabulary**, not a grammar feature — the parser accepts any alphabetic comparator and resolution
decides.

| Operator | Types | Meaning |
|---|---|---|
| `==` `!=` | all | Equality; `*` wildcard on `string` |
| `=gt=` `=ge=` `=lt=` `=le=` | `integer`, `number`, `date` | Ordered comparison, lifted per §9.1 |
| `=in=` `=out=` | all | Membership in a value list |
| `=descendantOf=` | `hierarchical` | **Inclusive**: the named node and everything below it |
| `=isNull=` | all | `true`/`false` — the only way to select on missing data |
| `=isAmbiguous=` | `sequenceState`, `date` | `true`/`false` — candidate set has more than one member |

### 10.1 Hierarchical fields

- Aliases resolve before matching (`BA` ≡ `B.1.1.529`), so query and stored value need not agree in
  form.
- An organism may carry several independent hierarchies (Pango, Nextclade clade, subclade); each is
  its own field of type `hierarchical`. The same applies to host taxonomy and geography, which is
  where this generalization pays off: `geography=descendantOf=westAfrica` needs no new syntax.
- **OPEN**: recombinants have multiple parents. Proposed default — `=descendantOf=` does not traverse
  recombinant edges. Needs a decision from whoever owns the lineage definitions, and it may
  reasonably differ per hierarchy, which the schema can express.

### 10.2 Sequence states and insertions

- `nuc.3423=='A'` — state at an alignment position, lifted per §9.1.
- `'-'` is deletion. Query-side IUPAC codes expand to sets: `=='R'` means A or G.
- `nuc.3423!=ref` — the bare word `ref` is reserved, meaning the reference state at that position, so
  this selects any mutation there.
- `aa.S.501=='Y'` for amino acids.

Insertions are their own field families, with the same slots as the families they mirror:

- `nuc_ins.1234=='ATG'` — an insertion of `ATG` following alignment position 1234.
  `aa_ins.S.144=='KV'` likewise. The position names the aligned position the insertion *follows*;
  insertions do not consume a coordinate of their own.
- `*` wildcards apply to the inserted sequence: `nuc_ins.1234=='A*'` matches any insertion there
  beginning with A, and `nuc_ins.1234=='*'` matches any insertion at all.
- **Absent is not unknown**, the §9.1 distinction applied here: at a covered, aligned position with
  no insertion the term is **false**, a definite non-match. Where the region is not covered, the
  candidate set is unconstrained and the term is **maybe**, which `maybe(...)` picks up. This is the
  same rule that governs dates and ambiguity codes; insertions need no special case.

*Rejected alternative — VCF convention.* Encoding an insertion as a REF/ALT pair at a position
(`A` → `ATTG`) folds insertions into the substitution namespace, forces the value to carry reference
context that the query builder would have to look up, makes "any insertion here" awkward to express,
and gives insertions different slot handling from every other genome field. Separate families reuse
the existing machinery unchanged and keep one family per concept (principle 5). The cost is that a
tool consuming VCF has to translate, which is an adapter's job (§11.2).

### 10.3 Derived fields

Counts and summary statistics — `nucMutationCount`, `ambiguityFraction`, `coverage` — are ordinary
schema-declared fields of numeric type, not language features. `nucMutationCount.HA=ge=10` needs no
new syntax. Whether a given backend can compute them is an adapter question (§11), not a language
question. This is the intended shape of most future growth.

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

Node types: `and`, `or`, `not`, `maybe`, `cmp`. Slots are resolved, so the AST is
schema-independent downstream. `scope` records the organism set the query resolved against — it is
derived, not authored, and makes the §7.3 hazard detectable after the fact.

### 11.2 Targets

A target is an adapter from AST to some backend's request format. Every target declares what it
cannot express; none of them constrains the language. Target #1 is LAPIS, because it is what exists.

**LAPIS adapter notes.** LAPIS metadata filters are conjunctive: distinct fields AND, values within a
field OR, ranges via `<field>From`/`<field>To`. Boolean structure is available for mutations, not for
metadata. Normalize the filter to DNF and classify:

| Class | Condition | Output |
|---|---|---|
| A | One disjunct | One request |
| B | Disjuncts differ in exactly one field | One request, that field as an array |
| C | Boolean structure confined to the mutation subtree | One request with a variant query |
| D | Otherwise | N requests, with a warning |
| E | OR crosses the metadata/mutation boundary | No request; diagnostic |

Cross-organism queries fan out across per-organism endpoints and merge on core fields; that is a
further multiplier on class D.

Class D is correct for accession lists after deduplication and **wrong for aggregated counts**
(records matching two disjuncts are double-counted). The app must never silently emit a D-class
aggregation.

The classification is user-facing: it tells someone their query is well-formed but not currently
executable, which is a different thing from invalid, and it is exactly the signal that would justify
a `?query=` parameter server-side.

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
| Rename a field | No — requires a schema alias table, and the app rewrites on load |

Language version and schema version are independent and both travel in the AST.

---

## 13. Canonical forms

Two renderings of one AST.

**Strict** — unambiguous and self-contained: organism scope pinned explicitly, every slot filled,
every value quoted, only precedence-required parentheses, operand order preserved.

**Minimal** — shortest faithful rendering given the schema: scope terms dropped where the app's
context supplies them, inferable slots dropped, quotes dropped where the bare-token rule allows,
redundant parentheses dropped.

Both are URL-safe, and both erase comparator aliases (§5.5).

**Readable** (recommended third rendering, display only) — minimal, but spelled with `<=` `>=` `<`
`>`. For prose, documentation, and email, where the string is read by a person rather than put in a
URL. It parses back to the identical AST, but it is **not** URL-safe and the UI must label it as
such, and must not use it for permalinks.

Operand order is **never** rewritten. Reordering would destroy user intent for no gain; determinism
comes from source order.

**Round-trip requirement** (requirement 2 of the overview), precisely:

```
canon(parse(canon(parse(s)))) == canon(parse(s))
```

for both renderings, and `resolve(parse(strict(q))) == resolve(parse(minimal(q)))` as ASTs. The app
checks this on every render; a failure is a bug, not user error.

---

## 14. Application

### 14.1 Requirements

From the overview: build queries as groups of filters combined with AND/OR, with nesting and
negation; validate by parsing, resolving, and checking the round-trip identity; display strict and
minimal renderings side by side; emit JSON; static, deployable to GitHub Pages.

Added:

1. **Import** — paste a query string and populate the UI from it. Without this, shared strings are
   read-only and the round-trip check has no user-visible purpose.
2. **Permalink** — full app state in the URL.
3. **Errors with offsets** — parse and resolve errors point at a character range.
4. **Scope indicator** — the UI shows which organisms the current query applies to, live. With
   cross-organism queries this is the single most important piece of feedback: it explains why an
   organism-scoped field is unavailable, and what filter would make it available.
5. **Live check** (recommended) — run the query and show a hit count. Makes validation real rather
   than syntactic.

### 14.2 Schema sourcing

Static and cross-origin, so the app needs a CORS-enabled configurable instance URL. Per organism it
needs field names, types, and enum values; reference, segment, and CDS names; which fields are
hierarchical, plus hierarchies and alias maps. Across organisms it needs the core field list and the
organism taxonomy.

**OPEN — verify against a live instance**: which of these the target LAPIS deployment actually
exposes, and in what shape. Some may have to be bundled with the app or served as a static schema
document alongside it. Do not design around remembered endpoint names.

The core field registry and the organism taxonomy are **governance** artifacts as much as technical
ones — someone has to own which fields are harmonized across organisms and what the taxonomy is. The
language depends on that decision existing; it does not depend on which way it goes.

### 14.3 Packaging

Parser, resolver, renderers, and target adapters ship as a standalone dependency-free package; the
web app is one consumer. Alongside it, a **conformance corpus** in JSON: input → strict → minimal →
AST → target output or diagnostic, including error cases with offsets, and specifically including the
scope-rule cases in §7.2. This is what a second implementation would be tested against.

---

## 15. Open questions

1. **Core field registry and organism taxonomy** — who owns them, and what is in them (§14.2). Blocks
   cross-organism search more than anything technical.
2. **Schema endpoints** — verify against a live instance (§14.2).
3. **Segment and CDS identity across organisms** — the scope rule needs "the HA segment" to mean the
   same thing across influenza A subtypes. Is that declared, or inferred from name equality? (§7.2)
4. **Recombinant traversal** in `=descendantOf=` (§10.1).
5. **`set<T>` semantics** — for multi-valued fields, does `==` mean "contains" or "equals the set"?
   Proposal: `=in=` for membership, `==` for set equality, but this needs a real use case first.
6. **Field naming convention** (§5.6) — `_` for family composition with camelCase elsewhere, or
   snake_case throughout?
7. **Literal `*` escaping** (§5.4) and **case sensitivity as a type property** (§5.4).
8. **Maximum practical query length** before a permalink cannot carry the query.
9. Confirm sort/fields/limit are out of scope (§1).
10. Confirm the readable rendering (§13) is wanted — it is the natural home for the friendly
    comparators, but it is a third string for users to choose between.
