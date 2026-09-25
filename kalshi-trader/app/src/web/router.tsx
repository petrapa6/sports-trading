import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import { appPath, href } from './base';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener('popstate', notify);

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Pushes (or replaces) a history entry for an app path, which may carry a query string. */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = href(to);
  if (url === window.location.pathname + window.location.search) return;
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  notify();
}

/** The current app path and query string; re-renders on navigation and back/forward. */
export function useLocation(): { path: string; search: string } {
  const key = useSyncExternalStore(subscribe, () => `${appPath()}${window.location.search}`);
  const i = key.indexOf('?');
  return i === -1 ? { path: key, search: '' } : { path: key.slice(0, i), search: key.slice(i) };
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string };

/** An in-app link: a real `href` (open in new tab works) with client-side navigation on click. */
export function Link({ to, onClick, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={href(to)} onClick={handle} {...rest} />;
}
