# hypha

**Static capability-map for Galerina.** Extracts the compiler's dispatch
surfaces, sentinel sets and checker wiring into a SQLite database, then runs
deterministic drift/coverage/dead-code queries over it.

Named for the threads that connect a mycelium: hypha connects the *layers* a
capability fact lives in, so no single layer is ever mistaken for the whole
surface again.

## Why it exists

Four real defects were found by hand before this tool, and each is one of its
queries:

| incident | query that would have caught it |
|---|---|
| `.push()` judged absent because only the interpreter's inline fallback table was read — the gate list had it all along | `surface` (a name's visibility, layer by layer) |
| `FLOW_KINDS` hand-copied at 4 sites; none gained `governedFlowDecl`, so governed flows were skipped by checkers and unrunnable by the flow index | `duplicate-sets` (same intent, drifted membership) |
| `checkEvents` exported, imported — and called by nothing: `FUNGI-EVENT-001` unreachable from the package CLI in every mode | `dead-exports` |
| parser gained `governedFlowDecl`; every gating set silently ignored it | `kind-coverage` (parser-producible kinds vs each set) |

## Requirements

- Node.js ≥ 22.5 (uses the built-in `node:sqlite` — **no npm installs**).
- A Galerina checkout. The checkout is **read-only** to this tool; all writes
  go to the `--db` path.

## Usage

```bash
node src/cli.js report --root <galerina-checkout> --db hypha.db --out report.md
```

- `map` — build the fact DB (and a `hypha.db.json` mirror for diffing in PRs)
- `report` — map + render the full markdown report
- `query <name>` — one query as JSON: `duplicate-sets`, `kind-coverage`,
  `dead-exports`, `surface`, `surface:<methodName>`

`--root` falls back to the `GALERINA_ROOT` environment variable.

## Fact tables

`gate_names` (STD_METHOD_NAMES with the author's own `// section` comments) ·
`stdlib_cases` · `inline_cases` (per-receiver fallback tables) · `kind_sets` +
`kind_set_members` · `pass_calls` (cli.js wiring) · `exported_checkers` +
`checker_call_sites` · `parser_kinds` · `meta`.

The companion tool **sporeprint** writes its execution-verified matrix into the
same DB (`verified_surface`), so the report can join *static visibility* against
*runtime ground truth*. Static extraction is heuristic (line-based, anchored on
meaning-bearing tokens); the verified matrix is the truth lane.

## Caveats

- Extraction targets `dist/` JavaScript, not TypeScript sources — it maps what
  ships, which is also what runs.
- Heuristics can miss exotic formatting; every claim in the report carries
  `file:line` so a human can check in seconds.
- Roadmap: a surface lane for the WASM/SLIDE backend once the DSS rewrite
  lands; near-duplicate clustering across ALL set literals (not just flow-kind
  sets).

## Contact

hello@trithypha.dev
