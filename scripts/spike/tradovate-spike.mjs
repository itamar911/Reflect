#!/usr/bin/env node
/**
 * Tradovate API spike — READ ONLY exploration. Not product code.
 *
 * Throwaway: nothing here is imported by the app. It exists to answer six
 * questions about the Tradovate demo environment before we design the real
 * integration. See FINDINGS.md in this directory for the answers.
 *
 * Run:
 *   node --env-file=scripts/spike/.env scripts/spike/tradovate-spike.mjs
 *
 * Or export the vars yourself; see .env.example for the shape. Credentials are
 * read from the environment only — never hardcoded, never logged.
 *
 *
 * THE --orders MODE (REF-113 STAGE 0)
 * -----------------------------------
 *
 *   node --env-file=scripts/spike/.env scripts/spike/tradovate-spike.mjs --orders
 *
 * A SEPARATE MODE, not an extra step, and that is deliberate: the six original
 * steps open a WebSocket, deliberately drop it and wait ~30s, which has nothing
 * to do with orders and would make this slow to re-run. `--orders` authenticates
 * and then reads the six order-shaped endpoints on BOTH hosts.
 *
 * It answers the seven questions REF-113's investigation could not answer from
 * the repo, because NOTHING in the repo describes the `order` or `orderVersion`
 * entity at field level — not vendored, not typed, and §2/§4 of FINDINGS.md are
 * still [PENDING] because this script has never been run live. Those seven
 * questions are printed at the top of its output as a checklist.
 *
 * WHAT IT PRINTS IS DELIBERATELY NOT THE DATA. Field NAMES and TYPES are what
 * REF-113 needs; a stop price, an order id and a timestamp are the trader's
 * position. So every sample value is replaced by its type name unless the field
 * is in {@link VOCABULARY} — the low-cardinality enums (`ordStatus`,
 * `orderType`, `action`, …) that are the whole point of the measurement and are
 * not trader data. Fail closed: a field nobody listed prints as `<number>`.
 * The aggregates are counts, which name nothing.
 *
 *
 * SAFETY: this script must never place, modify or cancel an order. Two
 * independent guards enforce that (allowlist + mutation denylist) on both the
 * REST and WebSocket paths. Do not weaken them to "just try something".
 *
 * Note for anyone adding an endpoint: the three added for `--orders` pass the
 * mutation denylist UNCHANGED. `/orderStrategy/list` does not match
 * `startorderstrategy`, which needs the `start` prefix. The regex was not
 * touched and must not be.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');

// Demo environment. Confirmed against tradovate/example-api-js tutorialsURLs.js.
// There is no sandbox: demo is simulated trading on real market data.
const REST_URL = 'https://demo.tradovateapi.com/v1';
const WS_URL = 'wss://demo.tradovateapi.com/v1/websocket';
// wss://md.tradovateapi.com/v1/websocket is the Market Data socket. We are NOT
// entitled to it (needs CME sub-vendor registration) and never open it.

/**
 * The two trading hosts, for --orders.
 *
 * Steps 1-6 are demo-only and stay that way. The app is not: `loadBrokerDay`
 * asks BOTH hosts because the token's mint server says nothing about where the
 * trader's accounts live (REF-90), so a measurement that only looked at demo
 * would not describe what the integration will actually read.
 *
 * The live host is reached with the SAME token, which is what the app does
 * (`getUserTradingApi` hands one token to a reader per host). A trial account
 * with no live provisioning answers 401/403, and that is recorded rather than
 * fatal — the same asymmetry as `loadBrokerDay`'s failure rule 1.
 */
const HOSTS = {
  demo: REST_URL,
  live: 'https://live.tradovateapi.com/v1',
};

// ---------------------------------------------------------------------------
// Read-only guards
// ---------------------------------------------------------------------------

const ALLOWED_REST = new Set([
  '/auth/accesstokenrequest',
  '/auth/renewaccesstoken',
  '/account/list',
  '/cashBalance/list',
  '/contract/item',
  '/contract/items',
  '/executionReport/list',
  '/fill/deps',
  '/fill/item',
  '/fill/list',
  '/fillPair/list',
  '/order/list',
  '/orderVersion/list',
  '/position/list',
  '/user/list',
  // REF-113 Stage 0. All three pass the mutation denylist unchanged; see the
  // note in the module header before adding a fourth.
  '/orderStrategy/list',
  '/orderStrategyLink/list',
  '/command/list',
]);

const ALLOWED_WS = new Set(['authorize', 'user/syncrequest']);

// Belt and braces: even if something lands in an allowlist by mistake, anything
// that looks like it mutates trading state is refused outright.
const MUTATING =
  /place|cancel|modify|liquidat|closeposition|startorderstrategy|interrupt|accept|create|update|delete/i;

function assertReadOnly(kind, path) {
  const allow = kind === 'rest' ? ALLOWED_REST : ALLOWED_WS;
  if (MUTATING.test(path)) {
    throw new Error(`READ-ONLY GUARD: refusing ${kind} call to "${path}" (matches mutation pattern)`);
  }
  if (!allow.has(path)) {
    throw new Error(`READ-ONLY GUARD: refusing ${kind} call to "${path}" (not in allowlist)`);
  }
}

// ---------------------------------------------------------------------------
// Credentials + redaction
// ---------------------------------------------------------------------------

function env(name, { required = true } = {}) {
  const v = process.env[name];
  if (required && (!v || !v.trim())) {
    throw new Error(
      `Missing env var ${name}. See scripts/spike/.env.example, then run with ` +
        `node --env-file=<file> ${process.argv[1]}`
    );
  }
  return v?.trim();
}

/** Never let a token or password reach stdout or a report file. */
const SECRETS = [];
function registerSecret(s) {
  if (s && s.length > 6) SECRETS.push(s);
}
function redact(text) {
  let out = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  for (const s of SECRETS) out = out.split(s).join('<redacted>');
  return out;
}
function tokenFingerprint(t) {
  return `len=${t.length} head=${t.slice(0, 6)}...`;
}

// ---------------------------------------------------------------------------
// Report accumulation
// ---------------------------------------------------------------------------

const report = { steps: [], rateLimitEvents: [], observedHeaders: {} };

