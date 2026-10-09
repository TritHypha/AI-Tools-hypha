# Advisory Myco link findings

Myco publishes `myco.links.v1` from its explicitly launched `links watch` command.
Hypha reads that independent UTF-8 JSON file. There is no link table in the
capability database and the link commands do not load SQLite or map Galerina.

```text
node src/cli.js links status --snapshot <myco.json> --root <expected-root>
node src/cli.js links follow --snapshot <myco.json> --root <expected-root>
node src/cli.js links --help
```

`status` emits one JSON object: exit 0 CLEAN, 1 FINDINGS, 2 INCOMPLETE/UNKNOWN.
`follow` polls until Ctrl+C/SIGTERM, emitting a JSON line when evidence changes
or becomes stale. It installs no service, scheduled task or login startup.
`--poll-ms` defaults to 1000 (10..60000); `--max-age-ms` defaults to 120000
(1..3600000). Age is measured from the scan's start, not the most recent write.
Choose the maximum age with the Myco reconciliation interval/budget in mind.

Every result says `advisory: true`, `directSourceScan: false` and identifies the
snapshot path. Valid results include Myco's root, schema, producer, session,
sequence, scan/publication times, age, scope, limits, findings and issues.
This is unsigned local evidence; provenance identifies the publisher's claim,
not authenticated authorship. Keep snapshots local because they contain paths.

Accepted contract: `myco.links.v1` with producer `myco`, absolute expected root,
UUID session, positive increasing sequence, running boolean, ordered timestamps,
findings `{source, line, target, kind, temp}`, nonnegative files/references counters,
issues, limits and the fixed `local-paths-v1` scope. Myco's `docs/LINK-MONITOR.md`
owns the format and supported grammar. Hypha requires that scope's exact extension
and exclusion arrays and eleven positive integer limits. A future format needs
an explicit consumer update.

CLEAN requires running, no issues and no findings. FINDINGS permits only BROKEN
or TEMP_REFERENCE. UNAVAILABLE/EXCLUDED/UNPARSEABLE findings or issues require
INCOMPLETE. Malformed/oversized (>16 MiB)/unreadable input, invalid provenance,
inconsistent status, wrong root, invalid/future times or stale scan yield UNKNOWN.
A follower also refuses sequence/time regression or changed content reusing a
sequence during that follower process. It has no durable anti-replay authority;
restart still validates scope, chronology and age. Stopped writers publish
INCOMPLETE; force-killed writers eventually become stale. No direct source or
atomic filesystem consistency claim is made by Hypha.

## Verification

With Myco as the sibling repository, first run `npm run build` there, then run
`npm run test:links` here. The tests import the actual built Myco monitor and consume
its real publications through Hypha, including stale/corrupt/wrong-root/status
controls, lifecycle transitions and shutdown. A second fixture launches both real
command lines and observes a new broken link through the follower within five
seconds using short test intervals. No production documents or capability database
are involved. A missing sibling build fails the test; it is not a skipped pass.

The ordinary `npm test` also runs existing capability self-tests. Their optional
external-Galerina integration remains separate and is skipped without an explicit
root. Passing link tests does not establish capability-map coverage.
