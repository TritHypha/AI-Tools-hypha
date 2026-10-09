#!/usr/bin/env node
// =============================================================================
// hypha — cli.js
//
// Commands:
//   hypha map    --root <galerina> [--db hypha.db]     build the fact DB (+ .json mirror)
//   hypha report --root <galerina> [--db hypha.db] [--out report.md]
//                                                      map (if needed) + full markdown report
//   hypha query  <duplicate-sets|kind-coverage|dead-exports|surface[:name]|diagnostics[:kw]>
//                --root <galerina> [--db hypha.db]
//   hypha status --root <galerina> [--db hypha.db]     counts + freshness (JSON)
//
// --root falls back to the GALERINA_ROOT environment variable. The target
// checkout is READ-ONLY to this tool — all writes go to the --db path.
//
// PASSIVE MODE — `--in-memory`
//   Builds the facts in memory and answers straight from them: no `.db` file,
//   no `.db.json` mirror, nothing left on disk. Use it for a one-off question.
//
// FRESHNESS — `--stale warn|refuse|ignore`  (default: warn)
//   LIMITS §11: a fact base can go stale because the *extractor* moved or the
//   *target dist/* moved. After opening an existing DB (not after a rebuild),
//   compare stored extractorSha/targetSha to live values. warn → stderr + continue;
//   refuse → exit 3; ignore → silent.
// =============================================================================
"use strict";

const fs = require("fs");
const path = require("path");
// Link following has no SQLite/capability-map dependency.
let buildMap, X, Q;

/** Minimal arg parser: positionals + --flag value pairs + boolean flags. */
function parseArgs(argv) {
  const BOOL = new Set(["in-memory"]);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (BOOL.has(key) || argv[i + 1] === undefined || String(argv[i + 1]).startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = argv[i + 1];
        i++;
      }
    } else out._.push(argv[i]);
  }
  return out;
}

function usage() {
  console.log("       hypha links <status|follow> --snapshot <myco.json> --root <expected-root> (links --help)");
  console.log("usage: hypha <map|report|query|status> --root <galerina-checkout> [--db hypha.db] [--in-memory] [--out report.md] [--stale warn|refuse|ignore]");
  console.log("       --in-memory  answer from memory; write no .db and no .json mirror");
  console.log("       --stale      how to treat a fact base whose extractorSha/targetSha no longer match (default: warn)");
  console.log("queries: duplicate-sets | kind-coverage | dead-exports | surface[:name] | diagnostics[:keyword]");
}

/**
 * Apply freshness policy. Returns true if the caller may continue.
 * Always ok after a rebuild in the same process (shas match by construction).
 */
function applyStalePolicy(db, root, policy, rebuilt) {
  if (rebuilt || !root) return true;
  const meta = Q.readMeta(db);
  const check = X.freshnessCheck(meta, root);
  if (check.ok) return true;
  for (const w of check.warnings) {
    console.error("[hypha] STALE: " + w);
  }
  if (policy === "refuse") {
    console.error("[hypha] refusing to answer from a stale fact base (--stale refuse). Re-run `hypha map`.");
    process.exit(3);
  }
  if (policy === "ignore") return true;
  // warn (default)
  console.error("[hypha] continuing with a possibly-stale fact base (pass --stale refuse to fail closed, or re-run map).");
  return true;
}

function main() {
  if (process.argv[2] === 'links') {
    require('./links').linksCommand(process.argv.slice(3)).catch(e => { console.error(e.message); process.exitCode = 2; });
    return;
  }
  ({ buildMap } = require('./db'));
  X = require('./extract'); Q = require('./queries');
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  const root = a.root || process.env.GALERINA_ROOT;
  const inMemory = !!a["in-memory"] || process.argv.includes("--in-memory");
  const dbPath = inMemory ? ":memory:" : (a.db || path.join(process.cwd(), "hypha.db"));
  const stalePolicy = (a.stale || "warn").toLowerCase();
  if (!["warn", "refuse", "ignore"].includes(stalePolicy)) {
    console.error("hypha: --stale must be warn|refuse|ignore");
    process.exit(2);
  }

  if (!cmd || !["map", "report", "query", "status"].includes(cmd)) {
    usage();
    process.exit(2);
  }
  if (inMemory && cmd === "map") {
    console.error("hypha: `map --in-memory` would build a fact base and discard it. Use `report`/`query`/`status --in-memory` to ask a question, or drop --in-memory to keep the DB.");
    process.exit(2);
  }
  if ((cmd === "map" || cmd === "report" || cmd === "status" || inMemory || !fs.existsSync(dbPath)) && !root) {
    console.error("hypha: need --root or GALERINA_ROOT (a Galerina checkout to map)");
    process.exit(2);
  }

  let liveDb = null;
  let rebuilt = false;
  if (cmd === "map" || cmd === "report" || inMemory || !fs.existsSync(dbPath)) {
    const facts = buildMap(root, dbPath, inMemory ? { json: false, keepOpen: true } : undefined);
    liveDb = facts.db ?? null;
    rebuilt = true;
    console.error("[hypha] mapped: " + facts.gateList.names.length + " gate names, " +
      facts.stdlibCases.length + " stdlib arms, " + facts.inlineTables.length + " inline tables, " +
      facts.kindSets.length + " kind-sets, " + facts.exportedCheckers.length + " exported checkers -> " +
      (inMemory ? "(memory — nothing written)" : dbPath));
    console.error("[hypha] freshness: extractorSha=" + facts.extractorSha.slice(0, 12) +
      "… targetSha=" + facts.targetSha.slice(0, 12) + "…");
    if (cmd === "map") return;
  }

  const db = liveDb ?? Q.open(dbPath);
  applyStalePolicy(db, root, stalePolicy, rebuilt);

  if (cmd === "status") {
    console.log(JSON.stringify(Q.status(db, root), null, 2));
    return;
  }
  if (cmd === "report") {
    const md = Q.render(db);
    if (a.out) { fs.writeFileSync(a.out, md); console.error("[hypha] report -> " + a.out); }
    else console.log(md);
    return;
  }
  // cmd === "query"
  const which = a._[1] || "";
  const [qname, qarg] = which.split(":");
  const result =
    qname === "duplicate-sets" ? Q.duplicateSets(db) :
    qname === "kind-coverage"  ? Q.kindCoverage(db) :
    qname === "dead-exports"   ? Q.deadExports(db) :
    qname === "surface"        ? Q.surface(db, qarg) :
    qname === "diagnostics"    ? Q.diagnostics(db, qarg) :
    null;
  if (result === null) {
    console.error("hypha: unknown query '" + which + "'");
    usage();
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
}

main();
