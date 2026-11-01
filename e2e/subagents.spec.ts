// Subagents end to end against the built image: create a subagent in the editor, see it in the
// list and on its page. No CSP violation.
import { expect, test, type Page } from '@playwright/test';

type Violation = { directive: string; blockedURI: string };

declare global {
  interface Window {
    subagentsCspViolations: Violation[];
  }
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run the e2e suite through scripts/e2e-image.sh`);
  }
  return value;
}

async function trackCsp(page: Page) {
  await page.addInitScript(() => {
    window.subagentsCspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.subagentsCspViolations.push({
        directive: e.effectiveDirective,
        blockedURI: e.blockedURI,
      }),
    );
  });
}

test('create a subagent in the editor and see it in the list', async ({ page }, info) => {
  test.setTimeout(180_000);
  const slug = `e2e-${info.project.name}-subagent`;
  await trackCsp(page);

  await page.goto('/login');
  await page.getByLabel('Username').fill(env('E2E_ADMIN_LOGIN'));
  await page.getByLabel('Password').fill(env('E2E_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/skills$/);

  await page.goto('/subagents/new');
  await page.getByLabel('Slug').fill(slug);
  await page.getByRole('combobox', { name: 'Folder' }).click();
  await page.getByRole('option').first().click();
  await page.getByLabel('Description').fill('Use for the e2e scenario');
  await page.getByLabel('Prompt').fill('You are the e2e subagent.');
  await page.getByRole('checkbox', { name: 'Inherit all tools' }).check();
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page).toHaveURL(new RegExp(`/subagents/${slug}`));
  await expect(page.getByRole('heading', { name: slug })).toBeVisible();

  await page.goto('/subagents');
  await expect(page.getByRole('link', { name: new RegExp(slug) })).toBeVisible({
    timeout: 30_000,
  });

  expect(await page.evaluate(() => window.subagentsCspViolations)).toEqual([]);
});
