# How we should manage this database

Written 2026-09-18, at the end of a long session, for a decision to be taken
with a fresh head. Nothing here has been done. It is a recommendation and a
description of what acting on it would involve.

---

## What we found

Four things, in the order they turned up, each one narrowing the diagnosis:

1. **Three plan-limit triggers existed that no migration mentions.** Created by
   hand in the dashboard. They were the real enforcement behind the Basic/Pro
   split, so flipping `src/lib/plans/config.ts` to a single plan unlocked
   nothing — the database went on rejecting the 6th trade of the week. Dropped
   in `022`.

2. **Two triggers the repo declares do not exist.** `002` creates
   `personal_strategies_updated_at` and `alert_settings_updated_at`; neither is
   there, while everything else in `002` landed. Drift running the other way.
   `026` restores them.

3. **Four policies the repo declares do not exist**, and a differently-named
   hand-made policy sits on each of those tables instead.

4. **The ledger.** `supabase_migrations.schema_migrations` holds exactly three
   rows — `create_notebook_pages`, `create_setups_and_link_trades`,
   `add_setup_structured_fields` — which are precisely the three tables that no
   file in `supabase/migrations/` creates. They went through Supabase's
   migration tool, were recorded properly, and never reached the repo. The
   other 26 files have no row at all, because pasting into the SQL editor
   records nothing.

Finding 3 is the one that settles the diagnosis. OID ordering showed every
policy sitting 16–22 OIDs after its own table — so the script that built each
table created a policy in the same pass, just under a different name than the
file in this repo. There was no later replacement. **The files in
`supabase/migrations/` are not a record of what was executed.**

That is a stronger claim than "some statements failed", and it is what makes
this an architecture question rather than a cleanup.

Note also that the migrations run tonight left no ledger entry either. This is
not a historical problem that stopped.

---

## The problem in one sentence

We have a directory that looks like a schema definition, is treated as one, and
is not one — with no mechanism that would ever have told us.

---

## What is wrong with the current approach

`supabase/queries/schema_drift.sql` compares a hand-maintained list of object
names against the catalog. It found real things. It also has two structural
limits that no amount of extending will fix:

**It only checks existence, at object grain.** Query 8 verifies that ten tables
exist. Across the 26 files there are 43 `ADD COLUMN`, 4 `ALTER COLUMN`, 1
`DROP COLUMN`, 3 backfill `UPDATE`s, 3 `ADD CONSTRAINT` and 4 `CREATE INDEX`
statements — **58 statements with no verification of any kind**. Nothing tells
us whether `trade_plans` actually has `direction`, `symbol`, the P&L columns or
`point_value`, or whether `019`'s backfill populated `image_path`.

**Its baseline is hand-maintained.** Every expected name is typed into the
query file. Miss one when adding a migration and the sweep reports your own
object as drift; add one the migrations later drop and it reports a MISSING
that can never be satisfied. Both have already happened during the writing of
it. A check that cries wolf is a check nobody runs.

Closing the first gap by hand means parsing 43 `ADD COLUMN` statements with
their types, defaults and constraints. A regex parser will have gaps, and a
checker with gaps that people trust is worse than no checker.

---

## Recommendation

Three changes. They are independent enough to do separately, but they are worth
more together than apart.

### A. A schema dump becomes the source of truth

`pg_dump --schema-only --schema=public` against production, committed to the
repo, regenerated on a schedule. Drift becomes a diff of a file.

Every column, type, default, nullability, constraint, index, policy, trigger,
function and grant is covered — with no parser to maintain and no expected-list
to rot. It is strictly more complete than what we have, and it is less code.

| Current query | Fate under a dump |
|---|---|
| 1 — plan-limit triggers | retire; a dump shows all triggers |
| 2 — triggers the repo lacks | retire |
| 3 — functions the repo lacks | retire |
| 4 — policies the repo lacks | retire |
| 5 — CHECK constraints, views | retire |
| 6 — triggers missing | retire |
| 7 — functions missing | retire |
| 8 — tables missing | retire |
| 9 — policies missing | retire |
| 10 — RLS off | **keep** |
| 11 — RLS on but toothless | **keep** |
| 12 — views bypassing RLS | **keep** |
| 13 — EXECUTE to PUBLIC/anon/authenticated | **keep** |
| 14 — policies TO public | **keep** |

Nine of fourteen go. The five that stay are the ones encoding a **judgement**
rather than a fact: a dump faithfully records that a policy is `TO public` — it
does not tell you that is wrong. Those five are the assertions, and they are
what CI should fail on.

### B. The CLI becomes the write path

The Supabase CLI is denied to the coding agent by `.claude/settings.json` and
that boundary should stay. It says nothing about what the owner runs.

**In practice:**

- `supabase migration new <name>` creates the file **in the repo**; paste the
  SQL in; `supabase db push` applies it **and writes the ledger**. File and
  ledger stay in lockstep by construction, which is the thing that has been
  missing.
- **Never use the dashboard for DDL again.** Note exactly what it did here: it
  wrote the ledger correctly and did not write the repo file. That is the
  three-table situation. The dashboard is half a migration tool and it is the
  wrong half.
- The division of labour improves rather than changes: the agent writes the
  migration file, the owner runs `db push`. Today the agent writes a file and
  the owner pastes it into an editor that records nothing, so the repo's claim
  that a migration was applied rests on memory.

