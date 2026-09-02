# Tradovate API spike — findings

Throwaway exploration for the NinjaTrader Vendor Program trial (username `RReflect`).
Nothing in `scripts/spike/` is wired into the app.

**Environment:** demo only. There is no sandbox — `demo.tradovateapi.com` is
simulated trading on real market data.

| | |
|---|---|
| REST | `https://demo.tradovateapi.com/v1` |
| User WebSocket | `wss://demo.tradovateapi.com/v1/websocket` |
| Market Data WebSocket | `wss://md.tradovateapi.com/v1/websocket` — **not entitled**, requires CME sub-vendor registration. Never opened. |

URLs confirmed against the official
[`tradovate/example-api-js` `tutorialsURLs.js`](https://github.com/tradovate/example-api-js/blob/main/tutorial/tutorialsURLs.js).

---

## Status of this document

The script is written and its safety guards are verified. **It has not been run
against the live API**, because no Tradovate credentials exist in the environment
or in `.env.local`. Every section below is therefore marked:

- **[DOC]** — established from the official docs / official example code. Cited.
- **[PENDING]** — needs the live run to answer. The script prints exactly this.

Once credentials are in place, run it and the `[PENDING]` sections fill in from
`scripts/spike/out/`:

```
node --env-file=scripts/spike/.env scripts/spike/tradovate-spike.mjs
```

---

## 1. Authentication, token lifetime, renewal

**[DOC] Endpoint** — `POST /v1/auth/accesstokenrequest` (REST only; you cannot
authenticate over the WebSocket).

Request body:

```
name         string   required   Tradovate username
password     string   required
appId        string              application registration name
appVersion   string
cid          number              API key id issued with API access
sec          string              API key secret
deviceId     string              stable per-installation id
hibpCheck    boolean  optional
```

Response body:

```
accessToken            string     the bearer token
expirationTime         datetime   ISO — authoritative expiry
passwordExpirationTime datetime
userId                 long
name                   string
userStatus             enum       Active | Closed | Initiated | TemporaryLocked | UnconfirmedEmail
hasLive                boolean
hasSimPlus             boolean
showKIDs               boolean
errorText              string     present on failure
hibpHint               enum       EmailAndPasswordCompromised | PasswordCompromised
```

Thereafter every REST call carries `Authorization: Bearer <accessToken>`.

**[DOC] Lifetime — the docs disagree, so trust the response.** The Tradovate
Partner docs say access tokens expire after **80 minutes**; the same vendor's
other material says **90 minutes**. Do not hardcode either. `expirationTime`
comes back on every auth and renewal response and is the only reliable value —
the script measures the real window and reports it.

**[DOC] Renewal** — `GET /v1/auth/renewaccesstoken` with the current bearer
token. It extends the existing session rather than opening a new one. Guidance is
to renew roughly **15 minutes before expiry**, not to re-authenticate: repeated
`accesstokenrequest` calls burn sessions and trip the penalty system.

**[DOC] Session cap — this one matters for our architecture.** A user is limited
to **2 concurrent sessions**. Opening a third silently closes the oldest, and the
orphaned token then starts throwing `408` / `429` / `500`. So the integration must
hold **one token per user, shared across REST and WebSocket**, renewed on a timer
— not a token per process, per request, or per serverless invocation. On Vercel
this rules out authenticating inside a request handler; the token needs to live
somewhere durable and be refreshed by a single owner.

**[PENDING]** measured lifetime in minutes; whether renewal rotates the token
string or extends the existing one.

---

## 2. Accounts and a single fill — raw

**[DOC] Entity system.** Every entity type has a uniform endpoint set
([FAQ](https://github.com/tradovate/example-api-faq/blob/main/docs/WhatIsTheEntitySystemAndHowDoesItWork.md)):

```
/{entityType}/list    all entities of that type for the logged-in user
/{entityType}/item    one, by id
/{entityType}/items   several, by a list of ids
/{entityType}/find    by name (useless for types with no name field, e.g. position)
/{entityType}/deps    dependents of one master entity, by masterid
/{entityType}/ldeps   dependents of several, by masterids
```

Relevant entity types: `account`, `fill`, `fillPair`, `order`, `orderVersion`,
`executionReport`, `position`, `cashBalance`, `contract`, `product`.

**[DOC] `fill` entity fields:**

```
id            number    fill id
orderId       number    -> order entity
contractId    number    -> contract entity (NOT a symbol string)
timestamp     string    ISO datetime
tradeDate     object    { year: number, month: number, day: number }
action        string    "Buy" | "Sell"
qty           number    contracts filled
price         number    fill price
active        boolean
finallyPaired number    qty already paired off into fillPairs
external      boolean
```

**[DOC] `fillPair` entity fields** — this is where a round trip becomes a single
row, and it is the entity our `trade_plans` model actually resembles:

```
id          number
positionId  number
buyFillId   number   -> fill
sellFillId  number   -> fill
qty         number
buyPrice    number
sellPrice   number
active      boolean
```

**[PENDING]** the verbatim JSON of a real `account/list` row, a real `fill`, a
real `fillPair` and the `contract/item` they resolve to. The script prints each
one unabridged plus a `field -> type -> sample` table, and writes them to
`scripts/spike/out/*.json`. **Do not build the mapping off the doc shapes above —
build it off that output.** Field sets drift and the docs are the only authority
we have, with no technical support to ask.

> If `fill/list` comes back empty, the demo account has simply never traded.
> Place a trade by hand in the Tradovate demo UI — not from this script — and
> re-run.

---

## 3. Tradovate fills vs. our `trade_plans` table

This is the answer that shapes the integration, so state the conclusion first:

> **Tradovate can tell us what was executed. It cannot tell us what was
> intended.** Our table is roughly half execution record and half trading-plan
> record, and Tradovate only supplies the first half.

Target columns are from `TradePlan` in `src/lib/types.ts`.

### Present — comes straight off the API

| `trade_plans` column | Source |
|---|---|
| `entry_price` | `fillPair.buyPrice`, or `fill.price` on the opening fill |
| `exit_price` | `fillPair.sellPrice`, or `fill.price` on the closing fill |
| `quantity` | `fill.qty` |
| `units` | `fill.qty` (contracts) |
| `submitted_at` | `fill.timestamp` of the opening fill |
| `closed_at` | `fill.timestamp` of the closing fill |
| `symbol` | `contract.name`, via a `contractId` → `contract/item` lookup |

### Derivable — the data is there but we compute it

| `trade_plans` column | How |
|---|---|
| `direction` | `fill.action` (`"Buy"` / `"Sell"`) on the **opening** fill. Note this is the fill's side, not a position direction — a short round trip is a Sell fill followed by a Buy fill, so ordering by timestamp is what tells you which is the open. |
| `status` | `open` until the position is flat. `fill.finallyPaired` vs `fill.qty`, or the existence of a completed `fillPair`, is the signal. |
| `actual_pnl` / `pnl_amount` | `(sellPrice - buyPrice) * qty * pointValue`. **There is no P&L field on a fill or a fillPair.** We must compute it, which means we must have the contract's point value. |
| `point_value` | From the `contract` / `product` entity, not from the fill. Our `016_add_point_value.sql` column has to be populated from there. |
| `pnl_currency` | Account currency (`cashBalance` / `currency` entity). Our column is `'₪' \| '$'`; futures accounts will be USD. |

### Missing — Tradovate has no idea, and never will

`stop_loss`, `take_profit`, `rr_ratio`, `strategy`, `trade_reason`,
`emotional_state`, `confidence_level`, `timeframe`, `risk_amount`, `risk_type`,
`followed_plan`, `kept_sl`, `proper_size`, `moved_sl`, `exited_early`,
`fomo_entry`, `revenge_trade`, `plan_score`, `debrief_*`, `post_trade_notes`.

These are the *discipline* half of the record — the reason the app exists. A
fill is an execution fact; a plan is an intention stated beforehand.

### What this implies for the integration

1. **A synced fill is not a `trade_plans` row.** It cannot satisfy
   `entry_price`/`stop_loss`/`take_profit` `NOT NULL`-shaped expectations, and it
   has no plan to be scored against. Writing fills straight into `trade_plans`
   would produce rows that look like plans but were never planned — which
   corrupts every discipline statistic the app computes.
2. **The natural model is reconciliation, not import.** Tradovate fills are
   evidence; the user's submitted plan is the record. The integration should
   *match* a fill to an existing plan (symbol + direction + time window) and use
   it to fill in `exit_price`, `closed_at`, `actual_pnl`, `status` — the fields
   we currently ask the user to type in from memory. That is the real product
   win: the post-trade half stops being self-reported.
3. **Unmatched fills need somewhere to live.** A fill with no plan is exactly the
   thing the app should flag ("you traded without a plan"), so it needs its own
   table with a nullable link to `trade_plans`, not a half-populated plan row.
4. **`point_value` must be resolved at sync time** from the contract, or P&L is
   uncomputable. Cache it per contract.

This needs schema work (a `broker_fills`-shaped table plus link columns). Per
`CLAUDE.md` that means writing a numbered migration in `supabase/migrations/`
and handing it to the owner to run — not running anything.

---

## 4. Execution history depth

**[PENDING]** — the script queries `/fill/list`, `/executionReport/list`,
`/order/list` and `/fillPair/list`, and reports count, oldest timestamp, newest
timestamp and depth in days for each.

**[DOC] The trap to watch for.** Tradovate caps the **number of entities one
response may return**, and the cap is deliberately variable — "where a limit on
data size could be 1024 entities one day, another day it may make more sense to
limit the data size to 2048 or 4096"
([FAQ](https://github.com/tradovate/example-api-faq/blob/main/docs/HowDoesTradovateLimitRequestsAndData.md)).

So a `/fill/list` that returns a round number is almost certainly **truncated,
not exhausted**, and the "oldest timestamp" you compute from it is the oldest
*returned* fill, not the oldest fill that exists. The script flags this
explicitly when a count lands on 1000/1024/2000/2048/4096. Backfill must page via
`/deps` / `/ldeps` rather than assuming one `list` call is the whole history.

---

## 5. WebSocket: subscribe, drop, reconnect — is anything replayed?

### [DOC] Protocol

Frame types — one indicator character, then the payload:

| Frame | Meaning |
|---|---|
| `o` | open — the first frame the server sends. Send `authorize` in response to this. |
| `h` | server heartbeat |
| `a` | a JSON array of messages — everything of substance |
| `c` | close |

Request envelope, newline-delimited:

```
<url>\n<requestId>\n<query>\n<body>
```

Authorization, in response to the `o` frame (canonical form from
[EX-05](https://github.com/tradovate/example-api-js/blob/main/tutorial/WebSockets/EX-05-WebSockets-Start/README.md)):

```
authorize\n0\n\n<accessToken>
```

> Note a real inconsistency in Tradovate's own examples: `EX-05` sends the raw
> token as above, while the FAQ's `tvSocket.js` runs the body through
> `JSON.stringify`, which sends the token **wrapped in quotes**. Both are
> published as working. The script uses the raw form.

Client heartbeat: send the literal string `[]` about **every 2.5 seconds**, or
the server drops the connection.

Responses are matched to requests by `i` (the request id) and carry `s` (an
HTTP-like status). `s: 200` with `i: 0` is a successful authorize.

### [DOC] Subscribing to account events

```
user/syncrequest\n<id>\n\n{"users":[<userId>]}
```

`user/syncrequest` exists **only on the WebSocket** — there is no REST
equivalent. It cannot be cancelled once started.

The **initial response is a full snapshot** of current user state — per the
official example, "an object that contains all your current user data at the
time of this subscription's start". Its top-level keys, verbatim from
[the official sample](https://github.com/tradovate/example-api-faq/blob/main/example-code/user-sync-request/src/index.js):

```
accountRiskStatuses, accounts, cashBalances, commandReports, commands,
contractGroups, contractMaturities, contracts, currencies, exchanges,
executionReports, fillPairs, fills, marginSnapshots, orderStrategies,
orderStrategyLinks, orderStrategyTypes, orderVersions, orders, positions,
products, properties, spreadDefinitions, userAccountAutoLiqs, userPlugins,
userProperties, userReadStatuses, users
```

**Everything we need is in there — `fills`, `fillPairs`, `orders`, `positions`,
`executionReports`** — which confirms the Market Data socket is genuinely not
required for our use case.

Every subsequent incremental message has this envelope:

```
{ entityType, entity, eventType }
```

### Replay on reconnect

**[DOC] There is no replay.** The subscription's initial response is defined as
current state "at the time of this subscription's start" — a snapshot, not a
backlog. Partner documentation states dropped connections do not replay missed
events, and prescribes reconnect with exponential backoff.

There is also a **structural** argument, which is the stronger one: the event
envelope is `{entityType, entity, eventType}` and the snapshot carries no
sequence number, cursor, offset or watermark anywhere. **Replay is not merely
absent, it is not expressible** — there is no token the client could present to
say "resume from here". The script tests exactly this: it scans the whole
snapshot and every event for any cursor-shaped field and reports what it finds.

**Recovery therefore has to be:** reconnect → `user/syncrequest` → diff the
returned snapshot against our own store → REST-backfill anything older than the
snapshot horizon by id/timestamp. Fills carry a monotonic `id`, so
"everything with `id` greater than the last one we stored" is the practical
backfill query.

**[PENDING]** empirical confirmation: whether the reconnect pushes any
unsolicited events before we re-subscribe, and whether the second snapshot is
identical to the first.

**[LIMITATION — read this before trusting step 5.]** The spike is read-only, so
it cannot place a trade during the disconnect window to generate an event that
*could* be missed. What it establishes is the protocol's shape — snapshot
semantics, and the absence of any cursor. That is sufficient to conclude no
replay is possible, but it is not the same as observing an event get dropped. To
observe that directly, someone would have to place a demo trade by hand in the
Tradovate UI during the 5-second gap the script opens.

---

## 6. Rate limits

**[DOC] There is no published hard cap, by design**
([FAQ](https://github.com/tradovate/example-api-faq/blob/main/docs/HowDoesTradovateLimitRequestsAndData.md)):

> "there is no 'hard-cap' on request rate or data size limits. Instead these
> values are variable. *This is fully intentional*. Where a limit on data size
> could be 1024 entities one day, another day it may make more sense to limit the
> data size to 2048 or 4096. The same goes for request rate limits — one hour it
> could be 10 requests per minute on a given endpoint, and another time it could
> be 100."

Limits apply at **hour, minute and second** intervals, and separately on
**response entity count**.

**The penalty protocol.** When you exceed a limit you do not get an HTTP 429 —
you get a normal-looking response whose body carries penalty fields instead of
the payload:

| Field | Meaning |
|---|---|
| `p-time` | seconds to wait before retrying |
| `p-ticket` | include in the body of the retried request, alongside the original fields |
| `p-captcha` | a third-party application **cannot** proceed; the user must try again in about an hour |

Any client that only checks `res.ok` will silently treat a penalty response as
success and parse garbage. The spike's `rest()` detects the fields, waits
`p-time`, and retries once with the `p-ticket`, per the FAQ's prescribed
handling.

Also a limit in practice: **2 concurrent sessions per user** (see §1).

**[PENDING]** whether any penalty is actually triggered by this run's request
volume, and whether the server emits any `X-RateLimit-*`-style headers (the
script captures any header matching `limit|retry|remaining|reset`; the docs
mention none, so `NONE` is the expected result).

---

## Safety

The script is read-only and cannot place, modify or cancel an order. Two
independent guards run on **both** the REST and WebSocket paths:

1. an **allowlist** of the specific endpoints the spike needs, and
2. a **mutation denylist** regex (`place|cancel|modify|liquidat|closeposition|
   startorderstrategy|interrupt|accept|create|update|delete`) that refuses a call
   even if it somehow reached the allowlist.

Verified:

```
rest /fill/list                    ALLOWED
rest /position/list                ALLOWED
rest /order/placeOrder             refused: mutation pattern
rest /order/cancelOrder            refused: mutation pattern
rest /order/modifyOrder            refused: mutation pattern
rest /order/liquidatePosition      refused: mutation pattern
ws   user/syncrequest              ALLOWED
ws   order/placeOrder              refused: mutation pattern
```

Credentials are read from environment variables only. The access token, password
and API secret are registered as secrets at startup and scrubbed from all stdout
and from every file written to `out/`. `scripts/spike/.env` and
`scripts/spike/out/` are gitignored.

---

## Open questions for the owner

1. **Credentials.** None are present, so nothing has been run live. Put them in
   `scripts/spike/.env` (see `.env.example` — currently blocked, see below) and
   re-run.
2. **`.env.example` was not created.** Writing any file matching `.env*` is
   refused by a permission rule in this environment (it also blocked reading
   `.env.local`), and I did not work around it. To create it, allow
   `Write(scripts/spike/.env.example)` in `.claude/settings.local.json` and ask
   me again. The variables are `TRADOVATE_USERNAME`, `TRADOVATE_PASSWORD`,
   `TRADOVATE_APP_ID`, `TRADOVATE_APP_VERSION`, `TRADOVATE_CID`,
   `TRADOVATE_SEC`, `TRADOVATE_DEVICE_ID` — the script names them in its error
   message too.
3. **Does the demo account have any fills?** If it has never traded, steps 2–4
   return nothing and the mapping cannot be confirmed against real data.
4. **Where does the token live in production?** The 2-session cap makes this an
   architecture decision, not an implementation detail — see §1.
