#!/usr/bin/env node
// =============================================================================
// hypha — src/check-docs.js
//
// Doc-to-source parity for the parts of the documentation that are EXECUTED
// rather than read.
//
// WHY THIS EXISTS. `docs/SPOREPRINT.md` documented the `verified_surface` table
// as four columns named `(name, receiver, verdict, evidence)`. The real table is
// five, in a different order, with two different names:
//
//     CREATE TABLE IF NOT EXISTS verified_surface (
//       receiver TEXT, name TEXT, status TEXT, detail TEXT, shape TEXT
//     )
//
// sporeprint inserts positionally — `INSERT INTO verified_surface VALUES
// (?,?,?,?,?)` — so a table built from the documented order is populated
// WRONGLY rather than rejected. A reader following that document would have got
// silent nonsense.
//
// Prose invites scrutiny; a schema invites use. Nobody copies a paragraph into a
// query editor. The parts of a document that are executed need the verification
// the parts that are read merely deserve.
//
// TWO CHECKS, AND THEY FAIL DIFFERENTLY:
//   1. hypha's own SCHEMA.md against src/db.js — always runnable, must be exact.
//   2. SPOREPRINT.md's quoted foreign schema against sporeprint's source — only
//      when sporeprint is reachable. When it is not, this reports SKIPPED and
//      NEVER passes. A check that cannot run must not print green.
//
// Exit codes: 0 clean · 1 a mismatch · 2 the check could not run at all.
// Writes nothing.
// =============================================================================
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const HERE = path.join(__dirname, "..");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };

/** Every `CREATE TABLE name (cols…)` in a source text, columns in declared order. */
function tablesIn(text) {
  const out = {};
  if (!text) return out;
  const RE = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z_]+)\s*\(([\s\S]*?)\)/gi;
  for (const m of text.matchAll(RE)) {
    out[m[1]] = m[2]
      .split(",")
      .map((c) => c.trim().split(/\s+/)[0])
      // Drop table constraints; they are not columns and their position is not meaningful.
      .filter((c) => c && /^[a-z_]+$/i.test(c) && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(c));
  }
  return out;
}

/**
 * A doc's column lists, looked up BY NAME from the source.
 *
 * SCHEMA.md writes them bare — `gate_names (name TEXT, section TEXT, line INTEGER)` — with no
 * `CREATE TABLE` prefix, which is perfectly readable and completely ambiguous to a parser: the
 * same shape is a function call. So the source is enumerated first and each table is looked up by
 * its own name. A bare pattern can then never match prose, because only real table names are
 * searched for.
 *
 * Only fenced blocks are read. A table named in a sentence is documentation, not a schema.
 */
function tablesInDoc(md, knownNames) {
  const out = {};
  if (!md) return out;
  // Same pairing rule as the flag scan: every fence delimits, only SQL fences contribute.
  // Accepting just ```/```sql as an opener left other-language blocks unpaired and let
  // their closers pair with later openers, capturing prose that was never a schema.
  const fenced = [...md.matchAll(/```([a-z]*)\r?\n([\s\S]*?)```/g)]
    .filter((m) => m[1] === "" || m[1] === "sql")
    .map((m) => m[2]).join("\n");
  for (const name of knownNames) {
    const re = new RegExp("(?:CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+)?\\b" + name + "\\s*\\(([^)]*)\\)");
    const m = re.exec(fenced);
    if (!m) continue;
    const cols = m[1].split(",").map((c) => c.trim().split(/\s+/)[0])
      .filter((c) => c && /^[a-z_]+$/i.test(c) && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(c));
    if (cols.length) out[name] = cols;
  }
  return out;
}

const results = [];
const say = (ok, label, detail) => { results.push({ ok, label, detail }); };