**This gives CI a far better check than any catalog query.** Every filename in
`supabase/migrations/` must have a ledger row, and every ledger row a file — a
list-versus-list on 29 names. No parsing, no inference, no baseline to
maintain. It would have caught all four findings above on day one.

### C. The five assertions run in CI

Weekly cron, plus on any PR touching `supabase/**`, plus manual dispatch.
Connect read-only, run queries 10–14, fail the job on any row.

Needs two things from the owner: a read-only Postgres role, and its connection
string as a repo secret. A script that reaches the database must also be added
to the deny list in `.claude/settings.json` in the same change — those rules are
enumerated by script name, not a catch-all.

---

## What the baseline reset actually involves

This is the part with real risk, and the reason not to decide it tired.

The 26 existing files **cannot simply be pushed**. Four of seven `CREATE
TRIGGER` and 16 of 18 `CREATE POLICY` statements are unguarded, so a replay
errors rather than converging. And since the files demonstrably are not what
ran, replaying them would not reproduce production even if they succeeded.

So adopting the CLI means declaring the existing history unreliable — which is
what finding 3 established — and starting from current production state:

1. **Dump production.** `pg_dump --schema-only --schema=public`. Read it. This
   is the first time the repo would contain a true description of the database.
2. **Commit it** as the new baseline, replacing `supabase/schema.sql`.
3. **Mark the existing versions applied without running them.** The CLI has a
   repair command for exactly this case; check its current flags rather than
   trusting a remembered syntax.
4. **Keep the 26 files** as history. They stop being a schema definition and
   become a change log — which is all they ever honestly were.
5. **Go forward** with `migration new` / `db push` and the ledger check in CI.

**Risks worth naming before agreeing to it:**

- A dump of a Supabase database includes platform objects. Restricting to
  `--schema=public` keeps it readable, but then `storage.objects` policies —
  where last week's exposure lived — are outside the dump and still need the
  assertions. That is an argument for C regardless of A.
- The dump will contain the hand-made policies and `ensure_rls` under their real
  names. That is the point, and it will look like the repo suddenly "gained"
  objects. It did not; it stopped lying.
- Step 3 is the irreversible-feeling one. It is not actually destructive —
  nothing is dropped — but it does mean the repo stops claiming the 26 files
  are replayable. Worth being at peace with.

---

## What this does not solve

- **It does not stop anyone using the dashboard.** Nothing can. What changes is
  that dashboard DDL becomes a visible, dated CI failure on the next PR instead
  of a silent divergence found months later by a pricing change that
  mysteriously does nothing.
- **It does not retroactively tell us what happened.** Postgres keeps no DDL
  history; OID ordering was the closest thing to evidence available, and the
  ledger only covers three migrations.
- **It does not verify the 58 unchecked statements.** The dump replaces the need
  to: it shows the end state, so the question "did `019`'s backfill run" becomes
  "is `image_path` populated", which is a data question, not a schema one.

---

## Decisions needed

1. **Do we pivot to a dump-based baseline?** If yes, queries 1–9 retire and the
   baseline generator is not worth building — it exists to produce the
   comparison a dump does better.
2. **Do we adopt the CLI as the write path**, with the dashboard closed to DDL?
3. **Do we do the baseline reset now**, or run the two side by side for a while
   first?
4. **Read-only role and CI secret** — needed for C whatever is decided about A
   and B.

My recommendation is yes to all three, in the order A, B, C, with the baseline
reset done in one sitting rather than gradually — a half-reset is a third state
to reason about and there are already two too many.

---

## Immediately outstanding, independent of all of the above

- **The backfill for `notebook_pages`, `rule_violations` and `setups`**, written
  from the ledger's stored statement text rather than from the catalog. Blocked
  only on pasting that output.
- **A migration codifying the four hand-made policies**, which are now the real
  access control for their tables and appear nowhere in the repo.

## Migrations run and verified, 2026-09-18

`022` through `027` have all been run and checked. Recorded here because none of
them left a ledger entry — which is the problem this document is about, and the
only record that they ran is this paragraph.

| | what was verified |
|---|---|
| `022` | plan-limit triggers and functions gone; `get_user_tier` gone; `ensure_rls` still wired |
| `023` | no policy in `public` granted `TO public` |
| `024` | four functions revoked; signup still works; RLS canary true |
| `025` | canary true after `CREATE OR REPLACE`; `ensure_rls` unchanged |
| `026` | both `updated_at` triggers present on `personal_strategies` and `alert_settings` |
| `027` | `proacl` is `{postgres=X/postgres, service_role=X/postgres}` on all four functions |

That final ACL is the intended end state, not a leftover. Query 13 asserts on
`PUBLIC`, `anon` and `authenticated` only: `service_role` is server-side with a
secret key and bypasses RLS regardless, and the owner needs `EXECUTE` for
`CREATE TRIGGER` to work. So the baseline for that assertion is now a true zero.

It also resolves an open question from earlier in the session. After `024`,
`postgres` and `service_role` appeared to have vanished from these functions;
they are both present in `proacl` now. `information_schema.routine_privileges`
only shows rows whose grantor or grantee is a role the current user belongs to,
so it was hiding them rather than reporting their absence. **Read `proacl` for
questions about grants; `information_schema` cannot prove a negative.**
