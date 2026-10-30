// The UI end to end against the built image (scripts/e2e-image.sh): sign in, seed the fixture
// skills through `POST /api/skills` (the request the editor sends), search, open a skill and its
// Cyrillic-named file, create a token, the users page, sign out; then edit SKILL.md, history,
// diff and rollback. No CSP violation on the way.
//
// Every browser project (E2E_BROWSERS) runs against the same box, so each creates its own copy
// of the fixture with slugs `e2e-<browser>-…` and names its token after the browser.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'skills');

// The second test edits the skill the first one creates.
test.describe.configure({ mode: 'serial' });

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run the e2e suite through scripts/e2e-image.sh`);
  }
  return value;
}

/** `e2e-code-review` → `e2e-<project>-code-review`. */
const slugFor = (info: TestInfo, base: string) =>
  base.replace(/^e2e-/, `e2e-${info.project.name}-`);

/**
 * Creates every fixture folder as a skill with this project's slug (`name:` rewritten), through
 * the signed-in page's cookies: a multipart `POST /api/skills`, one file part per path.
 */
async function createFixtureSkills(page: Page, info: TestInfo, origin: string): Promise<void> {
  const entries = await readdir(FIXTURE);
  await Promise.all(
    entries.map(async (entry) => {
      const slug = slugFor(info, entry);
      const root = join(FIXTURE, entry);
      const found = await readdir(root, { recursive: true, withFileTypes: true });
      const parts = await Promise.all(
        found
          .filter((f) => f.isFile())
          .map(async (f) => {
            const full = join(f.parentPath, f.name);
            const path = relative(root, full).split(sep).join('/');
            const bytes = await readFile(full);
            const buffer =
              path === 'SKILL.md'
                ? Buffer.from(bytes.toString('utf8').replace(`name: ${entry}`, `name: ${slug}`))
                : bytes;
            return [path, { name: f.name, mimeType: 'text/markdown', buffer }] as const;
          }),
      );
      const multipart = { slug, folder: 'general', ...Object.fromEntries(parts) };
      const res = await page.request.post('/api/skills', { multipart, headers: { origin } });
      expect(res.status(), await res.text()).toBe(201);
    }),
  );
}

type Violation = { directive: string; blockedURI: string };

declare global {
  interface Window {
    uiCspViolations: Violation[];
  }
}

async function trackCsp(page: Page) {
  await page.addInitScript(() => {
    window.uiCspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.uiCspViolations.push({ directive: e.effectiveDirective, blockedURI: e.blockedURI }),
    );
  });
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(env('E2E_ADMIN_LOGIN'));
  await page.getByLabel('Password').fill(env('E2E_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/skills$/);
}

test('find and open a skill, create a token, users, sign out', async ({
  page,
  context,
  browserName,
  baseURL,
}, info) => {
  test.setTimeout(240_000);
  const review = slugFor(info, 'e2e-code-review');
  // Only Chromium knows the clipboard permissions; elsewhere the copy may fall back to the hint.
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  }
  await trackCsp(page);
  await signIn(page);

  await test.step('create the fixture skills', async () => {
    if (baseURL === undefined) throw new Error('baseURL is not configured');
    await createFixtureSkills(page, info, new URL(baseURL).origin);
  });

  await test.step('search finds the skill (the outbox indexes it first)', async () => {
    await page.getByRole('link', { name: 'Skills' }).first().click();
    const query = 'review a pull request diff';
    await page.getByRole('searchbox', { name: 'Search' }).fill(query);
    // The input writes ?q= after a debounce; until the outbox has indexed the skill, reload
    // the search by URL so no attempt can run without the query.
    await expect(page).toHaveURL(/q=review/);
    await expect(async () => {
      await page.goto(`/skills?${new URLSearchParams({ q: query })}`);
      await expect(page.getByRole('link', { name: new RegExp(review) })).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 120_000 });
  });

  await test.step('open the skill and its Cyrillic-named file', async () => {
    await page.getByRole('link', { name: new RegExp(review) }).click();
    await expect(page).toHaveURL(new RegExp(`/skills/${review}`));
    await expect(page.getByRole('heading', { name: 'Code review' })).toBeVisible();
    await page.getByRole('treeitem', { name: 'Мой файл.md' }).click();
    await expect(page).toHaveURL(/file=references%2F/);
    // Files other than SKILL.md are shown as text; it came through the per-segment encoded URL.
    await expect(page.getByRole('region', { name: 'references/Мой файл.md' })).toContainText(
      '# Чек-лист ревью',
    );
  });

  await test.step('create a token and see the connect command', async () => {
    const tokenName = `e2e-${info.project.name}`;
    await page.getByRole('link', { name: 'Tokens' }).first().click();
    await page.getByRole('button', { name: 'Create token' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(tokenName);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog.getByText('The token is shown only once')).toBeVisible();
    await expect(dialog.getByLabel('Token', { exact: true })).toHaveValue(/^sk_/);
    const command = dialog.getByLabel('Connect command', { exact: true });
    await expect(command).toHaveValue(
      /^claude mcp add --transport http skills http:\/\/localhost:\d+\/mcp --header "Authorization: Bearer sk_/,
    );
    await dialog.getByRole('button', { name: 'Copy: Connect command' }).click();
    if (browserName === 'chromium') {
      await expect(page.getByText('Copied')).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        await command.inputValue(),
      );
    } else {
      await expect(page.getByText('Copied').or(dialog.getByText(/Could not copy/))).toBeVisible();
    }
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('row').filter({ hasText: tokenName })).toContainText('Active');
  });

  await test.step('users page as admin', async () => {
    await page.getByRole('link', { name: 'Users' }).first().click();
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    const self = page
      .getByRole('row')
      .filter({ hasText: env('E2E_ADMIN_LOGIN') })
      .filter({ hasText: '(you)' });
    await expect(self.getByRole('button', { name: 'Disable' })).toBeDisabled();
    await expect(page.getByRole('row').filter({ hasText: env('E2E_MEMBER_LOGIN') })).toContainText(
      'Member',
    );
  });

  await test.step('sign out', async () => {
    // "Sign out" sits in the menu under the signed-in login at the bottom of the sidebar.
    await page
      .getByRole('complementary')
      .getByRole('button', { name: env('E2E_ADMIN_LOGIN') })
      .click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  expect(await page.evaluate(() => window.uiCspViolations)).toEqual([]);
});

test.describe('editor and history', () => {
  test('edit SKILL.md, save, history shows 2 versions, diff, roll back', async ({ page }, info) => {
    test.setTimeout(120_000);
    const review = slugFor(info, 'e2e-code-review');
    const marker = `Edited in e2e (${info.project.name}).`;
    await trackCsp(page);
    await signIn(page);

    await test.step('edit SKILL.md in the editor and save', async () => {
      await page.goto(`/skills/${review}`);
      await page.getByRole('link', { name: 'Edit' }).click();
      await expect(page).toHaveURL(new RegExp(`/skills/${review}/edit`));
      // CodeMirror lives in an open shadow root; Playwright locators pierce it.
      const content = page.locator('.cm-content');
      await expect(content).toContainText(`name: ${review}`);
      await content.click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.press('Enter');
      // insertText, not type: a key typed right after Enter is sometimes dropped by CodeMirror.
      await page.keyboard.insertText(marker);
      await expect(content).toContainText(marker);
      await page.getByLabel('Change message').fill('e2e edit');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Saved: version 2')).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/skills/${review}$`));
      await expect(page.getByText(marker)).toBeVisible();
    });

    await test.step('history shows 2 versions; diff v1..v2', async () => {
      await page.getByRole('link', { name: 'History' }).click();
      await expect(page.getByRole('heading', { name: 'Version history' })).toBeVisible();
      await expect(page.getByRole('checkbox', { name: /^Select version \d+$/ })).toHaveCount(2);
      await page.getByRole('checkbox', { name: 'Select version 1' }).click();
      await page.getByRole('checkbox', { name: 'Select version 2' }).click();
      await page.getByRole('button', { name: 'Compare' }).click();
      await expect(page).toHaveURL(/\/diff\?from=1&to=2/);
      await expect(page.getByRole('heading', { name: 'Comparing v1 and v2' })).toBeVisible();
      const skillMd = page.getByRole('region', { name: 'SKILL.md' });
      await expect(skillMd).toContainText('modified');
      await expect(skillMd).toContainText(marker);
    });

    await test.step('roll back to v1: v3 has the content of v1', async () => {
      await page.getByRole('link', { name: 'Back to history' }).click();
      const v1 = page
        .getByRole('listitem')
        .filter({ has: page.getByRole('checkbox', { name: 'Select version 1' }) });
      await v1.getByRole('button', { name: 'Roll back to this version' }).click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toContainText('Roll back to version 1?');
      await confirm.getByRole('button', { name: 'Roll back' }).click();
      await expect(page.getByText('New version created — rollback to v1')).toBeVisible();
      await expect(page.getByRole('checkbox', { name: /^Select version \d+$/ })).toHaveCount(3);
      const v3 = page
        .getByRole('listitem')
        .filter({ has: page.getByRole('checkbox', { name: 'Select version 3' }) });
      await expect(v3).toContainText('rollback to v1');
      await expect(v3).toContainText('current');

      await page.goto(`/skills/${review}`);
      await expect(page.getByRole('heading', { name: 'Code review' })).toBeVisible();
      await expect(page.getByText(marker)).toHaveCount(0);
    });

    expect(await page.evaluate(() => window.uiCspViolations)).toEqual([]);
  });
});
