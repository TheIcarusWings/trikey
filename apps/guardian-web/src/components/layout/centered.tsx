import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { LogoMark } from '@/components/logo';
import { NetworkPill } from '@/components/network-pill';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';

/**
 * Full-page layout for the screens before the app: set up, sign in and locked. A card on the tinted
 * ground on wide screens, the bare page on a phone.
 */
export function Centered({ width }: { width: 'narrow' | 'wide' }) {
  return (
    <div className="min-h-screen bg-background text-foreground sm:bg-ground">
      <div className="flex justify-end px-4 pt-4 sm:px-6">
        <ThemeToggle />
      </div>
      <main
        id="main"
        className={cn(
          'mx-auto flex w-full flex-col px-5 pt-4 pb-12 sm:pt-[10vh]',
          width === 'narrow' ? 'max-w-[464px]' : 'max-w-[528px]',
        )}
      >
        <Outlet />
      </main>
    </div>
  );
}

/** The card (wide screens) around one of those screens' content. */
export function AuthCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-5 sm:rounded-2xl sm:border sm:bg-card sm:p-8 sm:shadow-sm', className)}>{children}</div>
  );
}

/** Logo, title and network pill, centered. The title is the page's h1. */
export function AuthHeader({ title }: { title: string }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <LogoMark size={76} />
      <h1 className="m-0 text-2xl leading-8 font-semibold tracking-[-0.02em]">{title}</h1>
      <NetworkPill />
    </div>
  );
}
