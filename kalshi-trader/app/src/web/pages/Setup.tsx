import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, ApiError, resetCsrf } from '../api';
import { navigate } from '../router';

export function SetupPage() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('setup', { username, password });
      resetCsrf();
      queryClient.clear();
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        navigate('/login', { replace: true });
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setError('Setup is only available from the Home Assistant sidebar.');
      } else if (err instanceof ApiError && Array.isArray(err.body['issues'])) {
        setError((err.body['issues'] as string[]).join('; '));
      } else {
        setError('Setup failed. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <h1>Create the app user</h1>
        <p>
          First run: choose the username and password for this app. This page is only available from the Home
          Assistant sidebar and only until the user exists.
        </p>
        <label htmlFor="username">Username</label>
        <input
          id="username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <label htmlFor="password">Password (at least 12 characters)</label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <label htmlFor="confirm">Repeat the password</label>
        <input
          id="confirm"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          Create user
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