function log(...args) {
  console.log(...args.map((a) => (typeof a === 'string' ? redact(a) : a)));
}
function section(n, title) {
  log(`\n${'='.repeat(72)}\nSTEP ${n}: ${title}\n${'='.repeat(72)}`);
}
function record(step, data) {
  report.steps.push({ step, ...data });
}
function dump(name, value) {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${name}.json`);
  writeFileSync(file, redact(JSON.stringify(value, null, 2)), 'utf8');
  return file;
}

/** Describe the shape of a value: field path -> JS type + verbatim sample. */
function shapeOf(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, shapeOf(v, path));
    } else {
      out[path] = {
        type: v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v,
        sample: v,
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

let accessToken = null;

/**
 * Tradovate applies variable request-rate limits and answers with a
 * `p-ticket` / `p-time` body instead of the normal payload. `p-captcha` means a
 * third-party app cannot proceed and must wait an hour.
 */
async function rest(path, { body = null, query = null, method = null, baseUrl = REST_URL } = {}) {
  assertReadOnly('rest', path);
  const verb = method ?? (body ? 'POST' : 'GET');
  const url = new URL(baseUrl + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(url, {
    method: verb,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // Capture anything limit-shaped the server volunteers.
  for (const [k, v] of res.headers.entries()) {
    if (/limit|retry|remaining|reset/i.test(k)) report.observedHeaders[k] = v;
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { __unparsed: text };
  }

  if (json && (json['p-ticket'] || json['p-time'] || json['p-captcha'])) {
    const evt = {
      path,
      status: res.status,
      'p-time': json['p-time'],
      'p-captcha': Boolean(json['p-captcha']),
      at: new Date().toISOString(),
    };
    report.rateLimitEvents.push(evt);
    log(`RATE LIMIT on ${path}: ${JSON.stringify(evt)}`);
    if (json['p-captcha']) {
      throw new Error('p-captcha received - third-party app must wait ~1 hour.');
    }
    // Honour the penalty and retry once with the ticket, as the FAQ prescribes.
    const waitMs = (json['p-time'] ?? 1) * 1000;
    log(`Waiting ${waitMs / 1000}s then retrying with p-ticket...`);
    await new Promise((r) => setTimeout(r, waitMs));
    return rest(path, { body: { ...(body ?? {}), 'p-ticket': json['p-ticket'] }, query, method, baseUrl });
  }

  if (!res.ok) {
    throw new Error(`${verb} ${path} -> ${res.status} ${redact(text).slice(0, 400)}`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// STEP 1 - Authenticate, token lifetime, renewal
// ---------------------------------------------------------------------------

async function step1Auth() {
  section(1, 'Authenticate against demo, token lifetime and renewal');

  const credentials = {
    name: env('TRADOVATE_USERNAME'),
    password: env('TRADOVATE_PASSWORD'),
    appId: env('TRADOVATE_APP_ID'),
    appVersion: env('TRADOVATE_APP_VERSION'),
    cid: Number(env('TRADOVATE_CID')),
    sec: env('TRADOVATE_SEC'),
    deviceId: env('TRADOVATE_DEVICE_ID', { required: false }) || 'reflect-spike-device',
  };
  registerSecret(credentials.password);
  registerSecret(credentials.sec);

  const requestedAt = new Date();
  const auth = await rest('/auth/accesstokenrequest', { body: credentials });

  if (auth.errorText) throw new Error(`Auth failed: ${auth.errorText}`);
  registerSecret(auth.accessToken);
  accessToken = auth.accessToken;

  const expiresAt = new Date(auth.expirationTime);
  const lifetimeMin = (expiresAt - requestedAt) / 60000;

  log(`accessToken:            ${tokenFingerprint(auth.accessToken)}`);
  log(`userId:                 ${auth.userId}`);
  log(`name:                   ${auth.name}`);
  log(`userStatus:             ${auth.userStatus}`);
  log(`hasLive:                ${auth.hasLive}`);
  log(`requested at:           ${requestedAt.toISOString()}`);
  log(`expirationTime:         ${auth.expirationTime}`);
  log(`=> measured lifetime:   ${lifetimeMin.toFixed(1)} minutes`);
  log(`passwordExpirationTime: ${auth.passwordExpirationTime ?? '(none)'}`);
  log('\nAuth response, raw (token redacted):');
  log(JSON.stringify({ ...auth, accessToken: '<redacted>' }, null, 2));

  // Renewal: extends the existing session rather than opening a new one.
  const renewedAt = new Date();
  const renewed = await rest('/auth/renewaccesstoken');
  let renewal = null;
  if (renewed?.accessToken) {
    registerSecret(renewed.accessToken);
    const newExpiry = new Date(renewed.expirationTime);
    renewal = {
      endpoint: '/auth/renewaccesstoken',
      method: 'GET with Bearer token',
      newExpirationTime: renewed.expirationTime,
      windowMinutes: Number(((newExpiry - renewedAt) / 60000).toFixed(1)),
      tokenChanged: renewed.accessToken !== auth.accessToken,
    };
    accessToken = renewed.accessToken;
    log(
      `\nRenewal -> new expirationTime ${renewed.expirationTime} ` +
        `(${renewal.windowMinutes} min from now, token ${renewal.tokenChanged ? 'rotated' : 'unchanged'})`
    );
  } else {
    log('\nRenewal returned no accessToken; raw:');
    log(JSON.stringify(renewed, null, 2));
  }

  record(1, {
    userId: auth.userId,
    expirationTime: auth.expirationTime,
    measuredLifetimeMinutes: Number(lifetimeMin.toFixed(1)),
    renewal,
    authResponseShape: shapeOf({ ...auth, accessToken: '<redacted>' }),
  });

  return { userId: auth.userId, name: auth.name };
}

// ---------------------------------------------------------------------------
// STEP 2 - Accounts, then one fill, printed verbatim
// ---------------------------------------------------------------------------

async function step2AccountsAndFill() {
  section(2, 'Account list, then a single fill - raw');

  const accounts = await rest('/account/list');
  log(`account/list returned ${accounts.length} account(s). RAW:`);
  log(JSON.stringify(accounts, null, 2));
  dump('account-list', accounts);

  const fills = await rest('/fill/list');
  log(`\nfill/list returned ${fills.length} fill(s).`);
  dump('fill-list', fills);

  if (!fills.length) {
    log('NO FILLS on this account. The demo account has never traded, so there is');
    log('nothing to map against. Place a trade by hand in the Tradovate demo UI');
    log('(not from this script - it is read-only) and re-run.');
    record(2, { accounts: accounts.map((a) => a.id), fillCount: 0, fill: null, fillShape: null });
    return { accounts, fills: [], fillPairs: [], contract: null };
  }

  const fill = fills[0];
  log('\nSingle fill, RAW VERBATIM:');
  log(JSON.stringify(fill, null, 2));
  log('\nField -> type -> sample:');
  const fShape = shapeOf(fill);
  for (const [k, v] of Object.entries(fShape)) {
    log(`  ${k.padEnd(24)} ${String(v.type).padEnd(9)} ${JSON.stringify(v.sample)}`);
  }

  // fillPair is where realized P&L pairing lives - central to the mapping.
  const fillPairs = await rest('/fillPair/list');
  log(`\nfillPair/list returned ${fillPairs.length} pair(s).`);
  if (fillPairs.length) {
    log('Single fillPair, RAW VERBATIM:');
    log(JSON.stringify(fillPairs[0], null, 2));
    dump('fillpair-list', fillPairs);
  }

  // Resolve the contract so we can see how the symbol actually arrives.
  let contract = null;
  if (fill.contractId) {
    contract = await rest('/contract/item', { query: { id: fill.contractId } });
    log('\ncontract/item for that fill, RAW VERBATIM:');
    log(JSON.stringify(contract, null, 2));
    dump('contract-item', contract);
  }

  record(2, {
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, accountType: a.accountType })),
    fillCount: fills.length,
    fill,
    fillShape: fShape,
    fillPair: fillPairs[0] ?? null,
    fillPairShape: fillPairs[0] ? shapeOf(fillPairs[0]) : null,
    contract,
    contractShape: contract ? shapeOf(contract) : null,
    accountShape: accounts[0] ? shapeOf(accounts[0]) : null,
  });

  return { accounts, fills, fillPairs, contract };
}

// ---------------------------------------------------------------------------
// STEP 3 - Compare against trade_plans
// ---------------------------------------------------------------------------

// The columns our trades table actually needs, from src/lib/types.ts TradePlan.
const TRADE_PLANS_COLUMNS = [
  ['symbol', 'PRESENT', 'contract.name via fill.contractId - needs a lookup plus root-symbol normalisation'],
  ['entry_price', 'PRESENT', 'fillPair.buyPrice, or fill.price on the opening fill'],
  ['exit_price', 'PRESENT', 'fillPair.sellPrice, or fill.price on the closing fill'],
  ['quantity', 'PRESENT', 'fill.qty'],
  ['units', 'PRESENT', 'fill.qty (contracts); our column is separate but the same number'],
  ['submitted_at', 'PRESENT', 'fill.timestamp of the opening fill'],
  ['closed_at', 'PRESENT', 'fill.timestamp of the closing fill'],
  ['direction', 'DERIVE', 'from fill.action ("Buy" | "Sell") on the opening fill'],
  ['status', 'DERIVE', 'open until the position is flat / the fillPair completes'],
  ['actual_pnl', 'DERIVE', '(sellPrice - buyPrice) * qty * point_value - no P&L field on a fill'],
  ['pnl_amount', 'DERIVE', 'same computation as actual_pnl'],
  ['point_value', 'DERIVE', 'from the contract/product, not carried on the fill'],
  ['pnl_currency', 'DERIVE', 'account currency, not carried on the fill'],
  ['stop_loss', 'MISSING', 'a plan input, not an execution fact'],
  ['take_profit', 'MISSING', 'a plan input, not an execution fact'],
  ['rr_ratio', 'MISSING', 'computed from stop/target, both of which are missing'],
  ['strategy', 'MISSING', 'user-authored'],
  ['trade_reason', 'MISSING', 'user-authored'],
  ['emotional_state', 'MISSING', 'user-authored'],
  ['confidence_level', 'MISSING', 'user-authored'],
  ['timeframe', 'MISSING', 'user-authored'],
  ['risk_amount / risk_type', 'MISSING', 'plan input'],
  ['user_id', 'MISSING', 'ours, not Tradovate identity'],
];

function step3Mapping(fill, fillPair, contract) {
  section(3, 'Tradovate fill fields vs. our trade_plans columns');

  const available = new Set([
    ...Object.keys(fill ? shapeOf(fill) : {}).map((k) => `fill.${k}`),
    ...Object.keys(fillPair ? shapeOf(fillPair) : {}).map((k) => `fillPair.${k}`),
    ...Object.keys(contract ? shapeOf(contract) : {}).map((k) => `contract.${k}`),
  ]);
  log('Fields the API actually gave us:');
  for (const f of [...available].sort()) log(`  ${f}`);

  log('\nOur column -> verdict -> source:');
  const rows = TRADE_PLANS_COLUMNS.map(([column, verdict, note]) => {
    log(`  ${verdict.padEnd(8)} ${column.padEnd(24)} ${note}`);
    return { column, verdict, note };
  });

  const tally = rows.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {});
  log(`\nTally: ${JSON.stringify(tally)}`);

  record(3, { availableFields: [...available].sort(), mapping: rows, tally });
  return rows;
}

// ---------------------------------------------------------------------------
// STEP 4 - Execution history depth
// ---------------------------------------------------------------------------

async function step4History() {
  section(4, 'Execution history - how far back does it go?');

  const sets = {};
  for (const path of ['/fill/list', '/executionReport/list', '/order/list', '/fillPair/list']) {
    try {
      const rows = await rest(path);
      sets[path] = rows;
      const stamps = rows
        .map((r) => r.timestamp ?? r.transactTime ?? null)
        .filter(Boolean)
        .map((t) => new Date(t))
        .sort((a, b) => a - b);
      const oldest = stamps[0];
      const newest = stamps[stamps.length - 1];
      const days = oldest ? ((Date.now() - oldest.getTime()) / 86400000).toFixed(1) : null;
      log(
        `${path.padEnd(24)} count=${String(rows.length).padEnd(6)} ` +
          `oldest=${oldest ? oldest.toISOString() : 'n/a'} ` +
          `newest=${newest ? newest.toISOString() : 'n/a'} ` +
          `depth=${days ? days + ' days' : 'n/a'}`
      );
      dump(`history${path.replace(/\//g, '-')}`, rows);
    } catch (e) {
      log(`${path.padEnd(24)} ERROR: ${e.message}`);
      sets[path] = { error: e.message };
    }
  }

  // A count landing on a round number is the data-size cap, not the true depth:
  // Tradovate caps entities per response and the cap is deliberately variable.
  for (const [path, rows] of Object.entries(sets)) {
    if (Array.isArray(rows) && [1000, 1024, 2000, 2048, 4096].includes(rows.length)) {
      log(
        `NOTE: ${path} returned exactly ${rows.length} rows - almost certainly the ` +
          `response entity cap, so history is TRUNCATED, not exhausted.`
      );
    }
  }

  record(4, {
    counts: Object.fromEntries(
      Object.entries(sets).map(([k, v]) => [k, Array.isArray(v) ? v.length : v])
    ),
  });
  return sets;
}

