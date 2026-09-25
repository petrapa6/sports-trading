import { describe, expect, it } from 'vitest';
import { createClassifier } from '../../src/server/requestClass.js';

const prod = createClassifier({ trustedProxies: ['172.30.32.0/23'], nodeEnv: 'production' });
const dev = createClassifier({ trustedProxies: ['172.30.32.0/23'], nodeEnv: 'development' });
const INGRESS = { 'x-ingress-path': '/api/hassio_ingress/abc' };

describe('request classification (SPEC.md §10 Request classes)', () => {
  it.each([
    ['172.30.32.2 + X-Ingress-Path', prod, '172.30.32.2', INGRESS, 'ingress', '172.30.32.2'],
    [
      '172.30.33.5 + CF-Connecting-IP',
      prod,
      '172.30.33.5',
      { 'cf-connecting-ip': '198.51.100.7' },
      'tunnel',
      '198.51.100.7',
    ],
    [
      '10.0.0.9 + CF-Connecting-IP (untrusted peer)',
      prod,
      '10.0.0.9',
      { 'cf-connecting-ip': '198.51.100.7' },
      'other',
      '10.0.0.9',
    ],
    [
      '172.30.32.2 + CF-Connecting-IP',
      prod,
      '172.30.32.2',
      { ...INGRESS, 'cf-connecting-ip': '198.51.100.7' },
      'tunnel',
      '198.51.100.7',
    ],
    ['loopback in development', dev, '127.0.0.1', {}, 'dev', '127.0.0.1'],
    ['IPv6 loopback in development', dev, '::1', {}, 'dev', '::1'],
    ['loopback in production', prod, '127.0.0.1', {}, 'other', '127.0.0.1'],
    ['IPv4-mapped ingress peer', prod, '::ffff:172.30.32.2', INGRESS, 'ingress', '172.30.32.2'],
    ['ingress peer without X-Ingress-Path', prod, '172.30.32.2', {}, 'other', '172.30.32.2'],
    ['X-Ingress-Path from another peer', prod, '172.30.33.5', INGRESS, 'other', '172.30.33.5'],
    [
      'malformed X-Ingress-Path',
      prod,
      '172.30.32.2',
      { 'x-ingress-path': '/x; Domain=evil' },
      'other',
      '172.30.32.2',
    ],
    [
      'invalid CF-Connecting-IP from a trusted peer',
      prod,
      '172.30.33.5',
      { 'cf-connecting-ip': 'nope' },
      'other',
      '172.30.33.5',
    ],
  ] as const)('%s', (_name, classify, peer, headers, cls, clientIp) => {
    const c = classify(peer, headers);
    expect(c.class).toBe(cls);
    expect(c.clientIp).toBe(clientIp);
  });

  it('ingress: client IP from the last X-Forwarded-For hop; secure only for https', () => {
    const c = prod('172.30.32.2', {
      ...INGRESS,
      'x-forwarded-for': '1.2.3.4, 192.168.1.20',
      'x-forwarded-proto': 'http',
    });
    expect(c).toMatchObject({
      class: 'ingress',
      clientIp: '192.168.1.20',
      secure: false,
      ingressPath: '/api/hassio_ingress/abc',
    });
    expect(prod('172.30.32.2', { ...INGRESS, 'x-forwarded-proto': 'https' }).secure).toBe(true);
  });

  it('the ingress peer is configurable (tests)', () => {
    const custom = createClassifier({ trustedProxies: ['10.1.0.0/16'], ingressPeer: '10.9.9.9' });
    expect(custom('10.9.9.9', INGRESS).class).toBe('ingress');
    expect(custom('172.30.32.2', INGRESS).class).toBe('other');
    expect(custom('10.1.2.3', { 'cf-connecting-ip': '203.0.113.1' })).toMatchObject({
      class: 'tunnel',
      clientIp: '203.0.113.1',
    });
  });
});
