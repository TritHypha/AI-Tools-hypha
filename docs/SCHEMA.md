# hypha — fact-table schema

**Eleven tables, under nine headings** — `kind_sets`/`kind_set_members` and
`exported_checkers`/`checker_call_sites` are each documented as a pair, because neither half is
meaningful alone. Each row is one extracted fact with the `file:line` it came from, so every claim
a query makes can be checked by hand in seconds. A `map` run **drops and recreates** every one of
these eleven **fact** tables: facts are cheap to extract, and stale rows are worse than no rows.
It does **not** touch `verified_surface`, which `sporeprint` writes and which is evidence rather
than extraction — see [SPOREPRINT.md](SPOREPRINT.md).

The database is the queryable artifact — every query in `queries.js` is SQL over these tables —
and `sporeprint` writes into the *same* file, so static visibility can be joined against runtime
ground truth. See [SPOREPRINT.md](SPOREPRINT.md).

---

## `gate_names` — the ONE named routing set

```sql
gate_names (name TEXT, section TEXT, line INTEGER)
```

Extracted from `STD_METHOD_NAMES` in `interpreter.js`: the single named set that decides method
dispatch.

| column | meaning |
|---|---|
| `name` | the method name, e.g. `push` |
| `section` | the author's own `// Array`, `// Map`, `// String` comment above the run of names |
| `line` | line in `interpreter.js` |

**Why `section` is preserved.** It is the author's taxonomy, stated in their own words. A query
that groups by it is grouping by intent rather than by a grouping the tool invented.

---

## `stdlib_cases` — the implementations

```sql
stdlib_cases (name TEXT, file TEXT, line INTEGER)
```

Every `case "name":` arm in `stdlib.js` — where a method is actually implemented, as opposed to
merely routed.

---

## `inline_cases` — the per-receiver fallback tables

```sql
inline_cases (receiver_tag TEXT, name TEXT, file TEXT, line INTEGER)
```

The interpreter's `if (receiver.__tag === "list") { switch (method) { … } }` tables. A third,
independent place a method name can be handled.

| column | meaning |
|---|---|
| `receiver_tag` | the `__tag` guarding the table — `list`, `map`, `string`, … |

**This table is the reason `surface` exists.** `.push()` was once judged unsupported because only
this layer was read; it was in `gate_names` the whole time.

---

## `kind_sets` + `kind_set_members` — the sentinel sets

```sql
kind_sets        (set_id INTEGER, file TEXT, line INTEGER)
kind_set_members (set_id INTEGER, member TEXT)
```

Every `Set` literal anywhere in `dist/` whose members look like AST node kinds. Split across two
tables so membership is queryable relationally — set comparison is the whole point, and comparing
comma-joined strings would make near-miss detection impossible.

`set_id` is a positional index assigned at extraction. **It is not stable across runs** and must
never be stored outside a single database.

---

## `pass_calls` — what the CLI wires in

```sql
pass_calls (name TEXT, file TEXT, line INTEGER, text TEXT)
```

Call sites of `check*` / `verifyGovernance` in `cli.js` — the checkers the package CLI actually
invokes, as distinct from the checkers that exist. `text` keeps the whole source line, because the
*mode* guarding a call (`if (PRODUCTION_STRICTNESS_MODES.has(mode))`) is usually on it.

---

## `exported_checkers` + `checker_call_sites` — existence vs. reachability

```sql
exported_checkers (name TEXT, file TEXT, line INTEGER, is_checker INTEGER)
checker_call_sites(name TEXT, file TEXT, line INTEGER)
```

| column | meaning |
|---|---|
| `is_checker` | `1` when the name matches the `check*` convention; `0` for other exports |

`checker_call_sites` is populated during extraction rather than at query time, so the queries stay
pure SQL. **The definition line is filtered out** — a "call site" inside the defining file at the
definition line is the definition leaking through the matcher, and leaving it in would make every
checker look alive.

A checker present in `exported_checkers` with **no** rows in `checker_call_sites` is a fully-built
gate that never runs.

---

## `parser_kinds` — what the parser can produce

```sql
parser_kinds (kind TEXT)
```

Every flow-declaration node kind the parser can emit. The reference set `kind_coverage` diffs the
sentinel sets against.

