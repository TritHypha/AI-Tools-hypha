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
//
// --root falls back to the GALERINA_ROOT environment variable. The target
// checkout is READ-ONLY to this tool — all writes go to the --db path.
//
// PASSIVE MODE — `--in-memory`
//   Builds the facts in memory and answers straight from them: no `.db` file,
//   no `.db.json` mirror, nothing left on disk. Use it for a one-off question.
//
//   The persistent path remains the default, because the DB is not incidental
//   to this tool: it is what lets one run be diffed against another, and what
//   lets `sporeprint` write its execution-verified matrix into the SAME file so
//   static visibility can be joined against runtime ground truth. A throwaway
//   scan has nothing to diff and nothing to join — so it should not pay for a
//   file, and should not leave one behind.
//
//   Rule of thumb: `--in-memory` to ask a question, the default to keep a
//   fact base.
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
  // `--in-memory` is a boolean flag, so the minimal parser will have eaten the
  // NEXT token as its "value". Treat any presence of the flag as true and push
  // that token back — otherwise `--in-memory report` silently loses `report`.
  const inMemory = process.argv.includes("--in-memory");
  const dbPath = inMemory ? ":memory:" : (a.db || path.join(process.cwd(), "hypha.db"));

  if (!cmd || !["map", "report", "query"].includes(cmd)) {
    console.log("usage: hypha <map|report|query> --root <galerina-checkout> [--db hypha.db] [--in-memory] [--out report.md]");
    console.log("       --in-memory  answer from memory; write no .db and no .json mirror");
    process.exit(2);
  }
  if (inMemory && cmd === "map") {
    // `map` exists to PRODUCE the fact base. In memory it would build one and
    // throw it away, which is not a lesser version of the command — it is a
    // no-op wearing its name. Refuse rather than appear to succeed.
    console.error("hypha: `map --in-memory` would build a fact base and discard it. Use `report`/`query --in-memory` to ask a question, or drop --in-memory to keep the DB.");
    process.exit(2);
  }
  if ((cmd === "map" || cmd === "report" || inMemory || !fs.existsSync(dbPath)) && !root) {
    console.error("hypha: need --root or GALERINA_ROOT (a Galerina checkout to map)");
    process.exit(2);
  }

  // In passive mode the handle must stay OPEN: an in-memory database ceases to
  // exist when its last handle closes, so a closed one cannot be re-opened to
  // query. keepOpen returns it on facts.db.
  let liveDb = null;
  if (cmd === "map" || cmd === "report" || inMemory || !fs.existsSync(dbPath)) {
    const facts = buildMap(root, dbPath, inMemory ? { json: false, keepOpen: true } : undefined);
    liveDb = facts.db ?? null;
    console.error("[hypha] mapped: " + facts.gateList.names.length + " gate names, " +
      facts.stdlibCases.length + " stdlib arms, " + facts.inlineTables.length + " inline tables, " +
      facts.kindSets.length + " kind-sets, " + facts.exportedCheckers.length + " exported checkers -> " +
      (inMemory ? "(memory — nothing written)" : dbPath));
    if (cmd === "map") return;
  }

  const db = liveDb ?? Q.open(dbPath);
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
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
}

main();
