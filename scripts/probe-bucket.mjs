/**
 * Read-only exposure probe for the `setup-images` bucket (REF-69 / REF-72).
 *
 * Makes no writes of any kind — every call is a list, a GET, or a select.
 * Run from the repo root:  node scripts/probe-bucket.mjs
 *
 * Phase A uses only the anon key, which ships in the browser bundle: it is
 * exactly what an unauthenticated visitor already holds. Phase B needs
 * SUPABASE_SERVICE_ROLE_KEY and is skipped without it.
 *
 * Expected results as the fix lands:
 *
 *   step        A1 (anon list)     A2 (no key)   A4 (public GET)
 *   before      200 + folders      400           200 + bytes
 *   after 1     200 + ZERO entries 400           200 + bytes
 *   after 2     200 + ZERO entries 400           400/404
 *
 * A1's pass criterion after step 1 is "no paths returned", not an error
 * status. RLS filters rows rather than rejecting the request, so anon gets an
 * empty array with HTTP 200; some storage-api versions 400 on a permission
 * pre-check instead. Both are closed. A non-empty array is the only failure.
 *
 * A4 must keep running after step 1 closes A1, or step 2 cannot be verified.
 * So when anonymous enumeration fails, A4 falls back to a service-role lookup
 * purely to obtain a path, then fetches that path with no credentials at all.
 * The fetch under test is always unauthenticated; only the path discovery is
 * privileged. Set PROBE_PATH=<userId>/<file> to skip discovery entirely.
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
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'setup-images';

const hr = (t) => console.log('\n' + '─'.repeat(72) + '\n' + t + '\n');
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

/** POST /storage/v1/object/list/<bucket> — the list operation REF-72 is about. */
async function list(prefix, key, { withApiKey = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (withApiKey && key) {
    headers.apikey = key;
    headers.Authorization = `Bearer ${key}`;
  }
  const res = await fetch(`${URL_BASE}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, ok: res.ok && Array.isArray(body) };
}

/** Walk every prefix and return flat object records. */
async function walk(key) {
  const root = await list('', key);
  if (!root.ok) return { ok: false, status: root.status, body: root.body, objects: [] };
  const objects = [];
  for (const e of root.body) {
    if (e.id !== null) { objects.push({ path: e.name, owner: null, meta: e }); continue; }
    const sub = await list(e.name, key);
    if (!sub.ok) continue;
    for (const o of sub.body) objects.push({ path: `${e.name}/${o.name}`, owner: e.name, meta: o });
  }
  return { ok: true, status: root.status, root: root.body, objects };
}

// ── Phase A: what is reachable without an account ────────────────────────────
hr('PHASE A — unauthenticated reachability (anon key only)');

console.log('A1. POST /storage/v1/object/list/setup-images  prefix=""  apikey=<anon>');
const rootAnon = await list('', ANON);
console.log('    HTTP', rootAnon.status);
if (rootAnon.ok && rootAnon.body.length > 0) {
  console.log(`    >>> LISTING SUCCEEDED — ${rootAnon.body.length} entries at bucket root <<<`);
  for (const e of rootAnon.body) console.log(`      ${e.id === null ? '[folder]' : '[object]'} ${e.name}`);
} else if (rootAnon.ok) {
  // RLS filters the rows rather than rejecting the call: an empty array here
  // means anon matches no SELECT policy. This is the pass state after step 1.
  console.log('    0 entries — RLS returned nothing to this caller');
  console.log('    >>> enumeration is closed <<<');
} else {
  console.log('    listing refused:', JSON.stringify(rootAnon.body));
  console.log('    >>> enumeration is closed <<<');
}

console.log('\nA2. same request, no apikey header at all');
const noKey = await list('', null, { withApiKey: false });
console.log('    HTTP', noKey.status, '—',
  noKey.ok ? `${noKey.body.length} entries` : JSON.stringify(noKey.body));

console.log('\nA3. descend into each folder with the anon key');
let probePath = env.PROBE_PATH || process.env.PROBE_PATH || null;
let pathSource = probePath ? 'PROBE_PATH env override' : null;

if (rootAnon.ok && rootAnon.body.length > 0) {
  const anonWalk = await walk(ANON);
  for (const [owner, group] of groupBy(anonWalk.objects)) {
    console.log(`    ${owner}/ → ${group.length} objects`);
    for (const o of group.slice(0, 5)) {
      console.log(`        ${o.meta.name}   ${kb(o.meta.metadata?.size ?? 0)}   ${o.meta.created_at ?? ''}`);
    }
    if (group.length > 5) console.log(`        … and ${group.length - 5} more`);
  }
  if (!probePath && anonWalk.objects[0]) {
    probePath = anonWalk.objects[0].path;
    pathSource = 'discovered anonymously in A3';
  }
} else {
  console.log('    skipped — A1 returned no folders, so there is nothing to descend into.');
}

// A4 must survive step 1. Fall back to privileged discovery for the path only.
if (!probePath && SERVICE) {
  const svcWalk = await walk(SERVICE);
  if (svcWalk.objects[0]) {
    probePath = svcWalk.objects[0].path;
    pathSource = 'service-role lookup (path discovery only — the GET below is unauthenticated)';
  }
}

console.log('\nA4. GET /storage/v1/object/public/setup-images/<path>  — no headers whatsoever');
if (!probePath) {
  console.log('    skipped — no path available. Set PROBE_PATH=<userId>/<file> to force.');
} else {
  console.log('    path source:', pathSource);
  console.log('    path:', probePath);
  const pub = await fetch(`${URL_BASE}/storage/v1/object/public/${BUCKET}/${encodeURI(probePath)}`);
  console.log('    HTTP', pub.status,
    '| content-type:', pub.headers.get('content-type'),
    '| bytes:', pub.headers.get('content-length'));
  console.log(pub.ok
    ? '    >>> FETCH SUCCEEDED — readable by anyone, no credential <<<'
    : '    >>> public fetch is closed <<<');
}

function groupBy(objects) {
  const m = new Map();
  for (const o of objects) {
    const k = o.owner ?? '(root)';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(o);
  }
  return m;
}

// ── Phase B: orphan census — also the dry run for step 4 ─────────────────────
if (!SERVICE) {
  hr('PHASE B — skipped (no SUPABASE_SERVICE_ROLE_KEY in env)');
  process.exit(0);
}
hr('PHASE B — orphan census (service role, read-only: this is the step-4 dry run)');

const svcHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
const all = await walk(SERVICE);

// Every path a live setups row still points at. Matches both the public-URL
// form (pre step 2) and a bare stored path (post step 2).
const setupsRes = await fetch(
  `${URL_BASE}/rest/v1/setups?select=id,user_id,image_url,image_path`,
  { headers: svcHeaders },
);
const setupsRaw = await setupsRes.json();
const setups = Array.isArray(setupsRaw) ? setupsRaw : [];
if (!Array.isArray(setupsRaw)) {
  // image_path does not exist until step 2; retry without it.
  const retry = await fetch(`${URL_BASE}/rest/v1/setups?select=id,user_id,image_url`, { headers: svcHeaders });
  const r = await retry.json();
  if (Array.isArray(r)) setups.push(...r);
}

const marker = `/object/public/${BUCKET}/`;
const referenced = new Set();
for (const s of setups) {
  if (typeof s.image_path === 'string' && s.image_path) referenced.add(s.image_path);
  if (typeof s.image_url === 'string' && s.image_url) {
    const i = s.image_url.indexOf(marker);
    if (i !== -1) referenced.add(decodeURIComponent(s.image_url.slice(i + marker.length)));
  }
}

const usersRes = await fetch(`${URL_BASE}/auth/v1/admin/users?page=1&per_page=1000`, { headers: svcHeaders });
const usersBody = await usersRes.json();
const emailById = new Map();
for (const u of (usersBody.users ?? [])) emailById.set(u.id, u.email);

const orphans = all.objects.filter((o) => !referenced.has(o.path));

console.log(`objects in bucket:        ${all.objects.length}`);
console.log(`referenced by a setup:    ${referenced.size}`);
console.log(`ORPHANED (no live row):   ${orphans.length}`);
console.log(`orphan bytes:             ${kb(orphans.reduce((a, o) => a + (o.meta.metadata?.size ?? 0), 0))}`);

console.log('\nwould delete (step 4 targets):');
for (const o of orphans) {
  console.log(`  ${o.path}`);
  console.log(`      ${kb(o.meta.metadata?.size ?? 0)}   uploaded ${o.meta.created_at ?? '?'}`);
  console.log(`      owner ${o.owner}  →  ${emailById.get(o.owner) ?? 'NO SUCH AUTH USER (account already deleted)'}`);
}
if (orphans.length === 0) console.log('  (none)');

console.log('\nwould keep:');
for (const o of all.objects.filter((x) => referenced.has(x.path))) console.log(`  ${o.path}`);

console.log('\nall prefixes present:');
for (const uid of new Set(all.objects.map((o) => o.owner).filter(Boolean))) {
  console.log(`  ${uid}  →  ${emailById.get(uid) ?? 'NO SUCH AUTH USER'}`);
}