// ── check 1: hypha's own schema ──────────────────────────────────────────────
{
  const src = tablesIn(read(path.join(HERE, "src/db.js")));
  const srcNames = Object.keys(src);
  const doc = tablesInDoc(read(path.join(HERE, "docs/SCHEMA.md")), srcNames);
  if (srcNames.length === 0) {
    say(false, "own schema: src/db.js yielded no CREATE TABLE", "the check cannot run, so it does not pass");
  } else {
    for (const t of srcNames) {
      const d = doc[t];
      if (!d) { say(false, `own schema: \`${t}\` has no column block in SCHEMA.md`, "documented in prose only — not checkable"); continue; }
      const same = d.length === src[t].length && src[t].every((c, i) => c === d[i]);
      say(same, `own schema: \`${t}\``, same ? `${d.length} columns, in order`
        : `source (${src[t].join(", ")}) vs doc (${d.join(", ")})`);
    }
    for (const t of Object.keys(doc)) if (!src[t]) say(false, `own schema: \`${t}\` is in the doc and not in src/db.js`, "phantom table");
  }
}

// ── check 2: the foreign schema quoted in SPOREPRINT.md ──────────────────────
{
  // sporeprint lives outside this repository. Reachability is normal-case, not an error —
  // but an unreachable check reports SKIPPED and never green.
  const candidates = [
    path.join(HERE, "../sporeprint/src/cli.js"),
    path.join(HERE, "../../sporeprint/src/cli.js"),
  ];
  const found = candidates.map(read).find((t) => t !== null);
  if (!found) {
    // Reachability is still checked against the doc's own claims, so an
    // unreachable source SKIPS rather than passes — but only after asserting
    // the doc quotes at least the surface table it exists to describe.
    const doc = tablesInDoc(read(path.join(HERE, "docs/SPOREPRINT.md")), ["verified_surface", "verified_meta"]);
    if (!doc.verified_surface) say(false, "sporeprint join: SPOREPRINT.md quotes no verified_surface block", "the join cannot be checked from the doc");
    results.push({ skipped: true, label: "sporeprint join: source not reachable",
      detail: `looked in ${candidates.map((c) => path.relative(HERE, c)).join(" and ")}` });
  } else {
    // ★ EVERY table sporeprint creates must be documented, in column order —
    // not just the one this check was first written for. `verified_meta` was
    // added by the provenance change (owner Q3); a hand-kept list here would
    // have silently exempted it, which is exactly the drift class this file
    // exists to catch. The source enumerates; the doc answers.
    const real = tablesIn(found);
    const names = Object.keys(real);
    const doc = tablesInDoc(read(path.join(HERE, "docs/SPOREPRINT.md")), names);
    if (names.length === 0) say(false, "sporeprint join: no CREATE TABLE in sporeprint's source", "cannot compare");
    for (const t of names) {
      const quoted = doc[t];
      if (!quoted) { say(false, `sporeprint join: \`${t}\` has no column block in SPOREPRINT.md`, "sporeprint creates it; the join doc must describe it"); continue; }
      const same = quoted.length === real[t].length && real[t].every((c, i) => c === quoted[i]);
      say(same, `sporeprint join: \`${t}\``, same ? `${real[t].length} columns, in order`
        : `source (${real[t].join(", ")}) vs doc (${quoted.join(", ")})`);
    }
  }
}

