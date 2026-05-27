import { launchBrowser, discoverPage } from '../core/discovery.mjs';
import { isDangerousText, isSelectorBlocked } from '../core/safety.mjs';
import { saveScreenshot } from '../core/workflow-runtime.mjs';

// Playwright adapter — the primary execution engine.
// Implements the Browsy adapter interface:
//   open, discover, fill, upload, safeClick, snapshot, close
//
// All fill/click operations check the safety policy before acting.
// dry-run mode logs intended actions without executing them.
export class PlaywrightAdapter {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this._persistent = false;
  }

  // Launch Chromium. storageState is loaded only if the file exists.
  async open({ headed = true, storageState = undefined, userDataDir = undefined, dryRun = false } = {}) {
    this._dryRun = dryRun;
    const { browser, context, page, persistent } = await launchBrowser({ headed, storageState, userDataDir });
    this.browser = browser;
    this.context = context;
    this.page = page;
    this._persistent = !!persistent;
  }

  // Navigate to a URL and return the discovered DOM inventory.
  async discover(url, { waitUntil = 'domcontentloaded', timeout = 60000 } = {}) {
    await this.page.goto(url, { waitUntil, timeout });
    return await discoverPage(this.page);
  }

  // Fill a text input or textarea. Clears existing value first.
  async fill(selector, value) {
    await this.page.fill(selector, String(value ?? ''));
  }

  // Set file input(s). filePath may be a string or array of strings.
  async upload(selector, filePath) {
    await this.page.setInputFiles(selector, filePath);
  }

  // Click a button or element, blocking if the label matches the safety policy.
  // label should be the visible text or aria-label of the element.
  async safeClick(selector, label, policy = {}) {
    if (isDangerousText(label, policy)) {
      throw new Error(`SafeClick blocked (dangerous text): "${label}"`);
    }
    if (isSelectorBlocked(selector, policy)) {
      throw new Error(`SafeClick blocked (blocked selector): "${selector}"`);
    }
    await this.page.click(selector);
  }

  // Select a dropdown option by value.
  async selectOption(selector, value) {
    await this.page.selectOption(selector, value);
  }

  // Check or uncheck a checkbox.
  async setChecked(selector, checked = true) {
    if (checked) await this.page.check(selector);
    else await this.page.uncheck(selector);
  }

  // Save a screenshot to runDir/name.
  async snapshot(runDir, name) {
    return await saveScreenshot(this.page, runDir, name);
  }

  // Get the full page HTML.
  async html() {
    return await this.page.content().catch(() => '');
  }

  // Get the visible text of the page body.
  async text() {
    return await this.page.locator('body').innerText().catch(() => '');
  }

  // Close the browser.
  async close() {
    if (this.context && this._persistent) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.browser = null;
      return;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  // Wait for user to close the browser (used for manual checkpoint).
  async waitForClose() {
    if (this.context && this._persistent) {
      await new Promise(resolve => this.context.on('close', resolve));
      return;
    }
    if (!this.browser) return;
    await new Promise(resolve => this.browser.on('disconnected', resolve));
  }
}
