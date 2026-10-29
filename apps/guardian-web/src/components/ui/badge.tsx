import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs leading-5',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground font-semibold',
        outline: 'border border-border text-foreground font-medium',
        secondary: 'bg-secondary text-secondary-foreground font-medium',
        success: 'bg-good-soft text-good font-semibold',
        warning: 'bg-warn-soft text-warn font-semibold',
        destructive: 'bg-bad-soft text-bad font-semibold',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
);

function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
