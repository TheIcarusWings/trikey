import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Clock, LayoutGrid, List, LogOut, Menu, QrCode, Shield, Smartphone, UserPlus, X } from 'lucide-react';
import { api, usingMockApi } from '@/api';
import { useGuardian } from '@/components/guardian-provider';
import { Logo } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  Icon: typeof LayoutGrid;
  end?: boolean;
  tone?: 'warn';
}

function useNavItems(): NavItem[] {
  const { status } = useGuardian();
  const items: NavItem[] = [{ to: '/', label: 'Dashboard', Icon: LayoutGrid, end: true }];
  if (status?.recoveryInProgress) items.push({ to: '/recovery', label: 'Recovery', Icon: Clock, tone: 'warn' });
  items.push(
    { to: '/activity', label: 'Activity', Icon: List },
    { to: '/rules', label: 'Rules', Icon: Shield },
    { to: '/pair', label: 'Pair a phone', Icon: QrCode },
    { to: '/recover-phone', label: 'Recover on a new phone', Icon: Smartphone },
    { to: '/host', label: 'Host for someone', Icon: UserPlus },
  );
  return items;
}

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <nav aria-label="Guardian">
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {items.map(({ to, label, Icon, end, tone }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-sidebar-foreground no-underline outline-none transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-ring',
                  isActive ? (tone === 'warn' ? 'bg-warn-soft' : 'bg-accent') : 'hover:bg-accent/60',
                )
              }
            >
              <Icon className={cn('size-4 shrink-0', tone === 'warn' && 'text-warn')} aria-hidden="true" />
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
        <p className="m-0 px-2.5 text-xs leading-4 text-muted-foreground">Demo data. No guardian is connected.</p>
      )}
      <div className="flex items-center justify-between gap-2 px-1.5">
        <ThemeToggle />
        <button type="button" onClick={signOut} className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-accent/60">
          <LogOut className="size-3.5" aria-hidden="true" />
          Sign out
        </button>
      </div>
    </div>
  );
}

/** Sidebar on wide screens; a header with a collapsible menu on narrow ones. */
export function Shell() {
  const items = useNavItems();
  const [open, setOpen] = useState(false);
  const location = useLocation();

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
    <div className="min-h-screen bg-background md:flex">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>

      {/* Wide screens */}
      <aside className="sticky top-0 hidden h-screen w-[220px] shrink-0 flex-col justify-between gap-5 border-r bg-sidebar px-3 py-5 md:flex">
        <div className="flex flex-col gap-5">
          <div className="px-2.5">
            <Logo />
          </div>
          <NavList items={items} />
        </div>
        <SidebarFooter />
      </aside>

      {/* Narrow screens */}
      <header className="border-b bg-sidebar md:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <Logo />
          <button
            type="button"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex size-9 items-center justify-center rounded-md border bg-background outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            {open ? <X className="size-4" aria-hidden="true" /> : <Menu className="size-4" aria-hidden="true" />}
          </button>
        </div>
        <div id="mobile-nav" hidden={!open} className="flex flex-col gap-4 border-t px-3 py-3">
          <NavList items={items} onNavigate={() => setOpen(false)} />
          <SidebarFooter />
        </div>
      </header>

      <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 outline-none sm:p-8">
        <Outlet />
      </main>
    </div>
  );
}
