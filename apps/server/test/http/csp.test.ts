import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import { securityHeaders } from '../../src/platform/http/security.ts';

// ADR 0006: the strict Part 1 policy. No style-src-elem relaxation: the UI inserts no <style>
// (Base UI under CSPProvider disableStyleElements, toasts on Base UI Toast, CodeMirror in a
// shadow root).
const STRICT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "frame-ancestors 'none'";

describe('securityHeaders', () => {
  it('sends the strict CSP, without style-src-elem or hashes', async () => {
    const app = new Hono();
    app.use(securityHeaders());
    app.get('/', (c) => c.text('ok'));
    const csp = (await app.request('/')).headers.get('content-security-policy');
    expect(csp).toBe(STRICT_CSP);
    expect(csp).not.toContain('style-src-elem');
    expect(csp).not.toContain('sha256-');
  });
});
