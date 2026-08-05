// =============================================================================
// hypha — db.js
//
// Persists the extracted facts into SQLite (node:sqlite, built into Node 24 —
// zero dependencies, synchronous API) and mirrors them to a portable JSON.
//
// The DB is the queryable artifact: every query in queries.js is SQL over
// these tables, and sporeprint (the dynamic lane) writes its execution-verified
// matrix into the SAME file so static claims can be joined against runtime
// ground truth (`verified_surface`).
// =============================================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const X = require("./extract");

/** Open (or create) the hypha DB and (re)create the fact tables. A map run is
 *  a full rebuild — facts are cheap to extract and stale rows are worse than
 *  no rows, so we DROP first rather than diff. */
function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    DROP TABLE IF EXISTS gate_names;
    DROP TABLE IF EXISTS stdlib_cases;
    DROP TABLE IF EXISTS inline_cases;
    DROP TABLE IF EXISTS kind_sets;
    DROP TABLE IF EXISTS kind_set_members;
    DROP TABLE IF EXISTS pass_calls;
    DROP TABLE IF EXISTS exported_checkers;
    DROP TABLE IF EXISTS checker_call_sites;
    DROP TABLE IF EXISTS parser_kinds;
    DROP TABLE IF EXISTS meta;
    CREATE TABLE gate_names        (name TEXT, section TEXT, line INTEGER);
    CREATE TABLE stdlib_cases      (name TEXT, file TEXT, line INTEGER);
    CREATE TABLE inline_cases      (receiver_tag TEXT, name TEXT, file TEXT, line INTEGER);
    CREATE TABLE kind_sets         (set_id INTEGER, file TEXT, line INTEGER);
    CREATE TABLE kind_set_members  (set_id INTEGER, member TEXT);
    CREATE TABLE pass_calls        (name TEXT, file TEXT, line INTEGER, text TEXT);
    CREATE TABLE exported_checkers (name TEXT, file TEXT, line INTEGER);
    CREATE TABLE checker_call_sites(name TEXT, file TEXT, line INTEGER);
    CREATE TABLE parser_kinds      (kind TEXT);
    CREATE TABLE meta              (key TEXT, value TEXT);
  `);
  return db;
}

/** Extract every fact family from the Galerina root and load the DB.
 *  Also writes <dbPath>.json with the same content for tools without SQLite. */
function buildMap(root, dbPath) {
  const facts = {
    root,
    builtAt: new Date().toISOString(),
    gateList: X.extractGateList(root),
    stdlibCases: X.extractStdlibCases(root),
    inlineTables: X.extractInlineTables(root),
    kindSets: X.extractKindSets(root),
    passCalls: X.extractPassCalls(root),
    exportedCheckers: X.extractExportedCheckers(root),
    parserKinds: X.extractParserKinds(root),
  };
  // Dead-export adjudication needs global call sites per exported checker —
  // collected here (extraction pass) so queries stay pure SQL.
  facts.checkerCallSites = {};
  for (const c of facts.exportedCheckers) {
    facts.checkerCallSites[c.name] = X.findCallSites(root, c.name)
      // A "call site" inside the defining file at the definition line is the
      // definition itself leaking through the regex — drop it.
      .filter((s) => !(s.file === c.file && s.line === c.line));
  }

  const db = openDb(dbPath);
  const tx = (sql, rows, bind) => {
    const st = db.prepare(sql);
    for (const r of rows) st.run(...bind(r));
  };
  tx("INSERT INTO gate_names VALUES (?,?,?)", facts.gateList.names,
     (r) => [r.name, r.section, r.line]);
  tx("INSERT INTO stdlib_cases VALUES (?,?,?)", facts.stdlibCases,
     (r) => [r.name, r.file, r.line]);
  for (const t of facts.inlineTables) {
    tx("INSERT INTO inline_cases VALUES (?,?,?,?)", t.cases,
       (c) => [t.receiverTag, c.name, t.file, c.line]);
  }
  facts.kindSets.forEach((s, i) => {
    db.prepare("INSERT INTO kind_sets VALUES (?,?,?)").run(i, s.file, s.line);
    for (const m of s.members) {
      db.prepare("INSERT INTO kind_set_members VALUES (?,?)").run(i, m);
    }
  });
  tx("INSERT INTO pass_calls VALUES (?,?,?,?)", facts.passCalls,
     (r) => [r.name, r.file, r.line, r.text]);
  tx("INSERT INTO exported_checkers VALUES (?,?,?)", facts.exportedCheckers,
     (r) => [r.name, r.file, r.line]);
  for (const [name, sites] of Object.entries(facts.checkerCallSites)) {
    tx("INSERT INTO checker_call_sites VALUES (?,?,?)", sites,
       (s) => [name, s.file, s.line]);
  }
  tx("INSERT INTO parser_kinds VALUES (?)", facts.parserKinds, (k) => [k]);
  db.prepare("INSERT INTO meta VALUES (?,?)").run("root", root);
  db.prepare("INSERT INTO meta VALUES (?,?)").run("builtAt", facts.builtAt);
  db.close();

  // JSON mirror — same facts, portable, diffable in a PR.
  fs.writeFileSync(dbPath + ".json", JSON.stringify(facts, null, 1));
  return facts;
}

module.exports = { buildMap, DatabaseSync };
