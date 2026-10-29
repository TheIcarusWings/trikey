import * as React from 'react';
import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none transition-colors',
        'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-ground',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'aria-invalid:border-bad aria-invalid:focus-visible:ring-bad',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