// ── check 3: query names — the doc's headings against the module's functions ─
// A documented query that is not a function is a promise the tool cannot keep; a function that is
// not documented is a capability nobody can find. Both directions matter, so both are asserted.
{
  const q = read(path.join(HERE, "src/queries.js"));
  const doc = read(path.join(HERE, "docs/QUERIES.md"));
  if (!q || !doc) {
    say(false, "query names: src/queries.js or docs/QUERIES.md unreadable", "the check cannot run, so it does not pass");
  } else {
    // `open` connects the database, `render` formats, and `readVerifiedMeta` validates the
    // sporeprint provenance stamp for `render` — none is a query a user can name at the CLI.
    // Helpers and report plumbing are not named queries; `status` is a CLI
    // command documented under its own heading, not a ## `status` query.
    const NOT_QUERIES = new Set(["open", "render", "readVerifiedMeta", "readMeta", "status"]);
    const fns = [...q.matchAll(/^function\s+([A-Za-z_][\w]*)/gm)].map((m) => m[1]).filter((n) => !NOT_QUERIES.has(n));
    // Headings are kebab-case (`duplicate-sets`); functions are camelCase. `surface` appears under
    // several headings (`surface`, `surface:<name>`) — one capability, several usages.
    const kebabToCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const documented = [...new Set([...doc.matchAll(/^#{2,3} `([a-z][a-z0-9-]*)`/gm)].map((m) => kebabToCamel(m[1])))];
    if (fns.length === 0) say(false, "query names: no functions found in src/queries.js", "the check cannot run");
    else {
      const missing = documented.filter((n) => !fns.includes(n));
      const undocumented = fns.filter((n) => !documented.includes(n));
      say(missing.length === 0, "query names: every documented query is a function",
        missing.length ? `documented but absent: ${missing.join(", ")}` : `${documented.length} documented`);
      say(undocumented.length === 0, "query names: every function is documented",
        undocumented.length ? `undocumented: ${undocumented.join(", ")}` : `${fns.length} functions`);
    }
  }
}

// ── check 4: exit codes, and the CLI commands quoted in fenced blocks ────────
{
  const cli = read(path.join(HERE, "src/cli.js"));
  const doc = read(path.join(HERE, "docs/QUERIES.md"));
  const readme = read(path.join(HERE, "README.md"));
  if (!cli) {
    say(false, "cli surface: src/cli.js unreadable", "the check cannot run, so it does not pass");
  } else {
    // Exit codes. `0` is emitted by falling off the end and never appears as a literal, so a
    // documented `0` is satisfied by normal completion; every other documented code must exist.
    const emitted = new Set([...cli.matchAll(/process\.exit\(\s*(\d+)\s*\)/g)].map((m) => m[1]));
    const documented = new Set([...(doc || "").matchAll(/^\|\s*`?(\d)`?\s*\|/gm)].map((m) => m[1]));
    const phantom = [...documented].filter((c) => c !== "0" && !emitted.has(c));
    const unlisted = [...emitted].filter((c) => !documented.has(c));
    say(phantom.length === 0, "exit codes: every documented code (other than 0) is emitted",
      phantom.length ? `documented, never emitted: ${phantom.join(", ")}` : `${[...documented].sort().join(", ")} documented`);
    say(unlisted.length === 0, "exit codes: every emitted code is documented",
      unlisted.length ? `emitted, undocumented: ${unlisted.join(", ")}` : `${[...emitted].sort().join(", ")} emitted`);

    // Commands. Read FENCED BLOCKS ONLY. Prose says things like "hypha connects the two lanes",
    // and a matcher that reads sentences will report `connects` as a command — which it did, the
    // first time this was measured. A fenced block is the only place a doc claims runnability.
    const usage = /usage:\s*hypha\s*<([a-z|]+)>/.exec(cli);
    const known = usage ? usage[1].split("|") : [];
    const fenced = [readme, doc].filter(Boolean)
      // Same pairing rule as the flag scan below: all fences delimit, shell fences contribute.
      .flatMap((t) => [...t.matchAll(/```([a-z]*)\r?\n([\s\S]*?)```/g)]
        .filter((m) => m[1] === "" || m[1] === "bash" || m[1] === "sh")
        .map((m) => m[2])).join("\n");
    const quoted = [...new Set([...fenced.matchAll(/(?:node\s+src\/cli\.js|hypha)\s+([a-z-]+)/g)].map((m) => m[1]))];
    if (known.length === 0) say(false, "cli surface: no usage string found in src/cli.js", "cannot establish the command set");
    else {
      const bogus = quoted.filter((c) => !known.includes(c));
      say(bogus.length === 0, "cli commands: every command quoted in a fenced block is real",
        bogus.length ? `quoted but not a command: ${bogus.join(", ")}` : `${quoted.join(", ")} against usage <${known.join("|")}>`);
    }
  }
}

// ── check 5: flags — three-way, and entirely static ─────────────────────────
// A flag exists in three places, and they must agree:
//   DECLARED  the usage string          — what the tool says it accepts
//   CONSUMED  `a.<name>` / `includes("--name")` — what the tool actually reads
//   PROMISED  fenced blocks in the docs — what a reader is told to type
//
// The interesting failure is PROMISED but not CONSUMED: a flag that is documented, declared, and
// silently ignored. A reader types it, nothing happens, and neither the tool nor the document is
// obviously at fault. No amount of `--help` output would reveal that — only reading the code does.
//
// NOT asserted: that every consumed flag is documented. An internal flag is a legitimate choice,
// and a check should assert what MUST be true rather than what happens to be true today.
{
  const cli = read(path.join(HERE, "src/cli.js"));
  if (!cli) {
    say(false, "flags: src/cli.js unreadable", "the check cannot run, so it does not pass");
  } else {
    const usage = cli.split(/\r?\n/).filter((l) => /usage:/.test(l)).join(" ");
    const declared = new Set([...usage.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
    // `parseArgs` turns `--name value` into `out[name]`; a valueless flag is tested with includes().
    const consumed = new Set([
      ...[...cli.matchAll(/\ba\.([a-z][a-zA-Z0-9]*)\b/g)].map((m) => m[1]),
      ...[...cli.matchAll(/includes\(\s*"--([a-z][a-z0-9-]*)"\s*\)/g)].map((m) => m[1]),
    ]);
    const promised = new Set();
    for (const f of ["README.md", "docs/QUERIES.md", "docs/SCHEMA.md", "docs/LIMITS.md", "docs/SPOREPRINT.md"]) {
      const t = read(path.join(HERE, f));
      if (!t) continue;
      // EVERY fence must participate in PAIRING, even ones whose flags we ignore.
      // The old pattern accepted only ```/```bash/```sh as an opener, so a block
      // tagged any other language left its markers unpaired — and the scan then
      // paired that block's CLOSER with a later opener, swallowing the prose
      // between them. A prose table containing `--scan full` was harvested that
      // way as a "documented flag", and which flags were found depended on how
      // many code blocks happened to precede them. Adding an unrelated ```bash
      // example anywhere in any doc could change the answer here.
      const fenced = [...t.matchAll(/```([a-z]*)\r?\n([\s\S]*?)```/g)]
        .filter((m) => m[1] === "" || m[1] === "bash" || m[1] === "sh")
        .map((m) => m[2]).join("\n");
      for (const m of fenced.matchAll(/--([a-z][a-z0-9-]*)/g)) promised.add(m[1]);
    }
    if (declared.size === 0) say(false, "flags: no usage string found", "the check cannot run");
    else {
      const dead = [...promised].filter((f) => !consumed.has(f));
      const undeclared = [...promised].filter((f) => !declared.has(f));
      const declaredDead = [...declared].filter((f) => !consumed.has(f));
      say(dead.length === 0, "flags: every documented flag is actually read",
        dead.length ? `promised but never consumed: ${dead.map((f) => "--" + f).join(", ")}` : `${promised.size} documented`);
      say(undeclared.length === 0, "flags: every documented flag is in the usage string",
        undeclared.length ? `promised but undeclared: ${undeclared.map((f) => "--" + f).join(", ")}` : `${declared.size} declared`);
      say(declaredDead.length === 0, "flags: every declared flag is read",
        declaredDead.length ? `declared but never consumed: ${declaredDead.map((f) => "--" + f).join(", ")}` : `${consumed.size} consumed`);
    }
  }
}

// ── check 6: negative flag claims — a denial is a claim ──────────────────────
// Checks 3–5 validate POSITIVE claims: is what the code does documented? None of them can read a
// sentence asserting a flag does NOT exist. The sibling devtool shipped with `No --root` in three
// documentation sites while its CLI consumed, advertised and even RECOMMENDED the flag — and the
// direction matters: an under-documented capability is self-healing (someone tries it, it works),
// but nobody tests for a capability they have been told is absent. The denial removes the
// experiment that would refute it.
//
// TWO grammar classes must NOT fire, and each earned its place by firing falsely first:
//   1. subordinator  — "No output file unless `--out` names one" denies the FILE, not the flag;
//                      `unless` reintroduces the flag as the condition under which it appears.
//   2. absence-event — "usage error — unknown query, or no `--root`" (QUERIES.md's own exit-code
//                      table) describes the ERROR PATH when the flag is not supplied, which
//                      presupposes the flag exists. Denying an ontology and reporting an event
//                      share the word "no"; only the first is a claim of absence.
{
  const cli = read(path.join(HERE, "src/cli.js"));
  if (!cli) {
    say(false, "denials: src/cli.js unreadable", "the check cannot run, so it does not pass");
  } else {
    const consumed = new Set([
      ...[...cli.matchAll(/\ba\.([a-z][a-zA-Z0-9]*)\b/g)].map((m) => m[1]),
      ...[...cli.matchAll(/includes\(\s*"--([a-z][a-z0-9-]*)"\s*\)/g)].map((m) => m[1]),
    ]);
    // Sentence-local: the gap may not cross a `.` or a newline, so one claim cannot borrow
    // another sentence's negation.
    const NEGATION = /\b(?:no|without|never|not)\b[^.\n]{0,40}?--([a-z][a-z0-9-]*)/gi;
    const SUBORDINATOR = /\b(?:unless|until|except|other than|besides|save for|apart from)\b/i;
    // Absence-event context, judged on the LINE the match sits in: error/usage vocabulary, or the
    // negation arriving as a disjunct/conditional ("or no", "if no", "when no").
    const EVENT_LINE = /\b(?:error|usage|exit|missing|need|require[sd]?)\b/i;
    const EVENT_LEAD = /\b(?:or|if|when|and)\s+no\b[^.\n]{0,40}?--/i;
    const denials = [];
    for (const f of ["README.md", "docs/QUERIES.md", "docs/SCHEMA.md", "docs/LIMITS.md", "docs/SPOREPRINT.md", "src/cli.js"]) {
      const t = read(path.join(HERE, f));
      if (!t) continue;
      for (const m of t.matchAll(NEGATION)) {
        if (SUBORDINATOR.test(m[0])) continue;
        const lineStart = t.lastIndexOf("\n", m.index) + 1;
        const line = t.slice(lineStart, t.indexOf("\n", m.index) === -1 ? t.length : t.indexOf("\n", m.index));
        if (EVENT_LINE.test(line) || EVENT_LEAD.test(line)) continue;
        if (consumed.has(m[1])) {
          denials.push(`${f}:${t.slice(0, m.index).split("\n").length} says "${m[0].replace(/\s+/g, " ").trim()}"`);
        }
      }
    }
    // LIVENESS: an empty consumed set makes every denial read as true — fail closed on it.
    if (consumed.size === 0) say(false, "denials: read no consumed flags from src/cli.js", "the matcher is dead, not the flags");
    else say(denials.length === 0, "denials: no document denies a flag the CLI accepts",
      denials.length ? denials.join(" · ") : `${consumed.size} consumed flags checked against 6 documents`);
  }
}

// ── check 7: package-claim denials — "no dependencies", "no build step" ──────
// Behavioural denials mostly need execution to verify, but two are static: a doc claiming the
// package has no dependencies or no build step is making a claim about package.json, and
// package.json is right here. Checked ONLY when the claim is made — a package that says neither
// asserts neither, and this check must not force a style on it.
{
  const pkgText = read(path.join(HERE, "package.json"));
  const readme = read(path.join(HERE, "README.md")) || "";
  if (!pkgText) {
    say(false, "package claims: package.json unreadable", "the check cannot run, so it does not pass");
  } else {
    let pkg;
    try { pkg = JSON.parse(pkgText); }
    catch { pkg = null; say(false, "package claims: package.json does not parse", "cannot compare claims against it"); }
    if (pkg) {
      if (/\bno dependencies\b|\bzero dependencies\b|\bdependency-free\b/i.test(readme)) {
        const deps = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})];
        say(deps.length === 0, "package claims: \"no dependencies\" is true",
          deps.length ? `package.json lists: ${deps.join(", ")}` : "no dependencies, no devDependencies");
      }
      if (/\bno build step\b|\bno build\b/i.test(readme)) {
        const hasBuild = Object.keys(pkg.scripts || {}).some((s) => /^(pre|post)?build$/.test(s));
        say(!hasBuild, "package claims: \"no build step\" is true",
          hasBuild ? "package.json has a build script" : "no build script in package.json");
      }
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────
// ── artifact hygiene: the persisted root must be a receipt, not a build path ──
//
// `report.md` exists to be SHARED — pasted into an issue, attached to a review — and
// it prints `meta.root` in its header. An absolute path there carries a username off
// this machine. The generated artifacts are correctly gitignored, so nothing reached
// the repository; .gitignore cannot cover the sharing route, so this does.
//
// A KAT WITH ITS CONTROL. Asserting only "the output has no path shape" would pass
// just as happily against a detector that matches nothing, so the same regex is first
// required to FIRE on the raw input. Without that, this check would measure itself.
{
  const ABSOLUTE = /[A-Za-z]:[\\/]Users[\\/]|\/(?:home|Users)\/[^/\s"']+/;
  const SAMPLE = "C:\\Users\\someone\\Documents\\GitHub\\Galerina";

  let db = null;
  try { db = require("./db.js"); } catch { db = null; }

  if (db === null || typeof db.displayRoot !== "function") {
    // Cannot run ⇒ does not pass. node:sqlite is a Node 24 built-in and db.js
    // requires it at load, so an older runtime lands here rather than green.
    results.push({ skipped: true, label: "artifact hygiene: db.js not loadable",
      detail: "node:sqlite unavailable? the check cannot run, so it does not pass" });
  } else {
    say(ABSOLUTE.test(SAMPLE),
      "artifact hygiene CONTROL: the detector fires on a raw absolute path",
      "without this, a clean result would only prove the regex matches nothing");

    const shown = db.displayRoot(SAMPLE);
    say(!ABSOLUTE.test(shown),
      "artifact hygiene: displayRoot() strips the absolute path",
      `${SAMPLE} -> ${shown}`);
    say(shown === "Galerina",
      "artifact hygiene: the receipt is still useful (basename kept)",
      `got ${JSON.stringify(shown)}`);
    say(db.displayRoot(undefined) === "<unknown>",
      "artifact hygiene: terminal arm names an unrecognised root rather than passing it through",
      `got ${JSON.stringify(db.displayRoot(undefined))}`);

    // And the artifacts themselves, when present. Absent ⇒ SKIP: "no file, no hits"
    // is a fact about the scan, not about the tool.
    for (const rel of ["hypha.db.json", "report.md"]) {
      const text = read(path.join(HERE, rel));
      if (text === null) {
        results.push({ skipped: true, label: `artifact hygiene: ${rel} not present`,
          detail: "nothing to scan — absence is not evidence of cleanliness" });
        continue;
      }
      const hit = ABSOLUTE.exec(text);
      say(hit === null, `artifact hygiene: ${rel} carries no absolute local path`,
        hit === null ? `${text.length} bytes scanned` : `found at offset ${hit.index} — regenerate it`);
    }
  }
}

console.log("=== hypha --check-docs ===");
let failed = 0, skipped = 0;
for (const r of results) {
  if (r.skipped) { skipped++; console.log(`   ➖ ${r.label}${r.detail ? "   (" + r.detail + ")" : ""}`); continue; }
  if (!r.ok) failed++;
  console.log(`   ${r.ok ? "✅" : "❌"} ${r.label}${r.detail ? "   (" + r.detail + ")" : ""}`);
}
const ran = results.length - skipped;
console.log(`\n=== ${ran - failed}/${ran} checks pass${skipped ? `, ${skipped} skipped` : ""} ===`);
if (ran === 0) { console.error("hypha: no check could run — refusing to report success."); process.exit(2); }
process.exit(failed ? 1 : 0);
