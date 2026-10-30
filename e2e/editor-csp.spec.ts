// The skill editor under the served CSP (ADR 0006): CodeMirror is mounted in a shadow root, so
// its styles are constructable stylesheets, not <style> elements. No violations, the base theme
// applies (`.cm-editor` is `display: flex`), and typing works.
import { expect, test } from '@playwright/test';

type Violation = { directive: string; blockedURI: string; sourceFile: string };

declare global {
  interface Window {
    cspViolations: Violation[];
  }
}

const login = process.env['E2E_ADMIN_LOGIN'];
const password = process.env['E2E_ADMIN_PASSWORD'];

test('the skill editor works without CSP violations', async ({ page }) => {
  if (!login || !password) {
    throw new Error('E2E_ADMIN_LOGIN and E2E_ADMIN_PASSWORD must be set (scripts/e2e-image.sh)');
  }
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

  await page.goto(`/login?next=${encodeURIComponent('/skills/new')}`);
  await page.getByLabel('Username').fill(login);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/skills\/new$/);
  await expect(page.getByRole('heading', { level: 1, name: 'New skill' })).toBeVisible();

  // CSS locators pierce open shadow roots.
  const editor = page.locator('.cm-editor');
  await expect(editor).toBeVisible();
  expect(await editor.evaluate((el) => getComputedStyle(el).display)).toBe('flex');
  const adoptedSheets = await page
    .getByTestId('code-editor')
    .evaluate((host) => host.shadowRoot?.adoptedStyleSheets.length ?? -1);
  expect(adoptedSheets).toBeGreaterThan(0);
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('style')].some((s) => s.textContent?.includes('.cm-')),
    ),
  ).toBe(false);

  const content = page.locator('.cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Typed under the CSP');
  await expect(content).toContainText('Typed under the CSP');

  expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
  expect(cspMessages).toEqual([]);
});
