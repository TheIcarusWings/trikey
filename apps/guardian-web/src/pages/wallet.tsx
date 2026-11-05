import { Link } from 'react-router-dom';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Clock, Lock, ShieldCheck, TriangleAlert, Vault } from 'lucide-react';
import { api, type WalletOverview, type WalletPayment } from '@/api';
import { CopyButton } from '@/components/copy-button';
import { useGuardian } from '@/components/guardian-provider';
import { PageHeader } from '@/components/page-header';
import { QrCode } from '@/components/qr-code';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useApi, usePageTitle } from '@/hooks/use-api';
import { WalletPicker, useSelectedWallet } from '@/components/wallet-picker';
import { LIMIT_OFF_TEXT, SAVINGS_NOTE, formatShortWhen, formatWhen, savingsBalanceText, shortenMiddle } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  LOCKED_WALLET_TEXT,
  NO_WALLET_TEXT,
  RECEIVE_CHECK_TEXT,
  RECEIVE_RULE_TEXT,
  VIEW_ONLY_TEXT,
  balanceLines,
  confirmationsText,
  groupAddress,
  limitLines,
  paymentAmountText,
  paymentFeeText,
  paymentTitle,
  receiveUri,
  splitPayments,
  testNetworkWarning,
} from '@/lib/wallet';

/** The guardian's live wallet changes within seconds of the chain; the page looks again this often. */
const POLL_MS = 15_000;

const card = 'flex min-w-0 flex-col gap-3 rounded-[14px] border border-border px-5 py-4 sm:px-6 sm:py-5';

function BalanceCard({ wallet }: { wallet: WalletOverview }) {
  if (!wallet.balance) return null;
  const { total, waiting } = balanceLines(wallet.balance);
  return (
    <section aria-labelledby="balance-heading" className={card}>
      <h2 id="balance-heading" className="m-0 text-sm leading-5 font-medium text-muted-foreground">
        Balance
      </h2>
      <p className="m-0 text-[28px] leading-[34px] font-semibold tracking-[-0.02em] tabular-nums sm:text-[32px] sm:leading-[38px]">{total}</p>
      {waiting ? (
        <p className="m-0 flex items-center gap-1.5 text-sm leading-5 text-muted-foreground tabular-nums">
          <Clock className="size-4 shrink-0" aria-hidden="true" />
          {waiting}
        </p>
      ) : null}
      {wallet.readAt ? <p className="m-0 text-xs leading-4 text-muted-foreground">As of {formatShortWhen(wallet.readAt)}{wallet.tipHeight ? ` · block ${wallet.tipHeight.toLocaleString('en-US')}` : ''}</p> : null}
    </section>
  );
}

function LimitCard({ limit }: { limit: NonNullable<WalletOverview['dailyLimit']> }) {
  const { used, left, pct } = limitLines(limit);
  return (
    <section aria-labelledby="limit-heading" className={card}>
      <h2 id="limit-heading" className="m-0 text-sm leading-5 font-medium text-muted-foreground">
        Daily limit
      </h2>
      {pct === null ? (
        <>
          <p className="m-0 text-base leading-6 font-semibold">No daily limit</p>
          <p className="m-0 text-sm leading-5 text-muted-foreground tabular-nums">{used}</p>
          <p className="m-0 flex items-start gap-2 rounded-[10px] bg-warn-soft px-3 py-2.5 text-sm leading-5">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={2} aria-hidden="true" />
            <span>{LIMIT_OFF_TEXT}</span>
          </p>
        </>
      ) : (
        <>
          <p className="m-0 text-base leading-6 font-semibold tabular-nums">{left}</p>
          <div
            role="progressbar"
            aria-label="Share of the daily limit used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="h-1.5 overflow-hidden rounded-[3px] bg-border"
          >
            <div className={cn('h-1.5', pct >= 100 ? 'bg-warn' : 'bg-good')} style={{ width: `${pct}%` }} />
          </div>
          <p className="m-0 text-sm leading-5 text-muted-foreground tabular-nums">{used}. Over it, payments need the hardware wallet.</p>
        </>
      )}
    </section>
  );
}

