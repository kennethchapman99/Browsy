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
  };
}

export async function startPlaywrightRecording({ recordingSessionId, session, options = {} } = {}) {
  if (!recordingSessionId) throw new Error('recordingSessionId is required');
  if (activeRecordings.has(recordingSessionId)) {
    return activeRecordings.get(recordingSessionId).launch;
  }
  const tabs = Array.isArray(session?.recordingSetup?.tabs) ? session.recordingSetup.tabs : [];
  if (!tabs.length) throw new Error('recording session has no tabs to launch');

  const startedAt = new Date().toISOString();
  const headless = options.headless === true || process.env.BROWSY_RECORDING_HEADLESS === 'true' || process.env.BROWSY_RECORDING_HEADLESS === '1';
  const slowMo = Number(options.slowMo || process.env.BROWSY_RECORDING_SLOWMO || 0) || 0;
  const browser = await chromium.launch({ headless, slowMo });
  const context = await browser.newContext({ acceptDownloads: true });
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
    append({
      type: 'page_opened',
      pageId: tab.id,
      pageUrl: tab.url,
      rawEvidence: { tab },
    });
    try {
      await page.goto(tab.url, { waitUntil: 'domcontentloaded', timeout: Number(options.navigationTimeoutMs || 60000) });
      append({
        type: 'page_seen',
        pageId: tab.id,
        pageUrl: page.url(),
        rawEvidence: { title: await safeTitle(page), url: page.url(), tab },
      });
    } catch (err) {
      append({
        type: 'page_navigation_failed',
        pageId: tab.id,
        pageUrl: tab.url,
        rawEvidence: { tab, error: err.message },
      });
    }
  }

  const launch = {
    createdAt: startedAt,
    mode: 'real_playwright_recorder',
    headless,
    pageCount: pages.length,
    tabs,
    auth: session?.auth || [],
    eventSink: `output/recordings/${recordingSessionId}/events.json`,
    observationSink: `output/recordings/${recordingSessionId}/observation.json`,
    instructions: [
      'Use the opened Playwright browser window to perform the workflow once.',
      'Browsy records generic page, input, click, file, download, navigation, and output events.',
      'Stop/import the recording through the recording session page or API.',
      'Final/publish/pay/delete actions should remain human-approved checkpoints.',
    ],
  };

  activeRecordings.set(recordingSessionId, { browser, context, pages, tabs, events, startedAt, launch });
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
  appendEventsToDisk(recordingSessionId, [{
    id: `recording-stopped-${Date.now()}`,
    recordingSessionId,
    timestamp: stoppedAt,
    source: 'playwrightRecorder',
    type: 'recording_stopped',
    rawEvidence: { eventCount: active.events.length },
  }]);
  try { await active.context.close(); } catch {}
  try { await active.browser.close(); } catch {}
  writeRuntimeStatus(recordingSessionId, { status: 'stopped', active: false, stoppedAt, eventCount: countEventsOnDisk(recordingSessionId) });
  return { active: true, stoppedAt, eventCount: countEventsOnDisk(recordingSessionId) };
}

function attachPageHandlers({ recordingSessionId, page, append, tab = null }) {
  if (page.__browsyAttached) return;
  page.__browsyAttached = true;
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return;
    append({
      type: 'page_navigated',
      pageId: tab?.id || null,
      pageUrl: frame.url(),
      rawEvidence: { url: frame.url(), tab },
    });
  });
  page.on('download', async download => {
    append({
      type: 'download_started',
      pageId: tab?.id || null,
      pageUrl: page.url(),
      rawEvidence: { suggestedFilename: download.suggestedFilename(), url: page.url() },
    });
    try {
      const suggested = download.suggestedFilename();
      const target = path.join(recordingDir(recordingSessionId), 'downloads', suggested || `download-${Date.now()}`);
      ensureDir(path.dirname(target));
      await download.saveAs(target);
      append({
        type: 'download_saved',
        pageId: tab?.id || null,
        pageUrl: page.url(),
        rawEvidence: { suggestedFilename: suggested, savedPath: target, url: page.url() },
      });
    } catch (err) {
      append({
        type: 'download_failed',
        pageId: tab?.id || null,
        pageUrl: page.url(),
        rawEvidence: { suggestedFilename: download.suggestedFilename(), error: err.message, url: page.url() },
      });
    }
  });
}

