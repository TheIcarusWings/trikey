import { RadioRow } from '@/components/choice';
import { Body, ListGroup } from '@/components/panels';
import { Screen } from '@/components/screen';
import { RadioGroup } from '@/components/ui/radio-group';
import { useWallet, useWalletService, type AmountUnit } from '@/data';

const OPTIONS: { value: AmountUnit; label: string }[] = [
  { value: 'sats', label: 'Sats' },
  { value: 'btc', label: 'BTC' },
];

export default function Units() {
  const wallet = useWalletService();
  const { unit } = useWallet();
  return (
    <Screen title="Show amounts in" backLabel="Settings">
      <Body>Sets the unit for your balance and your activity. The amount you type when sending can switch either way.</Body>
      <RadioGroup value={unit} onValueChange={(v) => wallet.setUnit(v as AmountUnit)} aria-label="Show amounts in" className="gap-0">
        <ListGroup>
          {OPTIONS.map((option) => (
            <RadioRow
              key={option.value}
              value={option.value}
              title={option.label}
              selected={unit === option.value}
            />
          ))}
        </ListGroup>
      </RadioGroup>
    </Screen>
  );
}
