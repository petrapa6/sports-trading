import { constants, createPrivateKey, sign, type KeyObject } from 'node:crypto';

/**
 * Kalshi request signing (SPEC.md §2 API essentials): `KALSHI-ACCESS-SIGNATURE` is the base64
 * RSA-PSS / SHA-256 signature (salt length = digest length) of `timestamp + METHOD + path`, where
 * `path` is the URL path **without** the query string (e.g. `/trade-api/v2/portfolio/balance`).
 */

/** The string that is signed: `1700000000000GET/trade-api/v2/portfolio/balance`. */
export function signedString(timestampMs: number | string, method: string, path: string): string {
  const q = path.indexOf('?');
  return `${String(timestampMs)}${method.toUpperCase()}${q === -1 ? path : path.slice(0, q)}`;
}

/** Parses a PEM private key once; v1 supports RSA keys only. */
export function loadSigningKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`Kalshi private key must be an RSA key (got ${key.asymmetricKeyType ?? 'unknown'})`);
  }
  return key;
}

export const PSS_OPTIONS = {
  padding: constants.RSA_PKCS1_PSS_PADDING,
  saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
} as const;

/** Base64 signature for one request. */
export function signRequest(key: KeyObject, timestampMs: number, method: string, path: string): string {
  return sign('sha256', Buffer.from(signedString(timestampMs, method, path)), {
    key,
    ...PSS_OPTIONS,
  }).toString('base64');
}

/** The three authentication headers for one request. */
export function authHeaders(
  keyId: string,
  key: KeyObject,
  timestampMs: number,
  method: string,
  path: string,
): Record<string, string> {
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': String(timestampMs),
    'KALSHI-ACCESS-SIGNATURE': signRequest(key, timestampMs, method, path),
  };
}
