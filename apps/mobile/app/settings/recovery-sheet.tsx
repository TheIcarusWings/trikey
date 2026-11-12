import { useMemo, useState } from 'react';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { FileText } from '@/components/icons';
import { Body, Footnote, InfoRow, Notice, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Segmented } from '@/components/segmented';
import { groupWalletId, shorten, useWallet, useWalletService, type RecoverySheetLayout } from '@/data';
import { printPage } from '@/lib/print-kit';
import { useAction } from '@/lib/use-action';

/**
 * "Print a recovery sheet" (docs/design/multi-wallet.md, per-wallet recovery sheets): for each wallet of this phone its
 * name, hardware wallet, guardian npub and relays, wallet id and "Recover on a new phone" code, so a new phone finds the
 * guardian when this phone and its backup are both gone. With several wallets: one sheet per wallet (each kept with its
 * hardware wallet) or one sheet listing them all. No secret on it. Printed as the Recovery Kit and the Savings map are:
 * the page goes to the print dialog in memory, never to a file of the app's own.
 */
export default function RecoverySheetScreen() {
  const wallet = useWalletService();
  const state = useWallet();
  const several = (state.wallets?.list.length ?? 1) > 1;
  const [layout, setLayout] = useState<RecoverySheetLayout>('each');
  // Made per visit and per choice: the page carries today's date.
  const sheet = useMemo(() => wallet.recoverySheet?.(layout) ?? null, [wallet, layout]);
  const print = useAction();

  if (!sheet) {
    return (
      <Screen title="Recovery sheet" backLabel="Back">
        <Notice tone="fill">Set up a wallet with your guardian first: the sheet says where that guardian is.</Notice>
      </Screen>
    );
  }

  return (
    <Screen
      title="Print a recovery sheet"
      androidTitle="Recovery sheet"
      backLabel="Back"
      footer={
        <>
          <ActionNotice message={print.message} error={print.error} />
          <AppButton
            title={several && layout === 'each' ? `Print ${sheet.wallets.length} sheets` : 'Print or save as PDF'}
            icon={FileText}
            busy={print.busy}
            onPress={() => void print.run(printPage(sheet.html))}
          />
        </>
      }>
      <Body>
        {several
          ? 'If this phone and its backup are both lost, a new phone finds each wallet with its sheet and that wallet\'s hardware wallet. Each sheet names the wallet, its hardware wallet, your guardian and the code a new phone scans.'
          : 'If this phone and its backup are both lost, a new phone finds your wallet with this sheet and your hardware wallet: it names the wallet, your guardian and the code a new phone scans.'}
      </Body>
      {several ? (
        <Segmented<RecoverySheetLayout>
          accessibilityLabel="How to print"
          value={layout}
          onChange={setLayout}
          options={[
            { value: 'each', label: 'One per wallet' },
            { value: 'list', label: 'All on one sheet' },
          ]}
        />
      ) : null}
      {several ? (
        <Footnote>
          {layout === 'each'
            ? 'One page per wallet: keep each with that wallet\'s hardware wallet, so whoever holds the device holds its sheet.'
            : 'Every wallet on one page: one sheet to keep with your papers.'}
        </Footnote>
      ) : null}
      {sheet.wallets.map((w) => (
        <Panel key={w.walletId}>
          <InfoRow label="Wallet" value={w.name} />
          <InfoRow label="Hardware wallet" value={w.device} />
          <InfoRow label="Wallet id" value={groupWalletId(w.walletId)} mono />
          <InfoRow label="Guardian" value={shorten(w.guardianNpub, 10, 6)} mono />
        </Panel>
      ))}
      <Notice tone="fill" title="It can't move money">
        No seed words, keys or backup recovery code on it. A recovery with it needs the wallet's hardware wallet, waits your security waiting period and tells your alert contacts. Keep it
        private all the same: it says you hold bitcoin with Trikey.
      </Notice>
      <Footnote>Made {sheet.date}. Print a new one after you add or remove a wallet, or replace your guardian.</Footnote>
    </Screen>
  );
}
