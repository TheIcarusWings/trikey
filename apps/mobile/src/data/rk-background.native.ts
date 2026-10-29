/**
 * The background refill scheduler on a phone: a periodic task (`expo-background-task`: WorkManager on Android,
 * BGTaskScheduler on iOS) that runs the same scheduler as the app does when it opens, so the next refill goes out
 * when it unlocks even if the app was not opened that week.
 *
 * - The task is defined at the top level of this module, which the app entry imports: the system may start the app's
 *   JavaScript just for it.
 * - It is registered while a finished Recovery Key wallet exists and removed when the wallet is removed.
 * - The system decides when it runs (at least 15 minutes apart, on iOS often once or twice a day while the phone
 *   charges). It is a convenience: opening the app always runs the scheduler too.
 * - On iOS the wallet's integrity key sits in the Keychain "when unlocked", so a run while the phone is locked cannot
 *   open the wallet and ends quietly. Android has no such limit.
 * - Needs no accounts: the plugin only adds `processing` to the iOS background modes and the task identifier to Info.plist.
 */
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { getPlatform } from '@/platform';

/** Also in ./rk-background-run.ts, which this entry-time module does not import (it pulls in the whole wallet). */
export const RK_BACKGROUND_TASK = 'trikey.rk.scheduler';

TaskManager.defineTask(RK_BACKGROUND_TASK, async () => {
  try {
    const { runRkSchedulerOnce } = await import('./rk-background-run');
    const platform = getPlatform();
    const run = await runRkSchedulerOnce({ kv: platform.kv, secureKeys: platform.secureKeys });
    return run.ran || run.reason !== 'failed' ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Registers the periodic task while a Recovery Key wallet exists, and drops it when none does. */
export async function syncBackgroundTask(hasWallet: boolean): Promise<void> {
  try {
    const registered = await TaskManager.isTaskRegisteredAsync(RK_BACKGROUND_TASK);
    if (hasWallet && !registered) await BackgroundTask.registerTaskAsync(RK_BACKGROUND_TASK, { minimumInterval: 60 });
    else if (!hasWallet && registered) await BackgroundTask.unregisterTaskAsync(RK_BACKGROUND_TASK);
  } catch {
    // Expo Go, an iOS simulator or a phone that restricts background work: the app still runs the scheduler when opened.
  }
}
