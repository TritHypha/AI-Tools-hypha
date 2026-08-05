// =============================================================================
// hypha — queries.js
//
// The value layer: deterministic queries over the fact DB. Each one exists
// because a real defect of its class was found by hand first:
//
//   duplicateSets — hand-copied sentinel sets that drifted
//                   (FLOW_KINDS ×4, none gained governedFlowDecl).
//   kindCoverage  — parser-producible kinds omitted from gating sets
//                   (governed flows skipped by checkers / unrunnable).
//   deadExports   — exported checkers no module ever calls
//                   (checkEvents: FUNGI-EVENT-001 unreachable).
//   surface       — where a method name is visible, by layer
//                   (`.push` lived in the gate list + stdlib, invisible to a
//                    reader of the inline fallback table alone).
//
// Every query returns plain rows; render() turns them into markdown.
// =============================================================================
"use strict";

const { DatabaseSync } = require("node:sqlite");

/** Open the fact DB read-only-ish (node:sqlite has no ro flag; we just never
 *  write here). */
function open(dbPath) { return new DatabaseSync(dbPath); }

/** Sets sharing a ≥3-member overlap but NOT identical membership — the drift
 *  signature: same intent, hand-copied, then one copy moved on. Also lists
 *  exact duplicates (same membership at >1 site) as consolidation targets. */
function duplicateSets(db) {
  const sets = new Map();
  for (const r of db.prepare(
    "SELECT s.set_id, s.file, s.line, m.member FROM kind_sets s JOIN kind_set_members m ON m.set_id = s.set_id"
  ).all()) {
    const k = r.set_id;
    if (!sets.has(k)) sets.set(k, { file: r.file, line: r.line, members: [] });
    sets.get(k).members.push(r.member);
  }
  const list = [...sets.values()].map((s) => ({ ...s, sig: [...s.members].sort().join(",") }));
  const drift = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const A = new Set(list[i].members), B = new Set(list[j].members);
      const inter = [...A].filter((x) => B.has(x));
      if (inter.length >= 3 && list[i].sig !== list[j].sig) {
        drift.push({
          a: list[i].file + ":" + list[i].line, b: list[j].file + ":" + list[j].line,
          onlyA: [...A].filter((x) => !B.has(x)), onlyB: [...B].filter((x) => !A.has(x)),
        });
      }
    }
  }
  const dup = new Map();
  for (const s of list) {
    if (!dup.has(s.sig)) dup.set(s.sig, []);
    dup.get(s.sig).push(s.file + ":" + s.line);
  }
  const duplicates = [...dup.entries()].filter(([, sites]) => sites.length > 1)
    .map(([sig, sites]) => ({ members: sig.split(","), sites }));
  return { drift, duplicates };
}

/** Parser-producible flow kinds diffed against every kind-set: any set missing
 *  a producible kind is flagged — that is exactly how governed flows became
 *  invisible to checkers and the flow index. */
function kindCoverage(db) {
  const kinds = db.prepare("SELECT kind FROM parser_kinds").all().map((r) => r.kind);
  const out = [];
  for (const s of db.prepare("SELECT set_id, file, line FROM kind_sets").all()) {
    const members = new Set(db.prepare(
      "SELECT member FROM kind_set_members WHERE set_id = ?"
    ).all(s.set_id).map((r) => r.member));
    const missing = kinds.filter((k) => !members.has(k));
    if (missing.length) out.push({ site: s.file + ":" + s.line, missing, has: [...members] });
  }
  return { parserKinds: kinds, gaps: out };
}

/** Exported check* functions with zero call sites anywhere in dist — dead
 *  passes. (Call sites were collected at extraction; definition lines were
 *  already filtered out there.) */
function deadExports(db) {
  return db.prepare(`
    SELECT e.name, e.file, e.line,
           (SELECT COUNT(*) FROM checker_call_sites c WHERE c.name = e.name) AS calls
    FROM exported_checkers e
    ORDER BY calls ASC, e.name
  `).all().filter((r) => r.calls === 0);
}

/** Where is a method name visible? Gate list (with author section), stdlib
 *  implementation arms, and inline fallback tables — the layered answer that
 *  prevents the `.push` class of miss. With no name, summarises the layers. */