> ⚠️ **The code says four; the committed artifact says one.** `extractParserKinds` was repaired on
> 2026-08-06 and now finds all four — `governedFlowDecl`, `guardedFlowDecl`, `pureFlowDecl`,
> `secureFlowDecl`. The mirror in this repository was built **before** that fix and still holds the
> single `governedFlowDecl`. **Re-`map` before reading `kind-coverage`**; a run against the stale
> base cannot report a gap, because a reference set of one has nothing to be missing from it. See
> [LIMITS.md](LIMITS.md) items 4 and 11.
>
> With the reference set correct, `kind-coverage` reports **17 of 19** extracted sets missing
> `governedFlowDecl` — the number it reported as zero for as long as the anchor was wrong.

---

## `diagnostics_codes` — the code universe

```sql
diagnostics_codes (code TEXT, file TEXT, line INTEGER, context TEXT)
```

Every `FUNGI-*` code appearing anywhere in `dist/`, with the nearest message text as `context` so
codes can be searched by meaning rather than by number.

**Presence here is not reachability.** A code can appear in source and never fire — `FUNGI-NUMERIC-001`
does exactly that, its trigger set being empty. This table is the code *universe*, not live
behaviour; whether a code can fire is an execution question.

---

## `meta` — provenance of the run

```sql
meta (key TEXT, value TEXT)
```

`root` (the mapped checkout) and `builtAt` (ISO timestamp). Two rows, so a report can never be
mistaken for a fresh one, and a stale DB identifies itself.

---

## The JSON mirror — the same facts, a **different shape**

`map` also writes `<db>.json`: portable, diffable in a pull request, and readable without SQLite.
`--in-memory` suppresses it along with the database — a throwaway scan has no baseline to diff
against.

It is `JSON.stringify(facts)` — the in-memory fact object, **before** it is flattened into rows.
So the mirror is not the schema above in another syntax: the relational splits that exist for
*queryability* are un-split, and the keys are camelCase. Both artifacts carry the same facts; only
the DB carries them in the shape the queries are written against.

**This matters more than it looks**, because `--in-memory` answers from the fact object directly.
In passive mode the shape below is the only shape there is.

| mirror key | table(s) | how the shape differs |
|---|---|---|
| `root`, `builtAt` | `meta` | two scalars, not two key/value rows |
| `gateList` | `gate_names` | one object `{ file, startLine, names }`, not a row per name — and it keeps `file`/`startLine`, which the table does not have |
| `stdlibCases` | `stdlib_cases` | same shape |
| `inlineTables` | `inline_cases` | ★ **one entry per receiver table, holding `cases[]`** — the DB stores one row per *case* |
| `kindSets` | `kind_sets` + `kind_set_members` | ★ **`members[]` inline** — the DB splits membership into a join table |
| `passCalls` | `pass_calls` | same shape |
| `exportedCheckers` | `exported_checkers` | `isChecker` is a **boolean**; the column is `is_checker INTEGER` |
| `checkerCallSites` | `checker_call_sites` | ★ **an object keyed by checker name** → `[{file,line}]`. The table is flat rows. **A checker with no call sites is an empty array here, but simply has no rows there** — see the warning below |
| `parserKinds` | `parser_kinds` | an array of strings, not a row per kind |
| `diagnostics` | `diagnostics_codes` | ★ **the name differs** — mirror `diagnostics`, table `diagnostics_codes` |

**Why they are allowed to differ.** The splits exist to make membership *relationally* queryable
(see `kind_sets`); JSON can nest, so it does, and a reader diffing two mirrors sees a set change as
one changed array rather than as a scatter of join-table rows. **The cost is that a query written
against one shape does not run against the other**, which is why `queries.js` is SQL-only and the
mirror is for reading and diffing rather than querying.

> ⚠️ `set_id` is positional and unstable across runs (see `kind_sets`). It does not appear in the
> mirror at all — nesting removes the need for it — so a mirror diff is stable where a raw
> table diff is not.

> ⚠️ **The dead-gate test is spelled differently in each artifact.** `exported_checkers` documents
> that a checker with **no rows** in `checker_call_sites` is a fully-built gate that never runs. In
> the mirror that same checker is **present with an empty array** — `"generateAttestationKey": []`.
> A reader who transliterates the SQL test into JSON by asking *"is the key missing?"* gets **zero
> dead gates**, every time, and the answer looks like good news. **Ask whether the array is
> empty.**
