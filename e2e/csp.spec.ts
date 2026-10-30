// The served UI under the served, strict CSP (ADR 0006): no violations in a real browser, and
// no <style> element at all (a dependency that starts inserting one fails here). Toasts are
// covered by ui.spec.ts, which shows several and also requires zero violations.
import { expect, test } from '@playwright/test';

type Violation = { directive: string; blockedURI: string; sourceFile: string };

declare global {
  interface Window {
    cspViolations: Violation[];
  }
}

test('the UI loads without CSP violations', async ({ page }) => {
  const cspMessages: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) cspMessages.push(m.text());
  });
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.cspViolations.push({
        directive: e.effectiveDirective,
        blockedURI: e.blockedURI,
        sourceFile: e.sourceFile,
      }),
    );
  });

  const res = await page.goto('/');
  expect(res?.headers()['content-security-policy']).toBe(
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "frame-ancestors 'none'",
  );
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(await page.evaluate(() => document.querySelectorAll('style').length)).toBe(0);
  expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
  expect(cspMessages).toEqual([]);
});
