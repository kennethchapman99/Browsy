import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { OUTPUT_DIR, ensureDir, exists, readJson, writeJson } from '../core/paths.mjs';
import { evaluateAuthPreflight } from '../core/auth-preflight.mjs';

const activeRecordings = new Map();

export function isPlaywrightRecordingActive(recordingSessionId) {
  return activeRecordings.has(recordingSessionId);
}

export function getActivePlaywrightRecording(recordingSessionId) {
  const active = activeRecordings.get(recordingSessionId);
  if (!active) return null;
  return {
    recordingSessionId,
    startedAt: active.startedAt,
    pageCount: active.pages.length,
    eventCount: active.events.length,
    tabs: active.tabs,
    authProfile: active.authProfile,
    screenshotsDir: `output/recordings/${recordingSessionId}/screenshots`,
  };
}

export async function startPlaywrightRecording({ recordingSessionId, session, options = {} } = {}) {
  if (!recordingSessionId) throw new Error('recordingSessionId is required');
  if (activeRecordings.has(recordingSessionId)) return activeRecordings.get(recordingSessionId).launch;

  const tabs = Array.isArray(session?.recordingSetup?.tabs) ? session.recordingSetup.tabs : [];
  if (!tabs.length) throw new Error('recording session has no tabs to launch');

  const expectedUrls = tabs.map(t => t.url);
  console.log('[browsy:recording] launch received', {
    recordingSessionId,
    appId: session?.appId,
    workflowId: session?.workflowId,
    tabCount: tabs.length,
    targetUrls: expectedUrls,
  });

  const startedAt = new Date().toISOString();
  const headless = options.headless === true || process.env.BROWSY_RECORDING_HEADLESS === 'true' || process.env.BROWSY_RECORDING_HEADLESS === '1';
  const slowMo = Number(options.slowMo || process.env.BROWSY_RECORDING_SLOWMO || 0) || 0;
  const authProfile = resolveAuthProfile(session, options);
  const contextOptions = { acceptDownloads: true };
  if (authProfile.storageStatePath && exists(authProfile.storageStatePath) && options.ignoreStorageState !== true) {
    contextOptions.storageState = authProfile.storageStatePath;
  }

  const usePersistent = options.usePersistentProfile === true || process.env.BROWSY_RECORDING_PERSISTENT_PROFILE === 'true';
  const { browser, context, channel } = await launchBrowserContext({ headless, slowMo, authProfile, usePersistent, contextOptions });

  const events = [];
  const pages = [];
  const append = event => {
    const normalized = normalizeEvent(recordingSessionId, event);
    events.push(normalized);
    appendEventsToDisk(recordingSessionId, [normalized]);
    return normalized;
  };

  await context.exposeFunction('__browsyRecordEvent', append);
  await context.addInitScript({ content: recorderInitScript(recordingSessionId) });
  context.on('page', page => {
    if (page.__browsyTracked) return;
    pages.push(page);
    attachPageHandlers({ recordingSessionId, page, append });
    append({ type: 'popup_opened', pageUrl: page.url(), rawEvidence: { opener: 'context_page_event' } });
  });

  // A persistent context opens with one default about:blank page. Reuse it for the
  // first tab instead of leaving it open and adding a fresh page (which left a
  // stray blank tab behind). Any *extra* pre-existing blank pages are closed.
  const seededPages = context.pages();
  const reusablePages = seededPages.filter(p => isBlankUrl(p.url()));
  for (const extra of reusablePages.slice(1)) { try { await extra.close(); } catch {} }
  let nextReusable = reusablePages[0] || null;

  const openedTabs = [];
  const tabPageRefs = [];
  for (const tab of tabs) {
    const page = nextReusable || await context.newPage();
    nextReusable = null;
    page.__browsyTracked = true;
    tabPageRefs.push(page);
    if (!pages.includes(page)) pages.push(page);
    attachPageHandlers({ recordingSessionId, page, append, tab });
    append({ type: 'page_opened', pageId: tab.id, pageUrl: tab.url, rawEvidence: { tab, authProfile } });
    const opened = { id: tab.id, requestedUrl: tab.url, finalUrl: null, title: '', authBlocked: false, blockedReason: null };
    try {
      await page.goto(tab.url, { waitUntil: 'domcontentloaded', timeout: Number(options.navigationTimeoutMs || 60000) });
      opened.finalUrl = page.url();
      opened.title = await safeTitle(page);
      const block = await detectAuthBlock(page);
      if (block.blocked) { opened.authBlocked = true; opened.blockedReason = block.reason; }
      append({ type: 'page_seen', pageId: tab.id, pageUrl: page.url(), rawEvidence: { title: opened.title, url: page.url(), tab, authBlocked: opened.authBlocked } });
      await capturePageScreenshot({ recordingSessionId, page, pageId: tab.id, reason: 'page_seen' });
    } catch (err) {
      opened.finalUrl = safePageUrl(page);
      opened.error = err.message;
      append({ type: 'page_navigation_failed', pageId: tab.id, pageUrl: tab.url, rawEvidence: { tab, error: err.message } });
    }
    openedTabs.push(opened);
  }

  // Close any extra blank pages not belonging to the tab set (e.g. restored session
  // pages, or blank popups opened before navigation ran).
  const tabPageSet = new Set(tabPageRefs);
  for (const p of context.pages()) {
    if (!tabPageSet.has(p) && isBlankUrl(p.url())) { try { await p.close(); } catch {} }
  }

  const actualUrls = openedTabs.map(t => t.finalUrl);
  const verification = buildTabVerification({ tabs, openedTabs });

  console.log('[browsy:recording] navigation result', {
    recordingSessionId,
    expectedUrls,
    actualUrls,
    verificationOk: verification.ok,
    blankTabs: verification.blankTabs,
    navErrors: verification.navErrors,
  });

  if (!verification.ok) {
    writeRuntimeStatus(recordingSessionId, { status: 'launch_failed', verification, active: false });
    try { await context.close(); } catch {}
    try { await browser?.close(); } catch {}
    const err = new Error(
      `Recorder launch failed: ${verification.summary}. ` +
      `Expected [${expectedUrls.join(', ')}] but got [${actualUrls.join(', ')}].`
    );
    err.launchVerification = verification;
    throw err;
  }

  const authBlockedTab = openedTabs.find(tab => tab.authBlocked);
  const launch = {
    createdAt: startedAt,
    mode: 'real_playwright_recorder',
    headless,
    channel,
    persistentProfile: usePersistent,
    pageCount: pages.length,
    tabs,
    openedTabs,
    verification,
    authBlocked: Boolean(authBlockedTab),
    authBlockedReason: authBlockedTab?.blockedReason || null,
    auth: session?.auth || [],
    authProfile,
    eventSink: `output/recordings/${recordingSessionId}/events.json`,
    observationSink: `output/recordings/${recordingSessionId}/observation.json`,
    screenshotSink: `output/recordings/${recordingSessionId}/screenshots`,
    instructions: [
      'Use the opened Playwright browser window to perform the workflow once.',
      'For SSO flows, put the identity provider tab first and set recordingSetup.authProfileId/authGroupId to a shared value.',
      'If a target site blocks automated sign-in, run the auth setup flow to log in once with the persistent profile, then re-record.',
      'Browsy records generic page, input, click, file, download, navigation, candidate output, and screenshot evidence.',
      'Auth storageState is reused and saved when a siteId/auth profile is available.',
      'Stop/import the recording through the recording session page or API.',
      'Final/publish/pay/delete actions should remain human-approved checkpoints.',
    ],
  };

  activeRecordings.set(recordingSessionId, { browser, context, pages, tabs, events, startedAt, launch, authProfile });
  writeRuntimeStatus(recordingSessionId, { status: 'recording', launch, active: true });
  return launch;
}

