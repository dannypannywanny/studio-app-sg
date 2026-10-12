#!/usr/bin/env node
// Repo checks with no dependencies (ESLint isn't installed). Fails on the mistakes that matter here:
//  1. student data in git (CSV exports, data/, migration/raw/)
//  2. client code writing to money / credit collections (only Cloud Functions may)
//  3. the studio's hostnames hard-coded in app or function code (they belong in per-school config)
//  4. focused or skipped tests, console.log left in the app
//  5. deploy commands in package scripts (deploys are a separate, approved step)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const problems = [];
const read = (f) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};
const lines = (f, re) =>
  read(f)
    .split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => re.test(l));

// 1. Personal data never goes in git.
for (const f of files) {
  if (/(^|\/)(data|migration\/raw)\//.test(f)) problems.push(`${f}: data/ and migration/raw/ must stay out of git`);
  if (/\.csv$/i.test(f) && f !== 'replica/features.csv' && !/^functions\/test\/fixtures\/[^/]+\.synthetic\.csv$/.test(f)) {
    problems.push(`${f}: CSV files (student exports) must not be committed; only *.synthetic.csv test fixtures`);
  }
}

// 2. No client writes to collections owned by Cloud Functions.
const LOCKED = 'ledger|moneyLedger|enrolments|invoices|payments|creditNotes|counters|auditLog|members|idempotency|jobs|series|lessons|attendees';
const clientWrite = new RegExp(`\\b(addDoc|setDoc|updateDoc|deleteDoc)\\([^;]*['"](${LOCKED})['"]`);
const writeBatch = new RegExp(`\\b(writeBatch|runTransaction)\\b`);
for (const f of files.filter((f) => /^apps\/[^/]+\/src\/.*\.(ts|tsx)$/.test(f))) {
  for (const [n, l] of lines(f, clientWrite)) problems.push(`${f}:${n}: client write to a function-owned collection: ${l.trim()}`);
  for (const [n, l] of lines(f, writeBatch)) problems.push(`${f}:${n}: batched/transaction writes belong in Cloud Functions: ${l.trim()}`);
  for (const [n] of lines(f, /\bconsole\.log\(/)) problems.push(`${f}:${n}: console.log left in app code`);
}

// 3. Hostnames come from schools/{id}.hosts, not code.
for (const f of files.filter((f) => /^(apps\/[^/]+\/src|functions\/src|packages\/shared\/src)\/.*\.(ts|tsx)$/.test(f))) {
  for (const [n, l] of lines(f, /singyourwayhome\.sg|class-app-sg/)) {
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue; // mentioned in a comment
    problems.push(`${f}:${n}: hard-coded studio host/project; use per-school config`);
  }
}

// 4. Tests must not be focused or skipped.
for (const f of files.filter((f) => /\.test\.(ts|tsx)$/.test(f))) {
  for (const [n] of lines(f, /\b(it|describe|test)\.(only|skip)\(/)) problems.push(`${f}:${n}: .only/.skip left in a test`);
}

// 5. No deploys from package scripts.
for (const f of files.filter((f) => /(^|\/)package\.json$/.test(f))) {
  const scripts = JSON.parse(read(f) || '{}').scripts ?? {};
  for (const [name, cmd] of Object.entries(scripts)) {
    if (/firebase\s+deploy|hosting:channel:deploy/.test(cmd)) problems.push(`${f}: script "${name}" deploys; deploys are a separate approved step`);
  }
}

// 6. Duplicate composite indexes: the emulator ignores them, but a production deploy fails with HTTP 409.
{
  const seen = new Map();
  (JSON.parse(read('firestore.indexes.json') || '{}').indexes ?? []).forEach((ix, n) => {
    const key = JSON.stringify([ix.collectionGroup, ix.queryScope, ix.fields]);
    if (seen.has(key)) problems.push(`firestore.indexes.json: index ${n} duplicates index ${seen.get(key)} (deploy fails with 409)`);
    else seen.set(key, n);
  });
}

if (problems.length) {
  console.error(`lint: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`lint: ok (${files.length} files checked)`);
