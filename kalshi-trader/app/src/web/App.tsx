import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, resetCsrf, setUnauthorizedHandler, type Me } from './api';
import { appPath } from './base';
import { LiveIndicator, LiveProvider } from './live';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { BacktestPage, NotFoundPage } from './pages/Placeholders';
import { SettingsPage } from './pages/Settings';
import { SetupPage } from './pages/Setup';
import { StrategiesPage } from './pages/Strategies';
import { TradesPage } from './pages/Trades';
import { ReauthProvider } from './reauth';
import { Link, navigate, useLocation } from './router';

const NAV = [
  { to: '/', label: 'Dashboard' },
  { to: '/strategies', label: 'Strategies' },
  { to: '/trades', label: 'Trades' },
  { to: '/backtest', label: 'Backtest' },
  { to: '/settings', label: 'Settings' },
] as const;

const PUBLIC_PATHS = new Set(['/login', '/setup']);

function Page({ path }: { path: string }) {
  if (path === '/') return <DashboardPage />;
  if (path === '/strategies') return <StrategiesPage />;
  if (path === '/trades') return <TradesPage />;
  if (path === '/backtest') return <BacktestPage />;
  if (path === '/settings' || path.startsWith('/settings/')) return <SettingsPage />;
  return <NotFoundPage />;
}

function Shell({ path }: { path: string }) {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('auth/me'), retry: false });

  const logout = async () => {
    try {
      await api.post('auth/logout');
    } finally {
      resetCsrf();
      queryClient.clear();
      navigate('/login', { replace: true });
    }
  };

  if (!me.data) return <main className="loading muted">Loading…</main>;

  const active = (to: string) => (to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`));
  return (
    <LiveProvider>
      <ReauthProvider>
        <header className="app-header">
          <div className="brand">Kalshi Sports Trader</div>
          <nav className="main-nav" aria-label="Main">
            {NAV.map((n) => (
              <Link key={n.to} to={n.to} aria-current={active(n.to) ? 'page' : undefined}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="header-right">
            <LiveIndicator />
            <span className="user muted">{me.data.username}</span>
            <button type="button" className="secondary small" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>
        <main className="content">
          <Page path={path} />
        </main>
      </ReauthProvider>
    </LiveProvider>
  );
}

export function App() {
  const { path } = useLocation();
  const queryClient = useQueryClient();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (PUBLIC_PATHS.has(appPath())) return;
      resetCsrf();
      queryClient.clear();
      navigate('/login', { replace: true });
    });
  }, [queryClient]);

  if (path === '/login') return <LoginPage />;
  if (path === '/setup') return <SetupPage />;
  return <Shell path={path} />;
}
