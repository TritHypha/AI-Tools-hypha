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
const crypto = require("crypto");

/** Resolve the compiler dist directory under a Galerina root, failing loudly
 *  (a missing dist means the map would be silently empty — refuse instead). */
function distDir(root) {
  const candidates = [
    path.join(root, "packages-ts", "galerina-core-compiler", "dist"),
    path.join(root, "packages-galerina", "galerina-core-compiler", "dist"),
  ];
  const present = candidates.filter((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch (error) {
      if (error && error.code === "ENOENT") return false;
      throw error;
    }
  });
  if (present.length === 0) {
    throw new Error("hypha: no compiler dist at any registered layout (" +
      candidates.join(", ") + ") — pass a Galerina checkout via --root or GALERINA_ROOT");
  }
  if (present.length > 1) {
    throw new Error("hypha: ambiguous compiler dist layouts (" + present.join(", ") + ")");
  }
  return present[0];
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

/**
 * Call sites for MANY names in ONE sweep of the tree.
 *
 * WHY THIS EXISTS — measured on the real repo, 335 exported checkers:
 *
 *     all 8 extraction passes combined      124 ms     0.8 %
 *     335 × findCallSites (below)        16 236 ms    99.2 %
 *
 * `findCallSites` reads and scans the whole dist tree to answer for ONE name,
 * so mapping the checker surface read the tree 335 times. Same O(names × files)
 * comparisons either way — the defect was that the FILE READS were in the inner
 * loop, and reads are what cost. Inverting the loops: 16 203 ms → 333 ms, a 49×
 * improvement with byte-identical results across all 335 names (verified by a
 * differential against findCallSites, not by a spot check).
 *
 * Speed is a correctness argument for a tool like this: a 16-second map is one
 * nobody puts in a hook and nobody runs casually, and a detector nobody runs
 * detects nothing.
 *
 * The predicate is IDENTICAL to findCallSites — a faster engine answering a
 * slightly different question is not an optimisation. Returns
 * { [name]: [{file, line}] } with an empty array for names that have no call
 * sites, so "absent from the result" and "no call sites" can never be confused.
 */
function findAllCallSites(root, names) {
  const out = Object.create(null);
  for (const n of names) out[n] = [];
  if (names.length === 0) return out;

  const matchers = names.map((n) => ({
    name: n,
    re: new RegExp("\\b" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\("),
  }));

  /** The findCallSites predicate, applied to one file's lines. */
  const scan = (lines, file, present) => {
    lines.forEach((ln, i) => {
      if (/function\s/.test(ln)) return;                        // a definition, not a call
      for (const m of present) {
        if (!m.re.test(ln)) continue;
        if (/\/\//.test(ln.split(m.name)[0] || "")) continue;   // commented out
        out[m.name].push({ file, line: i + 1 });
      }
    });
  };

  const files = distFiles(root);
  let read = 0;
  for (const file of files) {
    // No try/catch: an unreadable dist file is not a "no call sites" answer, it
    // is a broken sweep. Swallowing it would turn total failure into a clean
    // bill of health — the exact fail-open this tool exists to detect.
    const text = fs.readFileSync(path.join(distDir(root), file), "utf8");
    read++;
    // A name absent from the file's text cannot have a call site in it. Most
    // names miss most files, so this pre-filter is where the time now goes.
    const present = matchers.filter((m) => text.includes(m.name));
    if (present.length === 0) continue;
    scan(text.split("\n"), file, present);
  }

  // The root CLI imports dist/index.js, so a checker dead within dist can still
  // be alive from the root. findCallSites scans it; omitting it here would make
  // "dead" dishonest and the two engines would disagree.
  const rootCli = path.join(root, "galerina.mjs");
  if (fs.existsSync(rootCli)) {
    const text = fs.readFileSync(rootCli, "utf8");
    scan(text.split("\n"), "galerina.mjs", matchers.filter((m) => text.includes(m.name)));
  }

  if (read === 0) {
    throw new Error("hypha: call-site sweep read 0 of " + files.length +
      " dist files — the sweep is broken, not the codebase");
  }
  return out;
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
 *
 * SCOPE RULE (LIMITS.md §12, fixed here 2026-08-09). A `case "n":` belongs to a
 * table only while brace-depth is *strictly inside* the `if (receiver.__tag …)`
 * body that opened it. The previous heuristic kept `current` until the next
 * tag, so every later switch in the file — `safeDisplay` value-kinds, the
 * string-escape decoder — was attributed to the last tag (often the real
 * `unresolved` arm). That produced **false presence**: 25 names reported in
 * the inline layer when they are formatters/escapes, not methods.
 *
 * Unattributed switches (a `switch` opened while no tag-bucket is open) are
 * still extracted, tagged `unresolved`, and returned so `surface` can report
 * them as context without counting them as dispatch. Fail closed on the layer
 * union; report the uncertainty.
 */
function extractInlineTables(root) {
  const file = "interpreter.js";
  const lines = distLines(root, file);
  const buckets = [];
  let depth = 0;
  let current = null;       // attributed: inside receiver.__tag body
  let una = null;           // unattributed switch body

  /** Approximate brace delta; strings with braces are rare in this dist region. */
  const braceDelta = (ln) => {
    let d = 0;
    for (let i = 0; i < ln.length; i++) {
      const ch = ln[i];
      if (ch === "{") d++;
      else if (ch === "}") d--;
    }
    return d;
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const tag = ln.match(/receiver\.__tag\s*===\s*"([A-Za-z0-9_]+)"/);
    if (tag) {
      // Close any open unattributed switch — a real tag supersedes it.
      una = null;
      current = {
        receiverTag: tag[1],
        file,
        line: i + 1,
        cases: [],
        openDepth: depth,
      };
      buckets.push(current);
    } else if (/switch\s*\(/.test(ln) && !current) {
      // Switch with no enclosing receiver-tag guard: context, not dispatch.
      una = {
        receiverTag: "unresolved",
        file,
        line: i + 1,
        cases: [],
        openDepth: depth,
      };
      buckets.push(una);
    }

    const c = ln.match(/case\s+"([A-Za-z0-9_]+)"\s*:/);
    if (c) {
      if (current && depth > current.openDepth) {
        current.cases.push({ name: c[1], line: i + 1 });
      } else if (una && depth > una.openDepth) {
        una.cases.push({ name: c[1], line: i + 1 });
      }
    }

    depth += braceDelta(ln);
    if (depth < 0) depth = 0;
    if (current && depth <= current.openDepth) current = null;
    if (una && depth <= una.openDepth) una = null;
  }
  // Only buckets that actually collected cases are tables.
  return buckets.filter((b) => b.cases.length > 0).map(({ receiverTag, file: f, line, cases }) =>
    ({ receiverTag, file: f, line, cases }));
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

/** Every exported function across dist — what EXISTS, to diff against what is
 *  WIRED. Originally `check*`-only; widened after `resolveImports` (a dead
 *  import resolver) slipped past that filter — a pass does not have to be
 *  named check* to be a pass. `isChecker` keeps the original subset visible. */
function extractExportedCheckers(root) {
  const out = [];
  for (const file of distFiles(root)) {
    distLines(root, file).forEach((ln, i) => {
      const m = ln.match(/export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (m) out.push({ name: m[1], file, line: i + 1, isChecker: /^check[A-Z]/.test(m[1]) });
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

/**
 * Every FUNGI-* diagnostic code that appears anywhere in dist, with the module
 * and line, plus the nearest message text on the same or following line.
 *
 * Added Tick 137: answering "does ANY checker warn about X?" was previously a
 * hand search, and a hand search cannot support an exhaustiveness claim. This
 * makes the inventory a query. It reports codes as they appear in SOURCE —
 * whether a given code can actually FIRE is a separate question (FUNGI-NUMERIC-001
 * is present here yet unreachable, because its trigger set is empty), so treat
 * the output as the code universe, not as live behaviour.
 */
function extractDiagnostics(root) {
  const out = [];
  for (const file of distFiles(root)) {
    const lines = distLines(root, file);
    lines.forEach((ln, i) => {
      // FUNGI-* (compute lane) and GATE-* (authority / .gate v3 lane). Presence ≠ reachability.
      for (const m of ln.matchAll(/"((?:FUNGI|GATE)-[A-Z0-9-]+)"/g)) {
        // Grab whatever message-ish text sits nearby, for semantic filtering.
        const ctx = (ln + " " + (lines[i + 1] ?? "") + " " + (lines[i + 2] ?? ""))
          .replace(/\s+/g, " ").slice(0, 400);
        out.push({ code: m[1], file, line: i + 1, context: ctx });
      }
    });
  }
  return out;
}

// ── freshness digests (LIMITS.md §11) ────────────────────────────────────────

/** SHA-256 of this extractor. A fact base built by a different extractor is not
 *  comparable to one built by this file — and until re-map must not be trusted. */
function extractorSha() {
  const p = path.join(__dirname, "extract.js");
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/**
 * Fingerprint of the *mapped target*: sorted basenames of dist/*.js with size
 * and mtimeMs, plus the root CLI when present. Cheap (no full-file hashing of
 * hundreds of KB × N), strong enough to detect "dist moved under us".
 *
 * Axis 2 of LIMITS §11: the extractor can be byte-identical while the codebase
 * it measured has changed. Recording only extractorSha is a half-guard.
 */
function targetSha(root) {
  const h = crypto.createHash("sha256");
  const dir = distDir(root);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
  for (const f of files) {
    const st = fs.statSync(path.join(dir, f));
    h.update(f + "\0" + st.size + "\0" + st.mtimeMs + "\n");
  }
  const rootCli = path.join(root, "galerina.mjs");
  if (fs.existsSync(rootCli)) {
    const st = fs.statSync(rootCli);
    h.update("galerina.mjs\0" + st.size + "\0" + st.mtimeMs + "\n");
  }
  h.update("fileCount=" + files.length + "\n");
  return h.digest("hex");
}

/**
 * Compare a stored meta map against the live tree / this extractor.
 * Returns { ok, warnings: string[] }. Never throws on missing meta keys —
 * an old DB simply reports every missing axis as a warning.
 */
function freshnessCheck(meta, root) {
  const warnings = [];
  const nowEx = extractorSha();
  if (!meta.extractorSha) {
    warnings.push("meta.extractorSha missing — fact base predates freshness stamps; re-run `hypha map`");
  } else if (meta.extractorSha !== nowEx) {
    warnings.push("extractorSha mismatch — src/extract.js changed since this DB was built; re-run `hypha map`");
  }
  if (root) {
    let nowTg;
    try { nowTg = targetSha(root); }
    catch (e) {
      warnings.push("targetSha unavailable: " + (e && e.message ? e.message : e));
      return { ok: warnings.length === 0, warnings, extractorSha: nowEx, targetSha: null };
    }
    if (!meta.targetSha) {
      warnings.push("meta.targetSha missing — fact base predates target stamps; re-run `hypha map`");
    } else if (meta.targetSha !== nowTg) {
      warnings.push("targetSha mismatch — Galerina dist/ (or galerina.mjs) changed since this DB was built; re-run `hypha map`");
    }
    return { ok: warnings.length === 0, warnings, extractorSha: nowEx, targetSha: nowTg };
  }
  return { ok: warnings.length === 0, warnings, extractorSha: nowEx, targetSha: meta.targetSha || null };
}

/**
 * Flow-decl node kinds the parser can actually produce.
 * The coverage query diffs these against every kind-set's membership, so this set
 * being short makes that query quietly vacuous rather than visibly broken.
 *
 * WHY THIS IS NOT `kind:\s*"…"` (fixed 2026-08-06). That anchor found exactly ONE
 * kind — `governedFlowDecl` — and one flow kind is implausible for this language.
 * Reading `parser.js` settled it: only the governed re-tag is written as an object
 * literal property (`kind: "governedFlowDecl"`). The three TIER kinds are assigned
 * to a local first:
 *
 *     const kind = qualifier === "secure"  ? "secureFlowDecl"
 *                : qualifier === "pure"    ? "pureFlowDecl"
 *                : qualifier === "guarded" ? "guardedFlowDecl"
 *
 * …and only later used as the node's kind. Anchoring on the property syntax
 * therefore measured the parser's *coding style*, not the kinds it produces —
 * and `kind-coverage` was diffing gating sets against a reference set of one,
 * so it could not have reported a gap in the three tiers even if one existed.
 *
 * The anchor is now the STRING LITERAL, scoped to parser.js. Every `"…FlowDecl"`
 * literal in the parser is a kind the parser emits; the file has 19 lines
 * mentioning FlowDecl and no counter-example. Scoping to parser.js is deliberate:
 * 21 downstream files CONSUME these kinds, and a consumer is not a producer —
 * widening to all of dist would also pick up the bare `"FlowDecl"` that appears
 * once, in manifest-generator.js, which the parser never emits.
 */
function extractParserKinds(root) {
  const kinds = new Set();
  distLines(root, "parser.js").forEach((ln) => {
    // Skip comment lines: a kind named only in prose is not a kind produced.
    if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
    for (const m of ln.matchAll(/"([A-Za-z0-9_]*FlowDecl)"/g)) kinds.add(m[1]);
  });
  return [...kinds].sort();
}

module.exports = {
  distDir, distFiles,
  extractGateList, extractStdlibCases, extractInlineTables,
  extractKindSets, extractPassCalls, extractExportedCheckers, extractDiagnostics,
  findCallSites, findAllCallSites, extractParserKinds,
  extractorSha, targetSha, freshnessCheck,
};
