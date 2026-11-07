import { approvalContactsShown } from '@trikey/protocol';

/**
 * For a rule approval that names the alert contacts (the version-4 text, guardians with `approval_contacts`): the
 * contacts as the device shows them, one per line with the name this phone keeps for each (`names`, by the device's
 * form), and what to check; or, when the device shows their number and a code, where the same code appears. Undefined
 * for any other text (older guardians' texts show only how many contacts there are).
 */
export function approvalContactsNote(text: string, names: (id: string) => string | undefined = () => undefined): string | undefined {
  const shown = approvalContactsShown(text);
  if (!shown) return undefined;
  if (shown.kind === 'none') return 'Alert contacts: none (contacts=none).';
  if (shown.kind === 'list')
    return [
      `Alert contacts, as the device shows them (contacts=):`,
      ...shown.ids.map((id) => `  ${id}${names(id) ? `  ${names(id)}` : ''}`),
      'Check each one against that contact\u2019s nostr app. A contact you did not choose is a reason to reject on the device.',
    ].join('\n');
  return `The device shows ${shown.count} alert contacts as a code instead (contacts=${shown.count}:${shown.code}): too many to fit on its screen. Your guardian\u2019s web page shows the code of the contacts it holds under Rules; if this change keeps the contacts, it must match now, and every contact added or removed is told.`;
}
