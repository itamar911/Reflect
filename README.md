This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Tradovate integration

Read-only groundwork for syncing executions from Tradovate: authentication,
token lifecycle, and an authenticated request helper. There is **no order entry
or trade management**, and no market data — the Market Data WebSocket requires
CME sub-vendor registration, which we do not have. Everything the app needs
(fills, positions, order status) comes over REST and the main WebSocket.

Code lives in `src/lib/tradovate/`. It is **server-only**: it reads the Tradovate
password and API secret from the environment, so never import it from a client
component — the same rule as `src/lib/supabase/admin.ts`.

### Filling in the credentials

Set these in `.env.local` for local work, and in the Vercel project settings for
deployments. `.env.example` lists them with empty values.

| Variable | Where it comes from |
|---|---|
| `TRADOVATE_API_URL` | `https://demo.tradovateapi.com/v1` for development and testing. Live swaps in here and nowhere else — the URL is never hardcoded. |
| `TRADOVATE_USERNAME` | Tradovate login. The vendor trial account is `RReflect`. |
| `TRADOVATE_PASSWORD` | Password for that login. |
| `TRADOVATE_APP_ID` | Application name registered with Tradovate, e.g. `Reflect`. |
| `TRADOVATE_APP_VERSION` | Version string you report, e.g. `1.0`. Free-form. |
| `TRADOVATE_CID` | Numeric API key id issued with API access. **Must be a number** — the config layer rejects a non-numeric value by name rather than letting it fail obscurely at authentication. |
| `TRADOVATE_SEC` | API key secret issued alongside `cid`. |
| `TRADOVATE_DEVICE_ID` | Stable per-installation identifier you choose, e.g. `reflect-server`. Keep it constant: Tradovate ties sessions to it, and a new one each run burns through the session cap below. |

Only `TRADOVATE_PASSWORD`, `TRADOVATE_CID` and `TRADOVATE_SEC` are secret.

### Verifying

```bash
npm run tradovate:verify
```

Authenticates and prints whether it succeeded, the `userId`, and the token
expiry. Run it first when credentials arrive. Exit codes: `0` success,
`1` authentication or network failure, `2` configuration incomplete — in which
case it names the missing variables rather than throwing.

### Using it

```ts
import { tradovateGet } from '@/lib/tradovate';

const accounts = await tradovateGet<Account[]>('/account/list');
```

Token handling lives in `session.ts`; callers never see it.

### Two things worth knowing before extending this

**Tradovate allows two concurrent sessions per user.** Opening a third silently
closes the oldest, after which the evicted token starts returning 408/429/500.
So the token is cached per process, shared by every caller, and concurrent
callers are collapsed into a single authentication. It is renewed via
`/auth/renewaccesstoken` — which extends the session in place — rather than by
re-authenticating, and renewal happens ~15 minutes ahead of expiry rather than
in response to a failure. The cache is in-memory, so on Vercel it is per lambda
instance; if concurrent instances ever approach the session cap this needs a
shared store.

**Rate limits are signalled in the response body, not the status code.** An
over-limit request returns an ordinary status with `p-ticket` and `p-time` in
place of the payload, so code that only checks `response.ok` will happily parse
a penalty as data. `client.ts` detects this, waits `p-time`, and retries with the
ticket. A `p-captcha` response cannot be answered by an API client at all — it
fails immediately and tells you to wait about an hour.

Limits are deliberately variable and undocumented; Tradovate publishes no hard
cap. Written against the official docs at <https://api.tradovate.com/>.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