// ---------------------------------------------------------------------------
// STEP 5 - WebSocket: subscribe, drop, reconnect, is anything replayed?
// ---------------------------------------------------------------------------

function prepareMessage(raw) {
  const T = raw.slice(0, 1);
  const data = raw.length > 1 ? JSON.parse(raw.slice(1)) : [];
  return [T, data];
}

/**
 * Minimal Tradovate socket. Frames: 'o' open, 'h' heartbeat, 'a' JSON array,
 * 'c' close. Request envelope: `url\nid\nquery\nbody`. The client must send an
 * empty-array heartbeat `[]` about every 2.5s or the server drops the socket.
 */
function openSocket(label, token, onFrame) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let counter = 0;
    let heartbeat = null;
    const state = { ws, label, frames: [], authorized: false };

    state.send = ({ url, body, query }) => {
      assertReadOnly('ws', url);
      const id = counter++;
      // Canonical form from example-api-js EX-05: raw token, not JSON-quoted.
      const payload =
        url === 'authorize'
          ? `authorize\n${id}\n\n${body}`
          : `${url}\n${id}\n${query || ''}\n${body ? JSON.stringify(body) : ''}`;
      ws.send(payload);
      return id;
    };

    ws.addEventListener('message', (msg) => {
      const [T, data] = prepareMessage(msg.data);
      state.frames.push(T);
      if (T === 'o') {
        state.send({ url: 'authorize', body: token });
        heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('[]');
        }, 2500);
      } else if (T === 'a') {
        for (const d of data) {
          if (!state.authorized && d.i === 0 && d.s === 200) {
            state.authorized = true;
            log(`[${label}] authorized (frame 'o' -> authorize -> s:200)`);
            resolve(state);
          }
          if (d.s && d.s !== 200 && d.i === 0) {
            reject(new Error(`[${label}] authorize failed: ${JSON.stringify(d)}`));
          }
          onFrame?.(d, state);
        }
      } else if (T === 'c') {
        log(`[${label}] received close frame: ${JSON.stringify(data)}`);
      }
    });

    ws.addEventListener('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      log(`[${label}] socket closed`);
    });
    ws.addEventListener('error', (e) => reject(new Error(`[${label}] ws error: ${e.message ?? e}`)));
    setTimeout(() => reject(new Error(`[${label}] timed out waiting for authorization`)), 20000);
  });
}

