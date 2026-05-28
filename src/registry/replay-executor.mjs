import path from 'path';
import { chromium } from 'playwright';
import { OUTPUT_DIR, ensureDir, exists, writeJson } from '../core/paths.mjs';

export async function runReplay({ runId, workflowVersion, payload = {}, mode = 'preview', options = {}, runDir }) {
  const dir = runDir || path.join(OUTPUT_DIR, 'replay-runs', runId);
  const screenshotsDir = path.join(dir, 'screenshots');
  const downloadsDir = path.join(dir, 'downloads');
  ensureDir(dir);
  ensureDir(screenshotsDir);
  ensureDir(downloadsDir);

  const authProfile = authProfileFor(workflowVersion, options);
  const contextOptions = { acceptDownloads: true };
  if (authProfile.storageStatePath && exists(authProfile.storageStatePath) && options.ignoreStorageState !== true) {
    contextOptions.storageState = authProfile.storageStatePath;
  }

  const headless = options.headless === true || process.env.BROWSY_REPLAY_HEADLESS === 'true';
  const slowMo = Number(options.slowMo || process.env.BROWSY_REPLAY_SLOWMO || 0) || 0;
  const leaveOpen = options.leaveBrowserOpen === true || process.env.BROWSY_REPLAY_LEAVE_OPEN === 'true';
  const timeout = Number(options.timeoutMs || process.env.BROWSY_REPLAY_TIMEOUT_MS || 15000) || 15000;
  const settleMs = Number(options.settleMs || process.env.BROWSY_REPLAY_SETTLE_MS || 2500) || 2500;
  const steps = Array.isArray(workflowVersion.recordedSteps) ? workflowVersion.recordedSteps : [];
  const tabs = Array.isArray(workflowVersion.tabs) ? workflowVersion.tabs : [];

  let browser = null;
  let context = null;
  const pages = new Map();
  const completedSteps = [];
  const failedSteps = [];
  const skippedSteps = [];
  const capturedOutputs = {};
  const screenshots = [];
  const downloads = [];
  const filledFields = [];
  const uploadedFiles = [];
  const manualCheckpoints = [];
  const logs = [];

  try {
    if (options.usePersistentProfile === true || process.env.BROWSY_REPLAY_PERSISTENT_PROFILE === 'true') {
      ensureDir(authProfile.userDataDir);
      context = await chromium.launchPersistentContext(authProfile.userDataDir, { headless, slowMo, acceptDownloads: true });
    } else {
      browser = await chromium.launch({ headless, slowMo });
      context = await browser.newContext(contextOptions);
    }

    context.on('download', async d => {
      try {
        const name = d.suggestedFilename() || `download-${Date.now()}`;
        const target = path.join(downloadsDir, safeName(name));
        await d.saveAs(target);
        downloads.push({ name, path: target, type: 'download' });
      } catch (err) {
        logs.push({ type: 'download_failed', error: err.message });
      }
    });

    for (const step of steps) {
      const type = step.type || step.action;
      try {
        if (type === 'approve' || (step.requiresApproval && mode === 'live' && options.requireHumanApproval !== false)) {
          manualCheckpoints.push({ type: 'materialized_checkpoint', checkpointId: step.checkpointId || step.id, label: step.label || step.id, beforeAction: step.beforeAction || null, reason: step.reason || 'approval required' });
          skippedSteps.push({ id: step.id, type, status: 'checkpoint' });
          continue;
        }

        if (type === 'navigate') {
          const page = await getPage(context, pages, step.tabId || tabs[0]?.id || 'tab1');
          await page.goto(step.url, { waitUntil: step.waitUntil || 'domcontentloaded', timeout });
          await settlePage(page, { timeout, settleMs, targetHost: hostFromStep(step) });
          completedSteps.push({ id: step.id, type, status: 'completed', tabId: step.tabId, url: page.url() });
          pushUnique(screenshots, await shot(page, screenshotsDir, `${step.order || completedSteps.length}-${step.id}`));
          continue;
        }

        if (type === 'fill' || type === 'select') {
          const page = await getPage(context, pages, step.tabId || tabs[0]?.id || 'tab1');
          await settlePage(page, { timeout, settleMs });
          const value = valueFor(step.value, payload, step.binding);
          const loc = await locate(page, step, timeout);
          if (type === 'select') await loc.selectOption(String(value ?? ''), { timeout });
          else await loc.fill(String(value ?? ''), { timeout });
          filledFields.push({ field: step.binding || step.id, selector: step.selector || null, status: 'filled' });
          completedSteps.push({ id: step.id, type, status: 'completed', tabId: step.tabId });
          continue;
        }

        if (type === 'uploadFile') {
          const page = await getPage(context, pages, step.tabId || tabs[0]?.id || 'tab1');
          await settlePage(page, { timeout, settleMs });
          const filePath = fileFor(step.file, payload, step.binding);
          if (!filePath) throw new Error(`missing file for ${step.binding || step.id}`);
          const loc = await locate(page, step, timeout);
          await loc.setInputFiles(filePath, { timeout });
          uploadedFiles.push({ role: step.binding || step.id, selector: step.selector || null, path: filePath, status: 'uploaded' });
          completedSteps.push({ id: step.id, type, status: 'completed', tabId: step.tabId });
          continue;
        }

        if (type === 'click') {
          const page = await getPage(context, pages, step.tabId || tabs[0]?.id || 'tab1');
          await settlePage(page, { timeout, settleMs });
          const loc = await locate(page, step, timeout);
          await loc.click({ timeout });
          await settlePage(page, { timeout, settleMs });
          completedSteps.push({ id: step.id, type, status: 'completed', tabId: step.tabId, label: step.label || null });
          pushUnique(screenshots, await shot(page, screenshotsDir, `${step.order || completedSteps.length}-${step.id}`));
          continue;
        }

        if (type === 'extractText' || type === 'extractAttribute') {
          const outputId = step.output || step.binding || step.id;
          const page = await getPage(context, pages, step.tabId || bestOutputTab(tabs));
          await settlePage(page, { timeout, settleMs });
          let value = null;
          if (step.selector) {
            const loc = await locate(page, step, timeout);
            value = type === 'extractAttribute'
              ? await loc.getAttribute(step.attribute || 'href', { timeout })
              : await loc.innerText({ timeout });
          } else {
            value = await infer(page, outputId, workflowVersion.expectedOutputs || []);
          }
          capturedOutputs[outputId] = { status: value ? 'captured' : 'empty', value, selector: step.selector || null, required: step.required !== false };
          completedSteps.push({ id: step.id, type, status: value ? 'completed' : 'completed_empty', tabId: step.tabId, output: outputId });
          pushUnique(screenshots, await shot(page, screenshotsDir, `${step.order || completedSteps.length}-${step.id}`));
          continue;
        }

        skippedSteps.push({ id: step.id, type, status: 'unsupported_step_type' });
      } catch (err) {
        const page = pages.get(step.tabId || tabs[0]?.id || 'tab1');
        const diagnostic = page ? await pageDiagnostic(page) : {};
        if (page) pushUnique(screenshots, await shot(page, screenshotsDir, `failed-${step.id || type}`));
        failedSteps.push({ id: step.id, type, status: 'failed', error: err.message, selector: step.selector || null, tabId: step.tabId || null, ...diagnostic });
        if (options.stopOnStepFailure !== false) break;
      }
    }

    for (const [tabId, page] of pages.entries()) pushUnique(screenshots, await shot(page, screenshotsDir, `final-${tabId}`));

    const uniqueScreenshots = uniqueByPath(screenshots.filter(Boolean));
    const uniqueDownloads = uniqueByPath(downloads.filter(Boolean));
    const result = clean({
      ok: failedSteps.length === 0,
      workflow_id: workflowVersion.workflowId || workflowVersion.packageWorkflowId,
      run_id: runId,
      source_system: 'playwright_replay',
      entity_type: workflowVersion.appId,
      entity_id: runId,
      mode,
      status: failedSteps.length ? 'replay_failed' : 'replay_passed',
      completedSteps,
      failedSteps,
      skippedSteps,
      filled_fields: filledFields,
      uploaded_files: uploadedFiles,
      captured_outputs: withExpectedOutputs(capturedOutputs, workflowVersion.expectedOutputs || []),
      manual_checkpoints: manualCheckpoints,
      downloaded_files: uniqueDownloads,
      screenshots: uniqueScreenshots,
      artifacts: [...uniqueScreenshots.map(s => ({ ...s, type: 'screenshot' })), ...uniqueDownloads],
      artifact_paths: [...uniqueScreenshots.map(s => s.path), ...uniqueDownloads.map(d => d.path)],
      logs,
      authProfile,
      next_required_action: null,
      return_contract_version: 'automation-result-v1',
      generated_at: new Date().toISOString(),
    });
    writeJson(path.join(dir, 'playwright-result.json'), result);
    return result;
  } finally {
    if (!leaveOpen) {
      try { await context?.close(); } catch {}
      try { await browser?.close(); } catch {}
    }
  }
}

