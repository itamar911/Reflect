/**
 * The word a user must type to confirm account deletion.
 *
 * Shared by the route and the settings UI so the two can never drift — a form
 * that accepts a word the server rejects is a support ticket, and a form that
 * asks for a different word than the server checks is worse.
 *
 * Typing beats clicking here: the second click of a two-click confirm is muscle
 * memory, and this action has no undo. Kept short enough to type on a phone
 * keyboard without the user hunting for characters.
 */
export const DELETE_CONFIRMATION_WORD = 'מחיקה';

/**
 * Compare a typed confirmation against the required word.
 *
 * Trims, and normalises to NFC: Hebrew typed on some mobile keyboards arrives
 * decomposed, which compares unequal to the literal above despite looking
 * identical on screen. Case is irrelevant in Hebrew but the fold costs nothing
 * and guards the constant against ever being changed to a Latin word.
 */
export function matchesConfirmation(typed: string): boolean {
  const normalise = (s: string) => s.normalize('NFC').trim().toLocaleLowerCase();
  return normalise(typed) === normalise(DELETE_CONFIRMATION_WORD);
}
