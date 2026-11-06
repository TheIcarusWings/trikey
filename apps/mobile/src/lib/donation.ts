/**
 * Settings > Support the project: the one public bitcoin address donations go to, and what the screen says about it.
 * Plain TypeScript (no React Native) so the hide/show rule and the wording are unit-tested.
 */

/**
 * The project's donation address, as the owner published it: the same address as the other surfaces (phone app,
 * guardian web UI, website, README). Set it to '' and the Settings row and its screen are hidden.
 */
export const DONATION_ADDRESS = 'bc1qktf58cunadszkd2hq8uttrtezcm7nj3mwurw2z';

/** The address to show, or null to hide the donation row and screen (no address published yet). */
export function donationAddress(address: string = DONATION_ADDRESS): string | null {
  const trimmed = address.trim();
  return trimmed ? trimmed : null;
}

/** What the QR code holds: a BIP 21 URI, as on the Receive screen. */
export function donationUri(address: string): string {
  return `bitcoin:${address}`;
}

/** What donations are and what they pay for, one paragraph each. */
export const DONATION_ABOUT = [
  "Trikey has no company behind it. It's an open source project under the MIT license, built in public.",
  'Donations pay for one thing: the Google Play and Apple developer accounts, so people can install Trikey from the stores like any other app.',
  'They go to one public bitcoin address, so anyone can see what comes in. Donations are public.',
] as const;

/** The warning above the address. */
export const DONATION_WARNING_TITLE = 'Please read before donating';
export const DONATION_WARNING =
  "You get nothing in return. There are no guarantees: you're trusting the founder to spend it on the project. Treat it as money you've lost, and only give what you'd be fine never seeing again.";
