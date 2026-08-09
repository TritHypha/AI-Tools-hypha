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
 *  invisible to checkers and the flow index.
 *
 * A set containing *none* of the reference kinds is not a gating set (it is
 * some other Set of FlowDecl-looking strings or an empty extract). Reporting
 * it as "missing every kind" inflates gaps with noise. Skip those; only sets
 * that gate on *some* flow kind and omit another are candidates. */
function kindCoverage(db) {
  const kinds = db.prepare("SELECT kind FROM parser_kinds").all().map((r) => r.kind);
  const out = [];
  let setsExamined = 0;
  let setsSkippedNotGating = 0;
  for (const s of db.prepare("SELECT set_id, file, line FROM kind_sets").all()) {
    const members = new Set(db.prepare(
      "SELECT member FROM kind_set_members WHERE set_id = ?"
    ).all(s.set_id).map((r) => r.member));
    const has = kinds.filter((k) => members.has(k));
    if (has.length === 0) { setsSkippedNotGating++; continue; }
    setsExamined++;
    const missing = kinds.filter((k) => !members.has(k));
    if (missing.length) out.push({ site: s.file + ":" + s.line, missing, has: [...members] });
  }
  return { parserKinds: kinds, gaps: out, setsExamined, setsSkippedNotGating };
}

/** Exported check* functions with zero call sites anywhere in dist — dead
 *  passes. (Call sites were collected at extraction; definition lines were
 *  already filtered out there.) */
function deadExports(db) {
  return db.prepare(`
    SELECT e.name, e.file, e.line, e.is_checker,
           (SELECT COUNT(*) FROM checker_call_sites c WHERE c.name = e.name) AS calls
    FROM exported_checkers e
    ORDER BY calls ASC, e.name
  `).all().filter((r) => r.calls === 0);
}

/** Where is a method name visible? Gate list (with author section), stdlib
 *  implementation arms, and inline fallback tables — the layered answer that
 *  prevents the `.push` class of miss. With no name, summarises the layers.
 *
 * LIMITS §12: `receiver_tag = 'unresolved'` is an unattributed switch, not a
 * dispatch table. It must not contribute to the inline layer (false presence).
 * Those tables are returned separately as `unattributedSwitches` (context). */
function surface(db, name) {
  // Attributed inline only — fail closed on unattributed.
  const inlineSql =
    "SELECT receiver_tag, file, line FROM inline_cases WHERE name = ? AND receiver_tag != 'unresolved'";
  if (name) {
    return {
      gate: db.prepare("SELECT section, line FROM gate_names WHERE name = ?").all(name),
      stdlib: db.prepare("SELECT file, line FROM stdlib_cases WHERE name = ?").all(name),
      inline: db.prepare(inlineSql).all(name),
    };
  }
  // Case lines are what we store; MIN(line) is a lower bound on the switch open
  // line (good enough to jump to the region). Context, not a finding.
  const unaByFile = db.prepare(`
    SELECT file, COUNT(*) AS cases, MIN(line) AS line
    FROM inline_cases WHERE receiver_tag = 'unresolved'
    GROUP BY file
  `).all().map((r) => ({ at: r.file + ":" + r.line, cases: r.cases }));

  return {
    gateCount: db.prepare("SELECT COUNT(DISTINCT name) AS n FROM gate_names").get().n,
    bySection: db.prepare(
      "SELECT section, COUNT(DISTINCT name) AS n FROM gate_names GROUP BY section ORDER BY n DESC"
    ).all(),
    inlineTags: db.prepare(
      "SELECT receiver_tag, COUNT(*) AS n FROM inline_cases WHERE receiver_tag != 'unresolved' GROUP BY receiver_tag ORDER BY n DESC"
    ).all(),
    // Gate-listed names with NO stdlib arm and NO *attributed* inline arm.
    unimplemented: db.prepare(`
      SELECT DISTINCT g.name FROM gate_names g
      WHERE NOT EXISTS (SELECT 1 FROM stdlib_cases s WHERE s.name = g.name)
        AND NOT EXISTS (
          SELECT 1 FROM inline_cases i
          WHERE i.name = g.name AND i.receiver_tag != 'unresolved'
        )
      ORDER BY g.name
    `).all().map((r) => r.name),
    // Context, not a finding — a switch beside real dispatch is a lead.
    unattributedSwitches: unaByFile,
  };
}


