import type { ReactNode } from 'react';
import { NetworkPill } from '@/components/network-pill';

/** Every page's h1, in the app and on the sign-in, setup and locked screens: 26px on a phone, 28px from `sm` up. */
export const PAGE_TITLE_CLASS = 'm-0 text-[26px] leading-8 font-semibold tracking-[-0.02em] sm:text-[28px] sm:leading-[34px]';

/** Page title. `pill` adds the network pill ("Mainnet · pre-alpha · not audited · open source") next to it, on Home and Recovery; test networks get the strip instead. */
export function PageHeader({ title, pill, description }: { title: string; pill?: boolean; description?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className={PAGE_TITLE_CLASS}>{title}</h1>
        {pill && <NetworkPill />}
      </div>
      {description && <p className="m-0 max-w-[60ch] text-sm leading-5 text-muted-foreground">{description}</p>}
    </div>
  );
}
