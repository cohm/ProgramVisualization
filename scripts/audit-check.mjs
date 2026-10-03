#!/usr/bin/env node
// CI's dependency audit: `npm audit`, failing on HIGH or CRITICAL advisories,
// except those listed in scripts/audit-allowlist.json.
//
//   node scripts/audit-check.mjs        (npm run audit-check)
//
// `npm audit --audit-level=high` has no way to accept one advisory, so an
// advisory with no fixed version anywhere blocked every PR until it was fixed
// upstream. GHSA-vfj7-8cjw-p6xm was that case: `braces` <= 3.0.3, where 3.0.3
// is the latest release, reaching us only through eslint-config-next.
//
// An allowlist entry needs a reason and a `reviewBy` date. Past that date the
// check fails again, so an exception is looked at rather than kept by inertia.
// An entry whose advisory no longer appears is reported, to be removed.
//
// Escape hatches, in order of preference, before adding an entry here:
//   1. `npm audit fix` (or `--force` only after verifying the bumps are
//      non-breaking);
//   2. pin the offender via `package.json` `overrides` to a patched version;
//   3. an allowlist entry, when no patched version exists and the package
//      does not reach what ships (`npm audit --omit=dev`).

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATED = new Set(['high', 'critical']);
const here = dirname(fileURLToPath(import.meta.url));
const allowlist = JSON.parse(readFileSync(join(here, 'audit-allowlist.json'), 'utf8'));
const today = new Date().toISOString().slice(0, 10);

const run = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  // npm audit exits non-zero when it finds anything, so the exit code says
  // nothing; unparseable output (a registry outage) is a failure in itself.
  console.error('npm audit produced no JSON report:\n', run.stderr || run.stdout);
  process.exit(1);
}
if (report.error) {
  console.error('npm audit failed:', report.error.summary ?? report.error);
  process.exit(1);
}

// Advisories, by GHSA id. A package's `via` lists the advisories against it
// (objects) and the packages it inherits one from (strings); only the objects
// are advisories.
const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== 'object' || !GATED.has(via.severity)) continue;
    const id = String(via.url ?? '').match(/GHSA-[\w-]+/)?.[0] ?? `npm:${via.source}`;
    const a = advisories.get(id) ?? { id, package: via.name, severity: via.severity, title: via.title, url: via.url, paths: new Set() };
    for (const node of vuln.nodes ?? []) a.paths.add(node);
    advisories.set(id, a);
  }
}

const allowed = new Map(allowlist.map((e) => [e.id, e]));
const blocking = [];
const accepted = [];
const expired = [];
for (const a of advisories.values()) {
  const entry = allowed.get(a.id);
  if (!entry) blocking.push(a);
  else if (entry.reviewBy < today) expired.push({ a, entry });
  else accepted.push({ a, entry });
}
const stale = allowlist.filter((e) => !advisories.has(e.id));

const line = (a) => `  ${a.severity.toUpperCase()} ${a.id} ${a.package}: ${a.title}\n    ${a.url}\n    in ${[...a.paths].join(', ')}`;
for (const { a, entry } of accepted) console.log(`Accepted until ${entry.reviewBy} (scripts/audit-allowlist.json):\n${line(a)}`);
for (const e of stale) console.log(`Allowlisted but no longer reported, remove it: ${e.id} (${e.package})`);
for (const { a, entry } of expired) console.error(`Allowlist entry past its review date ${entry.reviewBy}; review it:\n${line(a)}`);
for (const a of blocking) console.error(`Not allowlisted:\n${line(a)}`);

if (blocking.length || expired.length) {
  console.error(`\n${blocking.length + expired.length} high/critical advisory(ies) block the build; see the escape hatches in scripts/audit-check.mjs.`);
  process.exit(1);
}
console.log(`No unaccepted high/critical advisories (${accepted.length} accepted).`);
