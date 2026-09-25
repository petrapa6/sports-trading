/**
 * Minimal server-rendered pages (login, first-run setup, signed-in placeholder) until the React
 * app arrives in T04. No inline scripts or styles: the CSP is `default-src 'self'`. Every link is
 * relative so the pages work under the Home Assistant ingress prefix.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

function layout(title: string, body: string, assetBase: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Kalshi Sports Trader</title>
<link rel="stylesheet" href="${escapeHtml(assetBase)}assets/auth.css">
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

const errorLine = (error?: string): string =>
  error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';

export function loginPage(opts: {
  error?: string;
  username?: string;
  totp?: boolean;
  noUser?: boolean;
}): string {
  const totp = opts.totp
    ? `<label for="totp">Authenticator code</label>
<input id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}">
<label for="recoveryCode">…or a recovery code</label>
<input id="recoveryCode" name="recoveryCode" autocomplete="off">`
    : '';
  const noUser = opts.noUser
    ? '<p class="hint">No user exists yet. Open the app from the Home Assistant sidebar to create one.</p>'
    : '';
  return layout(
    'Sign in',
    `<h1>Kalshi Sports Trader</h1>
<p>Sign in to continue.</p>
${noUser}
<form method="post" action="login">
<label for="username">Username</label>
<input id="username" name="username" autocomplete="username" required value="${escapeHtml(opts.username ?? '')}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
${totp}
<button type="submit">Sign in</button>
${errorLine(opts.error)}
</form>`,
    '',
  );
}

export function setupPage(opts: { error?: string; username?: string }): string {
  return layout(
    'Set up',
    `<h1>Create the app user</h1>
<p>First run: choose the username and password for this app. This page is only available from the Home Assistant sidebar and only until the user exists.</p>
<form method="post" action="setup">
<label for="username">Username</label>
<input id="username" name="username" autocomplete="username" required value="${escapeHtml(opts.username ?? '')}">
<label for="password">Password (at least 12 characters)</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
<button type="submit">Create user</button>
${errorLine(opts.error)}
</form>`,
    '',
  );
}

export function homePage(opts: { username: string; csrfToken: string }): string {
  return layout(
    'Home',
    `<h1>Kalshi Sports Trader</h1>
<p>Signed in as <strong>${escapeHtml(opts.username)}</strong>. The dashboard arrives in a later release.</p>
<form method="post" action="auth/logout">
<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">
<button type="submit">Sign out</button>
</form>`,
    '',
  );
}
