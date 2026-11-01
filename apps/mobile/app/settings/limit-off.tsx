import { useRouter } from 'expo-router';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Bell, HardwareWallet, Smartphone, TriangleAlert, Vault } from '@/components/icons';
import { Body, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { canOfferLimitOff, formatSats, useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';

/**
 * "Turn off the daily limit?" (Settings > Daily limit > the link at the bottom). Says plainly what is given up, that the
 * hardware wallet will ask to approve, and that the limit comes back from the phone alone. Reached only for a guardian
 * that supports it (`canOfferLimitOff`); the wallet and the guardian refuse it otherwise anyway.
 */
export default function TurnLimitOff() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const { hardware, dailyLimit, contacts } = state;
  const brand = hardware.brand;
  const { busy, run, message, error } = useAction();
  const offered = canOfferLimitOff(state);

  const turnOff = async () => {
    const r = await run(wallet.turnLimitOff());
    if (r.ok) router.back();
  };

  return (
    <Screen
      title="Turn off the daily limit?"
      androidTitle="Daily limit"
      androidTitleBelow
      backLabel="Daily limit"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <AppButton
            title={busy ? `Waiting for your ${brand}…` : `Turn off with ${brand}`}
            variant="outline"
            danger
            busy={busy}
            disabled={!offered}
            onPress={turnOff}
          />
          <AppButton title="Keep the limit" disabled={busy} onPress={() => router.back()} />
        </>
      }>
      <Body>
        Your phone and your guardian together can then spend everything. A stolen phone plus a broken-into guardian could
        take it all.
      </Body>
      <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn" title="Someone in your phone could empty your wallet">
        Today they could send {formatSats(dailyLimit.limitSats)} sats a day. Without a limit, anyone who gets past{' '}
        {pick('Face ID or your passcode', 'your fingerprint or screen lock')} can send everything at once, before you notice.
        Nothing waits, and your {brand} can't stop it.
      </Notice>
      {state.savings.status === 'active' ? (
        <Notice icon={Vault} title="Savings is not affected">
          It always needs your {brand} or your Recovery Key. What is exposed is Spending: {formatSats(state.balanceSats)} sats can be sent without your {brand}.
        </Notice>
      ) : state.savings.status === 'available' ? (
        <Notice icon={Vault} title="Consider Savings first">
          Keep what you don't need this week in Savings, a second wallet your phone and guardian can't move. It's optional; you can turn off the limit either way.
        </Notice>
      ) : null}
      <Notice icon={HardwareWallet} title={`Your ${brand} will ask you to approve`}>
        Check that it says "limit=off" before you approve.
      </Notice>
      <Notice icon={Bell} title="You'll be told, and so will your contacts">
        {contacts.length
          ? `Your guardian tells this phone and your alert contacts (${contacts.length}) that the limit is off.`
          : 'Your guardian tells this phone that the limit is off.'}
      </Notice>
      <Notice icon={Smartphone} title="You can turn it back on any time">
        From this phone alone, without your {brand}.
      </Notice>
    </Screen>
  );
}
