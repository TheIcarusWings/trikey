import { MANAGER_USERNAME } from '@/lib/password-manager';

/**
 * The user name a password manager binds the passphrase to. It is part of the form (so managers see it) but not of
 * the page: off-screen, out of the tab order and hidden from screen readers, never `display: none`, which managers skip.
 */
export function ManagerUsername() {
  return (
    <input
      type="text"
      name="username"
      autoComplete="username"
      value={MANAGER_USERNAME}
      readOnly
      tabIndex={-1}
      aria-hidden="true"
      className="sr-only"
    />
  );
}
