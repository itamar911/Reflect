/**
 * REF-69 step 4: remove setup-images objects that no setups row points at.
 *
 *   node scripts/cleanup-orphans.mjs                        dry run (default)
 *   node scripts/cleanup-orphans.mjs --apply '<path>' ...   remove exactly these
 *
 * Needs SUPABASE_SERVICE_ROLE_KEY in .env.local/.env. Run by the owner: nothing
 * in this repo writes to Supabase on its own (CLAUDE.md).
 *
 * The dry run makes no writes. It lists every object, every path a setups row
 * references -- image_path, or the object path inside a legacy image_url, the
 * same rule as probe-bucket.mjs -- and prints the orphans with a ready-to-paste
 * --apply command naming each one.
 *
 * --apply does not act on its own census. It removes only the paths named on
 * the command line, and only if every one of them is STILL an orphan when it
 * runs. If any named path is now referenced, or no longer exists, it removes
 * nothing: the state has moved since the list was reviewed, so the reviewed
 * list no longer describes what would happen. Re-run the dry run.
 *
 * Fails closed. A partial listing or a partial read of setups would make
 * referenced objects look orphaned, so either one aborts before any removal.
 * After removing, it re-lists the bucket and reports each path as gone or
 * still present, rather than trusting the storage API's reply.
 */

import { readFileSync } from 'node:fs';

function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    try {
      const out = {};
      for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
      if (out.NEXT_PUBLIC_SUPABASE_URL) return out;
    } catch { /* try next candidate */ }
  }
  throw new Error('No .env.local/.env with NEXT_PUBLIC_SUPABASE_URL. Run from the repo root.');
}

const env = loadEnv();
const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, '');
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'setup-images';
const PAGE = 1000;

const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const hr = (t) => console.log('\n' + '─'.repeat(72) + '\n' + t + '\n');

let removalAttempted = false;
function fail(msg) {
  console.error(`\nABORTED — ${msg}`);
  console.error(removalAttempted
    ? 'A removal WAS sent before this point. Re-run the dry run to see the current state.'
    : 'Nothing was removed.');
  process.exit(1);
}

if (!SERVICE) fail('SUPABASE_SERVICE_ROLE_KEY is not in .env.local/.env.');

// ── Arguments ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const apply = args[0] === '--apply';
const named = apply ? args.slice(1) : [];
if (!apply && args.length > 0) fail(`unexpected arguments: ${args.join(' ')} (the only flag is --apply)`);
if (apply && named.length === 0) fail('--apply needs the paths to remove, exactly as the dry run prints them.');
if (new Set(named).size !== named.length) fail('a path is named more than once.');

// ── Census ───────────────────────────────────────────────────────────────────

