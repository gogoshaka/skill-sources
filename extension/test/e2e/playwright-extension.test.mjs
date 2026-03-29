/**
 * Playwright E2E test for the Skill Sources browser extension.
 *
 * Loads the extension in Chromium, injects a GitHub token into
 * chrome.storage.sync, and exercises the full popup UI:
 *   - Save panel renders with pre-filled URL & title
 *   - Topic dropdown loads from _index.json
 *   - Priority pills and tag chips work
 *   - Save button pushes a source to the repo
 *   - Settings panel toggles
 *   - Logout returns to login panel
 *
 * Requirements:
 *   GITHUB_TOKEN — a valid token with public_repo scope
 *   (uses `gh auth token` as fallback)
 *
 * Cleanup: removes any test topic file it creates.
 */

import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..', '..');

const REPO = 'gogoshaka/skill-sources';
const [OWNER, REPO_NAME] = REPO.split('/');
const TEST_TOPIC = `test-playwright-${Date.now()}`;

// Resolve token
function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync('gh auth token', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const TOKEN = getToken();

test.describe('Skill Sources Extension', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;
  let extensionId;

  test.beforeAll(async () => {
    if (!TOKEN) test.skip(true, 'No GITHUB_TOKEN or gh auth token available');

    // Launch Chromium with the extension loaded.
    // Extensions require a persistent context and headless=false (new headless)
    context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--disable-default-apps',
        '--disable-gpu',
        // Use new headless mode that supports extensions
        '--headless=new',
      ],
    });

    // Find the extension ID by looking at the service worker
    let serviceWorker;
    // Wait for the service worker to be registered
    serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    }
    extensionId = serviceWorker.url().split('/')[2];

    // Inject token + settings into chrome.storage.sync via the service worker
    await serviceWorker.evaluate(
      ({ token, repo }) => {
        return chrome.storage.sync.set({
          gh_token: token,
          gh_repo: repo,
          gh_username: 'playwright-test',
        });
      },
      { token: TOKEN, repo: REPO }
    );
  });

  test.afterAll(async () => {
    // Clean up: delete the test topic file if it was created
    if (TOKEN) {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${OWNER}/${REPO_NAME}/contents/topics/${TEST_TOPIC}.json`,
          {
            headers: {
              Authorization: `Bearer ${TOKEN}`,
              Accept: 'application/vnd.github.v3+json',
            },
          }
        );
        if (res.ok) {
          const { sha } = await res.json();
          await fetch(
            `https://api.github.com/repos/${OWNER}/${REPO_NAME}/contents/topics/${TEST_TOPIC}.json`,
            {
              method: 'DELETE',
              headers: {
                Authorization: `Bearer ${TOKEN}`,
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                message: `[test cleanup] remove ${TEST_TOPIC}`,
                sha,
              }),
            }
          );
        }
      } catch { /* best effort */ }
    }

    if (context) await context.close();
  });

  function popupUrl() {
    return `chrome-extension://${extensionId}/popup/popup.html`;
  }

  test('popup shows save panel when token is injected', async () => {
    const page = await context.newPage();
    // Navigate to a test page first so the extension has a tab URL
    await page.goto('https://example.com');

    // Open popup in the same page (extension popup pages can be navigated to directly)
    const popup = await context.newPage();
    await popup.goto(popupUrl());
    await popup.waitForLoadState('domcontentloaded');

    // Save panel should be visible (not login panel) since token is injected
    const savePanel = popup.locator('#save-panel');
    await expect(savePanel).toBeVisible({ timeout: 10_000 });

    // Login panel should be hidden
    const loginPanel = popup.locator('#login-panel');
    await expect(loginPanel).toBeHidden();

    await popup.close();
    await page.close();
  });

  test('popup loads topics from _index.json', async () => {
    const popup = await context.newPage();
    await popup.goto(popupUrl());
    await popup.waitForLoadState('domcontentloaded');

    // Wait for topic dropdown to populate (network call to GitHub)
    const topicSelect = popup.locator('#field-topic');
    await expect(topicSelect).toBeVisible({ timeout: 10_000 });

    // Wait until "Loading topics…" is replaced
    await popup.waitForFunction(
      () => {
        const sel = document.querySelector('#field-topic');
        return sel && sel.options.length > 0 && sel.options[0].textContent !== 'Loading topics…';
      },
      { timeout: 15_000 }
    );

    // Should have at least one topic (microsoft-sentinel-graph)
    const options = await topicSelect.locator('option').allTextContents();
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.includes('microsoft-sentinel-graph'))).toBeTruthy();

    await popup.close();
  });

  test('priority pills toggle correctly', async () => {
    const popup = await context.newPage();
    await popup.goto(popupUrl());
    await popup.waitForSelector('#save-panel:not(.hidden)', { timeout: 10_000 });

    // P0 should be checked by default
    const p0 = popup.locator('input[name="priority"][value="P0"]');
    await expect(p0).toBeChecked();

    // Radio inputs are display:none (pill CSS hides them), click the <span> label instead
    await popup.locator('.pill:has(input[value="P1"]) span').click();
    await expect(popup.locator('input[name="priority"][value="P1"]')).toBeChecked();
    await expect(p0).not.toBeChecked();

    // Click P2 span
    await popup.locator('.pill:has(input[value="P2"]) span').click();
    await expect(popup.locator('input[name="priority"][value="P2"]')).toBeChecked();

    await popup.close();
  });

  test('tag chips can be added and removed', async () => {
    const popup = await context.newPage();
    await popup.goto(popupUrl());
    await popup.waitForSelector('#save-panel:not(.hidden)', { timeout: 10_000 });

    const tagInput = popup.locator('#tag-input');

    // Add a tag
    await tagInput.fill('sentinel');
    await tagInput.press('Enter');

    let tags = popup.locator('#tags-container .tag');
    await expect(tags).toHaveCount(1);
    await expect(tags.first()).toContainText('sentinel');

    // Add another tag
    await tagInput.fill('graph');
    await tagInput.press('Enter');
    await expect(tags).toHaveCount(2);

    // Remove first tag by clicking ×
    await popup.locator('#tags-container .remove-tag').first().click();
    await expect(tags).toHaveCount(1);
    await expect(tags.first()).toContainText('graph');

    await popup.close();
  });

  test('settings panel toggles', async () => {
    const popup = await context.newPage();
    await popup.goto(popupUrl());
    await popup.waitForSelector('#save-panel:not(.hidden)', { timeout: 10_000 });

    // Click settings button
    await popup.locator('#btn-settings').click();
    await expect(popup.locator('#settings-panel')).toBeVisible();
    await expect(popup.locator('#save-panel')).toBeHidden();

    // Repo field should have our default
    const repoInput = popup.locator('#setting-repo');
    await expect(repoInput).toHaveValue(REPO);

    // Cancel goes back
    await popup.locator('#btn-cancel-settings').click();
    await expect(popup.locator('#settings-panel')).toBeHidden();
    await expect(popup.locator('#save-panel')).toBeVisible();

    await popup.close();
  });

  test('create new topic via popup', async () => {
    const popup = await context.newPage();
    await popup.goto(popupUrl());
    await popup.waitForSelector('#save-panel:not(.hidden)', { timeout: 10_000 });

    // Wait for topics to load
    await popup.waitForFunction(
      () => {
        const sel = document.querySelector('#field-topic');
        return sel && sel.options.length > 0 && sel.options[0].textContent !== 'Loading topics…';
      },
      { timeout: 15_000 }
    );

    // Click "+ Create new topic…"
    await popup.locator('#btn-new-topic').click();
    await expect(popup.locator('#new-topic-form')).toBeVisible();

    // Fill in the new topic form
    await popup.locator('#new-topic-id').fill(TEST_TOPIC);
    await popup.locator('#new-topic-desc').fill('Playwright test topic');
    await popup.locator('#new-topic-tags').fill('test, playwright');

    // Create it (makes a real GitHub API call — give it time)
    await popup.locator('#btn-create-topic').click();

    // Should be added to the dropdown and selected
    await popup.waitForFunction(
      (topicId) => {
        const sel = document.querySelector('#field-topic');
        return sel && sel.value === topicId;
      },
      TEST_TOPIC,
      { timeout: 30_000 }
    );

    const selectedValue = await popup.locator('#field-topic').inputValue();
    expect(selectedValue).toBe(TEST_TOPIC);

    await popup.close();
  });

  test('save a source to the repo via popup', async () => {
    const popup = await context.newPage();
    await popup.goto(popupUrl());
    await popup.waitForSelector('#save-panel:not(.hidden)', { timeout: 10_000 });

    // Wait for topics to load
    await popup.waitForFunction(
      () => {
        const sel = document.querySelector('#field-topic');
        return sel && sel.options.length > 0 && sel.options[0].textContent !== 'Loading topics…';
      },
      { timeout: 15_000 }
    );

    // Fill the form (URL field is readonly, set it via JS)
    await popup.evaluate(() => {
      document.querySelector('#field-url').removeAttribute('readonly');
    });
    await popup.locator('#field-url').fill('https://example.com/playwright-test');
    await popup.locator('#field-title').fill('Playwright Test Source');
    await popup.locator('#field-summary').fill('E2E test source created by Playwright');

    // Select the test topic we created (or first available topic)
    const topicSelect = popup.locator('#field-topic');
    const options = await topicSelect.locator('option').allTextContents();
    const targetTopic = options.includes(TEST_TOPIC)
      ? TEST_TOPIC
      : 'microsoft-sentinel-graph';
    await topicSelect.selectOption(targetTopic);

    // Set priority to P2 (test data) — click span since input is display:none
    await popup.locator('.pill:has(input[value="P2"]) span').click();

    // Add a tag
    const tagInput = popup.locator('#tag-input');
    await tagInput.fill('e2e-test');
    await tagInput.press('Enter');

    // Click Save
    await popup.locator('#btn-save').click();

    // Wait for success message
    const saveResult = popup.locator('#save-result');
    await expect(saveResult).toBeVisible({ timeout: 20_000 });
    await expect(saveResult).toContainText('✅ Saved');

    await popup.close();

    // Verify the source was actually saved to GitHub
    const res = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO_NAME}/contents/topics/${targetTopic}.json`,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );
    expect(res.ok).toBeTruthy();
    const file = await res.json();
    const content = JSON.parse(Buffer.from(file.content, 'base64').toString());
    const savedSource = content.items.find(
      (s) => s.url === 'https://example.com/playwright-test'
    );
    expect(savedSource).toBeDefined();
    expect(savedSource.title).toBe('Playwright Test Source');
    expect(savedSource._priority).toBe('P2');

    // Clean up: remove the test source from the topic file if it's not the test topic
    if (targetTopic !== TEST_TOPIC) {
      content.items = content.items.filter(
        (s) => s.url !== 'https://example.com/playwright-test'
      );
      const updated = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
      await fetch(
        `https://api.github.com/repos/${OWNER}/${REPO_NAME}/contents/topics/${targetTopic}.json`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: '[test cleanup] remove playwright test source',
            content: updated,
            sha: file.sha,
          }),
        }
      );
    }
  });

  test('logout returns to login panel', async () => {
    const popup = await context.newPage();
    await popup.goto(popupUrl());
    await popup.waitForSelector('#save-panel:not(.hidden)', { timeout: 10_000 });

    // Click logout
    await popup.locator('#btn-logout').click();

    // Page should reload and show login panel
    await popup.waitForSelector('#login-panel:not(.hidden)', { timeout: 10_000 });
    await expect(popup.locator('#login-panel')).toBeVisible();
    await expect(popup.locator('#save-panel')).toBeHidden();

    // Restore token for other tests (cleanup already handles this)
    const sw = context.serviceWorkers()[0];
    if (sw) {
      await sw.evaluate(
        (token) => chrome.storage.sync.set({ gh_token: token }),
        TOKEN
      );
    }

    await popup.close();
  });
});
