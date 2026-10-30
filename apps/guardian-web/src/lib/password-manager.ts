/**
 * What password managers (Proton Pass, 1Password, Bitwarden, iCloud Keychain, Google) need to save, generate and
 * fill the guardian passphrase. The guardian has no user name, so every passphrase form carries the same fixed one:
 * one saved entry then fills set-up, unlock, sign-in and reset alike.
 */
export const MANAGER_USERNAME = 'Trikey Guardian';

/**
 * The `passwordrules` hint for a new passphrase (Safari's generator reads it; others ignore it): the set-up page's own
 * rule, a minimum length, any printable characters.
 */
export function passwordRules(minLength: number): string {
  return `minlength: ${minLength}; allowed: ascii-printable;`;
}