// Generic auth setup: open the named persistent Chrome profile straight to a
// target URL so a human can sign in once. No recording, no app-specific logic —
// the profile (userDataDir + storageState) is reused by later recordings/replays.
export async function openAuthSetupProfile({ appId, workflowId, authProfileId, targetUrl, options = {} } = {}) {
  if (!targetUrl) throw new Error('targetUrl is required for auth setup');
  const session = { appId, workflowId, recordingSetup: { authProfileId, tabs: [{ siteId: authProfileId, authProfileId }] } };
  const authProfile = resolveAuthProfile(session, { authProfileId });
  const headless = options.headless === true;
  const slowMo = Number(options.slowMo || 0) || 0;
  const { context, channel } = await launchBrowserContext({
    headless, slowMo, authProfile, usePersistent: true, contextOptions: { acceptDownloads: true },
  });
  const page = context.pages().find(p => isBlankUrl(p.url())) || await context.newPage();
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: Number(options.navigationTimeoutMs || 120000) });
  } catch {}
  ensureDir(authProfile.userDataDir);
  // In headless mode there is no interactive user to close the window; close
  // immediately so the process (and any test server) can drain cleanly.
  if (headless) {
    try { await context.close(); } catch {}
  }
  return {
    mode: 'auth_setup',
    channel,
    authProfileId: authProfile.authProfileId,
    userDataDir: authProfile.userDataDir,
    storageStatePath: authProfile.storageStatePath,
    targetUrl,
    instructions: [
      'Sign in to the target site in the opened Chrome window.',
      'Close the window when done — the session is saved to the persistent profile.',
      'Then start/relaunch the recording; it will reuse this authenticated profile.',
    ],
  };
}

