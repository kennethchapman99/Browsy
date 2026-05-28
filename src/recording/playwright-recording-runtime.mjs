import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { OUTPUT_DIR, ensureDir, exists, readJson, writeJson } from '../core/paths.mjs';

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

  const startedAt = new Date().toISOString();
  const headless = options.headless === true || process.env.BROWSY_RECORDING_HEADLESS === 'true' || process.env.BROWSY_RECORDING_HEADLESS === '1';
  const slowMo = Number(options.slowMo || process.env.BROWSY_RECORDING_SLOWMO || 0) || 0;
  const authProfile = resolveAuthProfile(session, options);
  const contextOptions = { acceptDownloads: true };
  if (authProfile.storageStatePath && exists(authProfile.storageStatePath) && options.ignoreStorageState !== true) {
    contextOptions.storageState = authProfile.storageStatePath;
  }

  let browser = null;
  let context = null;
  if (options.usePersistentProfile === true || process.env.BROWSY_RECORDING_PERSISTENT_PROFILE === 'true') {
    ensureDir(authProfile.userDataDir);
    context = await chromium.launchPersistentContext(authProfile.userDataDir, { headless, slowMo, acceptDownloads: true });
  } else {
    browser = await chromium.launch({ headless, slowMo });
    context = await browser.newContext(contextOptions);
  }

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
  context.on('page', page => attachPageHandlers({ recordingSessionId, page, append }));

  for (const tab of tabs) {
    const page = await context.newPage();
    pages.push(page);
    attachPageHandlers({ recordingSessionId, page, append, tab });
    append({ type: 'page_opened', pageId: tab.id, pageUrl: tab.url, rawEvidence: { tab, authProfile } });
    try {
      await page.goto(tab.url, { waitUntil: 'domcontentloaded', timeout: Number(options.navigationTimeoutMs || 60000) });
      append({ type: 'page_seen', pageId: tab.id, pageUrl: page.url(), rawEvidence: { title: await safeTitle(page), url: page.url(), tab } });
      await capturePageScreenshot({ recordingSessionId, page, pageId: tab.id, reason: 'page_seen' });
    } catch (err) {
      append({ type: 'page_navigation_failed', pageId: tab.id, pageUrl: tab.url, rawEvidence: { tab, error: err.message } });
    }
  }

  const launch = {
    createdAt: startedAt,
    mode: 'real_playwright_recorder',
    headless,
    pageCount: pages.length,
    tabs,
    auth: session?.auth || [],
    authProfile,
    eventSink: `output/recordings/${recordingSessionId}/events.json`,
    observationSink: `output/recordings/${recordingSessionId}/observation.json`,
    screenshotSink: `output/recordings/${recordingSessionId}/screenshots`,
    instructions: [
      'Use the opened Playwright browser window to perform the workflow once.',
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
    function structuralSelector(el) {
      const parts = []; let node = el;
      while (node && node.nodeType === 1 && parts.length < 5) {
        let part = node.tagName.toLowerCase();
        if (node.className && typeof node.className === 'string') {
          const cls = node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2);
          if (cls.length) part += '.' + cls.map(c => CSS.escape(c)).join('.');
        }
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(child => child.tagName === node.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part); node = parent;
      }
      return parts.join(' > ');
    }
    function selectorFor(el) { return baseCss(el) || structuralSelector(el); }
    function candidatesFor(el) {
      const out = [];
      const push = (selector, kind, confidence, score) => { if (selector && !out.some(x => x.selector === selector)) out.push({ selector, kind, confidence, score }); };
      push(el?.id ? '#' + CSS.escape(el.id) : '', 'id', 'high', 100);
      const testId = el?.getAttribute?.('data-testid') || el?.getAttribute?.('data-test');
      push(testId ? '[data-testid="' + CSS.escape(testId) + '"]' : '', 'testid', 'high', 95);
      const name = el?.getAttribute?.('name');
      push(name ? el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]' : '', 'name', 'high', 90);
      const role = el?.getAttribute?.('role');
      const label = labelText(el) || textOf(el);
      push(role && label ? '[role="' + CSS.escape(role) + '"]' : '', 'role', 'medium', 75);
      push(label ? el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(label) + '"]' : '', 'aria-or-label', 'medium', 70);
      push(structuralSelector(el), 'css-path', 'medium', 50);
      const root = el?.getRootNode?.();
      if (root && root.host) push(selectorFor(root.host) + ' >>> ' + selectorFor(el), 'shadow-pierce', 'medium', 65);
      return out.sort((a, b) => b.score - a.score);
    }
    function send(type, el, rawEvidence = {}) {
      const selector = rawEvidence.selector || selectorFor(el);
      const payload = { id: type + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), recordingSessionId, timestamp: new Date().toISOString(), source: 'playwrightRecorder', type, pageUrl: location.href, frameUrl: location.href, pageTitle: document.title, selector, rawEvidence: { selector, selectorCandidates: rawEvidence.selectorCandidates || candidatesFor(el), selectorConfidence: rawEvidence.selectorConfidence || (selector && selector.startsWith('#') ? 'high' : 'medium'), labelText: el ? labelText(el) : '', textPreview: el ? textOf(el) : '', ...rawEvidence } };
      try { window.__browsyRecordEvent(payload); } catch {}
    }
    function scheduleOutputScan() { clearTimeout(outputScanTimer); outputScanTimer = setTimeout(scanOutputs, 250); }
    function scanOutputs() {
      const nodes = Array.from(document.querySelectorAll('[id],[data-testid],[data-test],a,button,div,span,p,h1,h2,h3,strong,code,pre')).slice(0, 500);
      for (const el of nodes) {
        const text = textOf(el); const id = el.id || el.getAttribute('data-testid') || el.getAttribute('data-test') || '';
        if (!text || text.length > 240) continue;
        if (outputWords.test(id + ' ' + text)) send('output_candidate_detected', el, { outputId: id || '', text, reason: 'auto-output-scan' });
      }
    }
    document.addEventListener('click', event => { const target = event.composedPath ? event.composedPath()[0] : event.target; const el = target && target.closest ? target.closest('button,a,input,select,textarea,[role="button"],[data-testid],[data-test]') : target; if (!el) return; const label = textOf(el); send(dangerousWords.test(label) ? 'dangerous_action_candidate_detected' : 'action_detected', el, { label, text: label, tagName: el.tagName, inputType: el.getAttribute?.('type') || null }); scheduleOutputScan(); }, true);
    function recordInput(event) { const el = event.target; if (!el || !el.tagName) return; const tag = el.tagName.toLowerCase(); const inputType = (el.getAttribute('type') || tag || 'text').toLowerCase(); if (inputType === 'file') { const files = Array.from(el.files || []).map(file => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified })); send('file_selected', el, { id: el.id || el.name || '', name: el.name || '', label: labelText(el) || el.name || el.id || 'File', inputType: 'file', accept: el.accept || '', multiple: !!el.multiple, files }); return; } send('field_detected', el, { id: el.id || el.name || '', name: el.name || '', label: labelText(el) || el.name || el.id || '', inputType, value: el.type === 'password' ? '[redacted]' : el.value, textPreview: el.type === 'password' ? '[redacted]' : String(el.value || '').slice(0, 240) }); scheduleOutputScan(); }
    document.addEventListener('change', recordInput, true); document.addEventListener('input', recordInput, true);
    new MutationObserver(scheduleOutputScan).observe(document.documentElement || document.body, { childList: true, subtree: true, characterData: true });
    window.__browsyCaptureOutput = (outputId, selector) => { const el = selector ? document.querySelector(selector) : null; send('output_captured', el, { outputId, text: el ? textOf(el) : '', selector }); };
    setTimeout(scanOutputs, 500);
  })();`;
}

function appendEventsToDisk(recordingSessionId, events = []) {
  const dir = recordingDir(recordingSessionId);
  ensureDir(dir);
  const eventsPath = path.join(dir, 'events.json');
  const existing = exists(eventsPath) ? readJson(eventsPath) : [];
  const merged = [...(Array.isArray(existing) ? existing : []), ...events];
  writeJson(eventsPath, merged);
  const sessionPath = path.join(dir, 'session.json');
  if (exists(sessionPath)) {
    const session = readJson(sessionPath);
    writeJson(sessionPath, { ...session, events: merged, updatedAt: new Date().toISOString() });
  }
}

async function capturePageScreenshot({ recordingSessionId, page, pageId = 'page', reason = 'capture' }) {
  try {
    const dir = path.join(recordingDir(recordingSessionId), 'screenshots');
    ensureDir(dir);
    const name = `${safeSegment(pageId)}-${safeSegment(reason)}-${Date.now()}.png`;
    const filePath = path.join(dir, name);
    await page.screenshot({ path: filePath, fullPage: true });
    return { name, path: filePath, pageUrl: page.url(), reason };
  } catch { return null; }
}

function resolveAuthProfile(session, options = {}) {
  const firstAuth = Array.isArray(session?.auth) ? session.auth[0] : null;
  const firstSiteTab = Array.isArray(session?.recordingSetup?.tabs) ? session.recordingSetup.tabs.find(t => t.siteId) : null;
  const authProfileId = safeSegment(options.authProfileId || firstAuth?.siteId || firstSiteTab?.siteId || session?.appId || 'default');
  const dir = path.join(OUTPUT_DIR, 'auth-profiles', authProfileId);
  return { authProfileId, userDataDir: path.join(dir, 'user-data'), storageStatePath: path.join(dir, 'storageState.json') };
}

function writeRuntimeStatus(recordingSessionId, status) { const dir = recordingDir(recordingSessionId); ensureDir(dir); writeJson(path.join(dir, 'runtime-status.json'), { recordingSessionId, updatedAt: new Date().toISOString(), ...status }); }
function countEventsOnDisk(recordingSessionId) { const p = path.join(recordingDir(recordingSessionId), 'events.json'); if (!exists(p)) return 0; const events = readJson(p); return Array.isArray(events) ? events.length : 0; }
function normalizeEvent(recordingSessionId, event = {}) { return { id: event.id || `${event.type || 'event'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, recordingSessionId, timestamp: event.timestamp || new Date().toISOString(), source: event.source || 'playwrightRecorder', pageUrl: event.pageUrl || null, pageTitle: event.pageTitle || null, selector: event.selector || null, rawEvidence: event.rawEvidence || {}, ...event }; }
async function safeTitle(page) { try { return await page.title(); } catch { return ''; } }
function recordingDir(recordingSessionId) { return path.join(OUTPUT_DIR, 'recordings', safeSegment(recordingSessionId)); }
function safeSegment(value = '') { return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'; }