/** The diagnostic-code universe, optionally filtered by a semantic keyword over
 *  the surrounding message text. Added so questions like "does ANY checker warn
 *  about narrowing?" become a query instead of a hand search that cannot
 *  support an exhaustiveness claim.
 *  NOTE: presence in source does NOT mean a code can fire — FUNGI-NUMERIC-001
 *  appears here yet is unreachable (empty trigger set). Reachability is a
 *  separate, execution-only question. */
function diagnostics(db, keyword) {
  const codes = db.prepare(
    "SELECT code, COUNT(*) AS sites, MIN(file) AS first_file, MIN(line) AS first_line FROM diagnostics_codes GROUP BY code ORDER BY code"
  ).all();
  if (!keyword) return { total: codes.length, codes };
  const needles = keyword.split("|").map((k) => k.toLowerCase());
  const hits = db.prepare("SELECT code, file, line, context FROM diagnostics_codes").all()
    .filter((r) => needles.some((n) => (r.context || "").toLowerCase().includes(n)));
  const byCode = {};
  for (const h of hits) {
    if (!byCode[h.code]) byCode[h.code] = { code: h.code, sites: [] };
    if (byCode[h.code].sites.length < 3) byCode[h.code].sites.push(h.file + ":" + h.line);
  }
  return { total: codes.length, keyword, matched: Object.values(byCode) };
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
  for (const d of dead) L.push("- **" + d.name + "** (`" + d.file + ":" + d.line + "`) — never called" +
    (d.is_checker ? " _(check\* pass)_" : ""));

  const dg = diagnostics(db);
  L.push("", "## Diagnostic-code universe", "",
    "- distinct FUNGI-*/GATE-* codes in dist: **" + dg.total + "**",
    "- (presence \u2260 reachability: a code with an empty trigger set never fires)");

  const s = surface(db);
  L.push("", "## Method surface summary", "",
    "- gate-list names: " + s.gateCount, "- by section:");
  for (const b of s.bySection) L.push("  - " + b.section + ": " + b.n);
  L.push("- inline fallback tables (attributed only): " +
    (s.inlineTags.length
      ? s.inlineTags.map((t) => t.receiver_tag + "(" + t.n + ")").join(", ")
      : "(none)"));
  if (s.unattributedSwitches && s.unattributedSwitches.length) {
    L.push("- unattributed switches (context, not dispatch): " +
      s.unattributedSwitches.map((u) => u.at + " ×" + u.cases).join(", "));
  }
  L.push("- gate-listed but neither stdlib-cased nor attributed-inline (visibility holes): " +
    (s.unimplemented.length ? s.unimplemented.join(", ") : "(none)"));

  // If sporeprint has written its verified matrix into this DB, join it in —
  // static visibility vs runtime ground truth on one page.
  const hasVerified = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='verified_surface'"
  ).get();
  if (hasVerified) {
    L.push("", "## Execution-verified surface (from sporeprint)", "");
    const meta = readVerifiedMeta(db);
    if (meta.ok) {
      L.push("_Runtime facts stamped " + meta.values.stamped_at_utc +
        " · run `" + meta.values.run_id.slice(0, 8) + "` · sporeprint " + meta.values.tool_version +
        " · source `" + meta.values.source_identity.slice(0, 24) + "…`_", "");
    } else {
      // ★ Fail closed, loudly: an unstampable runtime half is UNKNOWN AGE, never
      // silently current. The counts still print — they are real rows — but the
      // reader is told exactly what guarantee they do not hold.
      L.push("**⚠ runtime facts of UNKNOWN standing — " + meta.reason + ".** " +
        "Treat the rows below as unverified until sporeprint re-stamps them.", "");
    }
    for (const r of db.prepare(
      "SELECT receiver, status, COUNT(*) AS n FROM verified_surface GROUP BY receiver, status ORDER BY receiver, n DESC"
    ).all()) L.push("- " + r.receiver + " · " + r.status + ": " + r.n);
  }
  L.push("");
  return L.join("\n");
}

