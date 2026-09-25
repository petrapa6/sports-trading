import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import QRCode from 'qrcode';
import { useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, type Me, type SessionRow } from '../../api';
import { useStepUp } from '../../reauth';

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== repeat) return setError('The new passwords do not match.');
    if (next.length < 12) return setError('The new password must be at least 12 characters.');
    setBusy(true);
    try {
      // Step-up with the current password, then the change itself (which needs a recent step-up).
      try {
        await api.post('auth/reauth', { password: current });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'locked_out') throw err;
        if (err instanceof ApiError && err.status === 401) return setError('The current password is wrong.');
        throw err;
      }
      await api.post('auth/password', { newPassword: next });
      setDone(true);
      setCurrent('');
      setNext('');
      setRepeat('');
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'locked_out'
          ? 'Too many failed attempts. Try again later.'
          : 'The password could not be changed.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit} aria-labelledby="password-heading">
      <h3 id="password-heading">Change password</h3>
      <label htmlFor="current-password">Current password</label>
      <input
        id="current-password"
        type="password"
        autoComplete="current-password"
        required
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <label htmlFor="new-password">New password (at least 12 characters)</label>
      <input
        id="new-password"
        type="password"
        autoComplete="new-password"
        required
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <label htmlFor="repeat-password">Repeat the new password</label>
      <input
        id="repeat-password"
        type="password"
        autoComplete="new-password"
        required
        value={repeat}
        onChange={(e) => setRepeat(e.target.value)}
      />
      <button type="submit" disabled={busy}>
        Change password
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="success" role="status">
          Password changed. Your other sessions were signed out.
        </p>
      )}
    </form>
  );
}

function TwoFactor() {
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('auth/me') });
  const [enrolment, setEnrolment] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    setRecoveryCodes(null);
    try {
      const res = await stepUp(() => api.post<{ otpauthUri: string; secret: string }>('auth/totp/enrol'));
      if (!res) return;
      const qr = await QRCode.toDataURL(res.otpauthUri, { margin: 1, width: 200 });
      setEnrolment({ secret: res.secret, qr });
    } catch {
      setError('Could not start the enrolment.');
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.post<{ recoveryCodes: string[] }>('auth/totp/confirm', { code: code.trim() });
      setRecoveryCodes(res.recoveryCodes);
      setEnrolment(null);
      setCode('');
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'invalid_code'
          ? 'That code is not valid.'
          : 'Could not enable two-factor.',
      );
    }
  };

  const disable = async () => {
    setError(null);
    setRecoveryCodes(null);
    try {
      await stepUp(() => api.post('auth/totp/disable'));
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    } catch {
      setError('Could not disable two-factor.');
    }
  };

  if (!me.data) return null;
  return (
    <section className="card" aria-labelledby="totp-heading">
      <h3 id="totp-heading">Two-factor authentication (TOTP)</h3>
      <p>
        Status: <strong data-testid="totp-status">{me.data.totpEnabled ? 'enabled' : 'off'}</strong>
        {me.data.totpEnabled && (
          <span className="muted"> · {me.data.recoveryCodesRemaining} recovery codes left</span>
        )}
      </p>
      {!me.data.totpEnabled && !enrolment && (
        <button type="button" onClick={() => void start()}>
          Set up two-factor
        </button>
      )}
      {enrolment && (
        <form className="form" onSubmit={confirm}>
          <p>Scan the QR code with your authenticator app, or enter the secret by hand.</p>
          <img className="qr" src={enrolment.qr} alt="TOTP QR code" width={200} height={200} />
          <p>
            Secret: <code data-testid="totp-secret">{enrolment.secret}</code>
          </p>
          <label htmlFor="totp-code">Code from the app</label>
          <input
            id="totp-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="submit">Enable two-factor</button>
        </form>
      )}
      {recoveryCodes && (
        <div className="recovery-codes">
          <p>
            <strong>Recovery codes</strong> — shown once. Each works once if you lose your authenticator.
          </p>
          <ul data-testid="recovery-codes">
            {recoveryCodes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {me.data.totpEnabled && (
        <button type="button" className="secondary" onClick={() => void disable()}>
          Disable two-factor
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

const col = createColumnHelper<SessionRow>();
const when = (iso: string) => new Date(iso).toLocaleString();

function Sessions() {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.get<{ sessions: SessionRow[] }>('auth/sessions').then((r) => r.sessions),
  });

  const columns = useMemo(
    () => [
      col.accessor('channel', { header: 'Channel' }),
      col.accessor('ua', {
        header: 'Browser',
        cell: (c) => <span className="ua">{c.getValue() ?? '—'}</span>,
      }),
      col.accessor('ip', { header: 'IP', cell: (c) => c.getValue() ?? '—' }),
      col.accessor('createdAt', { header: 'Signed in', cell: (c) => when(c.getValue()) }),
      col.accessor('lastSeenAt', { header: 'Last seen', cell: (c) => when(c.getValue()) }),
      col.display({
        id: 'action',
        header: '',
        cell: ({ row }) =>
          row.original.current ? (
            <span className="muted">This session</span>
          ) : (
            <button
              type="button"
              className="secondary small"
              onClick={async () => {
                await api.post(`auth/sessions/${encodeURIComponent(row.original.id)}/revoke`);
                await queryClient.invalidateQueries({ queryKey: ['sessions'] });
              }}
            >
              Revoke
            </button>
          ),
      }),
    ],
    [queryClient],
  );

  const table = useReactTable({ data: sessions.data ?? [], columns, getCoreRowModel: getCoreRowModel() });

  return (
    <section className="card" aria-labelledby="sessions-heading">
      <h3 id="sessions-heading">Active sessions</h3>
      <div className="table-wrap">
        <table>
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id}>{flexRender(h.column.columnDef.header, h.getContext())}</th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((r) => (
              <tr key={r.id} data-current={r.original.current ? 'true' : undefined}>
                {r.getVisibleCells().map((c) => (
                  <td key={c.id}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function AccountSettings() {
  return (
    <section className="settings-section" aria-labelledby="account-heading">
      <h2 id="account-heading">Account</h2>
      <ChangePassword />
      <TwoFactor />
      <Sessions />
    </section>
  );
}
