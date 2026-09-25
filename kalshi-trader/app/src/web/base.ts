/**
 * The browser-facing prefix of the app: `''` at the root, `/api/hassio_ingress/<token>` inside Home
 * Assistant. The server writes it into `<base href>`; relative URLs (`api/...`) resolve against it.
 */
export const BASE = new URL(document.baseURI).pathname.replace(/\/+$/, '');

/** The app path of the current location (`/settings/account`), without the prefix. */
export function appPath(pathname: string = window.location.pathname): string {
  if (BASE && pathname.startsWith(BASE)) return pathname.slice(BASE.length) || '/';
  return pathname || '/';
}

/** An absolute URL path for an app path (`/trades` → `/api/hassio_ingress/abc/trades`). */
export const href = (path: string): string => `${BASE}${path}`;

/** A URL for a server endpoint, relative to the base (`api/live`). */
export const endpoint = (path: string): string =>
  new URL(path.replace(/^\/+/, ''), document.baseURI).toString();