function ReceiveCard({ receive, network }: { receive: NonNullable<WalletOverview['receive']>; network?: string }) {
  const warning = testNetworkWarning(network);
  return (
    <section aria-labelledby="receive-heading" className={cn(card, 'gap-4')}>
      <div className="flex flex-col gap-1">
        <h2 id="receive-heading" className="m-0 text-base leading-[22px] font-semibold">
          Receive
        </h2>
        <p className="m-0 text-sm leading-5 text-muted-foreground">{RECEIVE_RULE_TEXT}</p>
      </div>
      <div className="flex flex-col items-center gap-3">
        <div className="rounded-[10px] bg-white p-3">
          <QrCode value={receiveUri(receive.address)} size={184} label="Receive address QR code" />
        </div>
        <p data-testid="receive-address" className="m-0 max-w-[30ch] text-center font-mono text-[15px] leading-6 break-all select-all">
          {groupAddress(receive.address)}
        </p>
        {warning ? (
          <p className="m-0 flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] leading-[18px] font-medium">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warn" />
            {warning}
          </p>
        ) : null}
        <CopyButton value={receive.address} label="Copy address" />
      </div>
      <p className="m-0 flex items-start gap-2 text-sm leading-5 text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{RECEIVE_CHECK_TEXT}</span>
      </p>
    </section>
  );
}

function SavingsCard({ savings }: { savings: NonNullable<WalletOverview['savings']> }) {
  return (
    <section aria-labelledby="wallet-savings-heading" className={cn(card, 'gap-2.5')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Vault className="size-5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
        <h2 id="wallet-savings-heading" className="m-0 text-base leading-[22px] font-semibold">
          Savings (watched)
        </h2>
        <span className="ml-auto text-sm tabular-nums">{savingsBalanceText(savings)}</span>
      </div>
      <p className="m-0 text-sm leading-5 text-muted-foreground">{SAVINGS_NOTE}</p>
    </section>
  );
}

const DIRECTION_ICON = { in: ArrowDownLeft, out: ArrowUpRight, self: ArrowLeftRight } as const;

function PaymentRow({ p }: { p: WalletPayment }) {
  const Icon = DIRECTION_ICON[p.direction];
  const pending = p.confirmations === 0;
  const amount = paymentAmountText(p);
  const fee = paymentFeeText(p);
  const meta = [pending ? 'Waiting for a confirmation' : p.at ? formatWhen(p.at) : null, pending ? null : confirmationsText(p.confirmations), fee].filter(Boolean);
  return (
    <li className="flex min-h-16 items-start gap-3 border-t py-3 first:border-t-0">
      <span
        className={cn(
          'mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full',
          pending ? 'bg-warn-soft text-warn' : p.direction === 'in' ? 'bg-good-soft text-good' : 'bg-accent text-muted-foreground',
        )}
        aria-hidden="true"
      >
        <Icon className="size-4" strokeWidth={2} />
      </span>
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="flex items-center gap-2 text-[15px] leading-5 font-medium">
            {paymentTitle(p)}
            {pending ? <Badge variant="warning">Pending</Badge> : null}
          </span>
          {amount ? <span className={cn('text-[15px] leading-5 font-semibold tabular-nums', p.direction === 'in' && 'text-good')}>{amount}</span> : null}
        </span>
        <span className="text-[13px] leading-[18px] text-muted-foreground">{meta.join(' · ')}</span>
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate font-mono text-xs leading-4 text-muted-foreground" title={p.txid}>
            {shortenMiddle(p.txid, 10, 8)}
          </span>
          <CopyButton value={p.txid} label="Copy txid" compact ariaLabel={`Copy transaction id ${shortenMiddle(p.txid, 10, 8)}`} />
        </span>
      </span>
    </li>
  );
}

function Payments({ wallet }: { wallet: WalletOverview }) {
  if (!wallet.payments) return null;
  const { pending, done } = splitPayments(wallet.payments);
  return (
    <section aria-labelledby="payments-heading" className="flex flex-col gap-2">
      <h2 id="payments-heading" className="m-0 text-base leading-[22px] font-semibold">
        Payments
      </h2>
      {wallet.payments.length === 0 ? (
        <p className="m-0 py-2 text-sm text-muted-foreground">No payments yet. Payments in and out of this wallet show here, from any device.</p>
      ) : (
        <>
          {pending.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="m-0 text-[13px] leading-4 font-semibold tracking-[0.06em] text-muted-foreground uppercase">Pending</h3>
              <ul aria-label="Pending payments" className="m-0 list-none p-0">
                {pending.map((p) => (
                  <PaymentRow key={p.txid} p={p} />
                ))}
              </ul>
            </div>
          )}
          {done.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="m-0 text-[13px] leading-4 font-semibold tracking-[0.06em] text-muted-foreground uppercase">Confirmed</h3>
              <ul aria-label="Confirmed payments" className="m-0 list-none p-0">
                {done.map((p) => (
                  <PaymentRow key={p.txid} p={p} />
                ))}
              </ul>
            </div>
          )}
          <p className="m-0 text-sm leading-5 text-muted-foreground">
            {wallet.paymentsTruncated ? 'The latest payments; the Trikey app has them all. ' : ''}
            What this guardian co-signed or refused is under{' '}
            <Link to="/activity" className="font-medium text-foreground underline underline-offset-3">
              Activity
            </Link>
            .
          </p>
        </>
      )}
    </section>
  );
}