// Generic auth preflight: open the named persistent Chrome profile to the target
// URL (default headless), observe the final URL/title/body, and evaluate generic
// app-provided rules to decide whether the profile is authenticated. The context
// is always closed before returning. We never return or log cookies, tokens, or
// page body text — only the final URL, title, and the generic verdict.
export async function runAuthPreflight({ appId, workflowId, authProfileId, targetUrl, rules, options = {} } = {}) {
  if (!targetUrl) throw new Error('targetUrl is required for auth preflight');
  const session = { appId, workflowId, recordingSetup: { authProfileId, tabs: [{ siteId: authProfileId, authProfileId }] } };
  const authProfile = resolveAuthProfile(session, { authProfileId });
  const headless = options.headless !== false;
  const slowMo = Number(options.slowMo || 0) || 0;

  let context = null;
  let channel = 'chromium';
  let finalUrl = null;
  let title = '';
  let bodyText = '';
  let navError = null;
  try {
    const launched = await launchBrowserContext({
      headless, slowMo, authProfile, usePersistent: true, contextOptions: { acceptDownloads: true },
    });
    context = launched.context;
    channel = launched.channel;
    const page = context.pages().find(p => isBlankUrl(p.url())) || await context.newPage();
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: Number(options.navigationTimeoutMs || 60000) });
    } catch (err) {
      navError = err.message;
    }
    finalUrl = safePageUrl(page);
    title = await safeTitle(page);
    bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => '');
  } finally {
    try { await context?.close(); } catch {}
  }

  const verdict = evaluateAuthPreflight({ targetUrl, finalUrl, title, bodyText, rules });
  ensureDir(authProfile.userDataDir);
  console.log('[browsy:auth-preflight] result', {
    appId: authProfile.appId,
    authProfileId: authProfile.authProfileId,
    targetUrl,
    finalUrl,
    ok: verdict.ok,
    code: verdict.code,
  });
  return {
    mode: 'auth_preflight',
    channel,
    ok: verdict.ok,
    code: verdict.code,
    authProfileId: authProfile.authProfileId,
    appId: authProfile.appId,
    userDataDir: authProfile.userDataDir,
    storageStatePath: authProfile.storageStatePath,
    targetUrl,
    finalUrl,
    title,
    matchedRule: verdict.matchedRule,
    navError,
    message: verdict.message,
  };
}

