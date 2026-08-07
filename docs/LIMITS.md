# hypha — limits and caveats

What this tool cannot tell you, written as plainly as what it can. A capability map that
overstates its own reach is worse than none: it converts "I do not know" into "I checked."

**The one-line summary: hypha produces CANDIDATES, not verdicts.** Every claim carries a
`file:line` precisely because the next step is meant to be a human — or an execution probe —
confirming it.

---

## 1. Static extraction, not execution ★ the important one

hypha reads text. It never runs the compiler.

So it answers *"where is this name written?"*, never *"what happens when this runs?"* Those come
apart constantly:

| static says | runtime may say |
|---|---|
| a name is in all three layers | the dispatch is guarded by a mode flag and never reached |
| a name is in no layer | it is handled by the registry or the runtime, which this map does not model |
| a diagnostic code exists | its trigger set is empty and it can never fire (`FUNGI-NUMERIC-001`) |
| a checker has call sites | every one is behind a branch that production never takes |

**A black-box static probe can establish presence. It can never establish absence.** If a query
returns nothing, that is a fact about the query until the enforcement point has been read directly.
For execution-verified answers, use `sporeprint` — see [SPOREPRINT.md](SPOREPRINT.md).

---

## 2. It maps `dist/`, not `src/`

Extraction targets the compiler's built JavaScript. That is deliberate — it maps what *ships*,
which is also what *runs* — but it has consequences:

- **A stale `dist/` produces a confident, wrong map.** hypha cannot tell a stale build from a
  current one. Check your build before trusting a run.
- **TypeScript-only constructs are invisible** — types, interfaces, `const enum` members that
  compile away.
- Galerina's own `scripts/audit-*.mjs` read `src/*.ts` instead. When hypha and an audit disagree,
  **check whether `dist/` is current before concluding anything about either.**

---

## 3. The extractors are heuristic

Line-based, anchored on tokens that exist because of what the code *means* rather than how it is
laid out — but heuristics miss. A set literal split unusually across lines, a declaration behind a
macro-like helper, an unconventional `case` layout: each can be skipped silently.

**Silently is the operative word.** A missed extraction looks exactly like an absent fact. This is
why every row carries `file:line`, and why a clean result should prompt "did the extractor see
this file at all?" before "the codebase is clean."

---

## 4. `parser_kinds` held ONE row — ✅ fixed 2026-08-06

**Kept as a worked example, because the failure mode is the one this whole file is about.**

`extractParserKinds` anchored on `kind: "…FlowDecl"` and found exactly one kind,
`governedFlowDecl`. Reading `parser.js` settled why: only the governed *re-tag* is written as an
object-literal property. The three tier kinds are assigned to a local first —

```js
const kind = qualifier === "secure"  ? "secureFlowDecl"
           : qualifier === "pure"    ? "pureFlowDecl"
           : qualifier === "guarded" ? "guardedFlowDecl"
```

— so the anchor was measuring the parser's **coding style**, not the kinds it produces.

**Why it was worse than a simple miss.** `kind-coverage` flags a set that contains *some*
reference kind and is missing another. With a reference set of one, a set containing that kind has
nothing missing, and a set lacking it is skipped as "not a gating set". **The query could not
report anything, ever.** It returned zero gaps, which reads exactly like a clean bill of health.

**After the fix** — anchor on the string literal, scoped to `parser.js`: 4 kinds, and
`kind-coverage` reports **17 gating sets missing `governedFlowDecl`** where it previously reported
zero.

The lesson, which generalises to every query here: **a query is only as good as its reference set,
and a vacuous reference set fails silent-green rather than red.**

---

## 5. `unimplemented` is a list of questions

`surface` with no name reports gate-listed names with no stdlib arm and no inline arm. That means
*this map does not model where they are handled* — the registry and the runtime are not extracted
layers. Reading the list as "unimplemented methods" would be exactly the `.push()` mistake the
tool was built to prevent, one level up.

**Measured 2026-08-06 against the committed fact base (see item 11): the list is empty — 0 of 118
gate-listed names lack both arms.** 178 distinct stdlib arms and 49 distinct inline arms cover all
of them. ★ **An empty list here is the good case, and it is also the case that most needs a
control**: a broken extractor produces the same empty list. The check that distinguishes them is
`.push` — it must appear in the gate list *and* in `stdlib`, which it does. If `surface` ever
reports zero while `.push` has stopped resolving, the extractor is what changed.

---

## 6. `set_id` is positional and unstable

Assigned at extraction order. It is meaningful only within one database and **must never be stored
or compared across runs**.

---

