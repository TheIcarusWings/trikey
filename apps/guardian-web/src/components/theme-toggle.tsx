import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type ThemePreference } from '@/components/theme-provider';
import { cn } from '@/lib/utils';

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light theme', Icon: Sun },
  { value: 'system', label: 'Match system theme', Icon: Monitor },
  { value: 'dark', label: 'Dark theme', Icon: Moon },
];

/** Three-way switch (light, system, dark). Arrow keys move between options. */
export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme();

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const index = OPTIONS.findIndex((o) => o.value === preference);
    let next = index;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % OPTIONS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + OPTIONS.length) % OPTIONS.length;
    else return;
    e.preventDefault();
    setPreference(OPTIONS[next]!.value);
    const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('button');
    buttons[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onKeyDown}
      className={cn('inline-flex items-center gap-0.5 rounded-lg border bg-background p-0.5', className)}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            tabIndex={selected ? 0 : -1}
            onClick={() => setPreference(value)}
            className={cn(
              'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none',
              'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
              selected && 'bg-accent text-foreground',
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
