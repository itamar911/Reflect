/**
 * The order the trade form opens in (REF-129 item 2).
 *
 * REF-129 reported that clicking "+ עסקה חדשה" took a long time to show
 * anything. The cause was the order: AppShell awaited the broker pull (seven to
 * nine upstream Tradovate requests) and then the rule gate, and only then
 * opened the sheet — so the trader watched a closed sheet for ~300-400ms
 * unconnected, 1.5-4s connected. lib/rules/openTradeFormGate.ts inverts that.
 *
 * WHY THIS IS A FIXTURE AND NOT A PLAYWRIGHT RUN. The thing to assert is a
 * HAPPENS-BEFORE: the sheet is open while both requests are still in flight.
 * A browser test can only observe that the sheet appeared quickly, which is a
 * timing claim about a machine rather than a claim about the order — and it
 * cannot observe it at all here, because the form is not rendered in demo mode
 * (AppShell) and this machine has no working session to run the real one with.
 * Deferred promises make the ordering directly observable instead: nothing
 * resolves until this file says so, so "open before resolve" is a fact about
 * the code and not about how fast anything ran.
 *
 * Covered:
 *   - the sheet opens before EITHER request resolves, and before submit is
 *     re-enabled
 *   - submit stays shut from the first line until the gate answers
 *   - a clean day leaves the sheet open with no warning and no block
 *   - a `warn` violation leaves the sheet open and shows its description
 *   - `block_day` and `block_timer` close the sheet and raise the modal
 *   - a previous open's warning is cleared before the new gate runs, not after
 *   - the gate's own throw fails OPEN and still re-enables submit
 *   - the pull's result is the value the gate is asked about (the two
 *     enforcement paths cannot be handed different days)
 *
 * Usage: npm run test:trade-gate
 * Exits non-zero on the first failing group's summary.
 */
import {
  openTradeFormThroughGate,
  violationBlocks,
  type TradeFormGateEffects,
} from '../src/lib/rules/openTradeFormGate';
import { BROKER_UNAVAILABLE, REFLECT_ONLY, type BrokerDayPull } from '../src/lib/rules/brokerDayContext';
import type { RuleViolationResult } from '../src/lib/rules/fetchActiveRuleViolation';
import type { ActionType } from '../src/lib/types';

interface Case {
  label: string;
  got: unknown;
  want: unknown;
}

const failures: string[] = [];

function group(name: string, cases: Case[]) {
  const bad = cases.filter((c) => JSON.stringify(c.got) !== JSON.stringify(c.want));
  console.log(`${bad.length ? 'FAIL  ' : 'ok    '}${name}  (${cases.length - bad.length}/${cases.length})`);
  for (const c of bad) {
    console.log(`         ${c.label}: got ${JSON.stringify(c.got)} want ${JSON.stringify(c.want)}`);
    failures.push(`${name} / ${c.label}`);
  }
}

const c = (label: string, got: unknown, want: unknown): Case => ({ label, got, want });

/** A promise this file resolves by hand, so the ordering is ours to choose. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The effects, recording what was called and in what order.
 *
 * `transcript` is the assertion surface for the ordering groups: a list of
 * effect names in call order reads as the behaviour, and a reordering of the
 * module shows up as a different list rather than as a subtly wrong boolean.
 */
function recorder() {
  const transcript: string[] = [];
  const state = {
    open: false,
    checking: false,
    warning: null as string | null,
    blocked: null as RuleViolationResult | null,
  };
  const effects: TradeFormGateEffects = {
    openSheet: () => {
      transcript.push('openSheet');
      state.open = true;
    },
    closeSheet: () => {
      transcript.push('closeSheet');
      state.open = false;
    },
    setChecking: (checking) => {
      transcript.push(`setChecking(${checking})`);
      state.checking = checking;
    },
    showWarning: (description) => {
      transcript.push(`showWarning(${description === null ? 'null' : JSON.stringify(description)})`);
      state.warning = description;
    },
    showBlock: (violation) => {
      transcript.push('showBlock');
      state.blocked = violation;
    },
  };
  return { transcript, state, effects };
}

const violation = (actionType: ActionType, description = 'תיאור'): RuleViolationResult => ({
  ruleName: 'חוק',
  description,
  actionType,
  cooldownMinutes: actionType === 'block_timer' ? 30 : null,
});

/** Let every already-resolved promise in the chain settle. */
const settle = () => new Promise((r) => setImmediate(r));

