/** Password managers bind the passphrase to one fixed user name, and Safari's generator reads `passwordrules`. */
import { describe, expect, it } from 'vitest';
import { MANAGER_USERNAME, passwordRules } from '../src/lib/password-manager';

describe('password manager hints', () => {
  it('use one fixed user name, so one saved entry fills every passphrase form', () => {
    expect(MANAGER_USERNAME).toBe('Trikey Guardian');
  });

  it('describe the set-up rule in the passwordrules syntax', () => {
    expect(passwordRules(12)).toBe('minlength: 12; allowed: ascii-printable;');
  });
});
