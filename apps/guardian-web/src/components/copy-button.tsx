import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // navigator.clipboard needs a secure context; a LAN http:// page often isn't one.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/**
 * Copies `value`. `compact`: a small ghost button, for a value in a list (a payment's txid); `ariaLabel` then names
 * what it copies.
 */
export function CopyButton({ value, label = 'Copy', compact, ariaLabel }: { value: string; label?: string; compact?: boolean; ariaLabel?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onClick = async () => {
    const ok = await writeClipboard(value);
    setState(ok ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2000);
  };

  return (
    <>
      <Button
        variant={compact ? 'ghost' : 'outline'}
        size={compact ? 'sm' : 'default'}
        className={compact ? 'h-8 shrink-0 px-2 text-muted-foreground' : 'shrink-0'}
        onClick={onClick}
        aria-label={ariaLabel}
      >
        {state === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      </Button>
      <span className="sr-only" role="status">
        {state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? 'Could not copy. Select the text and copy it by hand.' : ''}
      </span>
    </>
  );
}