## 7. Overlap with tools Galerina already has

Stated so nobody adopts hypha for a job that is already done better:

| query | overlap |
|---|---|
| `dead-exports` | **duplicates** `scripts/audit-checker-wiring.mjs`, which knows the pipeline's call graph. That audit is the authority. |
| `duplicate-sets`, `kind-coverage` | partial overlap with the existing drift audits |
| `surface` | **no equivalent** — `STD_METHOD_NAMES` and the inline fallback tables are read by **0** of the **169** scripts under `Galerina/scripts/` *(measured 2026-08-06; control: 27 of the same scripts mention `parseProgram`, so the scan can find a symbol)* |

The case for hypha rests on `surface`.

---

## 8. Requirements

- **Node ≥ 22.5** for the built-in `node:sqlite`. No npm installs, ever.
- A Galerina checkout, which is **read-only** to this tool: every write goes to `--db`, or nowhere
  at all under `--in-memory`.

---

## 9. Known-good behaviours worth relying on

Not everything here is a caveat. These are proven and may be depended on:

- **The target checkout is never written to.** Verified by a test that snapshots the tree around a
  run.
- **`--in-memory` leaves nothing behind** — no `.db`, no `.json` mirror. Verified against a
  control that proves the same command *does* write without the flag; without that control, "zero
  files" would equally mean the command did nothing.
- **`findAllCallSites` matches `findCallSites` exactly** — **re-proven 2026-08-06 across all 340
  exported checkers, 0 mismatches**, including the five `.gate` v3 additions (item 11, axis 2).
  Both engines were shown discriminating first: an invented name returns 0 sites from each, and a
  known name returns the same non-zero set from each. Same run measured the fast path at **368 ms**
  against **17,207 ms** for the per-name reference — **46.8×**, matching README's 46×.
  ⬜ It remains a proof about **a corpus at a moment**, not a standing guarantee: it must be re-run
  whenever the checker count moves.

---

## 10. Roadmap

- **Re-map after an extractor change** — see item 11. The highest-value repair here is no longer a
  code change; it is making a stale fact base announce itself.
- A surface lane for the WASM/SLIDE backend once the DSS rewrite lands.
- Near-duplicate clustering across **all** set literals, not just flow-kind sets.

*(The former first entry, "fix `extractParserKinds`", was completed on 2026-08-06 and is written up
as item 4. It survived here for a while after it stopped being true — which is itself the argument
for item 11.)*

---

## 11. ★ The committed fact base can be older than the extractor that built it

**Measured 2026-08-06: `src/extract.js` is 14.1 hours newer than `hypha.db.json`.** So the shipped
mirror still reports **one** parser kind, while the current extractor finds **four**.

Nothing is broken. `map` rebuilds every table, so the next run is correct. But between an extractor
change and the next `map`, **the artifact and the code disagree, and neither says so.**

This is item 2 turned on the tool itself:

> *A stale `dist/` produces a confident, wrong map. hypha cannot tell a stale build from a current
> one.*

★ **The same sentence is true with `dist/` replaced by `hypha.db`.** A tool whose central warning is
about trusting stale artifacts ships one.

**What to do until this is fixed in code:** treat `builtAt` in `meta` (or the mirror's top-level
`builtAt`) as load-bearing, and re-`map` after any change under `src/`. A run whose `builtAt`
predates your last extractor edit is measuring the previous extractor.

### Two independent axes, and the first proposal only covered one

A fact base goes stale for **two unrelated reasons**, and they need different guards:

| axis | what moved | example, measured 2026-08-06 |
|---|---|---|
| 1 — the **extractor** | `src/extract.js` | repaired 14.1 h after the base was built; `parser_kinds` 1 → 4 |
| ★ 2 — the **target** | Galerina's `dist/` | 20.2 h newer than the base; **335 → 340** exported checkers |

The five added are `dispatchGateSource`, `parseGateV3`, `formatGateV3`, `verifyGateV3Structure`,
`analyzeGateV3Liveness` — a `.gate` v3 front-end that did not exist when the base was built.

**Proposal.** `map` should record, alongside `builtAt`:

- `extractorSha` — a hash over `src/extract.js`, and
- ★ `targetSha` — a hash over the mapped `dist/` file list and mtimes,

and every query should refuse, or at minimum warn, when either differs from what it finds now.

> ⚠️ **The first version of this item proposed only `extractorSha`.** That guard is **blind to axis
> 2**: the extractor can be byte-identical while the codebase it measured has moved underneath.
> Recorded rather than quietly amended, because a half-guard that looks like a whole one is the
> failure this file exists to describe — see item 4.

