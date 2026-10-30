import { cn } from '@/lib/utils';

/** The Trikey mark: three keys on a triangle, the top one in the brand color. */
export function LogoMark({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={Math.round((size * 80) / 88)}
      viewBox="0 0 88 80"
      aria-hidden="true"
      className={cn('shrink-0', className)}
    >
      <path d="M44 14 L16 62 L72 62 Z" fill="none" stroke="var(--foreground)" strokeWidth="5" strokeLinejoin="round" />
      <circle cx="44" cy="14" r="12" fill="var(--brand)" />
      <circle cx="16" cy="62" r="12" fill="var(--foreground)" />
      <circle cx="72" cy="62" r="12" fill="var(--foreground)" />
    </svg>
  );
}

export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <LogoMark size={size} />
      <span className={size > 24 ? 'text-base font-semibold' : 'text-[15px] font-semibold'}>Trikey Guardian</span>
    </span>
  );
}
