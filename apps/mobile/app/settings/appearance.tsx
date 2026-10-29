import { RadioRow } from '@/components/choice';
import { Body, ListGroup } from '@/components/panels';
import { Screen } from '@/components/screen';
import { RadioGroup } from '@/components/ui/radio-group';
import { useWallet, useWalletService, type ThemePreference } from '@/data';
import { pick } from '@/lib/platform';

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: pick('System', 'System default') },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function Appearance() {
  const wallet = useWalletService();
  const { theme } = useWallet();
  return (
    <Screen title="Appearance" backLabel="Settings">
      <Body>Trikey follows your phone's light or dark setting unless you pick one here.</Body>
      <RadioGroup value={theme} onValueChange={(v) => wallet.setTheme(v as ThemePreference)} aria-label="Appearance" className="gap-0">
        <ListGroup>
          {OPTIONS.map((option) => (
            <RadioRow
              key={option.value}
              value={option.value}
              title={option.label}
              selected={theme === option.value}
            />
          ))}
        </ListGroup>
      </RadioGroup>
    </Screen>
  );
}