async function step5WebSocket(userId) {
  section(5, 'Main WebSocket: subscribe, drop, reconnect, test for replay');

  const collected = {
    first: { snapshot: null, events: [] },
    second: { snapshot: null, events: [] },
  };

  const handler = (bucket) => (d, state) => {
    const payload = d.d;
    if (payload?.users) {
      collected[bucket].snapshot = payload;
      log(`[${state.label}] SYNC SNAPSHOT received. Top-level keys: ${Object.keys(payload).join(', ')}`);
    } else if (d.e === 'props' && payload) {
      collected[bucket].events.push(payload);
      log(`[${state.label}] user event: entityType=${payload.entityType} eventType=${payload.eventType}`);
    }
  };

  // --- first connection
  const s1 = await openSocket('conn-1', accessToken, handler('first'));
  s1.send({ url: 'user/syncrequest', body: { users: [userId] } });
  log('[conn-1] sent user/syncrequest; listening 10s...');
  await new Promise((r) => setTimeout(r, 10000));

  const snap1 = collected.first.snapshot;
  if (snap1) {
    dump('sync-snapshot-1', snap1);
    log('\nSnapshot collection sizes:');
    for (const [k, v] of Object.entries(snap1)) {
      log(`  ${k.padEnd(22)} ${Array.isArray(v) ? v.length + ' rows' : typeof v}`);
    }
    if (Array.isArray(snap1.fills) && snap1.fills.length) {
      log('\nA fill AS IT ARRIVES OVER THE SOCKET, raw verbatim:');
      log(JSON.stringify(snap1.fills[0], null, 2));
    }
  }

  // Does anything in the protocol carry a cursor/sequence? If not, replay is
  // impossible by construction and recovery must be a snapshot/REST backfill.
  const cursorFields = new Set();
  const scan = (o, p = '') => {
    for (const [k, v] of Object.entries(o ?? {})) {
      if (/seq|cursor|offset|since|watermark|lastEventId|revision/i.test(k)) cursorFields.add(p + k);
      if (v && typeof v === 'object' && !Array.isArray(v)) scan(v, `${p}${k}.`);
    }
  };
  scan(snap1);
  for (const e of collected.first.events) scan(e);
  log(
    `\nCursor/sequence fields anywhere in snapshot or events: ` +
      `${cursorFields.size ? [...cursorFields].join(', ') : 'NONE FOUND'}`
  );

  const fillIdsBefore = new Set((snap1?.fills ?? []).map((f) => f.id));

  // --- deliberate drop
  log('\n--- dropping connection deliberately ---');
  s1.ws.close();
  await new Promise((r) => setTimeout(r, 5000));
  log('--- 5s gap elapsed, reconnecting ---\n');

  // --- reconnect
  const s2 = await openSocket('conn-2', accessToken, handler('second'));
  const eventsBeforeSync = collected.second.events.length;
  await new Promise((r) => setTimeout(r, 3000));
  const unsolicited = collected.second.events.length - eventsBeforeSync;
  log(`[conn-2] events pushed BEFORE we asked to re-sync: ${unsolicited}`);

  s2.send({ url: 'user/syncrequest', body: { users: [userId] } });
  log('[conn-2] sent user/syncrequest; listening 10s...');
  await new Promise((r) => setTimeout(r, 10000));

  const snap2 = collected.second.snapshot;
  if (snap2) dump('sync-snapshot-2', snap2);
  const fillIdsAfter = new Set((snap2?.fills ?? []).map((f) => f.id));

  const findings = {
    reconnectGotSnapshot: Boolean(snap2),
    unsolicitedEventsOnReconnect: unsolicited,
    cursorFields: [...cursorFields],
    fillsInSnapshot1: fillIdsBefore.size,
    fillsInSnapshot2: fillIdsAfter.size,
    snapshotsIdentical:
      fillIdsBefore.size === fillIdsAfter.size &&
      [...fillIdsBefore].every((id) => fillIdsAfter.has(id)),
    conclusion: null,
  };
  findings.conclusion =
    findings.unsolicitedEventsOnReconnect === 0 && findings.cursorFields.length === 0
      ? 'NO REPLAY. Reconnect yields a fresh full-state snapshot, with no cursor and no ' +
        'backlog. Recovery must diff that snapshot against our own store and/or ' +
        'REST-backfill fills by id/timestamp.'
      : 'Inconclusive - see raw output; something cursor-shaped or a backlog was observed.';

  log(`\n${findings.conclusion}`);
  s2.ws.close();
  record(5, findings);
  return findings;
}

