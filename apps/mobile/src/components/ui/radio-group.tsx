// Adapted from react-native-reusables (MIT): a 20px ring with an inner dot, and a
// `selected` flag so the ring itself can switch to the accent color as it does in the designs.
import { cn } from '@/lib/utils';
import * as RadioGroupPrimitive from '@rn-primitives/radio-group';
import { Platform } from 'react-native';

function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root className={cn('gap-3', className)} {...props} />;
}

function RadioGroupItem({
  className,
  selected,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item> & { selected?: boolean }) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        'aspect-square size-5 shrink-0 items-center justify-center rounded-full border',
        selected ? 'border-primary' : 'border-chevron',
        Platform.select({
          web: 'focus-visible:border-ring focus-visible:ring-ring/50 outline-none transition-all focus-visible:ring-[3px] disabled:cursor-not-allowed',
        }),
        props.disabled && 'opacity-50',
        className
      )}
      {...props}>
      <RadioGroupPrimitive.Indicator className="bg-primary size-2.5 rounded-full" />
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