// Launch a browser context, preferring a real installed Chrome channel (so sites
// that fingerprint bundled/automation Chromium for SSO are less likely to block
// sign-in). Falls back to bundled Chromium if the channel is unavailable.
async function launchBrowserContext({ headless, slowMo, authProfile, usePersistent, contextOptions }) {
  const preferred = String(process.env.BROWSY_RECORDING_CHANNEL ?? 'chrome').trim();
  const tryChannels = preferred && preferred !== 'chromium' && preferred !== 'bundled'
    ? [preferred, null]
    : [null];

  let lastError = null;
  for (const channel of tryChannels) {
    try {
      if (usePersistent) {
        ensureDir(authProfile.userDataDir);
        const context = await chromium.launchPersistentContext(authProfile.userDataDir, {
          headless, slowMo, acceptDownloads: true, ...(channel ? { channel } : {}),
        });
        return { browser: null, context, channel: channel || 'chromium' };
      }
      const browser = await chromium.launch({ headless, slowMo, ...(channel ? { channel } : {}) });
      const context = await browser.newContext(contextOptions);
      return { browser, context, channel: channel || 'chromium' };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('failed to launch browser context');
}

function isBlankUrl(url) {
  const u = String(url || '').trim();
  return u === '' || u === 'about:blank' || u.startsWith('chrome://newtab');
}

function safePageUrl(page) {
  try { return page.url(); } catch { return null; }
}

// Detect the common "automation browser blocked from sign-in" state (Google's
// "This browser or app may not be secure"). Returns a generic verdict so the
// recorder can report auth-blocked without any provider-specific automation.
async function detectAuthBlock(page) {
  try {
    const url = page.url();
    const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => '');
    const insecure = /this browser or app may not be secure/i.test(text)
      || /couldn[’']?t sign you in/i.test(text);
    if (insecure) {
      return { blocked: true, reason: 'Google blocked sign-in in the automation browser ("this browser or app may not be secure").' };
    }
    if (/accounts\.google\.com/i.test(url) && /sign in|log in/i.test(text)) {
      return { blocked: true, reason: 'Target redirected to Google sign-in; the persistent profile is not authenticated yet.' };
    }
    return { blocked: false, reason: null };
  } catch {
    return { blocked: false, reason: null };
  }
}

export async function stopPlaywrightRecording(recordingSessionId) {
  const active = activeRecordings.get(recordingSessionId);
  if (!active) {
    writeRuntimeStatus(recordingSessionId, { status: 'not_active', active: false });
    return { active: false, eventCount: countEventsOnDisk(recordingSessionId) };
  }

  activeRecordings.delete(recordingSessionId);
  const stoppedAt = new Date().toISOString();
  const screenshots = [];
  for (let i = 0; i < active.pages.length; i++) {
    const shot = await capturePageScreenshot({ recordingSessionId, page: active.pages[i], pageId: active.tabs[i]?.id || `page${i + 1}`, reason: 'stop' });
    if (shot) screenshots.push(shot);
  }

  let savedAuthState = null;
  try {
    if (active.authProfile?.storageStatePath) {
      ensureDir(path.dirname(active.authProfile.storageStatePath));
      await active.context.storageState({ path: active.authProfile.storageStatePath });
      savedAuthState = active.authProfile.storageStatePath;
    }
  } catch {}

  appendEventsToDisk(recordingSessionId, [{
    id: `recording-stopped-${Date.now()}`,
    recordingSessionId,
    timestamp: stoppedAt,
    source: 'playwrightRecorder',
    type: 'recording_stopped',
    rawEvidence: { eventCount: active.events.length, screenshots, savedAuthState },
  }]);

  try { await active.context.close(); } catch {}
  try { await active.browser?.close(); } catch {}

  const runtime = { status: 'stopped', active: false, stoppedAt, eventCount: countEventsOnDisk(recordingSessionId), screenshots, savedAuthState };
  writeRuntimeStatus(recordingSessionId, runtime);
  return { active: true, ...runtime };
}

function attachPageHandlers({ recordingSessionId, page, append, tab = null }) {
  if (page.__browsyAttached) return;
  page.__browsyAttached = true;
  page.on('framenavigated', frame => {
    append({
      type: frame === page.mainFrame() ? 'page_navigated' : 'frame_navigated',
      pageId: tab?.id || null,
      pageUrl: frame.url(),
      rawEvidence: { url: frame.url(), frameName: frame.name(), isMainFrame: frame === page.mainFrame(), tab },
    });
  });
  page.on('download', async download => {
    append({ type: 'download_started', pageId: tab?.id || null, pageUrl: page.url(), rawEvidence: { suggestedFilename: download.suggestedFilename(), url: page.url() } });
    try {
      const suggested = download.suggestedFilename();
      const target = path.join(recordingDir(recordingSessionId), 'downloads', suggested || `download-${Date.now()}`);
      ensureDir(path.dirname(target));
      await download.saveAs(target);
      append({ type: 'download_saved', pageId: tab?.id || null, pageUrl: page.url(), rawEvidence: { suggestedFilename: suggested, savedPath: target, url: page.url() } });
    } catch (err) {
      append({ type: 'download_failed', pageId: tab?.id || null, pageUrl: page.url(), rawEvidence: { suggestedFilename: download.suggestedFilename(), error: err.message, url: page.url() } });
    }
  });
}

function recorderInitScript(recordingSessionId) {
  return `(() => {
    if (window.__browsyRecorderInstalled) return;
    window.__browsyRecorderInstalled = true;
    const recordingSessionId = ${JSON.stringify(recordingSessionId)};
    const dangerousWords = /submit|release|publish|pay|purchase|checkout|delete|remove|confirm|certify|agree|final/i;
    const outputWords = /success|confirmation|confirmed|receipt|reference|tracking|case|ticket|request|order|submitted|complete|completed|saved|published|id|number|link/i;
    let outputScanTimer = null;
    function textOf(el) { return (el?.innerText || el?.textContent || el?.value || el?.getAttribute?.('aria-label') || el?.getAttribute?.('title') || '').trim().slice(0, 240); }
    function labelText(el) { if (!el) return ''; if (el.id) { const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (label) return textOf(label); } return el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || el.getAttribute?.('title') || ''; }
    function baseCss(el) {
      if (!el || !el.tagName) return '';
      if (el.id) return '#' + CSS.escape(el.id);
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
      if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
      const name = el.getAttribute('name');
      if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
      const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder');
      if (aria) return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(aria) + '"]';
      return '';
    }
    function structuralSelector(el) { const parts = []; let node = el; while (node && node.nodeType === 1 && parts.length < 5) { let part = node.tagName.toLowerCase(); if (node.className && typeof node.className === 'string') { const cls = node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2); if (cls.length) part += '.' + cls.map(c => CSS.escape(c)).join('.'); } const parent = node.parentElement; if (parent) { const siblings = Array.from(parent.children).filter(child => child.tagName === node.tagName); if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'; } parts.unshift(part); node = parent; } return parts.join(' > '); }
    function selectorFor(el) { return baseCss(el) || structuralSelector(el); }
    function candidatesFor(el) { const out = []; const push = (selector, kind, confidence, score) => { if (selector && !out.some(x => x.selector === selector)) out.push({ selector, kind, confidence, score }); }; push(el?.id ? '#' + CSS.escape(el.id) : '', 'id', 'high', 100); const testId = el?.getAttribute?.('data-testid') || el?.getAttribute?.('data-test'); push(testId ? '[data-testid="' + CSS.escape(testId) + '"]' : '', 'testid', 'high', 95); const name = el?.getAttribute?.('name'); push(name ? el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]' : '', 'name', 'high', 90); const role = el?.getAttribute?.('role'); const label = labelText(el) || textOf(el); push(role && label ? '[role="' + CSS.escape(role) + '"]' : '', 'role', 'medium', 75); push(label ? el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(label) + '"]' : '', 'aria-or-label', 'medium', 70); push(structuralSelector(el), 'css-path', 'medium', 50); const root = el?.getRootNode?.(); if (root && root.host) push(selectorFor(root.host) + ' >>> ' + selectorFor(el), 'shadow-pierce', 'medium', 65); return out.sort((a, b) => b.score - a.score); }
    function send(type, el, rawEvidence = {}) { const selector = rawEvidence.selector || selectorFor(el); const payload = { id: type + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), recordingSessionId, timestamp: new Date().toISOString(), source: 'playwrightRecorder', type, pageUrl: location.href, frameUrl: location.href, pageTitle: document.title, selector, rawEvidence: { selector, selectorCandidates: rawEvidence.selectorCandidates || candidatesFor(el), selectorConfidence: rawEvidence.selectorConfidence || (selector && selector.startsWith('#') ? 'high' : 'medium'), labelText: el ? labelText(el) : '', textPreview: el ? textOf(el) : '', ...rawEvidence } }; try { window.__browsyRecordEvent(payload); } catch {} }
    function scheduleOutputScan() { clearTimeout(outputScanTimer); outputScanTimer = setTimeout(scanOutputs, 250); }
    function scanOutputs() { const nodes = Array.from(document.querySelectorAll('[id],[data-testid],[data-test],a,button,div,span,p,h1,h2,h3,strong,code,pre')).slice(0, 500); for (const el of nodes) { const text = textOf(el); const id = el.id || el.getAttribute('data-testid') || el.getAttribute('data-test') || ''; if (!text || text.length > 240) continue; if (outputWords.test(id + ' ' + text)) send('output_candidate_detected', el, { outputId: id || '', text, reason: 'auto-output-scan' }); } }
    document.addEventListener('click', event => { const target = event.composedPath ? event.composedPath()[0] : event.target; const el = target && target.closest ? target.closest('button,a,input,select,textarea,[role="button"],[data-testid],[data-test]') : target; if (!el) return; const label = textOf(el); send(dangerousWords.test(label) ? 'dangerous_action_candidate_detected' : 'action_detected', el, { label, text: label, tagName: el.tagName, inputType: el.getAttribute?.('type') || null }); scheduleOutputScan(); }, true);
    function recordInput(event) { const el = event.target; if (!el || !el.tagName) return; const tag = el.tagName.toLowerCase(); const inputType = (el.getAttribute('type') || tag || 'text').toLowerCase(); if (inputType === 'file') { const files = Array.from(el.files || []).map(file => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified })); send('file_selected', el, { id: el.id || el.name || '', name: el.name || '', label: labelText(el) || el.name || el.id || 'File', inputType: 'file', accept: el.accept || '', multiple: !!el.multiple, files }); return; } send('field_detected', el, { id: el.id || el.name || '', name: el.name || '', label: labelText(el) || el.name || el.id || '', inputType, value: el.type === 'password' ? '[redacted]' : el.value, textPreview: el.type === 'password' ? '[redacted]' : String(el.value || '').slice(0, 240) }); scheduleOutputScan(); }
    document.addEventListener('change', recordInput, true); document.addEventListener('input', recordInput, true); new MutationObserver(scheduleOutputScan).observe(document.documentElement || document.body, { childList: true, subtree: true, characterData: true }); window.__browsyCaptureOutput = (outputId, selector) => { const el = selector ? document.querySelector(selector) : null; send('output_captured', el, { outputId, text: el ? textOf(el) : '', selector }); }; setTimeout(scanOutputs, 500);
  })();`;
}

// Verify that every requested tab navigated away from about:blank. Auth-blocked
// tabs are counted as navigated (they landed somewhere, just not the target). Nav
// errors (page.goto threw) leave finalUrl null-ish; those are failures.
function buildTabVerification({ tabs, openedTabs }) {
  if (openedTabs.length !== tabs.length) {
    return {
      ok: false,
      expectedCount: tabs.length,
      openedCount: openedTabs.length,
      expectedUrls: tabs.map(t => t.url),
      actualUrls: openedTabs.map(t => t.finalUrl),
      blankTabs: [],
      navErrors: [],
      summary: `Expected ${tabs.length} tab(s) but got ${openedTabs.length}.`,
    };
  }
  const blankTabs = openedTabs
    .filter(t => isBlankUrl(t.finalUrl) && !isBlankUrl(t.requestedUrl))
    .map(t => ({ id: t.id, requestedUrl: t.requestedUrl, finalUrl: t.finalUrl }));
  const navErrors = openedTabs
    .filter(t => t.error)
    .map(t => ({ id: t.id, requestedUrl: t.requestedUrl, error: t.error }));
  const ok = blankTabs.length === 0 && navErrors.length === 0;
  const parts = [];
  if (blankTabs.length) parts.push(`${blankTabs.length} tab(s) still on about:blank (${blankTabs.map(t => t.id).join(', ')})`);
  if (navErrors.length) parts.push(`${navErrors.length} navigation error(s) (${navErrors.map(t => t.id).join(', ')})`);
  return {
    ok,
    expectedCount: tabs.length,
    openedCount: openedTabs.length,
    expectedUrls: tabs.map(t => t.url),
    actualUrls: openedTabs.map(t => t.finalUrl),
    blankTabs,
    navErrors,
    summary: ok ? 'All tabs navigated successfully.' : parts.join('; '),
  };
}

function appendEventsToDisk(recordingSessionId, events = []) { const dir = recordingDir(recordingSessionId); ensureDir(dir); const eventsPath = path.join(dir, 'events.json'); const existing = exists(eventsPath) ? readJson(eventsPath) : []; const merged = [...(Array.isArray(existing) ? existing : []), ...events]; writeJson(eventsPath, merged); const sessionPath = path.join(dir, 'session.json'); if (exists(sessionPath)) { const session = readJson(sessionPath); writeJson(sessionPath, { ...session, events: merged, updatedAt: new Date().toISOString() }); } }
async function capturePageScreenshot({ recordingSessionId, page, pageId = 'page', reason = 'capture' }) { try { const dir = path.join(recordingDir(recordingSessionId), 'screenshots'); ensureDir(dir); const name = `${safeSegment(pageId)}-${safeSegment(reason)}-${Date.now()}.png`; const filePath = path.join(dir, name); await page.screenshot({ path: filePath, fullPage: true }); return { name, path: filePath, pageUrl: page.url(), reason }; } catch { return null; } }
function resolveAuthProfile(session, options = {}) { const setup = session?.recordingSetup || {}; const tabs = Array.isArray(setup.tabs) ? setup.tabs : []; const firstAuth = Array.isArray(session?.auth) ? session.auth[0] : null; const firstSiteTab = tabs.find(t => t.siteId); const firstProfileTab = tabs.find(t => t.authProfileId || t.authGroupId || t.ssoProfileId); const explicit = options.authProfileId || options.authGroupId || options.ssoProfileId || setup.authProfileId || setup.authGroupId || setup.ssoProfileId || firstProfileTab?.authProfileId || firstProfileTab?.authGroupId || firstProfileTab?.ssoProfileId; const authProfileId = safeSegment(explicit || firstAuth?.siteId || firstSiteTab?.siteId || session?.appId || 'default'); const appSegment = safeSegment(session?.appId || 'default'); const dir = path.join(OUTPUT_DIR, 'auth-profiles', appSegment, authProfileId); return { authProfileId, appId: appSegment, userDataDir: path.join(dir, 'user-data'), storageStatePath: path.join(dir, 'storageState.json') }; }
function writeRuntimeStatus(recordingSessionId, status) { const dir = recordingDir(recordingSessionId); ensureDir(dir); writeJson(path.join(dir, 'runtime-status.json'), { recordingSessionId, updatedAt: new Date().toISOString(), ...status }); }
function countEventsOnDisk(recordingSessionId) { const p = path.join(recordingDir(recordingSessionId), 'events.json'); if (!exists(p)) return 0; const events = readJson(p); return Array.isArray(events) ? events.length : 0; }
function normalizeEvent(recordingSessionId, event = {}) { return { id: event.id || `${event.type || 'event'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, recordingSessionId, timestamp: event.timestamp || new Date().toISOString(), source: event.source || 'playwrightRecorder', pageUrl: event.pageUrl || null, pageTitle: event.pageTitle || null, selector: event.selector || null, rawEvidence: event.rawEvidence || {}, ...event }; }
async function safeTitle(page) { try { return await page.title(); } catch { return ''; } }
function recordingDir(recordingSessionId) { return path.join(OUTPUT_DIR, 'recordings', safeSegment(recordingSessionId)); }
function safeSegment(value = '') { return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'; }
