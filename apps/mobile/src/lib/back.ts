/**
 * What a held screen does when something tries to take it off the stack. A held screen is one the person must not
 * leave by going back (a recovery that has started, a payment the hardware wallet is approving, a code shown once):
 * the Android back button, the iOS swipe and `router.back()` either do nothing or call the screen's own handler (which
 * can still `leave`, after cancelling what it was waiting for), while the app's own moves on (replace, dismissTo,
 * dismissAll) go through as usual.
 */
export type BackHold = boolean | ((leave: () => void) => void);

export type BackDecision = 'proceed' | 'stay' | 'redirect';

/** Navigation actions that mean "go back one screen". */
const BACK_ACTIONS = new Set(['GO_BACK', 'POP']);

export function backDecision(actionType: string, hold: BackHold): BackDecision {
  if (!hold || !BACK_ACTIONS.has(actionType)) return 'proceed';
  return typeof hold === 'function' ? 'redirect' : 'stay';
}
