// Adapted from react-native-reusables (MIT): flat 10px-radius field, Geist, 48px tall.
import { cn } from '@/lib/utils';
import { Platform, TextInput } from 'react-native';

function Input({
  className,
  ...props
}: React.ComponentProps<typeof TextInput> & React.RefAttributes<TextInput>) {
  return (
    <TextInput
      className={cn(
        'border-input bg-background text-foreground h-12 w-full min-w-0 flex-row items-center rounded-[10px] border px-3 py-1 font-sans text-base placeholder:text-muted-foreground',
        props.editable === false && 'opacity-50',
        Platform.select({
          web: cn(
            'outline-none transition-[color,box-shadow]',
            'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
            'aria-invalid:ring-destructive/20 aria-invalid:border-destructive disabled:cursor-not-allowed'
          ),
        }),
        className
      )}
      {...props}
    />
  );
}

export { Input };
