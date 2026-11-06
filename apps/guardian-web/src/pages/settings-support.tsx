import { CopyButton } from '@/components/copy-button';
import { QrCode } from '@/components/qr-code';
import { DONATION_ABOUT, DONATION_WARNING, DONATION_WARNING_TITLE, donationAddress } from '@/lib/donation';
import { groupAddress, receiveUri } from '@/lib/wallet';

const hint = 'm-0 max-w-[60ch] text-[13px] leading-[18px] text-muted-foreground';

/** Support the project: what donations pay for, the warning, and the one public donation address. Nothing while no address is published. */
export function SupportSection() {
  const address = donationAddress();
  if (!address) return null;
  return (
    <section aria-labelledby="support-heading" className="flex flex-col gap-3">
      <h2 id="support-heading" className="m-0 text-base leading-[22px] font-semibold">
        Support the project
      </h2>
      {DONATION_ABOUT.map((line) => (
        <p key={line} className={hint}>
          {line}
        </p>
      ))}
      <p className="m-0 max-w-[60ch] rounded-lg bg-warn-soft px-3 py-2 text-[13px] leading-[18px]">
        <strong className="font-semibold">{DONATION_WARNING_TITLE}</strong> {DONATION_WARNING}
      </p>
      <div className="flex flex-col items-start gap-3">
        <div className="rounded-[10px] bg-white p-3">
          <QrCode value={receiveUri(address)} size={158} label="Donation address QR code" />
        </div>
        <p data-testid="donation-address" className="m-0 max-w-[30ch] font-mono text-[15px] leading-6 break-all select-all">
          {groupAddress(address)}
        </p>
        <CopyButton value={address} label="Copy address" />
      </div>
    </section>
  );
}
