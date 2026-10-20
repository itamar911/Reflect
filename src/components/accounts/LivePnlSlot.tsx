'use client';

/**
 * The REF-108 slot on a portfolio card — reserved, empty, and deliberately
 * not a comment (REF-110 §D.1).
 *
 * WHAT THIS RENDERS TODAY: a fixed-height region and nothing inside it. That
 * is the whole of its job, and the two decisions in it are both about the day
 * REF-108 fills it.
 *
 * WHY IT IS A COMPONENT AND NOT A `{/* TODO *\/}`
 * ----------------------------------------------
 *
 * Because the boundary is the deliverable. REF-108 is live P&L — an open
 * position's unrealised money, polled. When it arrives it will need its own
 * state, its own fetch and its own re-render cadence, and the one thing it
 * must not do is re-render the card around it on every poll. A component that
 * already exists, already receives the portfolio id, and already sits alone in
 * its own subtree means that ticket adds a body and changes nothing else.
 *
 * WHY THE HEIGHT IS FIXED AND WHY IT SITS ABOVE THE FIGURES
 * ---------------------------------------------------------
 *
 * Above, because live P&L is the first number a trader looks for when they
 * have a position open — a figure they have to scroll past the realised ones
 * to reach is in the wrong place. And FIXED HEIGHT, because a slot that grows
 * when it acquires content reflows the card on every poll: the realised
 * figures below would shift by twenty pixels each time the number ticked,
 * which is the kind of motion that makes a page feel broken without anyone
 * being able to say why.
 *
 * So the space is paid for now, while it is free. An empty 44px on a card is
 * a small cost; a card that jumps is a visible defect.
 *
 * HOW TO FILL IT
 * --------------
 *
 * Render into the existing box. Do not change `SLOT_HEIGHT`, do not make the
 * container conditional, and do not move it below the figures — each of those
 * reintroduces exactly what this file exists to prevent. A portfolio with no
 * open position should render an empty box of the same height, not no box.
 */

import LivePositions from '@/components/tradovate/LivePositions';

/**
 * FILLED BY STAGE 3, AND THE FIGURE ARRIVED IN STAGE 4B — in the same box, at
 * the same height, in the same place.
 *
 * Stage 3 put "פוזיציה פתוחה · N חוזים" here and said, in this comment, that
 * if the broker turned out to compute an open figure of its own it would
 * arrive in this same box and nothing would move. **That is what happened.**
 * `/cashBalance/getcashbalancesnapshot` carries an `openPnL` (Stage 0 Q8,
 * measured 19.10), so the line now reads
 * "פוזיציה פתוחה · שני חוזים ESZ6 · +$120" for THIS portfolio only.
 *
 * `SLOT_HEIGHT` IS UNCHANGED AND THAT IS NOT LUCK. The figure goes INSIDE the
 * existing line rather than on a row of its own, and deleting Stage 3's
 * no-price sentence gave back a row — so the common case is shorter than what
 * this box already held. The one case that grows is a portfolio holding two or
 * more contracts, where the per-portfolio total takes a third row; see the
 * note on {@link SLOT_HEIGHT}.
 *
 * STILL A FIXED-HEIGHT BOX, and still unconditionally rendered. A portfolio
 * with no open position renders an empty one of the same height, exactly as
 * the header required — the content is conditional, the reservation is not.
 * A portfolio whose figure could not be read renders the line without it, in
 * silence, which is the Stage 3 floor.
 */

/** The reserved height, in px. See the header before changing it. */
export const SLOT_HEIGHT = 44;

export default function LivePnlSlot({ portfolioId, userId, enabled }: {
  /** Which portfolio's positions belong in this box — `accounts.id`, ours. */
  portfolioId: string;
  /** Who is looking. The poll is shared across every card on the page. */
  userId: string;
  /** The allowlist AND migration 037, decided on the server. */
  enabled: boolean;
}) {
  // No longer `aria-hidden`: the box can now carry a sentence, and hiding it
  // would announce nothing to the one reader most likely to miss a position.
  // When it is empty it contains no text, so it is still nothing to stop on.
  return (
    <div style={{ height: SLOT_HEIGHT, overflow: 'hidden' }}>
      <LivePositions userId={userId} enabled={enabled} accountId={portfolioId} compact />
    </div>
  );
}
