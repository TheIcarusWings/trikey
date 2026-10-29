/**
 * The background refill scheduler, for platforms without background tasks (the web preview): nothing to register.
 * The phone's version is ./rk-background.native.ts.
 */
export const RK_BACKGROUND_TASK = 'trikey.rk.scheduler';

/** Registers the periodic task while a Recovery Key wallet exists, and drops it when none does. */
export async function syncBackgroundTask(_hasWallet: boolean): Promise<void> {}
