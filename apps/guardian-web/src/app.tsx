import { BrowserRouter, Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import type { GuardianStatus } from '@/api';
import { GuardianProvider, useGuardian } from '@/components/guardian-provider';
import { Centered } from '@/components/layout/centered';
import { Shell } from '@/components/layout/shell';
import { ThemeProvider } from '@/components/theme-provider';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { usePageTitle } from '@/hooks/use-api';
import { ActivityPage } from '@/pages/activity';
import { DashboardPage } from '@/pages/dashboard';
import { FirstRunPage } from '@/pages/first-run';
import { HostPage } from '@/pages/host';
import { LockedPage } from '@/pages/locked';
import { PairPage } from '@/pages/pair';
import { RecoveryPage } from '@/pages/recovery';
import { RecoverPhonePage } from '@/pages/recover-phone';
import { ResetPage } from '@/pages/reset';
import { RulesPage } from '@/pages/rules';

type Phase = 'setup' | 'locked' | 'ready';

const PHASE_PATH: Record<Phase, string> = { setup: '/setup', locked: '/locked', ready: '/' };

function phaseOf(status: GuardianStatus): Phase {
  if (!status.setupComplete) return 'setup';
  return status.state === 'locked' ? 'locked' : 'ready';
}

/** Sends people to the screen that matches the guardian's state: setup, locked or the app. */
function Gate({ phase, children }: { phase: Phase; children: React.ReactNode }) {
  const { status, error, loading, refresh, landingFor } = useGuardian();

  if (loading) {
    return (
      <div role="status" className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Connecting to the guardian…
      </div>
    );
  }
  if (!status) {
    return (
      <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-4">
        <ErrorState error={error!} onRetry={refresh} title="Can't reach the guardian" />
      </div>
    );
  }
  const actual = phaseOf(status);
  if (actual !== phase) return <Navigate to={landingFor(status) ?? PHASE_PATH[actual]} replace />;
  return <>{children}</>;
}

function GatedOutlet({ phase }: { phase: Phase }) {
  return (
    <Gate phase={phase}>
      <Outlet />
    </Gate>
  );
}

function NotFound() {
  usePageTitle('Not found');
  return (
    <div className="flex max-w-xl flex-col items-start gap-3">
      <h1 className="text-2xl leading-8 font-semibold tracking-[-0.01em]">Page not found</h1>
      <p className="m-0 text-sm text-muted-foreground">There is nothing at this address.</p>
      <Button asChild variant="outline">
        <Link to="/">Back to the dashboard</Link>
      </Button>
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <GuardianProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<GatedOutlet phase="setup" />}>
              <Route element={<Centered width="wide" />}>
                <Route path="/setup" element={<FirstRunPage />} />
              </Route>
            </Route>
            <Route element={<GatedOutlet phase="locked" />}>
              <Route element={<Centered width="narrow" />}>
                <Route path="/locked" element={<LockedPage />} />
              </Route>
            </Route>
            <Route element={<GatedOutlet phase="ready" />}>
              <Route element={<Shell />}>
                <Route index element={<DashboardPage />} />
                <Route path="/activity" element={<ActivityPage />} />
                <Route path="/rules" element={<RulesPage />} />
                <Route path="/recovery" element={<RecoveryPage />} />
                <Route path="/pair" element={<PairPage />} />
                <Route path="/recover-phone" element={<RecoverPhonePage />} />
                <Route path="/reset" element={<ResetPage />} />
                <Route path="/host" element={<HostPage />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Route>
          </Routes>
        </BrowserRouter>
      </GuardianProvider>
    </ThemeProvider>
  );
}