function authProfileFor(workflowVersion, options = {}) {
  const auth = Array.isArray(workflowVersion.auth) ? workflowVersion.auth : [];
  const first = auth.find(a => a.authProfileId) || auth[0] || null;
  const id = safeSegment(options.authProfileId || first?.authProfileId || first?.siteId || workflowVersion.appId || 'default');
  const dir = path.join(OUTPUT_DIR, 'auth-profiles', id);
  return { authProfileId: id, userDataDir: path.join(dir, 'user-data'), storageStatePath: path.join(dir, 'storageState.json') };
}

async function getPage(context, pages, tabId) {
  const id = tabId || 'tab1';
  if (pages.has(id)) return pages.get(id);
  const page = await context.newPage();
  pages.set(id, page);
  return page;
}

async function settlePage(page, { timeout, settleMs, targetHost } = {}) {
  await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeout || 15000, 10000) }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeout || 15000, 10000) }).catch(() => {});
  if (targetHost) {
    await page.waitForFunction(host => location.hostname === host || location.hostname.endsWith('.' + host), targetHost, { timeout: Math.min(timeout || 15000, 12000) }).catch(() => {});
  }
  await page.waitForTimeout(Math.min(settleMs || 1500, 5000)).catch(() => {});
}

async function locate(page, step, timeout) {
  const selectors = [step.selector, ...(Array.isArray(step.fallbackSelectors) ? step.fallbackSelectors : [])].filter(Boolean);
  const tries = [];
  for (const selector of selectors) tries.push({ kind: 'css', selector });
  for (const label of candidateLabels(step)) {
    tries.push({ kind: 'role-link', label });
    tries.push({ kind: 'role-button', label });
    tries.push({ kind: 'aria', label });
    tries.push({ kind: 'text', label });
  }
  let last = null;
  for (const trial of tries) {
    try {
      const loc = locatorFor(page, trial).first();
      await loc.waitFor({ state: 'visible', timeout: Math.min(timeout || 15000, 8000) });
      return loc;
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`no usable selector for ${step.id || 'step'}: ${last?.message || 'missing selector'}`);
}

function locatorFor(page, trial) {
  if (trial.kind === 'role-link') return page.getByRole('link', { name: new RegExp(escapeRegex(trial.label), 'i') });
  if (trial.kind === 'role-button') return page.getByRole('button', { name: new RegExp(escapeRegex(trial.label), 'i') });
  if (trial.kind === 'aria') return page.locator(`[aria-label*="${cssEscape(trial.label)}" i]`);
  if (trial.kind === 'text') return page.getByText(new RegExp(`^\\s*${escapeRegex(trial.label)}\\s*$`, 'i'));
  return page.locator(trial.selector);
}

function candidateLabels(step = {}) {
  const values = [];
  for (const value of [step.label, step.name, step.id, step.selector]) {
    if (!value) continue;
    const cleaned = String(value)
      .replace(/^click[_-]?/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\[[^\]]+\]/g, ' ')
      .replace(/aria-label\s*=\s*["']?([^"'\]]+).*/i, '$1')
      .replace(/[^a-zA-Z0-9 ]+/g, ' ')
      .trim();
    if (cleaned && cleaned.length <= 80) values.push(cleaned);
  }
  return [...new Set(values)];
}

function valueFor(value, payload = {}, binding = null) {
  if (typeof value !== 'string') return value;
  const m = value.match(/^\{\{inputs\.([^}]+)\}\}$/);
  if (m) return payload[m[1]];
  if (binding && Object.prototype.hasOwnProperty.call(payload, binding)) return payload[binding];
  return value;
}

function fileFor(value, payload = {}, binding = null) {
  const direct = valueFor(value, payload, binding);
  if (direct && typeof direct === 'string' && !direct.startsWith('{{')) return direct;
  if (binding && payload[binding]) return payload[binding];
  if (payload.files && binding && payload.files[binding]) return payload.files[binding];
  return null;
}

async function infer(page, outputId, expectedOutputs = []) {
  const id = String(outputId || '').toLowerCase();
  const meta = expectedOutputs.find(o => String(o.id || '').toLowerCase() === id) || {};
  if (/url|link/.test(id) || /external_link/i.test(meta.scope || '')) return page.url();
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const patterns = [/(\d[\d,]*)\s+(rows|records|results|items)\b/i, /(total|count)\D{0,20}(\d[\d,]*)/i, /(\d[\d,]*)\s+of\s+(\d[\d,]*)/i];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0].trim();
  }
  return text.trim().slice(0, 500) || null;
}

