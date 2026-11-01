import { useState } from 'react';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Eye, FileText } from '@/components/icons';
import { Body, Footnote, InfoRow, Notice, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { groupWalletId, networkLabel, shorten, useWallet, useWalletService } from '@/data';
import { printPage } from '@/lib/print-kit';
import { useAction } from '@/lib/use-action';

/**
 * "Print the Savings wallet map" (open question 10): one page with the Savings descriptor (text and QR code), its three
 * keys' fingerprints, paths and xpubs, the first address and how to recover Savings without Trikey. It holds no secret;
 * the privacy warning comes before the print button, because the page shows Savings' balance and history to whoever
 * reads it. Offered at the end of "Set up Savings", on the Savings screen and in Wallet details.
 */
export default function SavingsMapScreen() {
  const wallet = useWalletService();
  const { savings, hardware } = useWallet();
  // Made once per visit: the page carries today's date.
  const [map] = useState(() => wallet.savings?.walletMap() ?? null);
  const print = useAction();
  const brand = savings.hardware?.brand ?? hardware.brand;

  if (!map) {
    return (
      <Screen title="Savings wallet map" backLabel="Back">
        <Notice tone="fill">This wallet has no Savings yet. Set up Savings first.</Notice>
      </Screen>
    );
  }

  return (
    <Screen
      title="Print the Savings wallet map"
      androidTitle="Savings wallet map"
      backLabel="Back"
      footer={
        <>
          <ActionNotice message={print.message} error={print.error} />
          <AppButton title="Print or save as PDF" icon={FileText} busy={print.busy} onPress={() => void print.run(printPage(map.html))} />
        </>
      }>
      <Body>
        One page that shows which keys spend Savings: the descriptor as text and as a QR code, the three keys and Savings' first address. With it and any two of the keys,
        you or your heirs can recover Savings in Sparrow or another multisig wallet, even without Trikey. Keep it with your Recovery Key or with your papers.
      </Body>
      <Notice icon={Eye} iconClass="text-warn" tone="warn-outline" title="Private, though it can't move money">
        Anyone who reads the map can see Savings' balance and every payment into and out of it. Nobody can spend with it alone: it has no seed words, private keys or
        recovery code on it.
      </Notice>
      <Panel>
        <InfoRow label="Savings wallet" value={groupWalletId(map.walletId)} mono />
        <InfoRow label="Network" value={networkLabel(map.network)} />
        <InfoRow label="Made" value={map.date} />
        <InfoRow label="First address" value={shorten(map.firstAddress, 10, 6)} mono />
      </Panel>
      <Footnote>
        Any two keys move Savings: this phone and your {brand}, or your Recovery Key with either. This phone's key comes back from its backup. The print sheet also
        saves a PDF: it can't move money, but keep it as private as the paper.
      </Footnote>
    </Screen>
  );
}