function surface(db, name) {
  if (name) {
    return {
      gate: db.prepare("SELECT section, line FROM gate_names WHERE name = ?").all(name),
      stdlib: db.prepare("SELECT file, line FROM stdlib_cases WHERE name = ?").all(name),
      inline: db.prepare("SELECT receiver_tag, file, line FROM inline_cases WHERE name = ?").all(name),
    };
  }
  return {
    gateCount: db.prepare("SELECT COUNT(DISTINCT name) AS n FROM gate_names").get().n,
    bySection: db.prepare(
      "SELECT section, COUNT(DISTINCT name) AS n FROM gate_names GROUP BY section ORDER BY n DESC"
    ).all(),
    inlineTags: db.prepare(
      "SELECT receiver_tag, COUNT(*) AS n FROM inline_cases GROUP BY receiver_tag ORDER BY n DESC"
    ).all(),
    // Gate-listed names with NO stdlib arm and NO inline arm — visibility
    // holes: routed somewhere this map does not yet model (registry, runtime).
    unimplemented: db.prepare(`
      SELECT DISTINCT g.name FROM gate_names g
      WHERE NOT EXISTS (SELECT 1 FROM stdlib_cases s WHERE s.name = g.name)
        AND NOT EXISTS (SELECT 1 FROM inline_cases i WHERE i.name = g.name)
      ORDER BY g.name
    `).all().map((r) => r.name),
  };
}

/** Render the full report as markdown — the artifact a human (or a PR bot)
 *  reads. Sections mirror the query list; every claim carries file:line. */
function render(db) {
  const L = [];
  const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
  L.push("# hypha report", "", "- root: `" + meta.root + "`", "- built: " + meta.builtAt, "");

  const dup = duplicateSets(db);
  L.push("## Sentinel-set drift (same intent, different membership)", "");
  if (!dup.drift.length) L.push("(none found)");
  for (const d of dup.drift) {
    L.push("- `" + d.a + "` vs `" + d.b + "` — only-in-A: " +
      (d.onlyA.join(", ") || "—") + " · only-in-B: " + (d.onlyB.join(", ") || "—"));
  }
  L.push("", "## Exact duplicate sets (consolidation targets)", "");
  if (!dup.duplicates.length) L.push("(none found)");
  for (const d of dup.duplicates) {
    L.push("- {" + d.members.join(", ") + "} defined at " + d.sites.join(" · "));
  }

  const cov = kindCoverage(db);
  L.push("", "## Kind coverage (parser-producible kinds missing from gating sets)", "");
  L.push("Parser can produce: " + cov.parserKinds.join(", "), "");
  if (!cov.gaps.length) L.push("(no gaps)");
  for (const g of cov.gaps) L.push("- `" + g.site + "` missing: **" + g.missing.join(", ") + "**");

  const dead = deadExports(db);
  L.push("", "## Dead exported checkers (zero call sites in dist + root CLI)", "");
  if (!dead.length) L.push("(none)");
  for (const d of dead) L.push("- **" + d.name + "** (`" + d.file + ":" + d.line + "`) — never called");

  const s = surface(db);
  L.push("", "## Method surface summary", "",
    "- gate-list names: " + s.gateCount, "- by section:");
  for (const b of s.bySection) L.push("  - " + b.section + ": " + b.n);
  L.push("- inline fallback tables: " +
    s.inlineTags.map((t) => t.receiver_tag + "(" + t.n + ")").join(", "));
  L.push("- gate-listed but neither stdlib-cased nor inline-cased (visibility holes): " +
    (s.unimplemented.length ? s.unimplemented.join(", ") : "(none)"));

  // If sporeprint has written its verified matrix into this DB, join it in —
  // static visibility vs runtime ground truth on one page.
  const hasVerified = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='verified_surface'"
  ).get();
  if (hasVerified) {
    L.push("", "## Execution-verified surface (from sporeprint)", "");
    for (const r of db.prepare(
      "SELECT receiver, status, COUNT(*) AS n FROM verified_surface GROUP BY receiver, status ORDER BY receiver, n DESC"
    ).all()) L.push("- " + r.receiver + " · " + r.status + ": " + r.n);
  }
  L.push("");
  return L.join("\n");
}

module.exports = { open, duplicateSets, kindCoverage, deadExports, surface, render };