// ---------------------------------------------------------------------------
// STEP 6 - Rate limits
// ---------------------------------------------------------------------------

function step6RateLimits() {
  section(6, 'Rate limits - hit and documented');
  log(`Penalty responses encountered this run: ${report.rateLimitEvents.length}`);
  for (const e of report.rateLimitEvents) log(`  ${JSON.stringify(e)}`);
  log(
    `Limit-shaped response headers seen: ` +
      `${Object.keys(report.observedHeaders).length ? JSON.stringify(report.observedHeaders) : 'NONE'}`
  );
  log(
    '\nDocumented (tradovate/example-api-faq):\n' +
      '  - Limits exist at hour, minute and second intervals, AND on response entity count.\n' +
      '  - There is deliberately NO published hard cap; the values are variable by design.\n' +
      '  - Over-limit => body carries p-ticket + p-time (seconds to wait); retry with p-ticket.\n' +
      '  - p-captcha => a third-party app cannot proceed; wait ~1 hour.\n' +
      '  - 2 concurrent sessions per user; opening a third closes the oldest, and the\n' +
      '    orphaned token then throws 408/429/500.'
  );
  record(6, { penaltiesHit: report.rateLimitEvents, headers: report.observedHeaders });
}

// ---------------------------------------------------------------------------
// --orders  -  REF-113 STAGE 0: the order entities, measured
// ---------------------------------------------------------------------------

const ORDER_ENDPOINTS = [
  '/order/list',
  '/orderVersion/list',
  '/orderStrategy/list',
  '/orderStrategyLink/list',
  '/command/list',
  '/executionReport/list',
];

/** The round counts that mean "truncated", per FINDINGS.md §4. */
const CAP_COUNTS = [1000, 1024, 2000, 2048, 4096];

/**
 * The only fields whose VALUE is printed.
 *
 * Low-cardinality enums and nothing else. These are the vocabulary REF-113 is
 * measuring — "is there a `TrailingStop` in `orderType`", "does a cancelled
 * order keep a readable `ordStatus`" — and an enum member names no trade.
 *
 * Everything absent from this set prints as its type. That direction is the
 * point: a field nobody has thought about is a field whose value might be a
 * price, so the default must be silence. Same fail-closed shape as
 * src/lib/tradovate/allowlist.ts.
 */
const VOCABULARY = new Set([
  'action',
  'ordStatus',
  'orderType',
  'timeInForce',
  'commandType',
  'commandStatus',
  'entityType',
  'eventType',
  'execType',
  'rejectReason',
  'label',
  'accountType',
  'status',
]);

/** An enum member looks like this. Anything else is treated as free text. */
const ENUM_SHAPED = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/**
 * One field's sample value, or its type name.
 *
 * Booleans and nulls print verbatim: a flag is not a measurement of anything a
 * trader did. Arrays print their length only. Everything else has to earn it by
 * being in {@link VOCABULARY} *and* being enum-shaped — a `label` that turns out
 * to hold the trader's own free text falls back to `<string>` rather than
 * leaking it.
 */
function safeSample(fieldPath, value) {
  const leaf = fieldPath.split('.').pop();
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `<array len=${value.length}>`;
  if (typeof value === 'object') return '<object>';
  if (VOCABULARY.has(leaf) && typeof value === 'string' && ENUM_SHAPED.test(value)) return value;
  return `<${typeof value}>`;
}

/**
 * Every field any row carried, its types, and one sanitised sample.
 *
 * Across ALL rows and not just the first, because these entities have optional
 * fields that only appear on some of them — `stopPrice` is absent from a limit
 * order's version and present on a stop's, which is exactly the distinction
 * being measured. A shape read off row zero would report the wrong answer with
 * total confidence.
 */
function fieldSurvey(rows) {
  const fields = new Map();
  for (const row of rows) {
    for (const [path, info] of Object.entries(shapeOf(row))) {
      const entry = fields.get(path) ?? { types: new Set(), sample: null, present: 0 };
      entry.types.add(info.type);
      entry.present += 1;
      if (entry.sample === null || entry.sample === 'null') {
        entry.sample = safeSample(path, info.sample);
      }
      fields.set(path, entry);
    }
  }
  return fields;
}

/** Distinct values of one enum field across rows. Printable by construction. */
function enumValues(rows, field) {
  const seen = new Set();
  for (const row of rows) {
    const v = row?.[field];
    if (typeof v === 'string' && ENUM_SHAPED.test(v)) seen.add(v);
    else if (typeof v === 'number') seen.add(`<number>`);
  }
  return [...seen].sort();
}

