import { useNetwork } from '@/components/guardian-provider';
import { cn } from '@/lib/utils';

const NAMES: Record<string, string> = {
  bitcoin: 'Mainnet',
  mainnet: 'Mainnet',
  main: 'Mainnet',
  testnet: 'Testnet',
  testnet3: 'Testnet',
  test: 'Testnet',
  testnet4: 'Testnet 4',
  signet: 'Signet',
  regtest: 'Regtest',
};

/** "Signet", "Mainnet"; an unknown name is shown as the guardian sent it. */
export function networkName(network: string): string {
  const key = network.toLowerCase();
  return NAMES[key] ?? network;
}

/**
 * "Signet · pre-alpha": which bitcoin network this guardian is on (from `/api/status`) and the
 * project's stage. Without a network (an older guardian) only the stage shows.
 */
export function NetworkPill({ className }: { className?: string }) {
  const network = useNetwork();
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-xl border px-2.5 text-xs leading-4 font-semibold whitespace-nowrap',
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-warn" />
      {network ? `${networkName(network)} · pre-alpha` : 'Pre-alpha'}
    </span>
  );
}
