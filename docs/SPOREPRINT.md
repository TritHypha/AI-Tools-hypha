# The sporeprint join — static visibility × runtime ground truth

hypha maps where a capability is **written**. `sporeprint` records what the compiler **does**. They
share one database file so the two can be joined, and the join is the point: neither lane alone can
answer "is this actually supported?"

---

## Why two lanes exist

The lanes fail in opposite directions, which is exactly why one is not enough:

| | hypha (static) | sporeprint (dynamic) |
|---|---|---|
| method | text extraction over `dist/` | execute a probe, record the diagnostics |
| finds | every place a name is written | what happens for the cases actually run |
| blind to | anything not spelled as expected; anything guarded at runtime | anything the probe corpus does not cover |
| can prove | **presence** | **presence and, within its corpus, absence** |
| cannot prove | absence — ever | absence outside its corpus |

**Static is a superset claim; dynamic is a sample.** A name in all three static layers may still be
unreachable behind a mode flag. A name absent from every static layer may still work, handled by a
layer this map does not model. Only the join distinguishes those.

---

## The shared table

`sporeprint` writes `verified_surface` into the same database `hypha map` produced. hypha's own
`map` never drops it — the fact tables are rebuilt on every run, the verified matrix is not, because
it is expensive to produce and is evidence rather than extraction.

```sql
-- sporeprint/src/cli.js:198 — verbatim
CREATE TABLE IF NOT EXISTS verified_surface (
  receiver TEXT, name TEXT, status TEXT, detail TEXT, shape TEXT
);
```

★ **Column order matters.** sporeprint inserts positionally — `INSERT INTO verified_surface`
`VALUES (?,?,?,?,?)` at `cli.js:200` — so a table created with these columns in a
different order is silently populated wrong, not rejected.

### The join key

| side | key |
|---|---|
| hypha, all three static layers | `name` |
| ★ hypha `inline_cases` | `(receiver_tag, name)` |
| sporeprint `verified_surface` | `(receiver, name)` |

`hypha.inline_cases.receiver_tag` and `verified_surface.receiver` are the same
vocabulary. ★ **Join on `name` for the gate and stdlib layers; join on**
**`(receiver, name)` for the inline layer**, or a name that exists on two receivers
fans out across both.

```sql
SELECT g.name, g.section, v.status, v.detail
  FROM gate_names g
  LEFT JOIN verified_surface v ON v.name = g.name
 ORDER BY g.name;
```

A `LEFT JOIN` is the right default: a static name with no runtime row is the
**absent-runtime** quadrant below, and an `INNER JOIN` would silently discard exactly the
rows worth reading.

### Cardinality

Measured from the shipped fact base:

| relation | rows | distinct keys | max rows per key |
|---|---:|---:|---:|
| `gate_names` by `name` | 118 | 116 | 2 |
| `stdlib_cases` by `name` | 254 | 178 | 7 |
| `inline_cases` by `(receiver, name)` | 57 | 57 | 1 |
| `verified_surface` by `(receiver, name)` | one row per probe result | — | — |

★★ So the join is **many-to-many on `name` alone** and near 1:1 on
`(receiver, name)`. ⬜ A report that counts joined rows is counting the fan-out, not the
capabilities — count `DISTINCT name`.

### ★★★ Freshness: the table is replaced, not appended

sporeprint's `writeVerifiedSurface` wipes and replaces every row — and does it in **one
transaction** with the provenance stamp below, so a reader sees the previous complete evidence
or the new complete evidence, never a half state.

| actor | effect on `verified_surface` + `verified_meta` |
|---|---|
| `hypha map` | ★ leaves both alone — the fact tables are rebuilt, these are not |
| ★★ `sporeprint --db` | **wipes and replaces both, atomically** |

### The provenance stamp: `verified_meta`

Written by sporeprint in the same transaction as the rows it describes:

```sql
verified_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)
```

Six required keys — a stamp missing any of them is refused whole:

| key | meaning |
|---|---|
| `schema` | `sporeprint.verified-meta.v1` — the stamp's own format version |
| `stamped_at_utc` | RFC 3339 UTC completion time of the probe run |
| `run_id` | unique id joining the surface to its run |
| `tool_version` | sporeprint's package version |
| `evidence_digest` | SHA-256 over the canonical serialisation of the `verified_surface` rows (sorted rows, columns joined with U+001F, rows with `\n`) — the one definition lives in sporeprint's exported `evidenceDigest` and hypha re-uses it |
| `source_identity` | `git:<HEAD>` of the probed checkout, or `distdigest:<sha256/32>` over the probed dist file list when the root is not a repository |

★★★ **The timestamp is visibility, never authority.** hypha's joined report admits the stamp
only when the schema is known, all six keys are present, the stamp parses as RFC 3339 UTC and is
not future-dated, and the **digest re-verifies against the rows actually present**. Any failure
prints the runtime half as *UNKNOWN standing* with the exact reason — never silently current.
Release admission must verify digest and source identity, not the clock.

Run order matters:

```bash
node src/cli.js map --root <galerina> --db hypha.db   # static facts (rebuilds fact tables)
# … sporeprint writes verified_surface into hypha.db …
node src/cli.js report --root <galerina> --db hypha.db --out report.md
```

`--in-memory` is **incompatible with the join** by construction: there is no file for sporeprint to
write into. That is the honest trade — passive mode buys "nothing left behind" and pays for it with
"nothing to join against."

---

## Reading the four quadrants

The join produces four cases. Three of them are interesting:

| static | runtime | reading |
|---|---|---|
| visible | works | **agreement.** The ordinary case. |
| visible | fails | ★ **the dangerous quadrant.** The capability is written and does not work — a mode guard, a dead branch, an unreached dispatch. This is where `dead-exports` and `pass_calls` earn their keep. |
| absent | works | the map is incomplete — the name is handled by a layer not extracted (registry, runtime). **A hypha bug, not a Galerina bug.** |
| absent | fails | consistent, but proves nothing on its own: a probe that fails and a name that is absent may share a single cause, namely that the probe was wrong. Read the enforcement point. |

The last row is the trap. Two nulls agreeing is not corroboration.

---

## The precedence rule

**Where the lanes disagree, execution wins.** Static extraction is a model of the code; execution
is the code. A static tool that contradicts an execution-verified result is the suspect, and should
be treated as such before any conclusion is drawn about the codebase.

This is not theoretical. Building the Galerina-side devtool, a static classifier reported
`Database.query` as ungoverned by the value-state checker, contradicting an execution result that
said otherwise. The tool was wrong: it read `isGovernedSink`'s five pattern arms and missed that the
function delegates to `getSinkRequirement`, which carries eight more — including the one that
governs `Database.query`. The execution result was right, and the disagreement was the only signal
that anything was wrong.

**A static claim that has never been checked against execution is a candidate.** That is the whole
reason the two lanes share a file.
