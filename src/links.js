// Read-only consumer of myco.links.v1. Never opens the capability database.
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const kinds = ['BROKEN', 'TEMP_REFERENCE', 'UNAVAILABLE', 'EXCLUDED', 'UNPARSEABLE'];
const integer = x => Number.isSafeInteger(x) && x >= 0;
const strings = x => Array.isArray(x) && x.every(v => typeof v === 'string' && v.length <= 8192);
const limitKeys = ['intervalMs', 'debounceMs', 'maxQueue', 'maxDirs', 'maxEntries', 'maxFiles', 'maxFileBytes', 'maxTotalBytes', 'maxReferences', 'maxFindings', 'scanBudgetMs'];

function interpret(snapshot, expectedRoot, maxAgeMs = 120000, now = Date.now()) {
  const unknown = reason => ({ advisory: true, directSourceScan: false, status: 'UNKNOWN', reason });
  if (!snapshot || typeof snapshot !== 'object' || snapshot.schema !== 'myco.links.v1' || snapshot.producer !== 'myco') return unknown('INVALID_SCHEMA');
  const s = snapshot;
  if (typeof s.root !== 'string' || !path.isAbsolute(s.root) || path.resolve(s.root) !== path.resolve(expectedRoot)) return unknown('ROOT_MISMATCH');
  if (typeof s.session !== 'string' || !/^[0-9a-f-]{36}$/.test(s.session) || !integer(s.sequence) || s.sequence < 1 || typeof s.running !== 'boolean') return unknown('INVALID_PROVENANCE');
  const times = [s.startedAt, s.completedAt, s.publishedAt].map(t => typeof t === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(t) ? Date.parse(t) : NaN);
  if (times.some(t => !Number.isFinite(t)) || times[0] > times[1] || times[1] > times[2] || times[2] > now + 1000) return unknown('INVALID_TIME');
  if (!integer(maxAgeMs) || maxAgeMs < 1 || now - times[0] > maxAgeMs) return unknown('STALE');
  if (!strings(s.issues) || s.issues.length > 200 || !Array.isArray(s.findings) || s.findings.length > 50000 || !integer(s.files) || !integer(s.references)) return unknown('INVALID_COVERAGE');
  if (!s.scope || s.scope.grammar !== 'local-paths-v1' || JSON.stringify(s.scope.extensions) !== JSON.stringify(['.md', '.markdown', '.txt']) || JSON.stringify(s.scope.excludedDirectories) !== JSON.stringify(['.git', 'node_modules', '.myco', 'dist', 'build']) || !s.limits || Object.keys(s.limits).length !== limitKeys.length || limitKeys.some(k => !integer(s.limits[k]) || s.limits[k] < 1)) return unknown('INVALID_SCOPE');
  if (s.findings.some(f => !f || !kinds.includes(f.kind) || typeof f.source !== 'string' || f.source.length > 8192 || path.isAbsolute(f.source) || path.win32.isAbsolute(f.source) || f.source.split(/[\\/]/).includes('..') || typeof f.target !== 'string' || f.target.length > 16384 || !integer(f.line) || f.line < 1 || typeof f.temp !== 'boolean')) return unknown('INVALID_FINDING');
  const incomplete = !s.running || s.issues.length > 0 || s.findings.some(f => ['UNAVAILABLE', 'EXCLUDED', 'UNPARSEABLE'].includes(f.kind));
  const expected = incomplete ? 'INCOMPLETE' : s.findings.length ? 'FINDINGS' : 'CLEAN';
  if (s.status !== expected) return unknown('INCONSISTENT_STATUS');
  return { advisory: true, directSourceScan: false, status: expected,
    provenance: { producer: s.producer, schema: s.schema, root: s.root, session: s.session, sequence: s.sequence,
      startedAt: s.startedAt, completedAt: s.completedAt, publishedAt: s.publishedAt },
    freshness: { ageMs: Math.max(0, now - times[0]), maxAgeMs }, scope: s.scope, limits: s.limits,
    files: s.files, references: s.references, findings: s.findings, issues: s.issues };
}