/** Which field NAMES differ between two rows. Names only — never the values. */
function changedFields(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const changed = [];
  for (const k of keys) {
    // JSON comparison: these are flat scalar entities, and this is only ever
    // asked "did it change", never "to what".
    if (JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null)) changed.push(k);
  }
  return changed.sort();
}

/** Versions grouped by their order, oldest first. `id` breaks a tie. */
function versionsByOrder(versions) {
  const byOrder = new Map();
  for (const v of versions) {
    const key = v?.orderId;
    if (typeof key !== 'number') continue;
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(v);
  }
  for (const list of byOrder.values()) {
    list.sort(
      (x, y) =>
        new Date(x.timestamp ?? 0) - new Date(y.timestamp ?? 0) || (x.id ?? 0) - (y.id ?? 0)
    );
  }
  return byOrder;
}

/**
 * The seven questions. Printed as a checklist the owner fills in by reading the
 * rest of the file, because the script can measure but it cannot decide.
 */
const STAGE0_QUESTIONS = [
  'Q1  Does `stopPrice` sit on orderVersion, or on order?  -> read the two FIELD SURVEY blocks.',
  'Q2  Does a modify produce a NEW VERSION on the same order, and a ladder drag a CANCEL+REPLACE?',
  '      -> read "versions per order" + "fields that differ between versions" + ordStatus values.',
  'Q3  Are cancelled orders still returned, and how far back?  -> read ordStatus values + depth.',
  'Q4  Which linkage field does a real bracket populate - orderStrategyLink, ocoId, parentId?',
  '      -> read the /orderStrategy/list and /orderStrategyLink/list surveys, and order\'s fields.',
  'Q5  How does a trailing stop appear, and is `pegDifference` visible?  -> orderType values.',
  'Q6  Does /command/list separate a trader modify from a server trail step?  -> commandType values.',
  'Q7  Response counts - does any land on a round number (truncated, not exhausted)?  -> COUNTS.',
];

