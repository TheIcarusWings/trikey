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

const TEST_NETWORKS = new Set(['testnet', 'testnet3', 'test', 'testnet4', 'signet', 'regtest']);

/** A network whose coins have no value: these get the strip across the page instead of the pill. */
export function isTestNetwork(network: string | undefined): network is string {
  return !!network && TEST_NETWORKS.has(network.toLowerCase());
}

/**
 * The strip across the top of every page on a test network, so test coins are never mistaken for
 * real ones: "Signet · pre-alpha · coins here have no value". Nothing on mainnet.
 */
export function NetworkStrip() {
  const network = useNetwork();
  if (!isTestNetwork(network)) return null;
  return (
    <div
      role="note"
      className="flex min-h-8 items-center justify-center gap-1.5 bg-warn-soft px-4 py-1.5 text-center text-xs leading-4 font-semibold text-foreground print:hidden"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warn" />
      {networkName(network)} · pre-alpha · coins here have no value
    </div>
  );
}

/**
 * "Mainnet · pre-alpha · not audited · open source": which bitcoin network this guardian is on (from `/api/status`) and the
 * project's stage, next to the page title. Without a network (an older guardian) only the stage
 * shows. On a test network the strip says it instead.
 */
export function NetworkPill({ className }: { className?: string }) {
  const network = useNetwork();
  if (isTestNetwork(network)) return null;
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-xl border px-2.5 text-xs leading-4 font-semibold whitespace-nowrap',
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-warn" />
      {network ? `${networkName(network)} · pre-alpha · not audited · open source` : 'Pre-alpha · not audited · open source'}
    </span>
  );
}
