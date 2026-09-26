import { Link, useLocation } from '../router';
import { AccountSettings } from './settings/Account';
import { DiagnosticsSettings } from './settings/Diagnostics';
import { LeaguesSettings } from './settings/Leagues';
import { TradingSettings } from './settings/Trading';

const SECTIONS = [
  { path: '/settings/trading', label: 'Trading' },
  { path: '/settings/leagues', label: 'Leagues' },
  { path: '/settings/account', label: 'Account' },
  { path: '/settings/diagnostics', label: 'Diagnostics' },
] as const;

export function SettingsPage() {
  const { path } = useLocation();
  const current = path === '/settings' ? '/settings/trading' : path;
  return (
    <>
      <h1>Settings</h1>
      <nav className="subnav" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <Link key={s.path} to={s.path} aria-current={current === s.path ? 'page' : undefined}>
            {s.label}
          </Link>
        ))}
      </nav>
      {current === '/settings/trading' && <TradingSettings />}
      {current === '/settings/leagues' && <LeaguesSettings />}
      {current === '/settings/account' && <AccountSettings />}
      {current === '/settings/diagnostics' && <DiagnosticsSettings />}
    </>
  );
}
