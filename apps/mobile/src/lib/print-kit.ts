/**
 * Hands the Recovery Kit's page to the operating system's print dialog (`expo-print`). On iOS and Android that dialog
 * also saves a PDF or sends it to Files, AirDrop or a printer app, which is the "share" the person needs.
 *
 * The page holds key 3 in the clear, so the app never writes it anywhere itself: `printAsync` takes the HTML in memory
 * and gives it to the system. (A "share as a file" route would have to write a PDF into the app's own storage, next to
 * the phone key, and that is exactly the pair of things the kit must never be kept beside.) The system's print queue,
 * a printer and wherever the person saves a PDF may keep a copy: the kit screen says so.
 */
import * as Print from 'expo-print';

export async function printKit(html: string): Promise<void> {
  try {
    await Print.printAsync({ html });
  } catch (e) {
    // Closing the print dialog is not a failure (iOS rejects with a message about cancelling).
    const text = e instanceof Error ? e.message : String(e);
    if (/cancel|did not complete|dismiss/i.test(text)) return;
    throw e;
  }
}