async function list(prefix) {
  const res = await fetch(`${URL_BASE}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit: PAGE, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
  });
  const body = await res.json().catch(() => null);
  const where = prefix || '(bucket root)';
  if (!res.ok || !Array.isArray(body)) fail(`listing ${where} returned HTTP ${res.status}.`);
  if (body.length >= PAGE) fail(`listing ${where} filled a ${PAGE}-entry page; this script does not paginate.`);
  return body;
}

/** Every object in the bucket, or an abort -- never a partial list. */
async function census() {
  const objects = [];
  for (const e of await list('')) {
    if (e.id !== null) { objects.push({ path: e.name, owner: null, meta: e }); continue; }
    for (const o of await list(e.name)) {
      // Keys are <userId>/<file>. Anything deeper is a shape nothing here
      // expects; stop and look rather than guess what it belongs to.
      if (o.id === null) fail(`unexpected nested folder ${e.name}/${o.name}/.`);
      objects.push({ path: `${e.name}/${o.name}`, owner: e.name, meta: o });
    }
  }
  return objects;
}

/** Every object path some setups row points at. Aborts on a partial read. */
async function referencedPaths() {
  const res = await fetch(`${URL_BASE}/rest/v1/setups?select=id,image_path,image_url`, {
    headers: { ...headers, Prefer: 'count=exact' },
  });
  const rows = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(rows)) fail(`reading setups returned HTTP ${res.status}.`);

  // PostgREST caps rows per response. A truncated read would leave referenced
  // objects out of the set and mark them for removal, so check the total.
  const total = Number((res.headers.get('content-range') ?? '').split('/')[1]);
  if (!Number.isFinite(total) || total !== rows.length) {
    fail(`read ${rows.length} setups rows but the table reports ${res.headers.get('content-range') ?? 'no count'}.`);
  }

  // Signed URLs are never stored, but match them too: over-counting references
  // only ever means removing less.
  const inUrl = new RegExp(`/object/(?:public|sign)/${BUCKET}/([^?#]+)`);
  const refs = new Set();
  for (const r of rows) {
    if (typeof r.image_path === 'string' && r.image_path) refs.add(r.image_path);
    if (typeof r.image_url === 'string' && r.image_url) {
      const m = inUrl.exec(r.image_url);
      if (!m) { console.warn(`  note: setup ${r.id} has an image_url outside ${BUCKET}; ignored`); continue; }
      try { refs.add(decodeURIComponent(m[1])); }
      catch { fail(`setup ${r.id} has an image_url that does not URL-decode: ${r.image_url}`); }
    }
  }
  return { refs, rowCount: rows.length };
}

/** Display only; a failure here never affects what is removed. */
async function emails() {
  try {
    const res = await fetch(`${URL_BASE}/auth/v1/admin/users?page=1&per_page=1000`, { headers });
    const body = await res.json();
    return new Map((body.users ?? []).map((u) => [u.id, u.email]));
  } catch { return new Map(); }
}

// ── Dry run (always runs; --apply acts on this same state) ───────────────────

hr(apply ? 'CURRENT STATE — checked before removing anything' : 'DRY RUN — no writes');

const objects = await census();
const { refs, rowCount } = await referencedPaths();
const emailById = await emails();
const orphans = objects.filter((o) => !refs.has(o.path));
const kept = objects.filter((o) => refs.has(o.path));

console.log(`setups rows read:         ${rowCount}`);
console.log(`objects in bucket:        ${objects.length}`);
console.log(`referenced by a setup:    ${kept.length}`);
console.log(`ORPHANED (no live row):   ${orphans.length}`);

console.log('\nwould remove:');
for (const o of orphans) {
  console.log(`  ${o.path}`);
  console.log(`      ${kb(o.meta.metadata?.size ?? 0)}   uploaded ${o.meta.created_at ?? '?'}   ` +
    `owner ${emailById.get(o.owner) ?? o.owner ?? '(bucket root)'}`);
}
if (orphans.length === 0) console.log('  (none)');

console.log('\nwould keep:');
for (const o of kept) console.log(`  ${o.path}`);
if (kept.length === 0) console.log('  (none)');

if (!apply) {
  if (orphans.length > 0) {
    // PowerShell quoting: single quotes, with any embedded ' doubled.
    const q = (p) => `'${p.replaceAll("'", "''")}'`;
    console.log('\nTo remove exactly the list above, review it, then run (PowerShell):\n');
    console.log(`  node scripts/cleanup-orphans.mjs --apply ${orphans.map((o) => q(o.path)).join(' ')}`);
    console.log('\nDrop any path from that command to keep it.');
  }
  console.log('\nNothing was removed.');
  process.exit(0);
}

// ── Apply ────────────────────────────────────────────────────────────────────

hr('APPLY');

const known = new Set(objects.map((o) => o.path));
const orphanSet = new Set(orphans.map((o) => o.path));
const problems = [];
for (const p of named) {
  if (!known.has(p)) problems.push(`  ${p}\n      no such object — already removed, or not typed exactly`);
  else if (!orphanSet.has(p)) problems.push(`  ${p}\n      a setups row references it now`);
}
if (problems.length > 0) {
  console.error('These named paths are not current orphans:\n' + problems.join('\n'));
  fail('the state no longer matches the reviewed list.');
}

console.log(`removing ${named.length}:`);
for (const p of named) console.log(`  ${p}`);

removalAttempted = true;
const res = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}`, {
  method: 'DELETE',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ prefixes: named }),
});
const reply = await res.json().catch(() => null);
console.log(`\nstorage replied HTTP ${res.status}, ` +
  `${Array.isArray(reply) ? `${reply.length} reported removed` : `body: ${JSON.stringify(reply)}`}`);

// Believe the listing, not the reply.
const after = new Set((await census()).map((o) => o.path));
let survivors = 0;
console.log('\nrechecked against a fresh listing:');
for (const p of named) {
  const present = after.has(p);
  if (present) survivors++;
  console.log(`  ${present ? 'STILL PRESENT' : 'gone         '}  ${p}`);
}
console.log(`\nobjects in bucket: ${objects.length} → ${after.size}`);

if (survivors > 0) fail(`${survivors} of ${named.length} named objects are still in the bucket.`);
console.log('\nDone. Re-run node scripts/probe-bucket.mjs to confirm the census independently.');
