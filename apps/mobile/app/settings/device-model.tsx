import { QR_MODELS, isQrModel, qrMessageMethod, qrModelInfo } from '@trikey/wallet';
import { ActionNotice } from '@/components/action-notice';
import { RadioRow } from '@/components/choice';
import { Info } from '@/components/icons';
import { Body, Footnote, ListGroup, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { RadioGroup } from '@/components/ui/radio-group';
import { useWallet, useWalletService } from '@/data';
import { useAction } from '@/lib/use-action';

/**
 * Settings > Hardware wallet model: which QR device this wallet's hardware wallet is. It decides what Trikey asks of it
 * (@trikey/wallet qr-devices.ts): a wallet made before models existed reads as "Other", which signs no text, so
 * approvals, notes and hardware unlock wait until the owner picks the model here. Nothing is asked of the device.
 */
export default function DeviceModel() {
  const wallet = useWalletService();
  const { hardware } = useWallet();
  const { run, message, error } = useAction();
  const current = hardware.qrModel ?? 'other';
  const info = qrModelInfo(current);

  return (
    <Screen title="Hardware wallet model" backLabel="Settings">
      <Body>
        Which QR device is this wallet’s hardware wallet? Trikey asks each one for different things. Picking the model changes nothing on the device or
        in the wallet: it only tells Trikey what the device can sign.
      </Body>
      {!info.signsMessages ? (
        <Notice icon={Info} tone="warn-outline" title={`${info.name} can’t sign Trikey’s texts`}>
          {`It co-signs payments, but rule changes that need your hardware wallet, notes on the guardian and unlocking the guardian with it need a device that signs a short text. ${info.whyNot ?? ''}`}
        </Notice>
      ) : null}
      {qrMessageMethod(current) === 'microsd' ? (
        <Notice icon={Info} tone="outline" title={`${info.name} signs Trikey’s texts from a microSD card`}>
          {`Pairing, approvals, recovery access and notes work: Trikey gives you a file to copy to the card, the ${info.name} signs it, and you bring the signed file back. ${info.unlockWhyNot ?? ''}`.trim()}
        </Notice>
      ) : null}
      <RadioGroup
        value={current}
        onValueChange={(v) => {
          if (isQrModel(v) && v !== current && wallet.setHardwareModel) void run(wallet.setHardwareModel(v));
        }}
        aria-label="Hardware wallet model"
        className="gap-0">
        <ListGroup>
          {QR_MODELS.map((model) => {
            const m = qrModelInfo(model);
            return <RadioRow key={model} value={model} title={m.name} description={m.detail} selected={current === model} />;
          })}
        </ListGroup>
      </RadioGroup>
      <ActionNotice message={message} error={error} />
      <Footnote>
        Picked the wrong one? Nothing breaks: a device asked for something it can’t do says so, and Trikey checks every signature before it uses it.
      </Footnote>
    </Screen>
  );
}