function recorderInitScript(recordingSessionId) {
  return `(() => {
    if (window.__browsyRecorderInstalled) return;
    window.__browsyRecorderInstalled = true;
    const recordingSessionId = ${JSON.stringify(recordingSessionId)};
    const dangerousWords = /submit|release|publish|pay|purchase|checkout|delete|remove|confirm|certify|agree|final/i;
    function textOf(el) {
      return (el?.innerText || el?.textContent || el?.value || el?.getAttribute?.('aria-label') || el?.getAttribute?.('title') || '').trim().slice(0, 240);
    }
    function selectorFor(el) {
      if (!el || !el.tagName) return '';
      if (el.id) return '#' + CSS.escape(el.id);
      const name = el.getAttribute('name');
      if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
      const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder');
      if (label) return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(label) + '"]';
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
      if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 4) {
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
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    }
    function candidatesFor(el) {
      const selector = selectorFor(el);
      const out = [];
      if (selector) out.push({ selector, kind: selector.startsWith('#') ? 'id' : 'css', confidence: selector.startsWith('#') ? 'high' : 'medium' });
      const name = el?.getAttribute?.('name');
      if (name) out.push({ selector: el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]', kind: 'name', confidence: 'high' });
      const testId = el?.getAttribute?.('data-testid') || el?.getAttribute?.('data-test');
      if (testId) out.push({ selector: '[data-testid="' + CSS.escape(testId) + '"]', kind: 'testid', confidence: 'high' });
      return out;
    }
    function send(type, el, rawEvidence = {}) {
      const selector = rawEvidence.selector || selectorFor(el);
      const payload = {
        id: type + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        recordingSessionId,
        timestamp: new Date().toISOString(),
        source: 'playwrightRecorder',
        type,
        pageUrl: location.href,
        pageTitle: document.title,
        selector,
        rawEvidence: {
          selector,
          selectorCandidates: rawEvidence.selectorCandidates || candidatesFor(el),
          selectorConfidence: rawEvidence.selectorConfidence || (selector && selector.startsWith('#') ? 'high' : 'medium'),
          ...rawEvidence,
        },
      };
      try { window.__browsyRecordEvent(payload); } catch {}
    }
    document.addEventListener('click', event => {
      const el = event.target && event.target.closest ? event.target.closest('button,a,input,select,textarea,[role="button"],[data-testid],[data-test]') : event.target;
      if (!el) return;
      const label = textOf(el);
      const type = dangerousWords.test(label) ? 'dangerous_action_candidate_detected' : 'action_detected';
      send(type, el, { label, text: label, tagName: el.tagName, inputType: el.getAttribute?.('type') || null });
    }, true);
    function recordInput(event) {
      const el = event.target;
      if (!el || !el.tagName) return;
      const tag = el.tagName.toLowerCase();
      const inputType = (el.getAttribute('type') || tag || 'text').toLowerCase();
      if (inputType === 'file') {
        const files = Array.from(el.files || []).map(file => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified }));
        send('file_selected', el, { id: el.id || el.name || '', name: el.name || '', label: el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.name || el.id || 'File', inputType: 'file', accept: el.accept || '', multiple: !!el.multiple, files });
        return;
      }
      send('field_detected', el, { id: el.id || el.name || '', name: el.name || '', label: el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || '', inputType, value: el.type === 'password' ? '[redacted]' : el.value, textPreview: el.type === 'password' ? '[redacted]' : String(el.value || '').slice(0, 240) });
    }
    document.addEventListener('change', recordInput, true);
    document.addEventListener('input', recordInput, true);
    window.__browsyCaptureOutput = (outputId, selector) => {
      const el = selector ? document.querySelector(selector) : null;
      send('output_captured', el, { outputId, text: el ? textOf(el) : '', selector });
    };
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

function writeRuntimeStatus(recordingSessionId, status) {
  const dir = recordingDir(recordingSessionId);
  ensureDir(dir);
  writeJson(path.join(dir, 'runtime-status.json'), { recordingSessionId, updatedAt: new Date().toISOString(), ...status });
}

function countEventsOnDisk(recordingSessionId) {
  const eventsPath = path.join(recordingDir(recordingSessionId), 'events.json');
  if (!exists(eventsPath)) return 0;
  const events = readJson(eventsPath);
  return Array.isArray(events) ? events.length : 0;
}

function normalizeEvent(recordingSessionId, event = {}) {
  return {
    id: event.id || `${event.type || 'event'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    recordingSessionId,
    timestamp: event.timestamp || new Date().toISOString(),
    source: event.source || 'playwrightRecorder',
    pageUrl: event.pageUrl || null,
    pageTitle: event.pageTitle || null,
    selector: event.selector || null,
    rawEvidence: event.rawEvidence || {},
    ...event,
  };
}

async function safeTitle(page) {
  try { return await page.title(); } catch { return ''; }
}

function recordingDir(recordingSessionId) {
  return path.join(OUTPUT_DIR, 'recordings', String(recordingSessionId || '').replace(/[^a-zA-Z0-9_-]+/g, '-'));
}
