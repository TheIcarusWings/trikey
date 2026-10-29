import type { ReactNode } from 'react';

export function PageHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-2xl leading-8 font-semibold tracking-[-0.01em]">{title}</h1>
      {description && <p className="max-w-[60ch] text-sm leading-5 text-muted-foreground">{description}</p>}
    </div>
  );
}
