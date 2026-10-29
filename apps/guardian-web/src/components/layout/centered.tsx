import { Outlet } from 'react-router-dom';
import { Logo } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';

/** Full-page card layout for first run and the locked screen. */
export function Centered({ width }: { width: 'narrow' | 'wide' }) {
  return (
    <div className="min-h-screen bg-ground text-foreground">
      <div className="flex justify-end px-4 pt-4 sm:px-6">
        <ThemeToggle />
      </div>
      <main
        id="main"
        className={`mx-auto flex w-full flex-col gap-6 px-4 pt-6 pb-12 sm:pt-12 ${width === 'narrow' ? 'max-w-[512px]' : 'max-w-[592px]'}`}
      >
        <Logo size={28} />
        <Outlet />
      </main>
    </div>
  );
}
