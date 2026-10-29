import { useCallback, useEffect, useRef, useState } from 'react';
import { checkKitProof } from '@/data/kit-proof';
import type { KitProof, RecoveryKit } from '@/data/types';

/**
 * Bridges a wallet call that stops in the middle to show a new Recovery Kit (`recoverWithKit` into a new vault,
 * `replaceKit`) and the screen that shows it. Pass `confirmNewKit` to the wallet; while it waits, `kit` is the kit to
 * show. `submit` checks the person's proof against that kit (a typo is fixed on the spot, not by starting over) and then
 * lets the wallet go on; `cancel` tells it the kit was not saved, so nothing moves.
 */
export function useNewKit() {
  const [kit, setKit] = useState<RecoveryKit | null>(null);
  const pending = useRef<{ kit: RecoveryKit; resolve: (proof: KitProof | false) => void } | null>(null);

  const confirmNewKit = useCallback(
    (shown: RecoveryKit) =>
      new Promise<KitProof | false>((resolve) => {
        pending.current = { kit: shown, resolve };
        setKit(shown);
      }),
    [],
  );

  const submit = useCallback(async (proof: KitProof) => {
    const p = pending.current;
    if (!p) return;
    checkKitProof(p.kit, proof); // throws in words; the screen shows it and the person tries again
    pending.current = null;
    setKit(null);
    p.resolve(proof);
  }, []);

  const cancel = useCallback(() => {
    const p = pending.current;
    pending.current = null;
    setKit(null);
    p?.resolve(false);
  }, []);

  // Leaving the screen with a kit on it counts as not saving it.
  useEffect(() => () => pending.current?.resolve(false), []);

  return { kit, confirmNewKit, submit, cancel };
}
