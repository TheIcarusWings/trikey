import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Clock, House, List, Lock, LockOpen, LogOut, Menu, Settings, SlidersHorizontal, Smartphone, UserPlus, Wallet, X } from 'lucide-react';
import { api, usingMockApi } from '@/api';
import { useGuardian, useNetwork } from '@/components/guardian-provider';
import { Logo } from '@/components/logo';
import { NetworkStrip, isTestNetwork } from '@/components/network-pill';
import { ThemeToggle } from '@/components/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { useApi } from '@/hooks/use-api';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  Icon: typeof House;
  end?: boolean;
  tone?: 'warn';
}

/** Whether this guardian hosts wallets for others (`GET /api/hosting`); hidden when it does not, or cannot say (locked). */
function useHostingAvailable(locked: boolean): boolean {
  const hosting = useApi(() => (locked ? Promise.resolve(undefined) : api.getHosting()), [locked], 300_000);
  return !locked && !!hosting.data?.available;
}

function useNavItems(): NavItem[] {
  const { status } = useGuardian();
  const locked = status?.state === 'locked';
  const hosting = useHostingAvailable(locked);
  // Locked: only the read-only Wallet page works, and the way to unlock.
  if (locked)
    return [
      { to: '/wallet', label: 'Wallet', Icon: Wallet },
      { to: '/locked', label: 'Unlock', Icon: LockOpen },
    ];
  const items: NavItem[] = [];
  // While a recovery runs it comes first: it is the one thing that needs a look.
  if (status?.recoveryInProgress) items.push({ to: '/recovery', label: 'Recovery', Icon: Clock, tone: 'warn' });
  items.push(
    { to: '/', label: 'Home', Icon: House, end: true },
    { to: '/wallet', label: 'Wallet', Icon: Wallet },
    { to: '/activity', label: 'Activity', Icon: List },
    { to: '/rules', label: 'Rules', Icon: SlidersHorizontal },
    { to: '/phones', label: 'Phones', Icon: Smartphone },
  );
  if (hosting) items.push({ to: '/host', label: 'Host for someone', Icon: UserPlus });
  items.push({ to: '/settings', label: 'Settings', Icon: Settings });
  return items;
}

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <nav aria-label="Main">
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {items.map(({ to, label, Icon, end, tone }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex h-10 items-center gap-2.5 rounded-lg px-3 text-sm no-underline outline-none transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-ring',
                  isActive
                    ? cn('font-semibold text-foreground', tone === 'warn' ? 'bg-warn-soft' : 'bg-accent')
                    : 'font-medium text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )
              }
            >
              <Icon className={cn('size-[18px] shrink-0', tone === 'warn' && 'text-warn')} aria-hidden="true" />
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SidebarFooter() {
  const { setStatus } = useGuardian();
  const signOut = async () => {
    try {
      setStatus(await api.signOut());
    } catch {
      /* the next status poll tells */
    }
  };
  return (
    <div className="flex flex-col gap-2">
      {usingMockApi && (
        <p className="m-0 px-3 text-xs leading-4 text-muted-foreground">Demo data. No guardian is connected.</p>
      )}
      <div className="px-2.5">
        <ThemeToggle />
      </div>
      <button
        type="button"
        onClick={signOut}
        className="flex h-10 items-center gap-2.5 rounded-lg px-3 text-sm text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <LogOut className="size-[18px]" aria-hidden="true" />
        Sign out
      </button>
    </div>
  );
}

/** "Locked" next to the logo while the guardian is locked (only the read-only pages are open then). */
function LockedBadge() {
  const { status } = useGuardian();
  if (status?.state !== 'locked') return null;
  return (
    <Badge variant="warning" className="gap-1">
      <Lock className="size-3" strokeWidth={2.4} aria-hidden="true" />
      Locked
    </Badge>
  );
}

/** Sidebar on wide screens; a header with a collapsible menu on narrow ones. */
export function Shell() {
  const items = useNavItems();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  // On a test network the strip sits above everything, so the sticky sidebar is that much shorter.
  const strip = isTestNetwork(useNetwork());

  useEffect(() => setOpen(false), [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="min-h-screen bg-background print:bg-white">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>

      <div className="sticky top-0 z-30">
        <NetworkStrip />
      </div>
      <div className="md:flex">
        {/* Wide screens */}
        <aside
          className={cn(
            'sticky hidden w-[220px] shrink-0 flex-col justify-between gap-5 border-r px-3.5 py-5 md:flex print:hidden',
            strip ? 'top-8 h-[calc(100vh-2rem)]' : 'top-0 h-screen',
          )}
        >
          <div className="flex flex-col gap-[18px]">
            <div className="flex flex-wrap items-center gap-2 px-2">
              <Logo size={28} />
              <LockedBadge />
            </div>
            <NavList items={items} />
          </div>
          <SidebarFooter />
        </aside>

        {/* Narrow screens */}
        <header className="md:hidden print:hidden">
          <div className="flex h-14 items-center justify-between pr-2 pl-5">
            <span className="flex min-w-0 items-center gap-2">
              <Logo size={28} />
              <LockedBadge />
            </span>
            <button
              type="button"
              aria-expanded={open}
              aria-controls="mobile-nav"
              aria-label="Menu"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex size-11 items-center justify-center rounded-lg outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
            >
              {open ? <X className="size-[22px]" aria-hidden="true" /> : <Menu className="size-[22px]" aria-hidden="true" />}
            </button>
          </div>
          <div id="mobile-nav" hidden={!open} className="flex flex-col gap-4 border-y px-3.5 py-3">
            <NavList items={items} onNavigate={() => setOpen(false)} />
            <SidebarFooter />
          </div>
        </header>

        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-5 pt-2 pb-10 outline-none md:px-12 md:py-8 print:p-0">
          <div className="mx-auto flex w-full max-w-[884px] flex-col gap-4 md:gap-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