// `async function main()` + `void main()` at the foot, which is
// scripts/share-leak-check.ts' shape and scripts/accounts-check.ts' before it.
// The whole point of this file is awaiting promises it resolves by hand, and
// tsx compiles these scripts to CJS — where a top-level await is a transform
// error rather than a runtime one. The body is left at its own indentation,
// like share-leak-check's, so the groups read as groups.
async function main() {

// ── The ordering, which is the whole ticket ──────────────────────────────────
//
// Neither request is allowed to resolve until after the assertions below, so
// every one of them is a statement about the order and not about any duration.

{
  const pull = deferred<BrokerDayPull>();
  const gate = deferred<RuleViolationResult | null>();
  const { transcript, state, effects } = recorder();

  const running = openTradeFormThroughGate(
    { loadBroker: () => pull.promise, checkRules: () => gate.promise },
    effects
  );
  await settle();

  const atFirstAwait = [...transcript];
  const openBeforePull = state.open;
  const checkingBeforePull = state.checking;

  pull.resolve(REFLECT_ONLY);
  await settle();
  const openWhileGateRuns = state.open;
  const checkingWhileGateRuns = state.checking;

  gate.resolve(null);
  await running;

  group('the sheet opens before either request resolves', [
    c('the sheet is open with the pull still in flight', openBeforePull, true),
    c('submit is already shut at that moment', checkingBeforePull, true),
    c('the sheet is still open while the gate runs', openWhileGateRuns, true),
    c('and submit is still shut', checkingWhileGateRuns, true),

    // The transcript up to the first await, in full. openSheet is FIRST — if a
    // later edit moves an await above it, this is the line that fails.
    c(
      'nothing precedes openSheet',
      atFirstAwait,
      ['openSheet', 'showWarning(null)', 'setChecking(true)']
    ),

    // And submit is only re-enabled at the end.
    c('submit re-enabled only after the gate answered', transcript[transcript.length - 1], 'setChecking(false)'),
    c('the sheet is still open on a clean day', state.open, true),
    c('with no warning', state.warning, null),
    c('and no block', state.blocked, null),
  ]);
}

// ── The pull's answer is what the gate is asked about ────────────────────────
//
// The two enforcement paths must not be handed different days — see the header
// of lib/rules/brokerDayContext.ts on why that parameter is mandatory. This
// asserts the gate receives the object the pull produced, unchanged.

{
  const { effects } = recorder();
  const produced: BrokerDayPull = { source: 'broker_verified', day: {
    closedCount: 3, losingCount: 1, net: -120, lost: 120, lossStreak: 1,
    minutesSinceLastClose: 12, asOf: '2026-10-28T18:00:00.000Z',
  } };
  let seen: BrokerDayPull | null = null;

  await openTradeFormThroughGate(
    {
      loadBroker: async () => produced,
      checkRules: async (broker) => {
        seen = broker;
        return null;
      },
    },
    effects
  );

  group('the gate judges the day the pull returned', [
    c('the same object, not a copy or a second pull', seen === produced, true),
  ]);
}

// ── A warning leaves the sheet open ──────────────────────────────────────────

{
  const { transcript, state, effects } = recorder();
  await openTradeFormThroughGate(
    {
      loadBroker: async () => BROKER_UNAVAILABLE,
      checkRules: async () => violation('warn', 'שלוש הפסדים ברצף'),
    },
    effects
  );

  group('a warn violation warns and does not block', [
    c('the sheet stays open', state.open, true),
    c('the description is shown', state.warning, 'שלוש הפסדים ברצף'),
    c('no block modal', state.blocked, null),
    c('submit is released', state.checking, false),
    c('and the sheet was never closed', transcript.includes('closeSheet'), false),
  ]);
}

// ── A block closes the sheet again ───────────────────────────────────────────
//
// Both blocking action types, because `violationBlocks` is the definition of
// "blocked" and a change that dropped either one would be silent otherwise.

for (const actionType of ['block_day', 'block_timer'] as const) {
  const { transcript, state, effects } = recorder();
  const v = violation(actionType);
  await openTradeFormThroughGate(
    { loadBroker: async () => REFLECT_ONLY, checkRules: async () => v },
    effects
  );

  group(`${actionType} closes the sheet and raises the modal`, [
    c('the sheet is closed', state.open, false),
    c('the modal has the violation', state.blocked, v),
    c('no warning banner as well', state.warning, null),
    c('submit released so a later open is not stuck', state.checking, false),
    c(
      'and it closed before the modal went up',
      transcript.indexOf('closeSheet') < transcript.indexOf('showBlock'),
      true
    ),
  ]);
}

group('what counts as blocked', [
  c('block_day blocks', violationBlocks(violation('block_day')), true),
  c('block_timer blocks', violationBlocks(violation('block_timer')), true),
  c('warn does not', violationBlocks(violation('warn')), false),
  c('no violation does not', violationBlocks(null), false),
]);

// ── A previous open's warning is cleared BEFORE the gate runs ────────────────
//
// The sheet is visible while the gate decides now, so a banner left over from
// the last open would be read as a statement about this trade.

{
  const pull = deferred<BrokerDayPull>();
  const { state, effects } = recorder();
  // Stand in for the leftover state.
  effects.showWarning('אזהרה משיחה קודמת');

  const running = openTradeFormThroughGate(
    { loadBroker: () => pull.promise, checkRules: async () => null },
    effects
  );
  await settle();
  const warningWhilePending = state.warning;

  pull.resolve(REFLECT_ONLY);
  await running;

  group("a previous open's warning does not survive into this one", [
    c('cleared while the gate is still in flight', warningWhilePending, null),
    c('and still clear afterwards', state.warning, null),
  ]);
}

// ── A gate error fails OPEN, and never leaves submit stuck ───────────────────
//
// Fail-open is only correct because attemptSubmit re-runs the whole check
// before it writes. See the catch block's note.

{
  const { state, effects } = recorder();
  await openTradeFormThroughGate(
    {
      loadBroker: async () => REFLECT_ONLY,
      checkRules: async () => {
        throw new Error('supabase is down');
      },
    },
    effects
  );

  group('a gate error fails open', [
    c('the sheet stays open', state.open, true),
    c('submit is released rather than stuck', state.checking, false),
    c('no block the trader cannot explain', state.blocked, null),
    c('no warning invented from an error', state.warning, null),
  ]);
}

{
  // And the same for a pull that rejects. loadBrokerDayPull is documented never
  // to reject, so this is defence against that promise being broken later.
  const { state, effects } = recorder();
  await openTradeFormThroughGate(
    {
      loadBroker: async () => {
        throw new Error('the pull rejected, which it should never do');
      },
      checkRules: async () => violation('block_day'),
    },
    effects
  );

  group('a rejecting pull cannot wedge the form', [
    c('the sheet stays open', state.open, true),
    c('submit is released', state.checking, false),
    c('the gate never ran, so nothing is blocked', state.blocked, null),
  ]);
}

console.log('');
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('trade form gate: all groups passed');

}

void main();
