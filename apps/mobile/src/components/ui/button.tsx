// Adapted from react-native-reusables (MIT). Differences from the stock component:
// 10px radius and no shadow (the designs are flat), 48/52px heights, an `xl` size,
// and no `sm:` breakpoint variants. Platform-specific type (iOS 17px semibold, Android
// 15px medium) is applied in components/app-button.tsx, not here.
import { TextClassContext } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';
import { Platform, Pressable } from 'react-native';

const buttonVariants = cva(
  cn(
    'group shrink-0 flex-row items-center justify-center gap-2 rounded-[10px]',
    Platform.select({
      web: "focus-visible:border-ring focus-visible:ring-ring/50 whitespace-nowrap outline-none transition-all focus-visible:ring-[3px] disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
    })
  ),
  {
    variants: {
      variant: {
        default: cn('bg-primary active:bg-primary/90', Platform.select({ web: 'hover:bg-primary/90' })),
        destructive: cn(
          'bg-destructive active:bg-destructive/90',
          Platform.select({ web: 'hover:bg-destructive/90' })
        ),
        outline: cn(
          'border-border border bg-transparent active:bg-accent',
          Platform.select({ web: 'hover:bg-accent' })
        ),
        secondary: cn('bg-secondary active:bg-secondary/80', Platform.select({ web: 'hover:bg-secondary/80' })),
        ghost: cn('active:bg-accent', Platform.select({ web: 'hover:bg-accent' })),
        link: '',
      },
      size: {
        default: 'h-12 px-4',
        xl: 'h-[52px] px-5',
        lg: 'h-12 px-6',
        sm: 'h-9 rounded-lg px-3.5',
        icon: 'h-12 w-12',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

const buttonTextVariants = cva('text-foreground text-sm font-medium', {
  variants: {
    variant: {
      default: 'text-primary-foreground',
      destructive: 'text-destructive-foreground',
      outline: 'text-foreground',
      secondary: 'text-secondary-foreground',
      ghost: 'text-primary',
      link: cn('text-primary', Platform.select({ web: 'underline-offset-4' })),
    },
    size: {
      default: '',
      xl: '',
      lg: '',
      sm: '',
      icon: '',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
});

type ButtonProps = React.ComponentProps<typeof Pressable> &
  React.RefAttributes<typeof Pressable> &
  VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
      <Pressable
        className={cn(props.disabled && 'opacity-50', buttonVariants({ variant, size }), className)}
        role="button"
        {...props}
      />
    </TextClassContext.Provider>
  );
}

export { Button, buttonTextVariants, buttonVariants };
export type { ButtonProps };
