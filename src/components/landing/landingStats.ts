/**
 * Figures the landing page states in more than one place.
 *
 * These are marketing illustrations, not live data — but a visitor reads the
 * whole page in one pass, so any figure that appears twice has to be the same
 * figure both times. The discipline score used to be written down separately in
 * HeroMock (87), DisciplineScoreMock (87) and HowItWorksSection (88), and the
 * third one had already drifted.
 *
 * Per-day discipline scores (CalendarMock's day cells) and per-trade debrief
 * totals (DebriefMock) are deliberately NOT this number: they measure a single
 * day or a single trade, where this is the trader's standing score.
 */
export const DISCIPLINE_SCORE = 87;

/** Improvement over the previous month, shown next to the score. */
export const DISCIPLINE_SCORE_DELTA = 6;
