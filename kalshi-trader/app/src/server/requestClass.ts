import { BlockList, isIP } from 'node:net';

/**
 * Request classes (SPEC.md §10 Request classes). Every request is classified once, by the socket
 * peer and headers, before any route runs.
 */
export const REQUEST_CLASSES = ['ingress', 'tunnel', 'dev', 'other'] as const;
export type RequestClass = (typeof REQUEST_CLASSES)[number];

/** The Home Assistant Supervisor ingress proxy. */
export const DEFAULT_INGRESS_PEER = '172.30.32.2';

/** Accepted `X-Ingress-Path` values; anything else is ignored (it ends up in a cookie `Path`). */
const INGRESS_PATH_RE = /^\/api\/hassio_ingress\/[A-Za-z0-9_-]{1,128}$/;

export interface Classification {
  class: RequestClass;
  /** The client IP used for rate limiting, lockout and the audit log. */
  clientIp: string;
  /** The socket peer (normalised). */
  peer: string;
  /** `X-Ingress-Path` for class `ingress`, e.g. `/api/hassio_ingress/abc`. */
  ingressPath?: string;
  /** Whether the browser-facing scheme is HTTPS (ingress: `X-Forwarded-Proto`; tunnel/other: always). */
  secure: boolean;
}

export interface ClassifierOptions {
  /** `TRUSTED_PROXIES`: IPs or CIDR ranges the `cloudflared` app may connect from. */
  trustedProxies: readonly string[];
  /** Peer address of the ingress proxy; configurable for tests. */
  ingressPeer?: string | undefined;
  /** `NODE_ENV`; class `dev` exists only for `development`. */
  nodeEnv?: string | undefined;
}

type Headers = Record<string, string | string[] | undefined>;

/** Strips the IPv4-mapped IPv6 prefix so `::ffff:172.30.32.2` compares as `172.30.32.2`. */
export function normaliseIp(address: string | undefined): string {
  if (!address) return '';
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4) return lower.slice(7);
  return lower;
}

function header(headers: Headers, name: string): string | undefined {
  const v = headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined ? undefined : s.trim();
}

function isLoopback(ip: string): boolean {
  return ip === '::1' || (isIP(ip) === 4 && ip.startsWith('127.'));
}

/** Builds a request classifier for a fixed configuration. */
export function createClassifier(options: ClassifierOptions) {
  const ingressPeer = normaliseIp(options.ingressPeer ?? DEFAULT_INGRESS_PEER);
  const trusted = new BlockList();
  for (const entry of options.trustedProxies) {
    const [ip = '', prefix] = entry.split('/');
    const type = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) trusted.addAddress(normaliseIp(ip), type);
    else trusted.addSubnet(normaliseIp(ip), Number.parseInt(prefix, 10), type);
  }
  const development = options.nodeEnv === 'development';

  const isTrusted = (ip: string): boolean => {
    const family = isIP(ip);
    if (family === 0) return false;
    return trusted.check(ip, family === 6 ? 'ipv6' : 'ipv4');
  };

  return function classify(peerAddress: string | undefined, headers: Headers): Classification {
    const peer = normaliseIp(peerAddress);
    const cfRaw = header(headers, 'cf-connecting-ip');
    const cf = cfRaw !== undefined && isIP(normaliseIp(cfRaw)) !== 0 ? normaliseIp(cfRaw) : undefined;
    const ingressPath = header(headers, 'x-ingress-path');

    if (peer === ingressPeer && cfRaw === undefined && ingressPath !== undefined) {
      if (INGRESS_PATH_RE.test(ingressPath)) {
        // The Supervisor appends the browser's address to X-Forwarded-For; the last entry is the one it saw.
        const xff = header(headers, 'x-forwarded-for')
          ?.split(',')
          .map((s) => normaliseIp(s.trim()));
        const last = xff?.[xff.length - 1];
        const proto = header(headers, 'x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
        return {
          class: 'ingress',
          clientIp: last !== undefined && isIP(last) !== 0 ? last : peer,
          peer,
          ingressPath,
          secure: proto === 'https',
        };
      }
    }
    if (cf !== undefined && isTrusted(peer)) {
      return { class: 'tunnel', clientIp: cf, peer, secure: true };
    }
    if (development && isLoopback(peer)) {
      return { class: 'dev', clientIp: peer, peer, secure: false };
    }
    return { class: 'other', clientIp: peer, peer, secure: true };
  };
}

export type Classifier = ReturnType<typeof createClassifier>;
