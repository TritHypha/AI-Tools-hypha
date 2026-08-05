// =============================================================================
// hypha — extract.js
//
// Reads a Galerina checkout (READ-ONLY) and extracts the raw facts the graph
// is built from. Everything here is line-based text extraction over the
// compiler's dist/ JavaScript — deliberately heuristic, never executing the
// target, and resilient to formatting drift (each extractor anchors on tokens
// that exist because of what the code MEANS, not how it is laid out).
//
// Extracted fact families (each returned as plain serialisable objects):
//   gateList         — STD_METHOD_NAMES: the ONE named routing set for method
//                      dispatch, with the section comments (// Array, // Map…)
//                      preserved, because the section is the author's intent.
//   stdlibCases      — every `case "name":` in stdlib.js (the implementations).
//   inlineTables     — the interpreter's per-receiver fallback tables
//                      (`if (receiver.__tag === "x") { switch … }`).
//   kindSets         — every Set literal whose members look like AST-node
//                      kinds ("…FlowDecl") anywhere in dist — the sentinel
//                      sets whose hand-copies drift.
//   passCalls        — call sites of check* / verifyGovernance in cli.js
//                      (what the CLI actually wires in).
//   exportedCheckers — every `export function check…` in dist (what EXISTS).
//   parserKinds      — every flow-decl node kind the parser can produce.
// =============================================================================
"use strict";

const fs = require("fs");
const path = require("path");

/** Resolve the compiler dist directory under a Galerina root, failing loudly
 *  (a missing dist means the map would be silently empty — refuse instead). */
function distDir(root) {
  const d = path.join(root, "packages-galerina", "galerina-core-compiler", "dist");
  if (!fs.existsSync(d)) {
    throw new Error("hypha: no compiler dist at " + d + " — pass a Galerina checkout via --root or GALERINA_ROOT");
  }
  return d;
}

/** Read one dist file as lines; returns [] when absent so extractors degrade
 *  to "no facts" rather than crashing the whole map. */
