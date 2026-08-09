# hypha

**Static capability-map for Galerina.** Extracts the compiler's dispatch surfaces, sentinel sets
and checker wiring into SQLite, then runs deterministic drift/coverage/dead-code queries over it.

Named for the threads that connect a mycelium: hypha connects the *layers* a capability fact lives
in, so no single layer is ever mistaken for the whole surface again.

```bash
# ask a question, leave nothing behind
node src/cli.js query surface:push --root <galerina-checkout> --in-memory

# build a fact base you can diff, and a full report
node src/cli.js report --root <galerina-checkout> --db hypha.db --out report.md
```

---

## Documentation

| | |
|---|---|
| [docs/QUERIES.md](docs/QUERIES.md) | the five queries, the incident behind each, output shapes |
| [docs/SCHEMA.md](docs/SCHEMA.md) | the ten fact tables, column by column |
| [docs/LIMITS.md](docs/LIMITS.md) | ★ **read before trusting a result** — what this tool cannot tell you |
| [docs/SPOREPRINT.md](docs/SPOREPRINT.md) | joining static visibility against runtime ground truth |
| `npm run check-docs` | doc-to-source parity for everything these documents make **executable** — quoted schemas, query names, exit codes, CLI commands and **flags**. Exit `1` on a mismatch, `2` if nothing could run, `SKIPPED` when sporeprint is not reachable |

---

## Why it exists

Four real defects were found **by hand** before this tool. Each is now one of its queries — which
is the whole design principle: a query whose motivating failure you cannot name is a query nobody
knows when to trust.

| incident | query that would have caught it |
|---|---|
| `.push()` judged absent because only the interpreter's inline fallback table was read — the gate list had it all along | `surface` |
| `FLOW_KINDS` hand-copied at 4 sites; none gained `governedFlowDecl`, so governed flows were skipped by checkers and unrunnable by the flow index | `duplicate-sets` |
| `checkEvents` exported, imported — and called by nothing: `FUNGI-EVENT-001` unreachable from the package CLI in every mode | `dead-exports` |
| parser gained `governedFlowDecl`; every gating set silently ignored it | `kind-coverage` |

A fifth, `diagnostics`, was added later so that *"does **any** checker warn about X?"* became a
query rather than a hand search — a hand search cannot support an exhaustiveness claim.

---

## Commands

```
hypha map    --root <galerina> [--db hypha.db]                build the fact DB (+ .json mirror)
hypha report --root <galerina> [--db hypha.db] [--out FILE]   map + full markdown report
hypha query  <name>[:<arg>] --root <galerina> [--db hypha.db] one query as JSON
hypha status --root <galerina> [--db hypha.db]                counts + freshness (JSON)
```

`--root` falls back to `GALERINA_ROOT`. Queries: `duplicate-sets`, `kind-coverage`,
`dead-exports`, `surface[:name]`, `diagnostics[:keyword]`.

`--stale warn|refuse|ignore` (default `warn`): when opening an **existing** DB whose
`extractorSha` / `targetSha` no longer match the live extractor or Galerina `dist/`, either warn
on stderr, exit `3`, or ignore. A rebuild in the same process is always fresh.

### `--in-memory` — passive mode

Builds the facts in memory and answers from them. **No `.db`, no `.json` mirror, nothing left on
disk.**

The persistent path stays the default, because the database is not incidental: it is what lets one
run be diffed against another, and what lets `sporeprint` write its execution-verified matrix into
the *same file* so static visibility can be joined against runtime truth. A throwaway scan has
nothing to diff and nothing to join — so it should not pay for a file, nor leave one behind.

> **`--in-memory` to ask a question. The default to keep a fact base.**

`map --in-memory` is refused rather than silently accepted: `map` exists to *produce* the fact
base, so in memory it would build one and throw it away — a no-op wearing a command's name.

---

## Requirements

- **Node ≥ 22.5** — uses the built-in `node:sqlite`. **No npm installs, ever.**
- A Galerina checkout. The checkout is **read-only** to this tool; every write goes to `--db`, or
  nowhere at all under `--in-memory`.

---

## Two things to know before you trust a result

1. **This produces candidates, not verdicts.** It reads text; it never runs the compiler. A
   black-box static probe can establish presence — it can never establish absence. Every row
   carries `file:line` precisely because the next step is a human or an execution probe confirming
   it. [docs/LIMITS.md](docs/LIMITS.md) is the full list.
2. **A query is only as good as its reference set.** Until 2026-08-06 `parser_kinds` held one kind,
   which made `kind-coverage` vacuous — it returned zero gaps, indistinguishable from a clean
   result. It now holds four and reports 17. When a query says "nothing found", check what it was
   comparing against. [docs/LIMITS.md](docs/LIMITS.md) §4 is the worked example.

---

## Also available inside Galerina

`packages-galerina/galerina-devtools-hypha` is a **passive-only** variant of this tool that lives
in the Galerina repo: no database, no build step, no dependencies, self-locating root, CI exit
codes. Use it when you want an answer from a checkout you have just cloned; use *this* one when
you want a persistent fact base to diff or to join against runtime evidence.

Its extractor is vendored from here by mechanical transform with a recorded SHA-256, never by
hand — a hand-copied mirror that drifts from its source is precisely the defect class this tool
detects.

---

## Performance note

A full map is **~0.5 s**. It was 16.4 s until 2026-08-06: `findCallSites` read the entire `dist/`
tree once per name, and at the 335 exported checkers *then present* that was 99.2% of the run.
`findAllCallSites` does one pass for all names — proven byte-identical across those 335 names by
differential, 46× faster.

*Corroborated 2026-08-06: `query kind-coverage --in-memory` against a full Galerina checkout
completed in **617 ms** wall-clock, map and query and Node startup together, writing nothing (a
before/after tree snapshot showed 0 files added and 0 changed). That confirms the order of
magnitude on one machine; it is not a re-measurement of `map` alone. The checker count has since
risen to **340** — see [LIMITS.md](docs/LIMITS.md) item 11.*

Speed matters for a tool like this beyond convenience: a 16-second map is one nobody puts in a
hook and nobody runs casually, and a detector nobody runs detects nothing.

---

## Contact

hello@trithypha.dev
