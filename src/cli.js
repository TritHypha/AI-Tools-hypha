#!/usr/bin/env node
// =============================================================================
// hypha — cli.js
//
// Commands:
//   hypha map    --root <galerina> [--db hypha.db]     build the fact DB (+ .json mirror)
//   hypha report --root <galerina> [--db hypha.db] [--out report.md]
//                                                      map (if needed) + full markdown report
//   hypha query  <duplicate-sets|kind-coverage|dead-exports|surface[:name]> [--db hypha.db]
//
// --root falls back to the GALERINA_ROOT environment variable. The target
// checkout is READ-ONLY to this tool — all writes go to the --db path.
// =============================================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { buildMap } = require("./db");
const Q = require("./queries");

/** Minimal arg parser: positionals + --flag value pairs. */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { out[argv[i].slice(2)] = argv[i + 1]; i++; }
    else out._.push(argv[i]);
  }
  return out;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  const root = a.root || process.env.GALERINA_ROOT;
  const dbPath = a.db || path.join(process.cwd(), "hypha.db");

  if (!cmd || !["map", "report", "query"].includes(cmd)) {
    console.log("usage: hypha <map|report|query> --root <galerina-checkout> [--db hypha.db] [--out report.md]");
    process.exit(2);
  }
  if ((cmd === "map" || cmd === "report" || !fs.existsSync(dbPath)) && !root) {
    console.error("hypha: need --root or GALERINA_ROOT (a Galerina checkout to map)");
    process.exit(2);
  }

  if (cmd === "map" || cmd === "report" || !fs.existsSync(dbPath)) {
    const facts = buildMap(root, dbPath);
    console.error("[hypha] mapped: " + facts.gateList.names.length + " gate names, " +
      facts.stdlibCases.length + " stdlib arms, " + facts.inlineTables.length + " inline tables, " +
      facts.kindSets.length + " kind-sets, " + facts.exportedCheckers.length + " exported checkers -> " + dbPath);
    if (cmd === "map") return;
  }

  const db = Q.open(dbPath);
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
    null;
  if (result === null) {
    console.error("hypha: unknown query '" + which + "'");
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
}

main();
