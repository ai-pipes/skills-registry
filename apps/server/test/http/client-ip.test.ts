import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import type { AppEnv } from '../../src/platform/http/env.ts';
import { clientIp } from '../../src/platform/http/security.ts';

const PEER = '192.0.2.1';

async function resolve(opts: { trustProxy: boolean; trustProxyHops: number }, xff?: string) {
  const app = new Hono<AppEnv>()
    .use(clientIp({ ...opts, remoteAddress: () => PEER }))
    .get('/', (c) => c.text(c.get('clientIp')));
  const res = await app.request(
    '/',
    xff === undefined ? {} : { headers: { 'x-forwarded-for': xff } },
  );
  return res.text();
}

describe('clientIp', () => {
  const XFF = '6.6.6.6, 10.0.0.5';

  it('takes the hop appended by the trusted proxy (hops=1 → right-most)', async () => {
    expect(await resolve({ trustProxy: true, trustProxyHops: 1 }, XFF)).toBe('10.0.0.5');
  });

  it('counts trustProxyHops from the right', async () => {
    expect(await resolve({ trustProxy: true, trustProxyHops: 2 }, XFF)).toBe('6.6.6.6');
  });

  it('falls back to the socket peer when the header has too few hops', async () => {
    expect(await resolve({ trustProxy: true, trustProxyHops: 3 }, XFF)).toBe(PEER);
    expect(await resolve({ trustProxy: true, trustProxyHops: 1 })).toBe(PEER);
  });

  it('falls back to the socket peer when the chosen hop is not an IP', async () => {
    expect(await resolve({ trustProxy: true, trustProxyHops: 1 }, '6.6.6.6, garbage')).toBe(PEER);
    expect(await resolve({ trustProxy: true, trustProxyHops: 1 }, '6.6.6.6, ')).toBe(PEER);
    expect(await resolve({ trustProxy: true, trustProxyHops: 1 }, '::1')).toBe('::1');
  });

  it('ignores the header entirely when trustProxy is false', async () => {
    expect(await resolve({ trustProxy: false, trustProxyHops: 1 }, XFF)).toBe(PEER);
    expect(await resolve({ trustProxy: false, trustProxyHops: 2 }, XFF)).toBe(PEER);
  });
});