function withExpectedOutputs(captured, expectedOutputs = []) {
  const out = { ...captured };
  for (const e of expectedOutputs) {
    const id = e.id || e.name || e.output;
    if (!id || out[id]) continue;
    out[id] = { status: 'pending', value: null, required: e.required !== false, selector: e.selector || null };
  }
  return out;
}

async function shot(page, dir, name) {
  try {
    ensureDir(dir);
    const filename = `${safeSegment(name)}-${Date.now()}.png`;
    const filePath = path.join(dir, filename);
    await page.screenshot({ path: filePath, fullPage: true });
    return { name: filename, path: filePath, pageUrl: page.url() };
  } catch { return null; }
}

async function pageDiagnostic(page) {
  try {
    const title = await page.title().catch(() => null);
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 1200) || '').catch(() => '');
    return { pageUrl: page.url(), pageTitle: title, bodyTextPreview: bodyText };
  } catch {
    return {};
  }
}

function pushUnique(list, item) {
  if (!item?.path) return;
  if (!list.some(x => x?.path === item.path)) list.push(item);
}

function uniqueByPath(items = []) {
  const map = new Map();
  for (const item of items) if (item?.path && !map.has(item.path)) map.set(item.path, item);
  return [...map.values()];
}

function hostFromStep(step = {}) {
  try { return new URL(step.url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function bestOutputTab(tabs = []) {
  return tabs.find(t => !t.requiresAuth)?.id || tabs[tabs.length - 1]?.id || tabs[0]?.id || 'tab1';
}

function safeSegment(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function safeName(value = '') {
  return safeSegment(value).slice(0, 120) || 'artifact';
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cssEscape(value = '') {
  return String(value).replace(/["\\]/g, '\\$&');
}

function clean(obj) {
  if (Array.isArray(obj)) return obj.map(clean).filter(v => v !== undefined && v !== null);
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = clean(v);
  }
  return out;
}