// ── verified_meta: the runtime half's provenance, validated fail-closed ──────
/**
 * sporeprint stamps `verified_meta` (six keys) in the SAME transaction as the
 * surface rows. This reader admits the stamp only when every check passes;
 * every failure names its reason, because "UNKNOWN AGE" with no cause is
 * uninvestigable. The timestamp is VISIBILITY, never authority — the digest is
 * what binds the meta to the rows it claims to describe.
 *
 * Refusals, in test order:
 *   - the table is absent (a pre-meta DB, or a foreign writer);
 *   - a required key is missing or empty;
 *   - the schema identifier is unknown;
 *   - the stamp does not parse as RFC 3339 UTC, or post-dates now by > 5 min
 *     (small skew tolerated; a future-dated stamp is refused, per the owner:
 *     never silently current);
 *   - the evidence digest does not match the rows actually present (the rows
 *     were edited after stamping, or the stamp describes a different run).
 */
function readVerifiedMeta(db) {
  const REQUIRED = ["schema", "stamped_at_utc", "run_id", "tool_version", "evidence_digest", "source_identity"];
  const hasTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='verified_meta'"
  ).get();
  if (!hasTable) return { ok: false, reason: "no verified_meta table (pre-provenance write)" };
  const values = {};
  for (const row of db.prepare("SELECT key, value FROM verified_meta").all()) values[row.key] = row.value;
  for (const k of REQUIRED) {
    if (typeof values[k] !== "string" || values[k] === "") return { ok: false, reason: "meta key missing or empty: " + k };
  }
  if (values.schema !== "sporeprint.verified-meta.v1") return { ok: false, reason: "unknown meta schema: " + values.schema };
  const t = Date.parse(values.stamped_at_utc);
  if (!Number.isFinite(t) || !/Z$/.test(values.stamped_at_utc)) return { ok: false, reason: "stamp is not RFC 3339 UTC" };
  if (t > Date.now() + 5 * 60 * 1000) return { ok: false, reason: "stamp is future-dated (" + values.stamped_at_utc + ")" };
  // Re-derive the digest over the rows present NOW, via the writer's own
  // exported canonicalisation when reachable — two definitions of "canonical"
  // would drift into a permanent false mismatch. Unreachable = SKIPPED-style
  // refusal: without the shared definition this reader cannot vouch.
  let digestOf = null;
  for (const rel of ["../../sporeprint/src/cli.js", "../../../sporeprint/src/cli.js"]) {
    try { digestOf = require(rel).evidenceDigest; break; } catch {}
  }
  if (!digestOf) return { ok: false, reason: "sporeprint's canonical digest is unreachable; cannot re-verify the stamp" };
  const rows = db.prepare("SELECT receiver, name, status, detail, shape FROM verified_surface").all();
  const actual = digestOf(rows);
  if (actual !== values.evidence_digest) {
    return { ok: false, reason: "evidence digest mismatch (rows changed after stamping, or a different run)" };
  }
  return { ok: true, values };
}

/** Load meta key/value pairs from a fact DB. */
function readMeta(db) {
  return Object.fromEntries(
    db.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value])
  );
}

/**
 * Status snapshot for humans and hooks: counts + freshness.
 * `freshness` is null when no root was supplied (cannot re-hash the target).
 */
function status(db, root) {
  const X = require("./extract");
  const meta = readMeta(db);
  const freshness = root ? X.freshnessCheck(meta, root) : null;
  return {
    meta,
    freshness,
    counts: {
      gateNames: db.prepare("SELECT COUNT(DISTINCT name) AS n FROM gate_names").get().n,
      stdlibCases: db.prepare("SELECT COUNT(*) AS n FROM stdlib_cases").get().n,
      inlineCasesAttributed: db.prepare(
        "SELECT COUNT(*) AS n FROM inline_cases WHERE receiver_tag != 'unresolved'"
      ).get().n,
      inlineCasesUnattributed: db.prepare(
        "SELECT COUNT(*) AS n FROM inline_cases WHERE receiver_tag = 'unresolved'"
      ).get().n,
      kindSets: db.prepare("SELECT COUNT(*) AS n FROM kind_sets").get().n,
      exportedCheckers: db.prepare("SELECT COUNT(*) AS n FROM exported_checkers").get().n,
      parserKinds: db.prepare("SELECT COUNT(*) AS n FROM parser_kinds").get().n,
      diagnostics: db.prepare("SELECT COUNT(DISTINCT code) AS n FROM diagnostics_codes").get().n,
    },
  };
}

module.exports = {
  open, duplicateSets, kindCoverage, deadExports, surface, diagnostics, render,
  readVerifiedMeta, readMeta, status,
};
