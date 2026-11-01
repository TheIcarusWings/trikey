/**
 * Hands the Recovery Kit's page to the operating system's print dialog (`expo-print`). On iOS and Android that dialog
 * also saves a PDF or sends it to Files, AirDrop or a printer app, which is the "share" the person needs.
 *
 * The page holds key 3 in the clear, so the app never writes it anywhere itself: `printAsync` takes the HTML in memory
 * and gives it to the system. (A "share as a file" route would have to write a PDF into the app's own storage, next to
 * the phone key, and that is exactly the pair of things the kit must never be kept beside.) The system's print queue,
 * a printer and wherever the person saves a PDF may keep a copy: the kit screen says so.
 *
 * The Savings wallet map (`printPage`) goes the same way: in memory, never a file of the app's own, so there is no print
 * cache to clear. It holds no secret, but it shows Savings' balance and history.
 */
import * as Print from 'expo-print';
import { IS_WEB } from '@/lib/platform';

async function printNative(html: string): Promise<void> {
  try {
    await Print.printAsync({ html });
  } catch (e) {
    // Closing the print dialog is not a failure (iOS rejects with a message about cancelling).
    const text = e instanceof Error ? e.message : String(e);
    if (/cancel|did not complete|dismiss/i.test(text)) return;
    throw e;
  }
}

export async function printKit(html: string): Promise<void> {
  await printNative(html);
}

/**
 * The browser's print dialog for `html` itself: `expo-print` on the web prints the app's own screen (`window.print()`),
 * so the page goes into a hidden frame and that frame prints. Removed once the dialog closes.
 */
async function printInBrowser(html: string): Promise<void> {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('tabindex', '-1');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  const loaded = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
  frame.srcdoc = html;
  document.body.appendChild(frame);
  await loaded;
  const win = frame.contentWindow;
  if (!win) {
    frame.remove();
    throw new Error('This browser could not open the print dialog.');
  }
  const remove = () => setTimeout(() => frame.remove(), 0);
  win.addEventListener('afterprint', remove, { once: true });
  // Browsers that never send "afterprint" (or block until the dialog closes): remove it later all the same.
  setTimeout(() => frame.isConnected && frame.remove(), 60_000);
  win.focus();
  win.print();
}

/** Prints a page that holds no secret (the Savings wallet map): the system's print dialog, or the browser's. */
export async function printPage(html: string): Promise<void> {
  if (IS_WEB && typeof document !== 'undefined') return printInBrowser(html);
  await printNative(html);
}
