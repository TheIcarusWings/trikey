import { describe, expect, it } from 'vitest';
import { backDecision } from './back';

describe('a held screen', () => {
  const home = () => {};

  it('stays on back (Android button, iOS swipe, router.back)', () => {
    expect(backDecision('GO_BACK', true)).toBe('stay');
    expect(backDecision('POP', true)).toBe('stay');
  });

  it('goes where the screen says on back, when it says', () => {
    expect(backDecision('GO_BACK', home)).toBe('redirect');
    expect(backDecision('POP', home)).toBe('redirect');
  });

  it("lets the app's own moves through", () => {
    for (const type of ['REPLACE', 'POP_TO', 'POP_TO_TOP', 'NAVIGATE', 'RESET']) {
      expect(backDecision(type, true)).toBe('proceed');
      expect(backDecision(type, home)).toBe('proceed');
    }
  });

  it('is not held when it does not ask to be', () => {
    expect(backDecision('GO_BACK', false)).toBe('proceed');
  });
});