async function readEvidence(snapshotPath, root, maxAgeMs = 120000) {
  let handle;
  try {
    handle = await fs.open(snapshotPath, 'r');
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) throw new Error('SNAPSHOT_SIZE_OR_TYPE');
    const buf = Buffer.alloc(st.size + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead !== st.size) throw new Error('SNAPSHOT_CHANGED');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, bytesRead));
    return interpret(JSON.parse(text), root, maxAgeMs);
  } catch (e) {
    return { advisory: true, directSourceScan: false, status: 'UNKNOWN', reason: 'SNAPSHOT_UNREADABLE_OR_MALFORMED', detail: e.code || e.message };
  } finally { await handle?.close(); }
}

function startFollower(snapshotPath, root, emit, { pollMs = 1000, maxAgeMs = 120000 } = {}) {
  if (!integer(pollMs) || pollMs < 10 || pollMs > 60000 || !integer(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 3600000) throw new Error('invalid follower limits');
  let stopped = false, timer, lastKey, lastProvenance, lastPayload, busy;
  async function tick() {
    let evidence = await readEvidence(snapshotPath, root, maxAgeMs);
    const p = evidence.provenance;
    const payload = JSON.stringify({ ...evidence, freshness: undefined });
    if (p && lastProvenance && ((p.session === lastProvenance.session && p.sequence < lastProvenance.sequence) || Date.parse(p.publishedAt) < Date.parse(lastProvenance.publishedAt))) {
      evidence = { advisory: true, directSourceScan: false, status: 'UNKNOWN', reason: 'SNAPSHOT_REGRESSION' };
    } else if (p && lastProvenance && p.session === lastProvenance.session && p.sequence === lastProvenance.sequence && payload !== lastPayload) {
      evidence = { advisory: true, directSourceScan: false, status: 'UNKNOWN', reason: 'SNAPSHOT_SEQUENCE_REUSED' };
    } else if (p) { lastProvenance = p; lastPayload = payload; }
    // Ignore changing age alone, but still emit when freshness crosses the limit.
    const key = JSON.stringify({ ...evidence, freshness: undefined });
    if (!stopped && key !== lastKey) { lastKey = key; emit({ snapshot: path.resolve(snapshotPath), ...evidence }); }
    if (!stopped) timer = setTimeout(() => { busy = tick(); }, pollMs);
  }
  busy = tick();
  return { async stop() { stopped = true; clearTimeout(timer); await busy; } };
}

async function linksCommand(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    snapshot: { type: 'string' }, root: { type: 'string' }, 'poll-ms': { type: 'string' }, 'max-age-ms': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('hypha links <status|follow> --snapshot <myco.json> --root <expected-root> [--poll-ms 1000] [--max-age-ms 120000]\nAdvisory JSON only; no direct source scan. Foreground follow stops with Ctrl+C.'); return;
  }
  if (positionals.length !== 1 || !['status', 'follow'].includes(positionals[0]) || !values.root || !values.snapshot) throw new Error('use links --help');
  const opts = { pollMs: Number(values['poll-ms'] ?? 1000), maxAgeMs: Number(values['max-age-ms'] ?? 120000) };
  if (!integer(opts.maxAgeMs) || opts.maxAgeMs < 1 || opts.maxAgeMs > 3600000) throw new Error('invalid max-age-ms');
  if (positionals[0] === 'status') {
    const e = await readEvidence(values.snapshot, values.root, opts.maxAgeMs);
    console.log(JSON.stringify({ snapshot: path.resolve(values.snapshot), ...e }));
    process.exitCode = e.status === 'CLEAN' ? 0 : e.status === 'FINDINGS' ? 1 : 2;
    return;
  }
  const follower = startFollower(values.snapshot, values.root, e => console.log(JSON.stringify(e)), opts);
  const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); void follower.stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
module.exports = { interpret, readEvidence, startFollower, linksCommand };
