import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative flex w-full items-start gap-3 rounded-xl border px-5 py-4 text-sm [&>svg]:mt-0.5 [&>svg]:size-5 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground [&>svg]:text-foreground',
        warning: 'border-warn/30 bg-warn-soft text-foreground [&>svg]:text-warn',
        destructive: 'border-bad/30 bg-bad-soft text-foreground [&>svg]:text-bad',
        success: 'border-good/30 bg-good-soft text-foreground [&>svg]:text-good',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

type AlertProps = React.ComponentProps<'div'> & VariantProps<typeof alertVariants>;

/** `role` defaults to "status"; pass role="alert" for errors that need to interrupt. */
function Alert({ className, variant, role = 'status', ...props }: AlertProps) {
  return <div data-slot="alert" role={role} className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-title" className={cn('text-[15px] leading-[22px] font-semibold', className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-description" className={cn('text-sm leading-5', className)} {...props} />;
}

export { Alert, AlertTitle, AlertDescription };
