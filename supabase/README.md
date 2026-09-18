# What is in the database that is not in these files

Read this before writing a migration.

The files in `migrations/` do **not** fully describe the live database. Objects
have been created by hand in the Supabase dashboard, which produces no artifact
here, so a `grep` over this directory will confidently tell you something does
not exist when it does. That has now cost real time twice, so the list below is
kept current deliberately.

Run `queries/schema_drift.sql` against production to regenerate this list. It
returns every trigger, function, policy, CHECK and view that the migrations do
not create, so anything it prints is either drift or a stale baseline in the
query itself.

---

## `ensure_rls` — load-bearing, invisible, do not drop

An **event trigger** named `ensure_rls`, owned by `postgres` (ours, not
Supabase's), running the function `rls_auto_enable()`:

- fires on `ddl_command_end`
- filtered to `CREATE TABLE`, `CREATE TABLE AS`, `SELECT INTO`
- loops `pg_event_trigger_ddl_commands()` and, for each new table in `public`,
  runs `ALTER TABLE IF EXISTS <t> ENABLE ROW LEVEL SECURITY`
- `RAISE LOG`s on both success and failure

**Why you care.** Every table in this database has RLS on, and for the tables
created by hand — `notebook_pages`, `rule_violations`, `setups` — this is the
only reason. Nobody wrote `ENABLE ROW LEVEL SECURITY` for those; the event
trigger did it silently at `CREATE TABLE` time.

**What happens if it goes.** Nothing visible, immediately. The next table
anyone creates is wide open: RLS off means every policy on it is inert and
PostgREST serves it to anyone with the anon key. This is exactly the failure
that is easy to cause and hard to notice, because the damage is to a table that
does not exist yet.

So: do not drop it, do not replace it without reading it first, and if you are
debugging "why did RLS turn on by itself" — this is why.

It is **not** codified in `migrations/`. It exists only in the live database,
which means a rebuild from these files would come up without it. That is a
known gap; see below.

---

## Tables the migrations cannot create

`notebook_pages`, `rule_violations` and `setups` are read and written by the
app but no migration creates them. `setups` is only ever `ALTER`ed, by `019`.

**`migrations/` cannot rebuild this database.** Treat it as a change log, not
as a schema definition, until these are backfilled.

---

## Policies

Nine policies in `public` were created by hand. `023` scopes them from
`TO public` to `TO authenticated`; four of them also duplicate a policy that
the migrations do create, which `023`'s footer explains.

`storage.objects` carries `setup_images_select` (from `018`) plus
`setup_images_insert` and `setup_images_delete`, which were made by hand and
are already correctly scoped to `authenticated`.

---

## Things that look like drift and are not

Anything outside `public` in `auth`, `storage`, `realtime`, `graphql`, `vault`,
`extensions`, `supabase_functions`, `cron` or `net` belongs to Supabase. Leave
it alone regardless of what the catalog says about extension ownership — not
everything they manage is extension-owned, so a null `owned_by_extension` is
not evidence that something is yours.

Confirmed instances, all harmless:
`realtime.subscription/tr_check_filters`,
`storage.buckets/enforce_bucket_name_length_trigger`,
`storage.buckets/protect_buckets_delete`,
`storage.objects/protect_objects_delete`,
`storage.objects/update_objects_updated_at`.

---

## Function privileges

Postgres grants `EXECUTE` to `PUBLIC` on every new function, and Supabase
grants `USAGE` on schema `public` to `anon`, so by default **every function
here is callable unauthenticated** at `/rest/v1/rpc/<name>`. For a
`SECURITY DEFINER` function that means it runs as its owner and bypasses RLS.

`024` revokes the existing grants and changes the default for future functions.
If you add a function that genuinely needs to be called over PostgREST, grant
it explicitly to `authenticated`, in its own migration, and say why.
