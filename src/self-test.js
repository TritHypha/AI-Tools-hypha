#!/usr/bin/env node
// =============================================================================
// hypha — self-test.js
//
// Small fail-closed checks for the LIMITS §11 / §12 fixes. Runs against a real
// Galerina checkout when --root / GALERINA_ROOT is set; pure unit checks always
// run. Exit 0 clean · 1 a check failed · 2 could not run.
// =============================================================================
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const X = require("./extract");
const Q = require("./queries");
const { buildMap, displayRoot } = require("./db");

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("  ok  " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail ? " — " + detail : ""));
  }
}

console.log("hypha self-test");

// ── unit: displayRoot never leaks absolute paths ─────────────────────────────
check("displayRoot basename only", displayRoot("C:\\\\Users\\\\x\\\\Galerina") === "Galerina");
check("displayRoot unknown", displayRoot(null) === "<unknown>");

// ── unit: compiler layout resolution is explicit and fail-closed ────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hypha-layout-"));
  const current = path.join(root, "packages-ts", "galerina-core-compiler", "dist");
  const legacy = path.join(root, "packages-galerina", "galerina-core-compiler", "dist");
  try {
    fs.mkdirSync(current, { recursive: true });
    let currentResult = null;
    try { currentResult = X.distDir(root); } catch { /* reported by check */ }
    check("distDir accepts current packages-ts layout", currentResult === current);

    fs.rmSync(path.join(root, "packages-ts"), { recursive: true, force: true });
    fs.mkdirSync(legacy, { recursive: true });
    let legacyResult = null;
    try { legacyResult = X.distDir(root); } catch { /* reported by check */ }
    check("distDir retains legacy packages-galerina layout", legacyResult === legacy);

    fs.mkdirSync(current, { recursive: true });
    let ambiguous = null;
    try { X.distDir(root); } catch (error) { ambiguous = error; }
    check("distDir refuses ambiguous dual layouts",
      ambiguous instanceof Error && /ambiguous compiler dist/.test(ambiguous.message),
      ambiguous && ambiguous.message);

    fs.rmSync(path.join(root, "packages-ts"), { recursive: true, force: true });
    fs.rmSync(path.join(root, "packages-galerina"), { recursive: true, force: true });
    let missing = null;
    try { X.distDir(root); } catch (error) { missing = error; }
    check("distDir refuses missing compiler layout",
      missing instanceof Error && /no compiler dist/.test(missing.message),
      missing && missing.message);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── unit: kindCoverage skips non-gating sets ─────────────────────────────────
{
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE parser_kinds (kind TEXT);
    CREATE TABLE kind_sets (set_id INTEGER, file TEXT, line INTEGER);
    CREATE TABLE kind_set_members (set_id INTEGER, member TEXT);
    INSERT INTO parser_kinds VALUES ('pureFlowDecl'),('guardedFlowDecl'),('secureFlowDecl'),('governedFlowDecl');
    INSERT INTO kind_sets VALUES (0,'a.js',1),(1,'b.js',2);
    INSERT INTO kind_set_members VALUES (0,'pureFlowDecl'),(0,'guardedFlowDecl');
    INSERT INTO kind_set_members VALUES (1,'SomeOtherKind');
  `);
  const r = Q.kindCoverage(db);
  check("kindCoverage reports gap on partial gating set",
    r.gaps.length === 1 && r.gaps[0].site === "a.js:1",
    "gaps=" + JSON.stringify(r.gaps));
  check("kindCoverage skips non-gating set",
    r.setsSkippedNotGating === 1,
    "skipped=" + r.setsSkippedNotGating);
  check("kindCoverage setsExamined=1", r.setsExamined === 1);
  db.close();
}

// ── unit: surface excludes unresolved from inline layer ──────────────────────
{
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE gate_names (name TEXT, section TEXT, line INTEGER);
    CREATE TABLE stdlib_cases (name TEXT, file TEXT, line INTEGER);
    CREATE TABLE inline_cases (receiver_tag TEXT, name TEXT, file TEXT, line INTEGER);
    INSERT INTO gate_names VALUES ('realMethod','Array',1),('phantom','Array',2);
    INSERT INTO inline_cases VALUES ('list','realMethod','i.js',10);
    INSERT INTO inline_cases VALUES ('unresolved','phantom','i.js',20);
    INSERT INTO inline_cases VALUES ('unresolved','0','i.js',21);
  `);
  const real = Q.surface(db, "realMethod");
  const fake = Q.surface(db, "phantom");
  check("attributed inline counts for realMethod", real.inline.length === 1);
  check("unattributed does NOT count as inline for phantom", fake.inline.length === 0);
  const sum = Q.surface(db);
  check("summary omits unresolved from inlineTags",
    !sum.inlineTags.some((t) => t.receiver_tag === "unresolved"));
  check("summary reports unattributedSwitches",
    sum.unattributedSwitches.length === 1 && sum.unattributedSwitches[0].cases === 2,
    JSON.stringify(sum.unattributedSwitches));
  check("phantom is unimplemented (no false presence)",
    sum.unimplemented.includes("phantom"));
  db.close();
}

// ── integration against Galerina (optional) ──────────────────────────────────
const root = process.argv.includes("--root")
  ? process.argv[process.argv.indexOf("--root") + 1]
  : process.env.GALERINA_ROOT;
let integrationLayoutError = null;
if (root) {
  try { X.distDir(root); } catch (error) { integrationLayoutError = error; }
}

if (!root) {
  console.log("  skip integration (pass --root or GALERINA_ROOT)");
} else if (integrationLayoutError) {
  console.log("  refuse integration (" + integrationLayoutError.message + ")");
  failed++;
  console.log("  FAIL dist missing");
} else {
  console.log("  integration root=" + root);
  const tables = X.extractInlineTables(root);
  const attributed = tables.filter((t) => t.receiverTag !== "unresolved");
  const una = tables.filter((t) => t.receiverTag === "unresolved");
  check("attributed tables exist", attributed.length >= 4, "n=" + attributed.length);
  check("no attributed table is polluted with escape '0'",
    !attributed.some((t) => t.cases.some((c) => c.name === "0")));
  check("unattributed switches still extracted (context)",
    una.length >= 1 && una.some((t) => t.cases.some((c) => c.name === "0" || c.name === "n")),
    "una=" + una.map((t) => t.line + ":" + t.cases.length).join(","));

  const facts = buildMap(root, ":memory:", { json: false, keepOpen: true });
  check("map stamps extractorSha", typeof facts.extractorSha === "string" && facts.extractorSha.length === 64);
  check("map stamps targetSha", typeof facts.targetSha === "string" && facts.targetSha.length === 64);
  const fresh = X.freshnessCheck(
    { extractorSha: facts.extractorSha, targetSha: facts.targetSha },
    root
  );
  check("freshness ok immediately after map", fresh.ok, JSON.stringify(fresh.warnings));
  const st = Q.status(facts.db, root);
  check("status freshness ok", st.freshness && st.freshness.ok);
  check("push is in gate list (control for empty unimplemented)",
    facts.gateList.names.some((n) => n.name === "push"));
  const surf = Q.surface(facts.db, "push");
  check("surface:push has gate layer", surf.gate.length >= 1);
  // stale detection: corrupt extractorSha
  const stale = X.freshnessCheck(
    { extractorSha: "0".repeat(64), targetSha: facts.targetSha },
    root
  );
  check("freshness detects extractor mismatch", !stale.ok && stale.warnings.some((w) => /extractorSha/.test(w)));
  facts.db.close();
}

if (failed) {
  console.log("\n" + failed + " failed");
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
