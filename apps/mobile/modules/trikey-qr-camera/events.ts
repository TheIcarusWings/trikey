// The events of the QR camera view, read without trusting their shape. No native imports, so the tests load it.

export type CodeScannedEvent = { nativeEvent: { data?: unknown } };
export type MountErrorEvent = { nativeEvent: { message?: unknown } };

/** The text of a scanned code, or null for an event without one. */
export function codeFromEvent(event: CodeScannedEvent | null | undefined): string | null {
  const data = event?.nativeEvent?.data;
  return typeof data === 'string' && data.length > 0 ? data : null;
}

/** What to show when the camera could not start. */
export function mountErrorMessage(event: MountErrorEvent | null | undefined): string {
  const message = event?.nativeEvent?.message;
  return typeof message === 'string' && message.trim() ? message.trim() : 'The camera could not be started.';
}
