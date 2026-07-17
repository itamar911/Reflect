// Single motion spec shared by the app shell (sidebar, backdrop, nav labels)
// so every piece of the toggle animation settles in lockstep.
// Standard ease-in-out-ish curve: motion is distributed across the whole
// duration instead of front-loaded (a hard ease-out reads as a snap/jump
// when 176px of content width moves in the first ~100ms).
export const SIDEBAR_DURATION = 300;
export const SIDEBAR_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';
export const SIDEBAR_TRANSITION = `${SIDEBAR_DURATION}ms ${SIDEBAR_EASING}`;
