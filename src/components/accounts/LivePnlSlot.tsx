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

/** The reserved height, in px. See the header before changing it. */
export const SLOT_HEIGHT = 44;

export default function LivePnlSlot({ portfolioId }: {
  /** Whose live P&L this will be. Unused today; REF-108's only input. */
  portfolioId: string;
}) {
  // `aria-hidden` and no accessible name: there is nothing here to announce,
  // and an empty landmark on every card would be eleven stops of nothing in a
  // screen reader's rotor. REF-108 gives it a name when it gives it content.
  return (
    <div
      aria-hidden
      data-portfolio={portfolioId}
      style={{ height: SLOT_HEIGHT }}
    />
  );
}
