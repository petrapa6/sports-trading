import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, resetCsrf } from '../api';
import { navigate } from '../router';

interface AuthState {
  needsSetup: boolean;
  setupAllowed: boolean;
}

function loginError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'locked_out') {
      const s = Number(err.body['retryAfterSeconds'] ?? 0);
      const mins = Math.max(1, Math.ceil(s / 60));
      return `Too many failed attempts. Sign-in is locked for about ${mins} minute${mins === 1 ? '' : 's'}.`;
    }
    if (err.code === 'rate_limited') return 'Too many sign-in attempts. Wait a minute and try again.';
    if (err.code === 'totp_required') return 'Enter the code from your authenticator app.';
    if (err.status === 401 || err.status === 400) return 'Wrong username or password.';
  }
  return 'Sign-in failed. Try again.';
}

export function LoginPage() {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: ['auth-state'], queryFn: () => api.get<AuthState>('auth/state') });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.data?.needsSetup && state.data.setupAllowed) navigate('/setup', { replace: true });
  }, [state.data]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('login', {
        username,
        password,
        ...(needTotp && totp ? { totp } : {}),
        ...(needTotp && recoveryCode ? { recoveryCode } : {}),
      });
      resetCsrf();
      queryClient.clear();
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totp_required') setNeedTotp(true);
      setLocked(err instanceof ApiError && err.code === 'locked_out');
      setError(loginError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <h1>Kalshi Sports Trader</h1>
        <p>Sign in to continue.</p>
        {state.data?.needsSetup && !state.data.setupAllowed && (
          <p className="hint">
            No user exists yet. Open the app from the Home Assistant sidebar to create one.
          </p>
        )}
        <label htmlFor="username">Username</label>
        <input
          id="username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {needTotp && (
          <>
            <label htmlFor="totp">Authenticator code</label>
            <input
              id="totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
            />
            <label htmlFor="recoveryCode">…or a recovery code</label>
            <input
              id="recoveryCode"
              autoComplete="off"
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value)}
            />
          </>
        )}
        <button type="submit" disabled={busy}>
          Sign in
        </button>
        {error && (
          <p className={locked ? 'error lockout' : 'error'} role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