This is the same shape as the `set_id` rule in item 6: **a value that is only meaningful within one
run should be checked, not trusted, when it crosses out of it.**

---

## 12. ★★ `inline_cases` contains a switch that is not a dispatch table — 25 names overstated

**Measured 2026-08-06.** The inline extractor produces six tables. Five carry a real receiver tag
(`string`, `int`, `decimal`, `bool`, `list`). The sixth is tagged **`unresolved`** — meaning the
extractor could not attribute it to a receiver — and it holds **29 cases that are not methods at
all**. It is two unrelated switches, merged:

| source | lines | what it really is |
|---|---|---|
| `interpreter.js` | 3019–3044 | ★ a **`safeDisplay` value-kind formatter** — `case "verdict": return … "Allow"`, `case "record": return \`{…}\`` |
| `interpreter.js` | 3215–3218 | ★ the **string-escape decoder** — `case "n": return "\n"`, `case "0": return "\0"` |

`"0"`, `"n"`, `"t"`, `"r"` are `\0 \n \t \r`. **None of the 29 is a method name.**

### What it does to `surface`

| | with `unresolved` | without |
|---|---:|---:|
| universe total | 185 | **181** |
| asymmetric | 168 | **164** |
| ★ names whose **layer count is wrong** | — | ★ **25** |

The 25 — `string`, `char`, `int`, `int64`, `uint64`, `float`, `byte`, `bytes`, `decimal`, `bool`,
`verdict`, `secure`, `protected`, `redacted`, `none`, `void`, `some`, `ok`, `err`, `record`, `list`,
`unresolved`, `runtimeError`, `function`, `error` — are each reported as present in **2** layers
when they are present in **1**.

> ★★★ **This is the `.push()` incident inverted.** `.push()` was judged *unsupported* because only
> one layer was read — a **false absence**. Here the tool reports a name as *handled by an inline
> dispatch table* when that table is a display formatter — a **false presence**. Item 1 says a
> static probe can establish presence but never absence; this is the reminder that **presence is
> only as good as the layer's definition.**

### Proposal

1. **Drop `unresolved` tables from the surface union.** A table the extractor could not attribute to
   a receiver is not evidence that a name is dispatched — it is evidence the extractor found *a
   switch*. Fail closed: an unattributed switch contributes nothing.
2. Keep extracting it, reported separately as `unattributed_switches`, so the signal is not lost —
   an unattributed switch near a dispatch site is worth a human look.
3. ★ **Anchor the extractor on the receiver guard**, not on switch shape. The five good tables were
   found by their `receiver.__tag === "…"` guard; the bad one had no guard and was taken anyway.
   **The guard is the thing that makes a switch a dispatch table.**

### ✅ Fixed 2026-08-06 in the Galerina devtool

All three proposals landed in `packages-galerina/galerina-devtools-hypha`:

| | before | after |
|---|---:|---:|
| `surface` universe total | 185 | **181** |
| asymmetric | 168 | **164** |
| `--scan full` findingCount | 361 | **357** |
| names with an overstated layer count | 25 | **0** |
| the phantom method `"0"` | present | **gone** |

★ The uncertainty is **reported, not discarded** — `surface` now returns
`unattributedSwitches: [{ at: "interpreter.js:2726", cases: 29 }]`. It is **context, not a finding**:
a switch beside real dispatch is a lead worth a human glance, and leads do not belong in a CI
count.

Three self-test cases hold it in place, each proven to fail when the behaviour is reverted:
an attributed table **does** put a name in the inline layer (`layers=2`); an unattributed one
**does not** (`layers=1`); and the unattributed table is **still reported**.

> ⬜ **This subproject's own `hypha.db.json` still carries the old figures** — it predates the fix,
> exactly as item 11 describes. The corrected numbers come from the devtool, which is in-memory and
> has no artifact to go stale.

## ★ The JSON mirror carries only the static lane

`hypha.db.json` is written by hypha's own exporter, which knows the fact tables it
builds. `verified_surface` is written by `sporeprint` and is **absent from the
mirror** — confirmed against the shipped file, whose top-level keys are the fact families only.

| consumer | sees |
|---|---|
| `hypha.db` (SQLite) | ★ both lanes |
| `hypha.db.json` | ⬜ **static only** |

★★ So a tool that reads the JSON mirror cannot perform the sporeprint join at all, and will not
be told that it cannot — it will simply see no runtime lane and report the static one as though it
were the whole picture. ⬜ If the mirror is your interface, the four-quadrant reading in
[SPOREPRINT.md](SPOREPRINT.md) is unavailable to you.
