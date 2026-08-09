# hypha — query reference

Five queries. Each exists because a real defect of its class was found **by hand first**; the
incident is stated with each one, because a query whose motivating failure you cannot name is a
query nobody knows when to trust.

```bash
node src/cli.js query <name>[:<arg>] --root <galerina-checkout> [--in-memory]
```

Output is JSON on stdout. Progress goes to stderr, so `| jq` works.

| query | argument | answers |
|---|---|---|
| [`duplicate-sets`](#duplicate-sets) | — | which sentinel sets were hand-copied and then drifted? |
| [`kind-coverage`](#kind-coverage) | — | which parser-producible kinds does a gating set omit? |
| [`dead-exports`](#dead-exports) | — | which exported checkers are never called? |
| [`surface`](#surface) | optional method name | where is a name visible, **layer by layer**? |
| [`diagnostics`](#diagnostics) | optional keyword | what is the diagnostic-code universe? |

---

## `duplicate-sets`

**The incident.** `FLOW_KINDS` existed at four sites. The parser gained `governedFlowDecl`; one
copy was updated and the others were not. Governed flows were silently skipped by checkers and
unrunnable by the flow index. Nothing failed — the sets simply disagreed.

**Returns** `{ drift, duplicates }` — two different problems, deliberately separated:

| field | meaning |
|---|---|
| `drift` | pairs overlapping by **≥3 members** with *different* membership, each with `onlyA` / `onlyB` |
| `duplicates` | sets with *identical* membership at more than one site |

```json
{ "drift": [ { "a": "checker.js:41", "b": "index.js:88",
               "onlyA": ["governedFlowDecl"], "onlyB": [] } ],
  "duplicates": [ { "members": ["flowDecl","guardedFlowDecl"],
                    "sites": ["a.js:12","b.js:30"] } ] }
```

**Why ≥3.** Below three shared members, two sets are plausibly unrelated and the pairing is noise.
Three is where "same intent, one copy moved on" becomes the likelier explanation.

**`duplicates` is not yet a defect** — it is a consolidation target, and a drift waiting to happen.
Reported separately so it never inflates a defect count.

---

## `kind-coverage`

**The incident.** The same failure from the other side: the parser gained a kind and every gating
set ignored it. Pure negative space — no test can notice the absence of a case nobody wrote.

**Returns** `{ parserKinds, gaps, setsExamined, setsSkippedNotGating }`; each gap carries `site`,
`missing`, `has`.

The reference set is the 4 flow-decl kinds `parser.js` emits: `pureFlowDecl`, `guardedFlowDecl`,
`secureFlowDecl`, `governedFlowDecl`. A set containing *some* of them and missing another is a
gap; a set containing none is not a gating set and is **skipped** (`setsSkippedNotGating`) rather
than reported as "missing every kind".

> **Read a gap as a candidate, not a defect.** Some exclusions are correct by design — the
> execution lanes (`interpreter.js`, `runtime.js`, `bytecode-vm.js`) legitimately exclude governed
> flows, which cannot execute. A gap in a *checker* set is the one worth reading, because that is
> the shape of the original incident: a kind the parser produces that a gate does not know about.

> **Historical note worth keeping.** Until 2026-08-06 the reference set held **one** kind, which
> made this query vacuous — it could not report anything, and returned zero gaps. It now reports
> 17. A query is only as good as its reference set, and a vacuous one fails silent-green.
> See [LIMITS.md](LIMITS.md) §4.

---

## `dead-exports`

**The incident.** `checkEvents` was implemented, exported and imported — and called by nothing, so
`FUNGI-EVENT-001` was unreachable from the package CLI in every mode. A fully-built gate that never
runs is a fail-open wearing the costume of a feature.

**Returns** exported checkers with **zero** call sites, each with `name`, `file`, `line`,
`is_checker`.

**Scope, stated plainly.** Call sites are counted across `dist/` **and** the root `galerina.mjs`,
because the public CLI imports `dist/index.js` and a checker dead within `dist/` can still be alive
from the root. Omitting the root would make "dead" dishonest.

**Overlap you should know about.** Galerina ships `scripts/audit-checker-wiring.mjs`, which answers
this more thoroughly — it knows the pipeline's call graph rather than counting call sites. Where
they disagree, **that audit is the authority**; treat this query as a cross-check.

---

## `surface`

**The incident.** `.push()` was judged absent because only the interpreter's inline fallback table
was read. It was in the gate list the whole time. One layer was mistaken for the whole surface.

### `surface:<name>` — one name

```json
{ "gate":   [ { "section": "Array", "line": 812 } ],
  "stdlib": [ { "file": "stdlib.js", "line": 1043 } ],
  "inline": [] }
```

Three layers, always all three, **an empty layer reported as empty rather than omitted**. Absence
is the finding; a shape that hides it defeats the query.

### `surface` — no name

Summary plus `unimplemented` and `unattributedSwitches`:

| field | meaning |
|---|---|
| `unimplemented` | gate-listed names with no stdlib arm *and* no **attributed** inline arm |
| `unattributedSwitches` | switches extracted but not under a `receiver.__tag` guard — **context, not findings** |
| `inlineTags` | attributed receiver tables only (`unresolved` excluded) |

**Read `unimplemented` carefully.** It means *this map does not model where the name is handled* —
the registry and the runtime are not extracted. It is a list of questions, not a list of bugs.

**Read `unattributedSwitches` carefully.** Presence here is not evidence a method is dispatched
(LIMITS §12). The extractor keeps the lead; the surface union fails closed.

---

## `diagnostics`

Added so that "does **any** checker warn about X?" is a query rather than a hand search — a hand
search cannot support an exhaustiveness claim.

- `diagnostics` — every `FUNGI-*` and `GATE-*` code with a site count and first location.
- `diagnostics:<keyword>` — codes whose surrounding message text matches. Pipe-separated
  alternatives: `diagnostics:narrow|truncat|precision` or `diagnostics:SEM-001|WIRE-101`.

**Presence is not reachability.** `FUNGI-NUMERIC-001` appears in source and can never fire — its
trigger set is empty. This is the code *universe*. Whether a code fires is an execution question,
and static extraction cannot answer it.

**Upstream only.** The Galerina-side devtool (`@galerina/devtools-hypha`) ships the other
four queries and not this one. It also carries one this tool does not — `name-set-drift`, which
needs a fact family upstream does not extract. Its exit code is a finding count, and a census has no findings to
count — it would always exit `0`, which reads as *clean* rather than *not a check*. Run
this query here.

---

## Exit codes

| code | meaning |
|---|---|
| `0` | the query ran |
| `2` | usage error — unknown query, or no `--root`/`GALERINA_ROOT` |
| `3` | fact base is stale and `--stale refuse` was set |

`query` does **not** exit non-zero on findings: it answers a question, and whether the answer is
bad news is the reader's judgement. For CI gating use the Galerina-side devtool
(`@galerina/devtools-hypha`), which exits `1` when findings are present.

## Status command (CLI — not a query)

```bash
node src/cli.js status --root <galerina> [--db hypha.db] [--in-memory]
```

JSON: `{ meta, freshness, counts }`. Use it to see whether `extractorSha` / `targetSha` still match
before trusting a persisted DB. Not listed in the query table above: it is a CLI command that
inspects provenance, not a drift/coverage question over the fact tables.
