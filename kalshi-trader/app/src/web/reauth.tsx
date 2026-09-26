import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { api, ApiError } from './api';

type StepUp = <T>(action: () => Promise<T>) => Promise<T | undefined>;

const ReauthContext = createContext<StepUp>(async (action) => action());

/**
 * Step-up authentication (SPEC.md §10): runs an action; when the server answers
 * `403 reauth_required`, asks for the password, calls `POST /auth/reauth` and retries once.
 * Resolves to `undefined` when the prompt is cancelled.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const ask = () =>
    new Promise<boolean>((resolve) => {
      pending.current = resolve;
      setPassword('');
      setError(null);
      setOpen(true);
    });

  const close = (ok: boolean) => {
    setOpen(false);
    pending.current?.(ok);
    pending.current = null;
  };

  const stepUp = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await action();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 403 && err.code === 'reauth_required')) throw err;
    }
    if (!(await ask())) return undefined;
    return action();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('auth/reauth', { password });
      close(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'locked_out')
        setError('Too many failed attempts. Try again later.');
      else if (err instanceof ApiError && err.status === 401) setError('Wrong password.');
      else setError('Could not confirm the password. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ReauthContext.Provider value={stepUp}>
      {children}
      {open && (
        <div className="modal-backdrop">
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reauth-title"
            onSubmit={submit}
          >
            <h2 id="reauth-title">Confirm your password</h2>
            <p>Changes that can lead to real orders, and data imports, need your password again.</p>
            <label htmlFor="reauth-password">Password</label>
            <input
              id="reauth-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="actions">
              <button type="button" className="secondary" onClick={() => close(false)}>
                Cancel
              </button>
              <button type="submit" disabled={busy}>
                Confirm
              </button>
            </div>
          </form>
        </div>
      )}
    </ReauthContext.Provider>
  );
}

export const useStepUp = (): StepUp => useContext(ReauthContext);
