/**
 * Opening the trade form, and checking the rules, in that order (REF-129 item 2).
 *
 *
 * WHAT CHANGED, AND WHY IT IS A MODULE
 * ------------------------------------
 *
 * The sheet used to open LAST. AppShell awaited the broker pull, then awaited
 * the rule gate, and only then called `setFormOpen(true)` — so the click that
 * opens the trade form paid for both before anything appeared on screen. The
 * pull alone is seven to nine upstream Tradovate requests; measured end to end
 * the delay was ~300-400ms for a trader with no broker connected and 1.5-4s for
 * one with. That is the "לוקח הרבה זמן עד שהגיליון נפתח" in REF-129, and none
 * of it was work the trader was waiting to see the result of: the form renders
 * its own day panel from its own pull, and the gate's answer only matters at
 * submit.
 *
 * So the order is inverted here: the sheet opens first and the gate runs while
 * it is visible. The ORDER IS THE WHOLE BEHAVIOUR, which is why it is a module
 * with injected effects rather than fifteen lines inside a 700-line client
 * component — scripts/trade-form-gate-check.ts drives it with deferred promises
 * and asserts that the sheet is open before either request resolves, which is
 * not a thing that can be asserted about a React event handler. The two
 * enforcement paths this product has disagreed about before (see the header of
 * tradeRuleContext.ts), so the sequencing deserves a test of its own.
 *
 *
 * THE PULL AND THE GATE ARE SEQUENTIAL, AND THAT IS NOT A MISSED PARALLELISM
 * -------------------------------------------------------------------------
 *
 * `checkRules` takes the pull as its argument: the gate cannot start until the
 * pull has answered, because the rules are evaluated AGAINST the broker's day.
 * brokerDayContext.ts explains why that parameter is mandatory rather than
 * fetched inside the gate — it is what stops the gate and the form from judging
 * two different days — and running the two concurrently would mean giving that
 * up. What the inversion buys is not a shorter chain, it is a chain the trader
 * is not staring at a closed sheet for.
 *
 * It also costs nothing extra. `loadBrokerDayPull` holds a pull for 30s and
 * shares an in-flight promise between concurrent callers, so the form's own
 * load — which starts the moment the sheet opens — and this gate are served by
 * ONE request, exactly as they were when the gate ran first.
 *
 *
 * WHAT THE TRADER SEES WHILE IT RUNS
 * ----------------------------------
 *
 * The sheet, with its day panel saying "טוען את נתוני היום." — TodayContextPanel
 * already had that state and already drew it from the form's own load, because
 * it has never been willing to state zeros as fact. Nothing new was needed
 * there.
 *
 * And a submit button that is disabled and reads "בודק חוקים…" until the gate
 * answers. THAT IS THE LOAD-BEARING PART OF THIS CHANGE: with the sheet open
 * before the gate has run, submit is the one place where a blocked trader could
 * otherwise get past a rule that should have stopped them. Opening the sheet
 * early is only safe because the button is shut until the answer arrives.
 */

import type { BrokerDayPull } from './brokerDayContext';
import type { RuleViolationResult } from './fetchActiveRuleViolation';

/** The two requests, injected so the fixture can defer them by hand. */
export interface TradeFormGateDeps {
  /** The broker's view of today. Never rejects — see loadBrokerDayPull. */
  loadBroker(): Promise<BrokerDayPull>;
  /** The rule check, against the day the pull reported. */
  checkRules(broker: BrokerDayPull): Promise<RuleViolationResult | null>;
}

/**
 * Everything this sequence does to the outside world.
 *
 * Named for what the trader sees rather than for the state setters behind them,
 * so the fixture's transcript reads as the behaviour and not as an
 * implementation it has copied.
 */
export interface TradeFormGateEffects {
  openSheet(): void;
  closeSheet(): void;
  /** Submit is disabled and reads "בודק חוקים…" while this is true. */
  setChecking(checking: boolean): void;
  /** A `block_day` / `block_timer` answer. Also where violation logging goes. */
  showBlock(violation: RuleViolationResult): void;
  /** The form's warning banner. Called with null to clear a previous open's. */
  showWarning(description: string | null): void;
}

/**
 * Whether this violation stops the trade outright, as opposed to warning about
 * it. Named rather than inlined because it is the definition of "blocked" that
 * the fixture asserts against, and because `warn` is the third case — a
 * violation that is neither of these is still a violation.
 */
export function violationBlocks(violation: RuleViolationResult | null): boolean {
  return violation?.actionType === 'block_day' || violation?.actionType === 'block_timer';
}

/**
 * Open the sheet, then check the rules against the broker's day.
 *
 * Resolves when the gate has answered, so a caller can await it; nothing in the
 * UI needs to.
 */
export async function openTradeFormThroughGate(
  deps: TradeFormGateDeps,
  effects: TradeFormGateEffects
): Promise<void> {
  // FIRST, BEFORE ANY AWAIT. This line is the ticket.
  effects.openSheet();

  // A previous open's warning must not be on screen while this open's gate is
  // still deciding — the sheet is visible now, so a stale banner would be read
  // as a statement about this trade. Cleared before the request rather than
  // after it, for the same reason the sheet is opened before it.
  effects.showWarning(null);
  effects.setChecking(true);

  try {
    const broker = await deps.loadBroker();
    const violation = await deps.checkRules(broker);

    if (violation && violationBlocks(violation)) {
      // The sheet closes again. The trader ends up where they ended up before
      // this change — the block modal, no form — and the only difference is
      // that the sheet was briefly on screen while the rules were read. Leaving
      // it open behind the modal would mean dismissing the modal reveals a form
      // the trader is not allowed to submit, which is a worse answer than not
      // offering it.
      effects.closeSheet();
      effects.showBlock(violation);
      return;
    }

    effects.showWarning(violation?.actionType === 'warn' ? violation.description : null);
  } catch {
    // FAIL OPEN, DELIBERATELY, AND ONLY BECAUSE SUBMIT RE-CHECKS.
    //
    // `loadBrokerDayPull` never rejects, so reaching here means the gate's own
    // queries threw — a Supabase outage, most likely. The choice is between
    // leaving submit disabled forever on a form that is already open, and
    // letting the trader through to a submit path that runs the full check
    // again before it writes anything (`attemptSubmit` in TradePlanForm). The
    // second is strictly better: the rule is still enforced, one request later,
    // and a trader whose rules happen to be fine is not locked out of their own
    // journal by an error that had nothing to do with them.
    //
    // If that re-check at submit is ever removed, this must become fail-closed.
    //
    // Nothing to do here: the warning was already cleared before the request,
    // and `finally` re-enables submit.
  } finally {
    // In the `finally` so a throw cannot leave submit disabled forever.
    effects.setChecking(false);
  }
}