async function stepOrders() {
  const startedAt = new Date();
  const lines = [];

  /** Write one line to stdout and to the report file. Redacted on both. */
  const w = (text = '') => {
    const line = redact(String(text));
    lines.push(line);
    console.log(line);
  };
  const rule = (ch = '-') => w(ch.repeat(78));

  rule('=');
  w(`REF-113 STAGE 0 - order entities, measured.  ${startedAt.toISOString()}`);
  rule('=');
  w();
  w('READ-ONLY. No order was placed, modified or cancelled; the allowlist and the');
  w('mutation denylist both ran on every call below.');
  w();
  w('NO VALUES. Every sample is its TYPE NAME unless the field is a known enum.');
  w('No price, no id, no timestamp and no quantity appears in this file. Counts do.');
  w();
  rule();
  w('THE SEVEN QUESTIONS - fill these in by reading what follows');
  rule();
  for (const q of STAGE0_QUESTIONS) w(q);
  w();
  w('  [ ] Q1 answer: ');
  w('  [ ] Q2 answer: ');
  w('  [ ] Q3 answer: ');
  w('  [ ] Q4 answer: ');
  w('  [ ] Q5 answer: ');
  w('  [ ] Q6 answer: ');
  w('  [ ] Q7 answer: ');
  w();

  const findings = { startedAt: startedAt.toISOString(), hosts: {} };

  for (const [host, baseUrl] of Object.entries(HOSTS)) {
    rule('=');
    w(`HOST: ${host}`);
    rule('=');

    const hostFindings = { endpoints: {} };
    findings.hosts[host] = hostFindings;

    /** @type {Record<string, unknown[]>} */
    const data = {};

    // ── counts first, so Q7 is answerable even if a later block throws ──────
    rule();
    w('COUNTS  (a count on a round number means TRUNCATED, not exhausted)');
    rule();
    for (const path of ORDER_ENDPOINTS) {
      try {
        const rows = (await rest(path, { baseUrl })) ?? [];
        const list = Array.isArray(rows) ? rows : [];
        data[path] = list;

        const stamps = list
          .map((r) => r?.timestamp ?? r?.transactTime ?? null)
          .filter(Boolean)
          .map((t) => new Date(t))
          .filter((d) => !Number.isNaN(d.getTime()))
          .sort((a, b) => a - b);
        const depthDays = stamps.length
          ? ((Date.now() - stamps[0].getTime()) / 86400000).toFixed(1)
          : null;
        const capped = CAP_COUNTS.includes(list.length);

        w(
          `  ${path.padEnd(26)} count=${String(list.length).padEnd(7)}` +
            `depth=${(depthDays ? depthDays + 'd' : 'n/a').padEnd(10)}` +
            (capped ? '*** ROUND NUMBER - TRUNCATED, history is NOT exhausted ***' : '')
        );
        hostFindings.endpoints[path] = { count: list.length, depthDays, capped };
      } catch (e) {
        // Recorded, never fatal. A host with no provisioning, or an entity a
        // host does not expose, is a finding — the /tradingPermission/list
        // precedent in fills.ts, where a 404 is the expected reply.
        w(`  ${path.padEnd(26)} ERROR: ${e.message.slice(0, 120)}`);
        hostFindings.endpoints[path] = { error: e.message.slice(0, 200) };
        data[path] = [];
      }
    }
    w();

    if (Object.values(data).every((rows) => rows.length === 0)) {
      w('Nothing on this host. Either it holds none of this user\'s accounts, or the');
      w('account has never placed an order. Place a BRACKETED trade and drag a stop by');
      w('hand in the Tradovate UI - not from this script - and re-run.');
      w();
      continue;
    }

    // ── field surveys ──────────────────────────────────────────────────────
    for (const path of ORDER_ENDPOINTS) {
      const rows = data[path];
      if (!rows.length) continue;
      rule();
      w(`FIELD SURVEY  ${path}   (${rows.length} rows)`);
      rule();
      const fields = fieldSurvey(rows);
      w(`  ${'field'.padEnd(26)} ${'type'.padEnd(18)} ${'on'.padEnd(8)} sample`);
      for (const [name, info] of [...fields.entries()].sort()) {
        w(
          `  ${name.padEnd(26)} ${[...info.types].sort().join('|').padEnd(18)} ` +
            `${`${info.present}/${rows.length}`.padEnd(8)} ${info.sample}`
        );
      }
      hostFindings.endpoints[path].fields = Object.fromEntries(
        [...fields.entries()].map(([k, v]) => [
          k,
          { types: [...v.types].sort(), presentOn: v.present, sample: v.sample },
        ])
      );
      w();
    }

    // ── enum vocabularies - Q3, Q5, Q6 ─────────────────────────────────────
    rule();
    w('ENUM VOCABULARIES');
    rule();
    const orders = data['/order/list'] ?? [];
    const versions = data['/orderVersion/list'] ?? [];
    const commands = data['/command/list'] ?? [];

    const ordStatuses = enumValues(orders, 'ordStatus');
    const orderTypes = enumValues(versions, 'orderType').concat(enumValues(orders, 'orderType'));
    const uniqueOrderTypes = [...new Set(orderTypes)].sort();
    const commandTypes = enumValues(commands, 'commandType');

    w(`  order.ordStatus          ${ordStatuses.join(', ') || '(none)'}`);
    w(`  orderType                ${uniqueOrderTypes.join(', ') || '(none)'}`);
    w(`  order.action             ${enumValues(orders, 'action').join(', ') || '(none)'}`);
    w(`  orderVersion.timeInForce ${enumValues(versions, 'timeInForce').join(', ') || '(none)'}`);
    w(`  command.commandType      ${commandTypes.join(', ') || '(none)'}`);
    w(`  command.commandStatus    ${enumValues(commands, 'commandStatus').join(', ') || '(none)'}`);
    w();
    // Q3, stated as a boolean rather than left to the reader's eye.
    const cancelShaped = ordStatuses.filter((s) => /cancel|reject|expire/i.test(s));
    w(`  Q3 >> a terminal ordStatus IS visible: ${cancelShaped.length > 0}` +
      (cancelShaped.length ? `  (${cancelShaped.join(', ')})` : ''));
    const trailShaped = uniqueOrderTypes.filter((t) => /trail/i.test(t));
    w(`  Q5 >> a trailing orderType IS present: ${trailShaped.length > 0}` +
      (trailShaped.length ? `  (${trailShaped.join(', ')})` : ''));
    w(`  Q5 >> pegDifference is a field on orderVersion: ` +
      `${versions.some((v) => v && 'pegDifference' in v)}`);
    const modifyShaped = commandTypes.filter((t) => /modify|replace/i.test(t));
    w(`  Q6 >> a modify-shaped commandType IS present: ${modifyShaped.length > 0}` +
      (modifyShaped.length ? `  (${modifyShaped.join(', ')})` : ''));
    w();

    // ── Q1 - where the stop price lives ────────────────────────────────────
    rule();
    w('Q1  WHERE THE STOP PRICE LIVES  -  the load-bearing question');
    rule();
    const orderHasStop = orders.some((o) => o && 'stopPrice' in o);
    const versionHasStop = versions.some((v) => v && 'stopPrice' in v);
    const versionStopCount = versions.filter((v) => v?.stopPrice != null).length;
    w(`  'stopPrice' present on any /order/list row:        ${orderHasStop}`);
    w(`  'stopPrice' present on any /orderVersion/list row: ${versionHasStop}`);
    w(`  orderVersion rows with a non-null stopPrice:       ${versionStopCount}`);
    w(`  'price' present on any /order/list row:            ${orders.some((o) => o && 'price' in o)}`);
    w(`  'price' present on any /orderVersion/list row:     ${versions.some((v) => v && 'price' in v)}`);
    w();
    w(`  >> ${
      versionHasStop && !orderHasStop
        ? 'CONFIRMED: terms are on the VERSION. The version history IS the move history.'
        : orderHasStop && !versionHasStop
          ? 'REFUTED: terms are on the ORDER. REF-113 needs a different source - escalate.'
          : versionHasStop && orderHasStop
            ? 'BOTH carry it. Decide which is authoritative before building anything.'
            : 'NEITHER carries it in this sample. Place a STOP order by hand and re-run.'
    }`);
    w();

    // ── Q2 - versions per order, and what changes between them ─────────────
    rule();
    w('Q2  VERSIONS PER ORDER, AND WHAT CHANGES BETWEEN THEM');
    rule();
    const byOrder = versionsByOrder(versions);
    const counts = [...byOrder.values()].map((l) => l.length);
    const histogram = counts.reduce((acc, n) => {
      const bucket = n >= 4 ? '4+' : String(n);
      acc[bucket] = (acc[bucket] ?? 0) + 1;
      return acc;
    }, {});
    w(`  distinct orderIds in /orderVersion/list: ${byOrder.size}`);
    w(`  max versions on one order:               ${counts.length ? Math.max(...counts) : 0}`);
    w(`  orders by version count:                 ${JSON.stringify(histogram)}`);
    w(`  orders in /order/list with NO version:   ${
      orders.filter((o) => typeof o?.id === 'number' && !byOrder.has(o.id)).length
    }`);
    w();

    // Which fields move, and on how many orders. Names and counts only.
    const changeTally = new Map();
    for (const list of byOrder.values()) {
      const seenHere = new Set();
      for (let i = 1; i < list.length; i++) {
        for (const f of changedFields(list[i - 1], list[i])) seenHere.add(f);
      }
      for (const f of seenHere) changeTally.set(f, (changeTally.get(f) ?? 0) + 1);
    }
    if (changeTally.size === 0) {
      w('  No order in this sample has more than one version.');
      w('  => either nothing was ever modified, OR a modify is a CANCEL+REPLACE here.');
      w('  Cross-check against the terminal ordStatus count above before concluding.');
    } else {
      w('  fields that differ between consecutive versions of the SAME order:');
      w(`  ${'field'.padEnd(26)} on how many orders`);
      for (const [f, n] of [...changeTally.entries()].sort((a, b) => b[1] - a[1])) {
        w(`  ${f.padEnd(26)} ${n}` + (f === 'stopPrice' ? '   <<< A STOP MOVE, IN PLACE' : ''));
      }
    }
    w();
    w(`  Q2 >> stopPrice changes across versions of one order: ${changeTally.has('stopPrice')}`);
    w();

    // ── the most recent order carrying a stop ──────────────────────────────
    rule();
    w('THE MOST RECENT ORDER THAT CARRIES A stopPrice');
    rule();
    const stopOrderIds = [...byOrder.entries()].filter(([, list]) =>
      list.some((v) => v?.stopPrice != null)
    );
    if (stopOrderIds.length === 0) {
      w('  None. No order in this sample ever carried a stopPrice, so REF-113 has');
      w('  nothing to measure yet. Place a bracketed trade WITH A STOP by hand, drag');
      w('  the stop at least once, then re-run.');
      hostFindings.mostRecentStopOrder = null;
    } else {
      // Most recent by its FIRST version's instant - when the stop was placed.
      const [, newest] = stopOrderIds.sort(
        (a, b) => new Date(b[1][0]?.timestamp ?? 0) - new Date(a[1][0]?.timestamp ?? 0)
      )[0];
      const theOrder = orders.find((o) => o?.id === newest[0]?.orderId) ?? null;
      const stopPrices = newest.map((v) => v?.stopPrice ?? null);
      const distinctStops = new Set(stopPrices.filter((p) => p != null)).size;

      w(`  orders carrying a stopPrice:     ${stopOrderIds.length}`);
      w(`  versions on this one:            ${newest.length}`);
      w(`  distinct stopPrice VALUES on it: ${distinctStops}   (count, not the prices)`);
      w(`  its stopPrice moved:             ${distinctStops > 1}`);
      w(`  orderType across its versions:   ${enumValues(newest, 'orderType').join(', ') || '(none)'}`);
      w(`  its ordStatus:                   ${
        typeof theOrder?.ordStatus === 'string' ? theOrder.ordStatus : '(not found in /order/list)'
      }`);
      w('  fields differing between its consecutive versions:');
      for (let i = 1; i < newest.length; i++) {
        w(`    v${i} -> v${i + 1}: ${changedFields(newest[i - 1], newest[i]).join(', ') || '(nothing)'}`);
      }
      hostFindings.mostRecentStopOrder = {
        versionCount: newest.length,
        distinctStopPrices: distinctStops,
        moved: distinctStops > 1,
        orderTypes: enumValues(newest, 'orderType'),
        ordStatus: typeof theOrder?.ordStatus === 'string' ? theOrder.ordStatus : null,
      };
    }
    w();

    // ── Q4 - linkage ───────────────────────────────────────────────────────
    rule();
    w('Q4  BRACKET / OCO LINKAGE');
    rule();
    const strategies = data['/orderStrategy/list'] ?? [];
    const links = data['/orderStrategyLink/list'] ?? [];
    for (const field of ['ocoId', 'parentId', 'linkedId', 'oso', 'orderStrategyId']) {
      const on = orders.filter((o) => o && field in o).length;
      const nonNull = orders.filter((o) => o?.[field] != null).length;
      w(`  order.${field.padEnd(18)} present on ${String(on).padEnd(6)} non-null on ${nonNull}`);
    }
    w(`  /orderStrategy/list rows:      ${strategies.length}`);
    w(`  /orderStrategyLink/list rows:  ${links.length}`);
    if (links.length) {
      w(`  link.label values:             ${enumValues(links, 'label').join(', ') || '(none)'}`);
    }
    w();
    hostFindings.linkage = {
      strategies: strategies.length,
      links: links.length,
      orderFieldsNonNull: Object.fromEntries(
        ['ocoId', 'parentId', 'linkedId', 'orderStrategyId'].map((f) => [
          f,
          orders.filter((o) => o?.[f] != null).length,
        ])
      ),
    };
  }

  // The structured copy is JSON and goes through the same sanitiser path: only
  // counts, booleans, field names and enum members were ever put into it.
  dump('orders-findings', findings);

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const file = join(OUT_DIR, `orders-${stamp}.txt`);
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  w(`Report written to ${file}`);
  // Written twice on purpose: the line above lands in stdout only, after the
  // file was closed, so the file does not claim to contain its own filename.

  record('orders', findings);
  return findings;
}

