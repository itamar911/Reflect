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

## Triggers the migrations claim and the database does not have

Drift runs in both directions. `002` creates `personal_strategies_updated_at`
and `alert_settings_updated_at`; **neither exists in the database.** Everything
else in `002` landed — both tables, both policies, the index, the
`subscription_tier` column — so this was not a migration that went unrun. Two
adjacent statements failed and the rest succeeded.

Their one shared dependency is `update_updated_at()`, which is defined in
`schema.sql` *below* the tables. If `002` was run before that part of
`schema.sql` had been applied, both `CREATE TRIGGER`s would have failed with
"function update_updated_at() does not exist" and nothing else in the file
would have cared. By the time `017` ran, the function existed, which is why
`tradovate_connections_updated_at` is there. That is inference, not proof —
Postgres keeps no DDL history — but nothing else explains exactly those two.

Consequence: `updated_at` on `personal_strategies` and `alert_settings` is
frozen at its insert-time default and never advances. Nothing reads it today
(every query on both tables orders by `created_at` or fetches by `user_id`), so
it is cosmetic — but it is a column that is NOT NULL, plausible, and wrong,
which is worse than one that is absent.

**A migration file in this directory is not evidence that it ran, or that all
of it ran.** The SQL editor will run twenty statements, fail on the
twenty-first, and leave a file that looks applied.

`026` restores the two triggers. No backfill: the real modification times are
gone, and writing `created_at` into `updated_at` would put a guess in a column
that is supposed to hold a fact.

---

## Most of these files cannot be re-run

Re-running a migration here mostly does not converge — it errors. Counted
across `schema.sql` and `migrations/`:

| Statement | Total | Safe to re-run | Not |
|---|---|---|---|
| `CREATE TRIGGER` | 7 | 3 | **4** |
| `CREATE POLICY` | 18 | 2 | **16** |

The three safe triggers are `on_auth_user_created` and `on_profile_created`
(both `CREATE OR REPLACE TRIGGER`) and `tradovate_connections_updated_at`
(`DROP ... IF EXISTS` then `CREATE`). The two safe policies are in `017` and
`018`. `004` does carry a `DROP POLICY IF EXISTS`, but for the policy it is
replacing, not for the four it then creates — so re-running `004` still fails.

`CREATE TABLE`, `CREATE INDEX` and `ADD COLUMN` are almost all written
`IF NOT EXISTS`, so the tables are fine. It is the triggers and policies that
are not.

**Why this matters.** When a migration fails halfway, the instinct is to fix
the problem and run the file again — and here that hits "trigger already
exists" or "policy already exists" on the statements that *did* succeed, which
makes it look as though the file is already applied. That is how you end up
believing `002` ran. Recovering means reading the file and running the
remaining statements by hand, which is exactly the situation that produces
divergence.

Not worth rewriting history for its own sake. But **anything new should be
written to converge**: `CREATE OR REPLACE TRIGGER` (PG14+), and
`DROP POLICY IF EXISTS` before every `CREATE POLICY`. `026` is the pattern.

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

`024` revokes the grants on the four functions that exist. It does **not**
change the default for future ones, and cannot: `ALTER DEFAULT PRIVILEGES`
only works per creating role and only for roles you are a member of, and the
SQL editor's `postgres` is not a member of `supabase_admin`. The first attempt
named it, failed, and — because the editor wraps the file in a transaction —
rolled back the revokes with it.

So the next function created here will carry an EXECUTE grant nobody asked
for, and the guarantee is a standing assertion rather than a migration: query
13 of `queries/schema_drift.sql` fails on any function in `public` granted
EXECUTE to `PUBLIC`, `anon` or `authenticated`.

The four that exist all return `trigger` or `event_trigger`, which cannot be
invoked as ordinary calls, so none is reachable over HTTP. That is a property
of what they happen to return, not a rule being enforced — `get_user_tier`
returned `text`, which is exactly why it was reachable. Don't read "not
exploitable today" as "the grant is fine".

If you add a function that genuinely needs calling over PostgREST: grant it to
`authenticated` explicitly, in its own migration, say why, and add its name to
query 13's allowance list in the same change.
