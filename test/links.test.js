'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { interpret, readEvidence, startFollower } = require('../src/links');

const mycoRoot = path.resolve(__dirname, '../../myco');
async function until(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(r => setTimeout(r, 20)); }
  assert.fail('expected follower state did not arrive within 5 seconds');
}

test('real Myco publication -> Hypha follower: clean, findings, incomplete, stale, malformed and shutdown', async () => {
  const { startLinkMonitor } = await import(pathToFileURL(path.join(mycoRoot, 'dist', 'links.js')).href);
  const base = await fs.mkdtemp(path.join(__dirname, '.links-'));
  const root = path.join(base, 'docs'), snapshot = path.join(base, 'links.json');
  await fs.mkdir(root);
  let monitor, follower; const seen = [];
  try {
    monitor = await startLinkMonitor(root, snapshot, { intervalMs: 100, debounceMs: 10 });
    follower = startFollower(snapshot, root, e => seen.push(e), { pollMs: 20, maxAgeMs: 1000 });
    await until(() => seen.at(-1)?.status === 'CLEAN');
    const clean = JSON.parse(await fs.readFile(snapshot, 'utf8'));
    assert.equal(seen.at(-1).advisory, true);
    assert.equal(seen.at(-1).directSourceScan, false);
    assert.equal(seen.at(-1).provenance.root, root);
    assert.equal(typeof seen.at(-1).freshness.ageMs, 'number');
    await fs.writeFile(path.join(root, 'notes.md'), '[x](missing.txt)');
    await until(() => seen.at(-1)?.status === 'FINDINGS');
    await fs.writeFile(path.join(root, 'missing.txt'), 'controlled fixture');
    await until(() => seen.at(-1)?.status === 'CLEAN');
    await fs.writeFile(path.join(root, 'notes.md'), '[x](%zz)');
    await until(() => seen.at(-1)?.status === 'INCOMPLETE' && seen.at(-1)?.findings?.some(f => f.kind === 'UNPARSEABLE'));
    await monitor.stop();
    await until(() => seen.at(-1)?.issues?.includes('STOPPED'));
    await fs.writeFile(snapshot, '{broken');
    await until(() => seen.at(-1)?.status === 'UNKNOWN');
    assert.equal((await readEvidence(snapshot, root)).status, 'UNKNOWN');
    assert.equal(interpret(clean, root, 1, Date.now() + 5000).reason, 'STALE');
    assert.equal(interpret(clean, path.join(root, 'wrong')).reason, 'ROOT_MISMATCH');
    assert.equal(interpret({ ...clean, issues: ['lost'], status: 'CLEAN' }, root).status, 'UNKNOWN');
    assert.equal(interpret({ ...clean, findings: [{}] }, root).status, 'UNKNOWN');
    assert.equal(interpret({ ...clean, publishedAt: 'tomorrow' }, root).status, 'UNKNOWN');
    assert.equal(interpret({ ...clean, limits: {} }, root).status, 'UNKNOWN');
    assert.equal(interpret({ ...clean, scope: { ...clean.scope, extensions: [] } }, root).status, 'UNKNOWN');
    // Follower must age even when bytes never change after producer failure.
    await follower.stop(); seen.length = 0;
    await fs.writeFile(snapshot, JSON.stringify(clean));
    follower = startFollower(snapshot, root, e => seen.push(e), { pollMs: 20, maxAgeMs: 100 });
    await until(() => seen.at(-1)?.reason === 'STALE');
  } finally { await follower?.stop(); await monitor?.stop(); await fs.rm(base, { recursive: true, force: true }); }
});

test('follower refuses same-sequence replacement and time regression', async () => {
  const { startLinkMonitor } = await import(pathToFileURL(path.join(mycoRoot, 'dist', 'links.js')).href);
  const base = await fs.mkdtemp(path.join(__dirname, '.links-replay-'));
  const root = path.join(base, 'docs'), snapshot = path.join(base, 'links.json');
  await fs.mkdir(root);
  let m, follower; const seen = [];
  try {
    m = await startLinkMonitor(root, snapshot, { intervalMs: 10000 });
    const clean = JSON.parse(await fs.readFile(snapshot, 'utf8'));
    await m.stop();
    await fs.writeFile(snapshot, JSON.stringify(clean));
    follower = startFollower(snapshot, root, e => seen.push(e), { pollMs: 20 });
    await until(() => seen.at(-1)?.status === 'CLEAN');
    await fs.writeFile(snapshot, JSON.stringify({ ...clean, status: 'INCOMPLETE', issues: ['changed'] }));
    await until(() => seen.at(-1)?.reason === 'SNAPSHOT_SEQUENCE_REUSED');
    await fs.writeFile(snapshot, JSON.stringify({ ...clean, sequence: 1 }));
    await until(() => seen.at(-1)?.reason === 'SNAPSHOT_REGRESSION');
  } finally { await follower?.stop(); await m?.stop(); await fs.rm(base, { recursive: true, force: true }); }
});

test('both real command lines publish/consume live changes without a capability database', async () => {
  const base = await fs.mkdtemp(path.join(__dirname, '.links-cli-'));
  const root = path.join(base, 'docs'), snapshot = path.join(base, 'snapshot.json');
  await fs.mkdir(root);
  const children = [];
  try {
    const myco = spawn(process.execPath, [path.join(mycoRoot, 'dist', 'cli.js'), 'links', 'watch', root, '--snapshot', snapshot, '--interval-ms', '100', '--debounce-ms', '10'], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(myco); let errors = ''; myco.stderr.on('data', d => errors += d);
    await until(async () => (await readEvidence(snapshot, root)).status === 'CLEAN');
    const hypha = spawn(process.execPath, [path.join(__dirname, '../src/cli.js'), 'links', 'follow', '--snapshot', snapshot, '--root', root, '--poll-ms', '20'], { cwd: base, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(hypha); let output = ''; hypha.stdout.on('data', d => output += d); hypha.stderr.on('data', d => errors += d);
    await until(() => output.includes('"status":"CLEAN"'));
    await fs.writeFile(path.join(root, 'notes.md'), '[new](missing.txt)');
    await until(() => output.includes('"status":"FINDINGS"'));
    assert(output.includes('"directSourceScan":false'));
    assert.equal(await fs.stat(path.join(base, 'hypha.db')).catch(() => null), null);
    assert.equal(errors, '');
  } finally {
    for (const child of children) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await fs.rm(base, { recursive: true, force: true });
  }
});