// ---------------------------------------------------------------------------

async function main() {
  const started = new Date();
  const ordersOnly = process.argv.includes('--orders');

  log(`Tradovate spike - READ ONLY - ${started.toISOString()}`);
  log(`REST ${REST_URL}`);
  if (!ordersOnly) log(`WS   ${WS_URL}`);

  // REF-113 Stage 0. Authenticate, then read orders on both hosts and stop:
  // the WebSocket steps are about replay semantics and cost ~30s of waiting,
  // and this mode is meant to be re-run after each hand-placed trade.
  if (ordersOnly) {
    log(`Hosts: ${Object.keys(HOSTS).join(', ')}`);
    await step1Auth();
    await stepOrders();
    const ordersFile = dump('spike-report-orders', { startedAt: started.toISOString(), ...report });
    log(`\nStructured report written to ${ordersFile}`);
    process.exit(0);
  }

  const { userId } = await step1Auth();
  const { fills, fillPairs, contract } = await step2AccountsAndFill();
  step3Mapping(fills[0] ?? null, fillPairs?.[0] ?? null, contract ?? null);
  await step4History();
  await step5WebSocket(userId);
  step6RateLimits();

  const file = dump('spike-report', { startedAt: started.toISOString(), ...report });
  log(`\nStructured report written to ${file}`);
  process.exit(0);
}

/**
 * Only when run as the entry point.
 *
 * Added for REF-113 Stage 0 so the pure helpers below can be imported by
 * ./orders-selfcheck.mjs without this file trying to authenticate. Running the
 * script is unchanged.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nSPIKE FAILED: ${redact(err.message)}`);
    if (err.stack) console.error(redact(err.stack));
    process.exit(1);
  });
}

/**
 * The pure parts of --orders, for ./orders-selfcheck.mjs.
 *
 * The claim that the Stage 0 report contains no price, no id and no timestamp
 * is a property of {@link safeSample} and {@link fieldSurvey}, and this repo's
 * habit is to measure such a claim rather than believe it (see "IDEMPOTENCE IS
 * MEASURED, NOT ASSERTED" in src/lib/tradovate/import.ts). Nothing in the app
 * imports any of this.
 */
export { safeSample, fieldSurvey, changedFields, versionsByOrder, enumValues, VOCABULARY };
