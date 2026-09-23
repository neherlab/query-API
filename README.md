# Sequence query builder

A static web app for building filter queries over a sequence database. It builds FIQL/RSQL query
strings, checks them, renders them in canonical forms, and translates them to JSON and to a backend
request format.

The language is specified in [`spec.md`](spec.md) (draft 0.2); [`overview.md`](overview.md) is the
original statement of intent. Section references in the code point at the spec.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # conformance corpus, semantics, scope rules, adapter, UI
npm run build    # static bundle in dist/
```

## What it does

- **Builds** filters as nested AND/OR groups, with negation and `maybe(...)`.
- **Validates** in two passes: parse (schema-free) then resolve (against the schema), so syntax
  errors and "not meaningful here" errors are reported differently, both with character offsets.
- **Renders** three canonical forms — minimal, strict, and readable — and checks the round-trip
  identity of §13 on every render.
- **Emits** the versioned JSON AST, which is the canonical output.
- **Translates** to LAPIS where possible, and says plainly when it is not.
- **Imports**: paste a query string and the builder populates from it.
- **Permalinks**: the whole state lives in the URL (`?q=…&schema=…`).

## Cross-organism queries

`organism` is an ordinary hierarchical field, not a grammar special case, and scope lives in the
query rather than beside it — so every query string means the same thing wherever it is read. What a
query may reference follows from its scope (spec §7.2):

```
host==duck;collectionDate=ge=2024                     every organism — core fields only
organism=descendantOf=influenzaA;length.HA=ge=1600    three subtypes — HA means the same for all
organism==sars2;nuc.23403==G                          one organism — everything available
nuc.23403==G                                          rejected: nuc does not resolve identically
```

The scope indicator above the builder shows which organisms are in play and what would make an
unavailable field available. The organism control beside it is the one place an organism is chosen —
it offers the taxonomy and writes a single top-level conjunct (`=descendantOf=` for a group, `==` for
one organism), so the filter rows do not offer the field as well.

## Layout

```
src/lang/        the language: lexer, parser, resolver, renderers, JSON, evaluator
src/lang/targets backend adapters (LAPIS today)
src/schema/      schema model consumers + the bundled demo schema
src/ui/          the builder app
test/corpus.json the conformance corpus
```

`src/lang/` has no dependency on the UI, the DOM, or any backend. It is the piece a server-side
implementation of `?query=` would be tested against, which is why the corpus records inputs against
canonical strings, ASTs, and diagnostics with offsets rather than against screenshots.

`src/lang/eval.ts` is a reference implementation of the three-valued semantics (§9). The app has no
sequence data and never runs it; it exists so the rules are executable and testable.

## Schema

The bundled schema is a **demonstration, not real data** — six organisms chosen to exercise the
awkward cases (segmented and unsegmented genomes, multiple references, a declared slot default,
per-organism lineage systems).

Point the app at a real one with `?schema=<url>`, serving the shape in `src/lang/schema.ts`. Which
endpoint should serve it is open question §15.2 in the spec: **verify against a live instance before
relying on it.** The same caveat applies to the LAPIS adapter's parameter names — the expressibility
classification is sound regardless, but the field names in the emitted bodies are provisional.

## Deployment

`.github/workflows/deploy.yml` builds and publishes `dist/` to GitHub Pages on push to `main`. The
build runs `npm test` first, so a deploy cannot ship a build whose canonical renderings disagree with
the corpus. `vite.config.ts` sets `base: './'`, so it works from any sub-path without configuration.
