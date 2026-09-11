/**
 * Isolate the post-018 upload regression on `setup-images`.
 *
 *   node scripts/repro-upload.mjs
 *
 * Signs in with SUPABASE_TEST_EMAIL and SUPABASE_TEST_PASSWORD, read from
 * .env.local (or .env) like the Supabase URL and anon key. They are
 * deliberately NOT read from the process environment, so there is no way to
 * pass them on the command line: an approved command is saved verbatim --
 * credentials included -- to .claude/settings.local.json and to the session
 * transcript.
 *
 * WRITES. It uploads small throwaway objects into YOUR OWN prefix and removes
 * them again at the end, reporting anything it could not clean up. It never
 * touches an existing object: every path it writes is prefixed `__repro-`.
 *
 * Reproduces SetupsClient.tsx:536-544 exactly — same client library, same
 * `${userId}/${Date.now()}-${filename}` path shape, same upsert flag — then
 * varies one factor at a time so the failing operation identifies itself
 * rather than being inferred:
 *
 *   T1  list own prefix          does SELECT work for the owner at all?
 *   T2  upload, upsert: false    does a plain INSERT work?
 *   T3  upload, upsert: true     does upsert work on a fresh path?
 *   T4  upload, upsert: true     ... on a path that already exists, which is
 *                                the only case that takes the ON CONFLICT
 *                                path and so needs an UPDATE policy
 *   T5  remove                   does DELETE work from the browser client?
 *   T6  list bucket root         does the owner see anyone else's folder?
 *
 * T2 vs T3 separates "SELECT rejects the owner" from "upsert needs something
 * the bucket lacks". T3 vs T4 separates a fresh upsert from a conflicting one.
 * If T2 and T3 both pass, the regression is not in this flow at all.
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

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
// From the env file only, never process.env -- see the header.
const EMAIL = env.SUPABASE_TEST_EMAIL;
const PASSWORD = env.SUPABASE_TEST_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error('Add SUPABASE_TEST_EMAIL and SUPABASE_TEST_PASSWORD to .env.local.');
  process.exit(1);
}

const BUCKET = 'setup-images';
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

/** Print every field the SDK's StorageError carries — message alone hides the status. */
function show(label, { data, error }) {
  if (error) {
    console.log(`  ${label}: FAILED`);
    console.log(`     name:       ${error.name}`);
    console.log(`     message:    ${error.message}`);
    console.log(`     status:     ${error.status ?? error.statusCode ?? '(none)'}`);
    const extra = { ...error };
    delete extra.name; delete extra.message; delete extra.stack;
    if (Object.keys(extra).length) console.log(`     raw:        ${JSON.stringify(extra)}`);
  } else {
    console.log(`  ${label}: ok`);
    if (data) console.log(`     data:       ${JSON.stringify(data)}`);
  }
  return !error;
}

const { data: auth, error: authErr } = await supabase.auth.signInWithPassword({
  email: EMAIL, password: PASSWORD,
});
if (authErr) { console.error('sign-in failed:', authErr.message); process.exit(1); }

const userId = auth.user.id;
const role = JSON.parse(Buffer.from(auth.session.access_token.split('.')[1], 'base64').toString()).role;
console.log(`signed in as ${EMAIL}`);
console.log(`  auth.uid(): ${userId}`);
console.log(`  jwt role:   ${role}   <- the policy's TO clause must include this`);

const store = supabase.storage.from(BUCKET);
const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' });
const mk = (tag) => `${userId}/__repro-${tag}-${Date.now()}.png`;
const created = [];

console.log('\nT1  list own prefix — SELECT for the owner');
show('list', await store.list(userId, { limit: 5 }));

console.log('\nT2  upload upsert:false — plain INSERT, fresh path');
const p2 = mk('insert');
if (show('upload', await store.upload(p2, blob, { upsert: false, contentType: 'image/png' }))) created.push(p2);

console.log('\nT3  upload upsert:true — fresh path, no conflict (what the app does)');
const p3 = mk('upsert');
if (show('upload', await store.upload(p3, blob, { upsert: true, contentType: 'image/png' }))) created.push(p3);

console.log('\nT4  upload upsert:true — SAME path again, forces the ON CONFLICT path');
if (created.includes(p3)) {
  show('upload', await store.upload(p3, blob, { upsert: true, contentType: 'image/png' }));
} else {
  console.log('  skipped — T3 did not create the object.');
}

console.log('\nT5  remove — DELETE from the browser client (what step 3 will rely on)');
if (created.length) {
  const res = await store.remove(created);
  show('remove', res);
  const { data: left } = await store.list(userId, { limit: 100 });
  const stragglers = (left ?? []).filter((o) => o.name.startsWith('__repro-'));
  console.log(stragglers.length
    ? `  !! ${stragglers.length} repro object(s) NOT cleaned up: ${stragglers.map((o) => o.name).join(', ')}`
    : '  cleanup confirmed — no repro objects remain');
} else {
  console.log('  skipped — nothing was created.');
}

console.log('\nT6  list bucket root — owner must see only their own folder');
const { data: root, error: rootErr } = await store.list('', { limit: 100 });
if (rootErr) {
  console.log('  list failed:', rootErr.message);
} else {
  console.log(`  ${root.length} entries: ${root.map((e) => e.name).join(', ') || '(none)'}`);
  const others = root.filter((e) => e.id === null && e.name !== userId);
  console.log(others.length
    ? `  !! sees ${others.length} other user folder(s) — scoping is not holding`
    : '  correct — no other user folders visible');
}

await supabase.auth.signOut();
console.log('\ndone.');
