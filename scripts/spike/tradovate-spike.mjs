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
 * SAFETY: this script must never place, modify or cancel an order. Two
 * independent guards enforce that (allowlist + mutation denylist) on both the
 * REST and WebSocket paths. Do not weaken them to "just try something".
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');

// Demo environment. Confirmed against tradovate/example-api-js tutorialsURLs.js.
// There is no sandbox: demo is simulated trading on real market data.
const REST_URL = 'https://demo.tradovateapi.com/v1';
const WS_URL = 'wss://demo.tradovateapi.com/v1/websocket';
// wss://md.tradovateapi.com/v1/websocket is the Market Data socket. We are NOT
// entitled to it (needs CME sub-vendor registration) and never open it.

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
async function rest(path, { body = null, query = null, method = null } = {}) {
  assertReadOnly('rest', path);
  const verb = method ?? (body ? 'POST' : 'GET');
  const url = new URL(REST_URL + path);
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
    return rest(path, { body: { ...(body ?? {}), 'p-ticket': json['p-ticket'] }, query, method });
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

async function main() {
  const started = new Date();
  log(`Tradovate spike - READ ONLY - ${started.toISOString()}`);
  log(`REST ${REST_URL}`);
  log(`WS   ${WS_URL}`);

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

main().catch((err) => {
  console.error(`\nSPIKE FAILED: ${redact(err.message)}`);
  if (err.stack) console.error(redact(err.stack));
  process.exit(1);
});