function distLines(root, file) {
  const p = path.join(distDir(root), file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n");
}

/** All .js files in dist (basenames) — the sweep universe for global scans. */
function distFiles(root) {
  return fs.readdirSync(distDir(root)).filter((f) => f.endsWith(".js"));
}

// ── gate list ────────────────────────────────────────────────────────────────

/**
 * STD_METHOD_NAMES lives in interpreter.js as a big array literal of quoted
 * names with `// Section` comments between runs. Anchor: the declaration line
 * itself (`STD_METHOD_NAMES`), then consume until the closing bracket.
 * Returns { names: [{name, section, line}], file, startLine } — the section
 * carried per-name so surface queries can group by the author's own taxonomy.
 */
function extractGateList(root) {
  const file = "interpreter.js";
  const lines = distLines(root, file);
  const startIdx = lines.findIndex((ln) => /STD_METHOD_NAMES\s*=/.test(ln));
  if (startIdx === -1) return { file, startLine: -1, names: [] };
  const names = [];
  let section = "(unsectioned)";
  for (let i = startIdx; i < lines.length; i++) {
    const ln = lines[i];
    const comment = ln.match(/\/\/\s*(.+)$/);
    // A section comment renames the bucket for every name that follows it.
    if (comment && !/^https?:/.test(comment[1])) section = comment[1].trim();
    for (const m of ln.matchAll(/"([A-Za-z0-9_]+)"/g)) {
      names.push({ name: m[1], section, line: i + 1 });
    }
    // The literal ends at the first `]` after the declaration line.
    if (i > startIdx && ln.includes("]")) break;
  }
  return { file, startLine: startIdx + 1, names };
}

// ── stdlib implementations ───────────────────────────────────────────────────

/**
 * stdlib.js implements gate-listed methods as `case "name":` arms. Every arm
 * is one fact: (name, line). Duplicate names are expected (per-receiver arms).
 */
function extractStdlibCases(root) {
  const file = "stdlib.js";
  const out = [];
  distLines(root, file).forEach((ln, i) => {
    const m = ln.match(/case\s+"([A-Za-z0-9_]+)"\s*:/);
    if (m) out.push({ name: m[1], file, line: i + 1 });
  });
  return out;
}

// ── interpreter inline fallback tables ───────────────────────────────────────

/**
 * The interpreter's per-receiver fallbacks look like:
 *   if (receiver.__tag === "list") { switch (method) { case "count": … } }
 * Heuristic: on a `__tag === "x"` line open a bucket; every `case "n":` line
 * belongs to the most recent bucket until the next `__tag` guard. This is the
 * layer that mis-led a human reader into calling it "the method table" — the
 * graph records it as the FALLBACK layer it actually is.
 */
function extractInlineTables(root) {
  const file = "interpreter.js";
  const buckets = [];
  let current = null;
  distLines(root, file).forEach((ln, i) => {
    const tag = ln.match(/receiver\.__tag\s*===\s*"([A-Za-z0-9_]+)"/);
    if (tag) {
      current = { receiverTag: tag[1], file, line: i + 1, cases: [] };
      buckets.push(current);
      return;
    }
    const c = ln.match(/case\s+"([A-Za-z0-9_]+)"\s*:/);
    if (c && current) current.cases.push({ name: c[1], line: i + 1 });
  });
  // Only buckets that actually dispatch methods are tables.
  return buckets.filter((b) => b.cases.length > 0);
}

// ── kind sets (the drift-prone sentinels) ────────────────────────────────────

/**
 * Every `new Set([ … ])` literal in dist whose members include an AST-node
 * kind ending in FlowDecl. These are the hand-copied sentinel sets whose
 * membership drifts (the four-copy FLOW_KINDS omission of governedFlowDecl
 * is the motivating incident). Multi-line literals are handled by joining a
 * short window after the opening line.
 */
function extractKindSets(root) {
  const out = [];
  for (const file of distFiles(root)) {
    const lines = distLines(root, file);
    lines.forEach((ln, i) => {
      if (!/new Set\(\[/.test(ln)) return;
      // Join up to 5 lines so multi-line set literals are captured whole.
      const window = lines.slice(i, i + 5).join(" ");
      const lit = window.match(/new Set\(\[([^\]]*)\]/);
      if (!lit) return;
      const members = [...lit[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
      if (!members.some((x) => /FlowDecl$/.test(x))) return;
      out.push({ file, line: i + 1, members });
    });
  }
  return out;
}

// ── CLI pass wiring ──────────────────────────────────────────────────────────

/** Call sites in cli.js of check* passes and verifyGovernance — the wiring
 *  layer. A checker missing here (in every mode) is dead from this CLI. */
function extractPassCalls(root) {
  const file = "cli.js";
  const out = [];
  distLines(root, file).forEach((ln, i) => {
    for (const m of ln.matchAll(/\b(check[A-Z][A-Za-z0-9]*|verifyGovernance)\s*\(/g)) {
      // Skip definitions — a call site is a use, not a declaration.
      if (/function\s/.test(ln)) continue;
      out.push({ name: m[1], file, line: i + 1, text: ln.trim().slice(0, 160) });
    }
  });
  return out;
}

/** Every exported check* function across dist — what EXISTS, to diff against
 *  what is WIRED. (checkEvents exported-but-never-called is the incident.) */
function extractExportedCheckers(root) {
  const out = [];
  for (const file of distFiles(root)) {
    distLines(root, file).forEach((ln, i) => {
      const m = ln.match(/export\s+(?:async\s+)?function\s+(check[A-Z][A-Za-z0-9]*)/);
      if (m) out.push({ name: m[1], file, line: i + 1 });
    });
  }
  return out;
}

/** Call sites of any name, across ALL dist files AND the root galerina.mjs
 *  (the public CLI imports dist/index.js — a checker dead in dist can still
 *  be alive from the root; scanning both keeps "dead" honest). */
function findCallSites(root, name) {
  const out = [];
  const scan = (lines, file) => {
    lines.forEach((ln, i) => {
      if (new RegExp("\\b" + name + "\\s*\\(").test(ln) &&
          !/function\s/.test(ln) && !/\/\//.test(ln.split(name)[0] || "")) {
        out.push({ file, line: i + 1 });
      }
    });
  };
  for (const file of distFiles(root)) scan(distLines(root, file), file);
  const rootCli = path.join(root, "galerina.mjs");
  if (fs.existsSync(rootCli)) {
    scan(fs.readFileSync(rootCli, "utf8").split("\n"), "galerina.mjs");
  }
  return out;
}

// ── parser-producible kinds ──────────────────────────────────────────────────

/** Flow-decl node kinds the parser can actually produce (`kind: "xFlowDecl"`).
 *  The coverage query diffs these against every kind-set's membership. */
function extractParserKinds(root) {
  const kinds = new Set();
  distLines(root, "parser.js").forEach((ln) => {
    for (const m of ln.matchAll(/kind:\s*"([A-Za-z0-9_]*FlowDecl)"/g)) kinds.add(m[1]);
  });
  return [...kinds].sort();
}

module.exports = {
  distDir, distFiles,
  extractGateList, extractStdlibCases, extractInlineTables,
  extractKindSets, extractPassCalls, extractExportedCheckers,
  findCallSites, extractParserKinds,
};