export function WalletPage() {
  usePageTitle('Wallet');
  const { status } = useGuardian();
  // Own wallets: the one the picker chose (the first without a choice).
  const { walletId } = useSelectedWallet();
  const wallet = useApi(() => api.getWallet(walletId), [status?.state, walletId], POLL_MS);
  const locked = (wallet.data?.state ?? status?.state) === 'locked';

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col gap-3">
        <PageHeader title="Wallet" description={VIEW_ONLY_TEXT} />
        <WalletPicker />
        {locked ? (
          <div role="note" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] bg-warn-soft px-4 py-3 text-sm leading-5">
            <Lock className="size-4 shrink-0 text-warn" strokeWidth={2} aria-hidden="true" />
            <span className="min-w-0 flex-1">{LOCKED_WALLET_TEXT}</span>
            <Button asChild size="sm" variant="outline">
              <Link to="/locked">Unlock</Link>
            </Button>
          </div>
        ) : null}
      </div>

      {wallet.loading && !wallet.data ? (
        <PageSkeleton rows={3} />
      ) : !wallet.data ? (
        <ErrorState error={wallet.error!} onRetry={wallet.reload} title="Couldn't load the wallet" />
      ) : !wallet.data.paired ? (
        <section className={cn(card, 'items-start')}>
          <p className="m-0 text-sm leading-5">{NO_WALLET_TEXT}</p>
          {!locked && (
            <Button asChild>
              <Link to="/phones">Pair a phone</Link>
            </Button>
          )}
        </section>
      ) : (
        <WalletBody wallet={wallet.data} />
      )}
    </div>
  );
}

function WalletBody({ wallet }: { wallet: WalletOverview }) {
  return (
    <>
      {wallet.chainError ? (
        <p role="status" className="m-0 flex items-start gap-2 rounded-[10px] bg-warn-soft px-4 py-3 text-sm leading-5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={2} aria-hidden="true" />
          <span>{wallet.chainError}</span>
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-6">
        <div className="flex min-w-0 flex-col gap-4 md:gap-6">
          <BalanceCard wallet={wallet} />
          {wallet.dailyLimit ? <LimitCard limit={wallet.dailyLimit} /> : null}
          {wallet.savings ? <SavingsCard savings={wallet.savings} /> : null}
        </div>
        {wallet.receive ? <ReceiveCard receive={wallet.receive} network={wallet.network} /> : null}
      </div>
      <Payments wallet={wallet} />
    </>
  );
}
