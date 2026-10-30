// Folders end to end against the built image: create a folder, create a skill in it through the
// editor, filter the list by folder, archive the folder (its skill goes with it). No CSP violation.
import { expect, test, type Page } from '@playwright/test';

type Violation = { directive: string; blockedURI: string };

declare global {
  interface Window {
    foldersCspViolations: Violation[];
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
    window.foldersCspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.foldersCspViolations.push({
        directive: e.effectiveDirective,
        blockedURI: e.blockedURI,
      }),
    );
  });
}

test('create a folder and a skill in it, filter by folder, archive the folder', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const browser = info.project.name;
  const folder = `e2e-${browser}-folder`;
  const folderName = `E2E ${browser} folder`;
  const skill = `e2e-${browser}-in-folder`;
  await trackCsp(page);

  await page.goto('/login');
  await page.getByLabel('Username').fill(env('E2E_ADMIN_LOGIN'));
  await page.getByLabel('Password').fill(env('E2E_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/skills$/);

  await test.step('create a folder', async () => {
    await page.goto('/folders/new');
    await page.getByLabel('Slug').fill(folder);
    await page.getByLabel('Name').fill(folderName);
    await page.getByLabel('Description').fill('Folder for the e2e scenario');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page).toHaveURL(/\/folders$/);
    await expect(page.getByRole('link', { name: folderName })).toBeVisible();
  });

  await test.step('create a skill with the folder preselected', async () => {
    await page.goto('/skills');
    await page.getByRole('combobox', { name: 'Folder' }).click();
    await page.getByRole('option', { name: folderName }).click();
    await expect(page).toHaveURL(new RegExp(`folder=${folder}`));
    await page.getByRole('link', { name: 'New skill' }).first().click();
    await expect(page).toHaveURL(/\/skills\/new/);
    await expect(page.getByRole('combobox', { name: 'Folder' })).toContainText(folderName);
    await page.getByLabel('Slug').fill(skill);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/skills/${skill}`));
  });

  await test.step('the folder filter shows the skill, another folder does not', async () => {
    await page.goto(`/skills?${new URLSearchParams({ folder })}`);
    await expect(page.getByRole('link', { name: new RegExp(skill) })).toBeVisible({
      timeout: 30_000,
    });
    await page.goto(`/skills?${new URLSearchParams({ folder: 'general' })}`);
    await expect(page.getByRole('combobox', { name: 'Folder' })).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(skill) })).toHaveCount(0);
  });

  await test.step('archive the folder with its skill', async () => {
    await page.goto('/folders');
    const row = page.getByRole('row').filter({ hasText: folder });
    await row.getByRole('button', { name: 'Archive' }).click();
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect(dialog).toContainText('1 active skill will be archived');
    await dialog.getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByText(`Folder “${folderName}” archived`)).toBeVisible();
    await page.goto(`/skills?${new URLSearchParams({ folder, status: 'archived' })}`);
    const card = page.getByRole('link', { name: new RegExp(skill) });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Archived');
  });

  expect(await page.evaluate(() => window.foldersCspViolations)).toEqual([]);
});
