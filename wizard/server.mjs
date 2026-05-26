#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateExecArgs } from './arg-validator.mjs';
import { evaluateProjectReadiness, writeAutomationProjectDraft } from '../src/core/project-model.mjs';
import {
  normalizeObservation,
  inferRepeatGroups,
  inferCapturedOutputs,
  inferRuntimeVariables,
  buildWorkflowPackageFromObservation,
  buildWorkflowConfigFromObservation,
  buildRunPlanFromObservation,
} from '../src/core/observation-ingestion.mjs';
import { createEvent, validateEvent, deriveStatsFromEvents, CAPTURE_SOURCES } from '../src/core/observation-events.mjs';
import { captureVisualEvidence, evidenceToRawEvidence } from '../src/adapters/observation/visual-evidence-adapter.mjs';
import { buildRecorderPackage } from '../src/core/recorder-package.mjs';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 3333;

const ALLOWED_COMMANDS = new Set([
  'validate-request', 'plan', 'init', 'auth', 'discover', 'discover:all',
  'run', 'review', 'feedback', 'promote',
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function has(filePath) { return fs.existsSync(filePath); }
function safeWorkflowId(id) { return /^[a-z0-9][a-z0-9\-_]{0,63}$/.test(id || ''); }
function json(res, status, payload) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); }

function latestRunInfo(runsDir) {
  if (!has(runsDir)) return { latestRun: null, latestRunDir: null, runs: [] };
  const runs = fs.readdirSync(runsDir)
    .filter(d => fs.statSync(path.join(runsDir, d)).isDirectory())
    .sort().reverse();
  const latestRun = runs[0] || null;
  return { latestRun, latestRunDir: latestRun ? path.join(runsDir, latestRun) : null, runs };
}

function getWorkflowState(workflowId) {
  const wfDir = path.join(REPO_ROOT, 'workflows', workflowId);
  const runsDir = path.join(REPO_ROOT, 'output', 'runs', workflowId);
  const authFile = path.join(REPO_ROOT, '.auth', `${workflowId}.json`);
  const outputObservationDir = path.join(REPO_ROOT, 'output', 'observations', workflowId);
  const { latestRun, latestRunDir, runs } = latestRunInfo(runsDir);

  const scaffolded = has(path.join(wfDir, 'workflow.json'));
  const projectDrafted = has(path.join(wfDir, 'project.json'));
  const validated = has(path.join(REPO_ROOT, 'output', 'plans', workflowId, 'build-plan.md'));

  let requestDone = false;
  const reqFile = path.join(REPO_ROOT, 'AUTOMATION_REQUEST.md');
  if (has(reqFile)) {
    try {
      const reqText = fs.readFileSync(reqFile, 'utf8');
      requestDone = reqText.includes(`\`${workflowId}\``) || reqText.includes(`"${workflowId}"`);
    } catch { requestDone = false; }
  }
  if (scaffolded || projectDrafted) requestDone = true;

  const hasDiscovery = has(runsDir) && runs.some(r => has(path.join(runsDir, r, 'discovered-fields.json')));
  let hasReview = false;
  let hasErrors = false;
  if (latestRunDir) {
    hasReview = has(path.join(latestRunDir, 'run-review.md'));
    const errorsPath = path.join(latestRunDir, 'errors.json');
    if (has(errorsPath)) {
      try { hasErrors = (JSON.parse(fs.readFileSync(errorsPath, 'utf8')) || []).length > 0; }
      catch { hasErrors = false; }
    }
  }

  const feedbackDir = path.join(wfDir, 'feedback');
  const readiness = evaluateProjectReadiness({ workflowDir: wfDir, runsDir, outputObservationDir });

  return {
    workflowId,
    stages: {
      request: { done: requestDone },
      validate: { done: validated || scaffolded || projectDrafted },
      package: { done: projectDrafted },
      observation: { done: readiness.states.observation_captured, needed: readiness.states.observation_needed },
      scaffold: { done: scaffolded },
      auth: { done: has(authFile) },
      discover: { done: hasDiscovery },
      'field-map': { done: readiness.states.field_map_verified, candidates: readiness.states.field_map_candidate_ready },
      'dry-run': { done: latestRun !== null, error: hasErrors, runId: latestRun },
      review: { done: hasReview, runId: latestRun },
      feedback: { done: has(feedbackDir) && fs.readdirSync(feedbackDir).length > 0 },
      'live-run': { done: readiness.states.live_run_completed, gated: readiness.states.live_run_gated },
      'output-capture': { done: readiness.states.output_capture_completed },
      promote: { done: has(path.join(wfDir, 'PROMOTED')) },
    },
    readiness,
    latestRun,
    workflowDir: wfDir,
    runsDir,
  };
}

function listWorkflows() {
  const wfRoot = path.join(REPO_ROOT, 'workflows');
  if (!has(wfRoot)) return [];
  return fs.readdirSync(wfRoot).filter(d => {
    const dir = path.join(wfRoot, d);
    return fs.statSync(dir).isDirectory() && (has(path.join(dir, 'workflow.json')) || has(path.join(dir, 'project.json')));
  });
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') return 'application/json';
  if (ext === '.md') return 'text/plain; charset=utf-8';
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.yaml' || ext === '.yml') return 'text/yaml; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function repoSafe(filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(REPO_ROOT)) throw new Error('forbidden');
  return resolved;
}

// ── Observation session store ────────────────────────────────────────────────
//
// In-memory only. Each session holds the captured events and (for playwright
// recorder sessions) the live browser/page handles so we can close them later.
// Stats are *derived* from session.events — never set independently.

const obsSessions = new Map();

function newSessionId() {
  return `obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function pushEventToSession(session, partial) {
  const event = createEvent({ sessionId: session.id, ...partial });
  const errs = validateEvent(event);
  if (errs.length) {
    console.warn(`[wizard] dropping invalid event for ${session.id}: ${errs.join(', ')}`);
    return null;
  }
  session.events.push(event);
  return event;
}

// Pick (or mint) a stable pageId for a Playwright Page. Stored on the session's
// WeakMap so the same Page handle always reports the same id across listeners.
function ensurePageId(session, page) {
  if (!page) return null;
  if (!session.pageIds) session.pageIds = new WeakMap();
  let id = session.pageIds.get(page);
  if (id) return id;
  session.pageCounter = (session.pageCounter || 0) + 1;
  id = `p${session.pageCounter}-${crypto.randomBytes(2).toString('hex')}`;
  session.pageIds.set(page, id);
  return id;
}

function ensureFrameId(session, frame) {
  if (!frame) return null;
  if (!session.frameIds) session.frameIds = new WeakMap();
  let id = session.frameIds.get(frame);
  if (id) return id;
  session.frameCounter = (session.frameCounter || 0) + 1;
  id = `f${session.frameCounter}-${crypto.randomBytes(2).toString('hex')}`;
  session.frameIds.set(frame, id);
  return id;
}

// Capture per-state visual evidence (screenshot + DOM snapshot + visible text)
// and emit a `page_snapshot_captured` event tied to the same page URL. This is
// best-effort — failures attach to the event payload rather than aborting.
//
// `kind` is one of:
//   'session_start'   — initial page load
//   'navigation'      — after framenavigated
//   'click_after'     — after a click on an action-like element
//   'add_instance'    — after a repeat-group add-button click
//   'page_opened'     — a new tab/popup appeared
//   'file_selected'   — a file input change
//   'file_dropped'    — a drag/drop upload completed
//   'paste'           — clipboard paste
//   'submit'          — form submit
//   'download'        — a download started
async function captureSnapshot(session, { kind, hint, settleMs = 150, page = null } = {}) {
  const targetPage = page || pickPageForSnapshot(session);
  if (!session || !targetPage) return null;
  if (session.state === 'finished') return null;
  // Serialize captures per-session so events land in a stable order even
  // when multiple actions fire in rapid succession. Without this, two clicks
  // close together can produce out-of-order page_snapshot_captured events
  // that depend on screenshot wall-clock time — fatal for golden stability.
  const prev = session.snapshotChain || Promise.resolve();
  const next = prev.then(async () => {
    if (session.state === 'finished') return null;
    if (targetPage.isClosed && targetPage.isClosed()) return null;
    if (settleMs > 0) {
      try { await new Promise(r => setTimeout(r, settleMs)); } catch {}
    }
    session.snapshotCounter = (session.snapshotCounter || 0) + 1;
    const evidence = await captureVisualEvidence({
      page: targetPage,
      sessionId: session.id,
      repoRoot: REPO_ROOT,
      kind,
      hint: hint || null,
      index: session.snapshotCounter,
    });
    const pageId = ensurePageId(session, targetPage);
    return pushEventToSession(session, {
      source: 'playwrightRecorder',
      type: 'page_snapshot_captured',
      pageId,
      pageUrl: evidence.url || (targetPage && targetPage.url()),
      pageTitle: evidence.title || null,
      rawEvidence: evidenceToRawEvidence(evidence),
    });
  });
  // Keep the chain alive even if one snapshot throws, so subsequent ones
  // still run. The .catch here only neutralizes rejection for the *chain*;
  // the original promise (`next`) is what callers await.
  session.snapshotChain = next.catch(() => {});
  return next;
}

// Choose a page to screenshot from. The first opened page is the primary
// target, but if it has closed we fall back to any other open page in the
// context so per-action snapshots still land somewhere meaningful.
function pickPageForSnapshot(session) {
  if (session.page && (!session.page.isClosed || !session.page.isClosed())) return session.page;
  if (session.context) {
    const open = session.context.pages().filter(p => !p.isClosed || !p.isClosed());
    if (open.length) return open[open.length - 1];
  }
  return null;
}

function sessionSummary(session) {
  return {
    id: session.id,
    source: session.source,
    state: session.state,
    startUrl: session.startUrl || null,
    workflowId: session.workflowId || null,
    startedAt: session.startedAt || null,
    finishedAt: session.finishedAt || null,
    events: session.events,
    stats: deriveStatsFromEvents(session.events),
  };
}

// The script injected into every page (and every frame) of a Playwright
// observation session via `context.addInitScript`. It attaches DOM listeners
// and emits structured events back to the server via window.__browsyEmit,
// which the server wires up with `context.exposeBinding` so each call also
// carries the originating page+frame info.
//
// Only listens — never writes to the page, never copies file contents.
//
// File / drag-drop / paste capture is privacy-preserving:
//   - File metadata only (name, size, type, lastModified). Never bytes.
//   - Clipboard previews are length-capped to ~120 chars. The full payload is
//     never exfiltrated.
const PLAYWRIGHT_OBS_INIT_SCRIPT = `(() => {
  if (window.__browsyAttached) return;
  window.__browsyAttached = true;

  const RICH_EDITOR_SEL = '[contenteditable=""], [contenteditable="true"], [role="textbox"], .ProseMirror, .ql-editor, .DraftEditor-root, .tiptap';
  const TEXT_PREVIEW_MAX = 120;
  const RICH_TEXT_MAX = 240;

  const DANGEROUS_RX = /\\b(submit|publish|pay|delete|confirm|checkout|release|charge|purchase|send)\\b/i;
  const ADD_RX       = /\\badd(\\s+(another|track|row|speaker|item|more|file|line|entry))?\\b/i;

  function safeCss(s) {
    try { return CSS.escape(s); } catch { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'); }
  }

  // Heuristic — IDs like \`mui-12345\` / \`:r0:\` / \`__next-route-announcer__\`
  // / pure-numeric tails are framework-generated and not stable across renders.
  function looksStableId(id) {
    if (!id) return false;
    if (/^:/.test(id)) return false;                      // React useId(): ":r0:"
    if (/^__/.test(id)) return false;                     // Next.js / framework
    if (/^(mui|chakra|radix|headlessui|el|ember)-/i.test(id)) return false;
    if (/-[0-9]{4,}$/.test(id)) return false;             // \`foo-12345\` numeric tail
    if (/^[a-z0-9]{16,}$/i.test(id)) return false;        // long opaque hash
    return true;
  }

  function nthOfType(el) {
    if (!el || !el.parentNode) return 1;
    let i = 1;
    let sibling = el.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === el.tagName) i++;
      sibling = sibling.previousElementSibling;
    }
    return i;
  }

  // Build a ranked list of selector candidates for an element. Each entry has
  // a \`selector\` string, the \`kind\` of selector, and a coarse \`confidence\`
  // bucket ('high' | 'medium' | 'low') the run-time can use to decide whether
  // to trust the selector or to fall back to a downstream candidate.
  function selectorCandidatesFor(el) {
    if (!el || !el.tagName) return [];
    const tag = el.tagName.toLowerCase();
    const out = [];

    // HIGH — explicit test hooks / stable IDs / aria-labels
    const testIdAttr = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'].find(a => el.getAttribute(a));
    if (testIdAttr) {
      out.push({ selector: tag + '[' + testIdAttr + '="' + safeCss(el.getAttribute(testIdAttr)) + '"]', kind: testIdAttr, confidence: 'high' });
    }
    if (el.id && looksStableId(el.id)) {
      out.push({ selector: '#' + safeCss(el.id), kind: 'id', confidence: 'high' });
    }
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) {
      out.push({ selector: tag + '[aria-label="' + safeCss(aria) + '"]', kind: 'aria-label', confidence: 'high' });
    }
    const role = el.getAttribute && el.getAttribute('role');
    if (role) {
      out.push({ selector: tag + '[role="' + safeCss(role) + '"]', kind: 'role', confidence: 'medium' });
    }

    // MEDIUM — form name, framework-y ID kept anyway, label association
    if (el.name) {
      out.push({ selector: tag + '[name="' + safeCss(el.name) + '"]', kind: 'name', confidence: 'medium' });
    }
    if (el.id && !looksStableId(el.id)) {
      out.push({ selector: '#' + safeCss(el.id), kind: 'id-unstable', confidence: 'low' });
    }
    if (el.id) {
      try {
        const lab = document.querySelector('label[for="' + safeCss(el.id) + '"]');
        if (lab && lab.textContent) {
          out.push({ selector: 'label:has-text("' + lab.textContent.trim().replace(/"/g, '\\\\"') + '")', kind: 'label-text', confidence: 'medium' });
        }
      } catch {}
    }
    if ((tag === 'button' || tag === 'a') && el.textContent) {
      const txt = el.textContent.trim();
      if (txt && txt.length < 60) {
        out.push({ selector: tag + ':has-text("' + txt.replace(/"/g, '\\\\"') + '")', kind: 'text', confidence: 'medium' });
      }
    }

    // LOW — structural fallbacks
    out.push({ selector: tag + ':nth-of-type(' + nthOfType(el) + ')', kind: 'nth-of-type', confidence: 'low' });
    out.push({ selector: tag, kind: 'tag', confidence: 'low' });

    // De-duplicate by selector string (preserve order = preserve ranking)
    const seen = new Set();
    return out.filter(c => { if (seen.has(c.selector)) return false; seen.add(c.selector); return true; });
  }

  function selectorFor(el) {
    const cands = selectorCandidatesFor(el);
    return (cands[0] && cands[0].selector) || (el.tagName ? el.tagName.toLowerCase() : '');
  }
  function topConfidence(el) {
    const cands = selectorCandidatesFor(el);
    return (cands[0] && cands[0].confidence) || 'low';
  }
  function labelFor(el) {
    if (el.id) {
      try {
        const lab = document.querySelector('label[for="' + safeCss(el.id) + '"]');
        if (lab && lab.textContent) return lab.textContent.trim();
      } catch {}
    }
    return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || '';
  }
  function emit(data) {
    try { window.__browsyEmit(Object.assign({ pageUrl: location.href, pageTitle: document.title }, data)); } catch {}
  }
  function controlText(el) {
    return (el.textContent && el.textContent.trim()) || el.value || el.getAttribute('aria-label') || '';
  }

  function fieldEvent(el) {
    const t = (el.type || '').toLowerCase();
    let value = null;
    if (t === 'checkbox' || t === 'radio') value = !!el.checked;
    else if (t === 'file') value = el.files && el.files.length ? '<file: ' + el.files[0].name + '>' : null;
    else if (el.tagName === 'SELECT') value = el.value;
    else value = el.value;
    const cands = selectorCandidatesFor(el);
    emit({
      type: 'field_detected',
      selector: (cands[0] && cands[0].selector) || el.tagName.toLowerCase(),
      rawEvidence: {
        tag: el.tagName.toLowerCase(),
        inputType: t || null,
        name: el.name || null,
        id: el.id || null,
        label: labelFor(el),
        value,
        required: !!el.required,
        selectorCandidates: cands,
        selectorConfidence: (cands[0] && cands[0].confidence) || 'low',
        eventTrigger: 'user_interaction',
      },
    });
  }

  function actionEvent(el) {
    const label = controlText(el);
    const cands = selectorCandidatesFor(el);
    const sel = (cands[0] && cands[0].selector) || el.tagName.toLowerCase();
    const conf = (cands[0] && cands[0].confidence) || 'low';
    emit({
      type: 'action_detected',
      selector: sel,
      rawEvidence: {
        tag: el.tagName.toLowerCase(),
        label,
        type: el.type || null,
        href: el.getAttribute && el.getAttribute('href') || null,
        selectorCandidates: cands,
        selectorConfidence: conf,
      },
    });
    if (DANGEROUS_RX.test(label)) {
      emit({
        type: 'dangerous_action_candidate_detected',
        selector: sel,
        confidence: 0.85,
        rawEvidence: { label, matchedKeyword: (label.match(DANGEROUS_RX) || [])[0], selectorCandidates: cands, selectorConfidence: conf },
      });
    }
    if (ADD_RX.test(label)) {
      emit({
        type: 'repeat_group_candidate_detected',
        selector: sel,
        confidence: 0.8,
        rawEvidence: { label, matchedKeyword: (label.match(ADD_RX) || [])[0], selectorCandidates: cands, selectorConfidence: conf },
      });
    }
  }

  const scanned = new WeakSet();
  function initialScan() {
    document.querySelectorAll('input[type="file"]').forEach(el => {
      if (scanned.has(el)) return;
      scanned.add(el);
      const cands = selectorCandidatesFor(el);
      emit({
        type: 'field_detected',
        selector: (cands[0] && cands[0].selector) || 'input',
        rawEvidence: {
          tag: 'input', inputType: 'file', name: el.name || null, id: el.id || null,
          label: labelFor(el), isFileInput: true, required: !!el.required,
          accept: el.getAttribute('accept') || null,
          selectorCandidates: cands,
          selectorConfidence: (cands[0] && cands[0].confidence) || 'low',
          eventTrigger: 'initial_scan',
        },
      });
    });
    document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button], a[href]').forEach(el => {
      if (scanned.has(el)) return;
      const label = controlText(el);
      if (!label) return;
      const cands = selectorCandidatesFor(el);
      const sel = (cands[0] && cands[0].selector) || el.tagName.toLowerCase();
      const conf = (cands[0] && cands[0].confidence) || 'low';
      if (DANGEROUS_RX.test(label)) {
        scanned.add(el);
        emit({
          type: 'dangerous_action_candidate_detected',
          selector: sel,
          confidence: 0.85,
          rawEvidence: { label, matchedKeyword: (label.match(DANGEROUS_RX) || [])[0], selectorCandidates: cands, selectorConfidence: conf, eventTrigger: 'initial_scan' },
        });
      }
      if (ADD_RX.test(label)) {
        scanned.add(el);
        emit({
          type: 'repeat_group_candidate_detected',
          selector: sel,
          confidence: 0.8,
          rawEvidence: { label, matchedKeyword: (label.match(ADD_RX) || [])[0], selectorCandidates: cands, selectorConfidence: conf, eventTrigger: 'initial_scan' },
        });
      }
    });
  }

  document.addEventListener('input', e => {
    const el = e.target;
    if (!el || !el.matches) return;
    if (!el.matches('input, textarea, select')) return;
    const t = (el.type || '').toLowerCase();
    if (t === 'checkbox' || t === 'radio' || t === 'file') return;
    fieldEvent(el);
  }, true);

  document.addEventListener('change', e => {
    const el = e.target;
    if (!el || !el.matches) return;
    if (!el.matches('input, textarea, select')) return;
    fieldEvent(el);
  }, true);

  document.addEventListener('click', e => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    for (const node of path) {
      if (node && node.matches && node.matches('button, input[type=submit], input[type=button], a[role=button], a[href]')) {
        actionEvent(node);
        break;
      }
    }
  }, true);

  document.addEventListener('submit', e => {
    const form = e.target;
    emit({
      type: 'action_detected',
      selector: form.id ? '#' + safeCss(form.id) : 'form',
      rawEvidence: { tag: 'form', label: 'form submit', type: 'submit' },
    });
    emit({
      type: 'dangerous_action_candidate_detected',
      selector: form.id ? '#' + safeCss(form.id) : 'form',
      confidence: 0.9,
      rawEvidence: { label: 'form submit', matchedKeyword: 'submit' },
    });
  }, true);

  // ── File upload (input[type=file]) ──────────────────────────────────────
  function fileSummary(file) {
    if (!file) return null;
    return {
      name: file.name || null,
      size: typeof file.size === 'number' ? file.size : null,
      type: file.type || null,
      lastModified: typeof file.lastModified === 'number' ? file.lastModified : null,
    };
  }
  document.addEventListener('change', e => {
    const el = e.target;
    if (!el || !el.matches) return;
    if (!el.matches('input[type=file]')) return;
    const files = el.files ? Array.from(el.files).map(fileSummary) : [];
    const cands = selectorCandidatesFor(el);
    emit({
      type: 'file_selected',
      selector: (cands[0] && cands[0].selector) || 'input[type=file]',
      rawEvidence: {
        tag: 'input',
        inputType: 'file',
        name: el.name || null,
        id: el.id || null,
        label: labelFor(el),
        multiple: !!el.multiple,
        accept: el.getAttribute('accept') || null,
        fileCount: files.length,
        files,
        selectorCandidates: cands,
        selectorConfidence: (cands[0] && cands[0].confidence) || 'low',
        eventTrigger: 'user_interaction',
      },
    });
  }, true);

  // ── Drag-and-drop file uploads ──────────────────────────────────────────
  function dropTargetMeta(el) {
    if (!el || !el.matches) return { selectorCandidates: [], label: null };
    const cands = selectorCandidatesFor(el);
    return {
      selectorCandidates: cands,
      selector: (cands[0] && cands[0].selector) || (el.tagName || '').toLowerCase(),
      selectorConfidence: (cands[0] && cands[0].confidence) || 'low',
      label: labelFor(el) || (el.textContent || '').trim().slice(0, 80) || null,
    };
  }
  document.addEventListener('dragenter', e => {
    const dt = e.dataTransfer;
    const carriesFiles = !!(dt && dt.types && Array.from(dt.types).includes('Files'));
    if (!carriesFiles) return;
    const meta = dropTargetMeta(e.target);
    emit({
      type: 'file_drop_detected',
      selector: meta.selector,
      rawEvidence: {
        phase: 'dragenter',
        selectorCandidates: meta.selectorCandidates,
        selectorConfidence: meta.selectorConfidence,
        targetLabel: meta.label,
        hasFiles: true,
      },
    });
  }, true);
  document.addEventListener('drop', e => {
    const dt = e.dataTransfer;
    const files = dt && dt.files ? Array.from(dt.files).map(fileSummary) : [];
    if (!files.length) return;
    const meta = dropTargetMeta(e.target);
    emit({
      type: 'file_dropped',
      selector: meta.selector,
      rawEvidence: {
        selectorCandidates: meta.selectorCandidates,
        selectorConfidence: meta.selectorConfidence,
        targetLabel: meta.label,
        fileCount: files.length,
        files,
        eventTrigger: 'user_interaction',
      },
    });
  }, true);

  // ── Clipboard: paste / copy / cut ──────────────────────────────────────
  function clipboardTargetMeta(el) {
    if (!el || !el.matches) return null;
    const cands = selectorCandidatesFor(el);
    return {
      selectorCandidates: cands,
      selector: (cands[0] && cands[0].selector) || (el.tagName || '').toLowerCase(),
      selectorConfidence: (cands[0] && cands[0].confidence) || 'low',
      tag: (el.tagName || '').toLowerCase(),
      contentEditable: !!(el.matches && el.matches(RICH_EDITOR_SEL)),
      label: labelFor(el),
    };
  }
  document.addEventListener('paste', e => {
    const meta = clipboardTargetMeta(e.target);
    if (!meta) return;
    const dt = e.clipboardData || window.clipboardData || null;
    let text = '';
    let html = '';
    const types = dt && dt.types ? Array.from(dt.types) : [];
    try { text = dt ? dt.getData('text/plain') : ''; } catch {}
    try { html = dt ? dt.getData('text/html') : ''; } catch {}
    const hasFiles = !!(dt && dt.files && dt.files.length > 0);
    const filesMeta = hasFiles ? Array.from(dt.files).map(fileSummary) : [];
    emit({
      type: 'paste_detected',
      selector: meta.selector,
      rawEvidence: {
        selectorCandidates: meta.selectorCandidates,
        selectorConfidence: meta.selectorConfidence,
        targetTag: meta.tag,
        targetLabel: meta.label,
        contentEditable: meta.contentEditable,
        clipboardTypes: types,
        textLength: (text || '').length,
        textPreview: (text || '').replace(/\\s+/g, ' ').slice(0, TEXT_PREVIEW_MAX),
        hasHtml: !!html,
        hasFiles,
        files: filesMeta,
      },
    });
  }, true);
  function clipboardOp(type) {
    return e => {
      const meta = clipboardTargetMeta(e.target);
      if (!meta) return;
      const dt = e.clipboardData || window.clipboardData || null;
      let text = '';
      try { text = dt ? dt.getData('text/plain') : ''; } catch {}
      emit({
        type,
        selector: meta.selector,
        rawEvidence: {
          selectorCandidates: meta.selectorCandidates,
          selectorConfidence: meta.selectorConfidence,
          targetTag: meta.tag,
          targetLabel: meta.label,
          contentEditable: meta.contentEditable,
          textLength: (text || '').length,
          textPreview: (text || '').replace(/\\s+/g, ' ').slice(0, TEXT_PREVIEW_MAX),
        },
      });
    };
  }
  document.addEventListener('copy', clipboardOp('copy_detected'), true);
  document.addEventListener('cut',  clipboardOp('cut_detected'),  true);

  // ── Rich text / contenteditable / role=textbox ──────────────────────────
  function richTarget(el) {
    if (!el || !el.matches) return null;
    if (!el.matches(RICH_EDITOR_SEL)) return null;
    const cands = selectorCandidatesFor(el);
    return {
      selectorCandidates: cands,
      selector: (cands[0] && cands[0].selector) || (el.tagName || '').toLowerCase(),
      selectorConfidence: (cands[0] && cands[0].confidence) || 'low',
      tag: (el.tagName || '').toLowerCase(),
      role: el.getAttribute('role') || null,
      label: labelFor(el),
    };
  }
  function emitRichInput(type, el, extra) {
    const meta = richTarget(el);
    if (!meta) return;
    let text = '';
    try { text = (el.textContent || '').replace(/\\s+/g, ' ').trim(); } catch {}
    emit({
      type,
      selector: meta.selector,
      rawEvidence: Object.assign({
        selectorCandidates: meta.selectorCandidates,
        selectorConfidence: meta.selectorConfidence,
        targetTag: meta.tag,
        role: meta.role,
        label: meta.label,
        textLength: text.length,
        textPreview: text.slice(0, RICH_TEXT_MAX),
      }, extra || {}),
    });
  }
  document.addEventListener('input', e => emitRichInput('editor_input', e.target, { inputType: e.inputType || null }), true);
  document.addEventListener('beforeinput', e => {
    const meta = richTarget(e.target);
    if (!meta) return;
    emit({
      type: 'editor_input',
      selector: meta.selector,
      rawEvidence: {
        selectorCandidates: meta.selectorCandidates,
        selectorConfidence: meta.selectorConfidence,
        targetTag: meta.tag,
        role: meta.role,
        label: meta.label,
        phase: 'beforeinput',
        inputType: e.inputType || null,
      },
    });
  }, true);
  document.addEventListener('compositionend', e => emitRichInput('rich_text_changed', e.target, { phase: 'compositionend' }), true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialScan);
  } else {
    initialScan();
  }
})();`;

// ── Browser-context observation ─────────────────────────────────────────────
//
// The recorder is scoped to the *browser context*, not a single page. Every
// page in the context (initial tab, target=_blank links, window.open popups)
// is automatically attached via context.on('page'), gets its own stable
// pageId, listens for lifecycle and download events, and shares one binding
// (`__browsyEmit`) that routes DOM-emitted events back to the session with
// the originating page+frame metadata.
//
// The script in PLAYWRIGHT_OBS_INIT_SCRIPT is added to the *context*, which
// runs it in every page and every frame before any page script. That gives
// us same-origin frame coverage without per-page hooking.

function emitForBindingSource(session, source, partial) {
  if (!partial || typeof partial !== 'object') return null;
  const page = source && source.page;
  const frame = source && source.frame;
  const pageId = ensurePageId(session, page);
  const isMainFrame = !!(frame && page && frame === page.mainFrame());
  const frameId = isMainFrame ? undefined : ensureFrameId(session, frame);
  const parentPageId = page && page.opener && session.pageIds?.get(page.opener()) || undefined;
  const eventPayload = { source: 'playwrightRecorder', ...partial };
  if (pageId !== null) eventPayload.pageId = pageId;
  if (frameId !== undefined) eventPayload.frameId = frameId;
  if (parentPageId) eventPayload.parentPageId = parentPageId;
  return pushEventToSession(session, eventPayload);
}

function downloadsDir(session) {
  return path.join(REPO_ROOT, 'output', 'observations', '_sessions', String(session.id), 'downloads');
}

function attachPage(session, page, { trigger = 'page_event', opener = null } = {}) {
  if (!page) return null;
  if (session.attachedPages?.has(page)) return session.pageIds.get(page);
  if (!session.attachedPages) session.attachedPages = new WeakSet();
  session.attachedPages.add(page);

  const pageId = ensurePageId(session, page);
  const parentPageId = opener ? (session.pageIds?.get(opener) || null) : null;
  const isFirstPage = !session.page;
  if (isFirstPage) session.page = page;

  const initialUrl = (() => { try { return page.url(); } catch { return null; } })();

  pushEventToSession(session, {
    source: 'playwrightRecorder',
    type: 'page_opened',
    pageId,
    ...(parentPageId ? { parentPageId } : {}),
    pageUrl: initialUrl,
    rawEvidence: { trigger, opener: parentPageId || null, isFirstPage },
  });

  // Frame lifecycle. The main frame's navigation is also tracked separately
  // as page_navigated/page_seen so the existing UI keeps working.
  page.on('frameattached', frame => {
    if (frame === page.mainFrame()) return;
    const frameId = ensureFrameId(session, frame);
    pushEventToSession(session, {
      source: 'playwrightRecorder',
      type: 'frame_seen',
      pageId,
      frameId,
      pageUrl: (() => { try { return frame.url(); } catch { return null; } })(),
      rawEvidence: { name: frame.name() || null, parentPageId: pageId },
    });
  });
  page.on('framenavigated', frame => {
    try {
      if (frame === page.mainFrame()) {
        const url = frame.url();
        let title = null;
        pushEventToSession(session, {
          source: 'playwrightRecorder',
          type: 'page_navigated',
          pageId,
          pageUrl: url,
          rawEvidence: { trigger: 'framenavigated' },
        });
        // page_seen is the legacy event the existing UI/preview reads.
        pushEventToSession(session, {
          source: 'playwrightRecorder',
          type: 'page_seen',
          pageId,
          pageUrl: url,
          rawEvidence: { trigger: 'framenavigated' },
        });
        captureSnapshot(session, { kind: 'navigation', hint: 'framenavigated', page }).catch(() => {});
      } else {
        const frameId = ensureFrameId(session, frame);
        pushEventToSession(session, {
          source: 'playwrightRecorder',
          type: 'frame_navigated',
          pageId,
          frameId,
          pageUrl: frame.url(),
          rawEvidence: { name: frame.name() || null },
        });
      }
    } catch {}
  });
  page.on('framedetached', frame => {
    if (frame === page.mainFrame()) return;
    const frameId = session.frameIds?.get(frame);
    if (!frameId) return;
    pushEventToSession(session, {
      source: 'playwrightRecorder',
      type: 'frame_detached',
      pageId,
      frameId,
      rawEvidence: {},
    });
  });
  page.on('domcontentloaded', () => {
    // Stable signal for the preview to know the page rendered. We do not
    // re-snapshot here — framenavigated already triggers a navigation snapshot.
  });

  page.on('popup', popup => {
    // Ensure the popup is attached (context.on('page') usually fires first,
    // but the order isn't guaranteed). Then emit a separate popup_opened
    // event so the opener relationship is preserved even when attach already
    // happened via the context listener.
    attachPage(session, popup, { trigger: 'popup_attach', opener: page });
    const popupId = ensurePageId(session, popup);
    pushEventToSession(session, {
      source: 'playwrightRecorder',
      type: 'popup_opened',
      pageId: popupId,
      parentPageId: pageId,
      pageUrl: (() => { try { return popup.url(); } catch { return null; } })(),
      rawEvidence: { opener: pageId, trigger: 'page.on(popup)' },
    });
  });

  page.on('download', download => handleDownload(session, page, download));

  page.on('close', () => {
    pushEventToSession(session, {
      source: 'playwrightRecorder',
      type: 'page_closed',
      pageId,
      pageUrl: (() => { try { return page.url(); } catch { return null; } })(),
      rawEvidence: { isFirstPage },
    });
    // Finishing the session when the *first* page closes preserves the
    // pre-refactor behavior: a single-page workflow's natural end was the
    // user closing the tab. For multi-tab workflows the remaining pages
    // keep recording until the user stops the session or closes the browser.
    if (isFirstPage && session.state !== 'finished') {
      pushEventToSession(session, {
        source: 'playwrightRecorder',
        type: 'session_finished',
        pageId,
        rawEvidence: { trigger: 'page_closed' },
      });
      session.state = 'finished';
      session.finishedAt = Date.now();
    }
  });

  return pageId;
}

async function handleDownload(session, page, download) {
  const pageId = ensurePageId(session, page);
  const suggested = (() => { try { return download.suggestedFilename(); } catch { return null; } })();
  const url = (() => { try { return download.url(); } catch { return null; } })();
  pushEventToSession(session, {
    source: 'playwrightRecorder',
    type: 'download_started',
    pageId,
    pageUrl: (() => { try { return page.url(); } catch { return null; } })(),
    rawEvidence: { suggestedFilename: suggested, url },
  });
  let savedPath = null;
  try {
    const dir = downloadsDir(session);
    fs.mkdirSync(dir, { recursive: true });
    const filename = suggested && /^[A-Za-z0-9._-]+$/.test(suggested)
      ? suggested
      : `download-${Date.now()}.bin`;
    const absPath = path.join(dir, filename);
    await download.saveAs(absPath);
    savedPath = path.relative(REPO_ROOT, absPath);
    const stats = (() => { try { return fs.statSync(absPath); } catch { return null; } })();
    pushEventToSession(session, {
      source: 'playwrightRecorder',
      type: 'download_saved',
      pageId,
      pageUrl: (() => { try { return page.url(); } catch { return null; } })(),
      rawEvidence: {
        suggestedFilename: suggested,
        savedPath,
        size: stats ? stats.size : null,
        url,
      },
    });
  } catch (e) {
    pushEventToSession(session, {
      source: 'playwrightRecorder',
      type: 'download_failed',
      pageId,
      rawEvidence: { suggestedFilename: suggested, url, error: e.message || String(e) },
    });
  }
  captureSnapshot(session, { kind: 'download', hint: suggested || 'download', page }).catch(() => {});
}

async function launchPlaywrightSession(session, startUrl) {
  const { chromium } = await import('playwright');
  const headless = process.env.BROWSY_OBS_HEADLESS === '1';
  // BROWSY_OBS_CDP_PORT enables remote DevTools for acceptance tests so they
  // can attach to the very same browser the server launched and drive real
  // DOM interactions — proving the capture pipeline works end-to-end.
  const cdpPort = process.env.BROWSY_OBS_CDP_PORT ? Number(process.env.BROWSY_OBS_CDP_PORT) : null;
  const launchArgs = [];
  if (cdpPort) launchArgs.push(`--remote-debugging-port=${cdpPort}`);
  const browser = await chromium.launch({ headless, args: launchArgs });
  // Auto-accept downloads so page.on('download') always fires with a usable
  // Download object. We persist the bytes ourselves via saveAs().
  const context = await browser.newContext({ acceptDownloads: true });

  // Bind once on the context. Playwright invokes the callback with a `source`
  // arg that carries `{ context, page, frame }` — that's how we route DOM
  // events back to a stable pageId/frameId.
  await context.exposeBinding('__browsyEmit', (source, partial) => {
    const event = emitForBindingSource(session, source, partial);
    if (!event) return;
    // Per-state visual evidence triggers — fire-and-forget so a slow
    // screenshot never back-pressures the DOM-event listener.
    const kindMap = {
      action_detected: { kind: 'click_after' },
      file_selected:   { kind: 'file_selected' },
      file_dropped:    { kind: 'file_dropped' },
      paste_detected:  { kind: 'paste' },
    };
    const spec = kindMap[partial.type];
    if (spec) {
      const label = (partial.rawEvidence && partial.rawEvidence.label) || (partial.rawEvidence && partial.rawEvidence.targetLabel) || '';
      captureSnapshot(session, { kind: spec.kind, hint: label.slice(0, 30), page: source && source.page }).catch(() => {});
    } else if (partial.type === 'repeat_group_candidate_detected') {
      const trigger = partial.rawEvidence && partial.rawEvidence.eventTrigger;
      if (trigger !== 'initial_scan') {
        const label = (partial.rawEvidence && partial.rawEvidence.label) || '';
        captureSnapshot(session, { kind: 'add_instance', hint: label.slice(0, 30), page: source && source.page }).catch(() => {});
      }
    }
  });

  await context.addInitScript(PLAYWRIGHT_OBS_INIT_SCRIPT);

  context.on('page', page => attachPage(session, page, { trigger: 'context_page' }));

  browser.on('disconnected', () => {
    if (session.state !== 'finished') {
      session.state = 'finished';
      session.finishedAt = Date.now();
    }
  });

  session.browser = browser;
  session.context = context;
  session.startUrl = startUrl;

  // Initial page — open it explicitly so we control the URL and can attach
  // listeners before navigation begins.
  const page = await context.newPage();
  // attachPage runs via context.on('page') above; if listener didn't fire in
  // time (rare race), attach explicitly so we don't miss the initial events.
  if (!session.attachedPages?.has(page)) attachPage(session, page, { trigger: 'initial' });

  if (startUrl) {
    try {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
      // Initial state snapshot — DOM is mounted; let the initial scan flush
      // before we capture, so the visible-text summary reflects the rendered
      // page rather than a placeholder shell.
      await captureSnapshot(session, { kind: 'session_start', hint: 'initial_load', settleMs: 400, page }).catch(() => {});
    } catch (e) {
      pushEventToSession(session, { source: 'playwrightRecorder', type: 'user_note_added', userAnnotation: `navigation failed: ${e.message}` });
    }
  }
}

async function stopPlaywrightSession(session, { reason = 'user_finished' } = {}) {
  // Drain pending snapshot captures so the event log is complete before we
  // close the page. Without this the trailing screenshots get aborted mid-flight.
  try { if (session.snapshotChain) await session.snapshotChain; } catch {}
  try {
    if (session.context) {
      for (const p of session.context.pages()) {
        if (p.isClosed && p.isClosed()) continue;
        await p.close().catch(() => {});
      }
    }
  } catch {}
  try {
    if (session.browser) await session.browser.close();
  } catch {}
  session.browser = null;
  session.context = null;
  session.page = null;
  if (session.state !== 'finished') {
    pushEventToSession(session, { source: session.source, type: 'session_finished', rawEvidence: { trigger: reason } });
    session.state = 'finished';
    session.finishedAt = Date.now();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/logo.png') {
    const logoPath = path.join(REPO_ROOT, 'Browsy_logo.png');
    if (has(logoPath)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(fs.readFileSync(logoPath)); }
    else { res.writeHead(404); res.end(); }
    return;
  }

  // Serve fixture files so Playwright can navigate to http://localhost:3333/fixtures/...
  // rather than file://, which behaves more like a real site.
  if (req.method === 'GET' && url.pathname.startsWith('/fixtures/')) {
    const rel = url.pathname.replace(/^\/fixtures\//, '');
    let fixturePath;
    try { fixturePath = repoSafe(path.join(REPO_ROOT, 'fixtures', rel)); } catch { res.writeHead(403); res.end(); return; }
    if (!has(fixturePath) || fs.statSync(fixturePath).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': contentTypeFor(fixturePath) });
    res.end(fs.readFileSync(fixturePath));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/write-request') {
    try {
      const { markdown } = await readBody(req);
      if (typeof markdown !== 'string' || !markdown.trim()) return json(res, 400, { error: 'markdown field required' });
      fs.writeFileSync(path.join(REPO_ROOT, 'AUTOMATION_REQUEST.md'), markdown, 'utf8');
      json(res, 200, { ok: true });
      console.log('[wizard] Wrote AUTOMATION_REQUEST.md');
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/write-package') {
    try {
      const { package: pkg, workflowId } = await readBody(req);
      if (!pkg || typeof pkg !== 'object') return json(res, 400, { error: 'package object required' });
      if (!safeWorkflowId(workflowId)) return json(res, 400, { error: 'valid workflowId required' });
      const result = writeAutomationProjectDraft({ repoRoot: REPO_ROOT, workflowId, automationPackage: pkg });
      json(res, 200, { ok: true, path: result.packagePath, files: result.relativeFiles });
      console.log(`[wizard] Wrote automation project draft for ${result.workflowId}`);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/workflows') {
    return json(res, 200, { workflows: listWorkflows().map(id => getWorkflowState(id)) });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const workflowId = url.searchParams.get('workflow');
    if (!workflowId) return json(res, 200, { hasRequest: has(path.join(REPO_ROOT, 'AUTOMATION_REQUEST.md')), workflows: listWorkflows() });
    return json(res, 200, getWorkflowState(workflowId));
  }

  if (req.method === 'GET' && url.pathname === '/api/artifact') {
    const workflowId = url.searchParams.get('workflow');
    const runId = url.searchParams.get('run');
    const file = url.searchParams.get('file');
    if (!safeWorkflowId(workflowId) || !file) return json(res, 400, { error: 'workflow and file required' });

    let filePath;
    if (runId) filePath = path.join(REPO_ROOT, 'output', 'runs', workflowId, runId, file);
    else {
      const { latestRunDir } = latestRunInfo(path.join(REPO_ROOT, 'output', 'runs', workflowId));
      if (latestRunDir) filePath = path.join(latestRunDir, file);
      if (!filePath || !has(filePath)) filePath = path.join(REPO_ROOT, 'workflows', workflowId, file);
    }
    if (!filePath || !has(filePath)) return json(res, 404, { error: 'artifact not found' });
    try { filePath = repoSafe(filePath); } catch { return json(res, 403, { error: 'forbidden' }); }
    res.writeHead(200, { 'Content-Type': contentTypeFor(file) });
    res.end(fs.readFileSync(filePath));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/artifact-list') {
    const workflowId = url.searchParams.get('workflow');
    if (!safeWorkflowId(workflowId)) return json(res, 400, { error: 'valid workflow id required' });
    const wfDir = path.join(REPO_ROOT, 'workflows', workflowId);
    const runsDir = path.join(REPO_ROOT, 'output', 'runs', workflowId);
    const wfFiles = [
      'project.json','workflow.json','workflow.yaml','manifest.schema.json','manifest.example.json','workflow-package.example.json',
      'safety-policy.json','field-map.example.json','field-map.local.json.example','field-map.local.json','walkthrough.md','README.md',
      'run.mjs','smoke-test.mjs','observations/atlas-observation-template.md','observations/observation-checklist.md',
      'fixtures/observed-form.html','fixtures/observed-review.html','fixtures/observed-success.html','PROMOTED',
    ];
    const wfArtifacts = wfFiles.map(file => ({ file, scope: 'workflow', path: `workflows/${workflowId}/${file}`, exists: has(path.join(wfDir, file)) }));

    const feedbackDir = path.join(wfDir, 'feedback');
    const feedbackFiles = has(feedbackDir) ? fs.readdirSync(feedbackDir).map(file => ({ file, scope: 'feedback', path: `workflows/${workflowId}/feedback/${file}`, exists: true })) : [];

    const { latestRun, latestRunDir } = latestRunInfo(runsDir);
    const runFiles = ['run-review.md','run-log.json','filled-fields.json','skipped-fields.json','errors.json','runtime-vars.json','captured-outputs.json','discovered-fields.json','discovered-fields.md','field-map.candidates.md','page-text-snapshot.txt','html-snapshot.html','screenshot-start.png','screenshot-after-fill.png','screenshot-discovery.png','live-run-completed.json'];
    const runArtifacts = latestRunDir ? runFiles.map(file => ({ file, scope: 'run', runId: latestRun, path: `output/runs/${workflowId}/${latestRun}/${file}`, exists: has(path.join(latestRunDir, file)) })) : [];

    return json(res, 200, {
      workflowId,
      latestRun,
      readiness: evaluateProjectReadiness({ workflowDir: wfDir, runsDir, outputObservationDir: path.join(REPO_ROOT, 'output', 'observations', workflowId) }),
      artifacts: [...wfArtifacts, ...feedbackFiles, ...runArtifacts],
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/exec') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid JSON' }); }
    const { command, args = [] } = body;
    if (!command || !ALLOWED_COMMANDS.has(command)) return json(res, 400, { error: `command not allowed: ${command}` });
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) return json(res, 400, { error: 'args must be an array of strings' });
    const argCheck = validateExecArgs(command, args);
    if (!argCheck.ok) return json(res, 400, { error: `invalid args: ${argCheck.reason}` });

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    write('start', { command, args });
    const child = spawn('node', ['src/cli/index.mjs', command, ...args], { cwd: REPO_ROOT, env: { ...process.env, FORCE_COLOR: '0' } });
    child.stdout.on('data', chunk => { for (const line of chunk.toString().split('\n')) if (line) write('stdout', { line }); });
    child.stderr.on('data', chunk => { for (const line of chunk.toString().split('\n')) if (line) write('stderr', { line }); });
    child.on('close', code => { write('done', { code }); res.end(); });
    child.on('error', err => { write('error', { message: err.message }); res.end(); });
    req.on('close', () => { child.kill(); });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/observation/sample') {
    const samplePath = path.join(REPO_ROOT, 'fixtures', 'observed-conference-proposal', 'observation.json');
    if (!has(samplePath)) return json(res, 404, { error: 'sample fixture not found' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(fs.readFileSync(samplePath));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/observation/preview') {
    try {
      const { observation } = await readBody(req);
      if (!observation) return json(res, 400, { error: 'observation field required' });
      const obs = normalizeObservation(observation);
      const repeatGroups = inferRepeatGroups(obs);
      const capturedOutputs = inferCapturedOutputs(obs);
      const runtimeVariables = inferRuntimeVariables(obs);
      const pkg = buildWorkflowPackageFromObservation(obs);
      const workflow = buildWorkflowConfigFromObservation(obs);
      const runPlan = buildRunPlanFromObservation(obs);
      const globalFields = obs.fields.filter(f => f.scope !== 'asset' && f.scope !== 'default' && f.inputType !== 'file');
      const globalAssets = obs.fields.filter(f => f.scope === 'asset' || f.inputType === 'file');
      const sharedDefaults = obs.fields.filter(f => f.scope === 'default');
      json(res, 200, {
        ok: true,
        workflowId: obs.workflowId,
        summary: {
          workflowId: obs.workflowId,
          title: obs.title,
          goal: obs.goal,
          globalFieldCount: globalFields.length,
          globalFieldNames: globalFields.map(f => f.id),
          globalAssetCount: globalAssets.length,
          globalAssetNames: globalAssets.map(f => f.id),
          sharedDefaultCount: sharedDefaults.length,
          sharedDefaultNames: sharedDefaults.map(f => f.id),
          repeatGroupCount: repeatGroups.length,
          repeatGroups: repeatGroups.map(g => ({
            id: g.id,
            label: g.label,
            itemLabel: g.itemLabel,
            itemFieldCount: (g.itemFields || []).length,
            itemFieldNames: (g.itemFields || []).map(f => f.id),
            itemAssetCount: (g.itemAssets || []).length,
            itemAssetNames: (g.itemAssets || []).map(f => f.id),
          })),
          capturedOutputCount: capturedOutputs.length,
          capturedOutputNames: capturedOutputs.map(o => o.id),
          runtimeInputCount: runtimeVariables.input.length,
          runtimeInputNames: runtimeVariables.input.map(v => v.name),
          runtimeCapturedCount: runtimeVariables.captured.length,
          runtimeCapturedNames: runtimeVariables.captured.map(v => v.name),
          runtimeDerivedCount: runtimeVariables.derived.length,
          runtimeDerivedNames: runtimeVariables.derived.map(v => v.name),
          humanCheckpointCount: obs.humanCheckpoints.length,
          humanCheckpointLabels: obs.humanCheckpoints.map(c => c.label),
          manualOnlyCount: (workflow.manualOnlyActions || []).length,
          manualOnlyLabels: (workflow.manualOnlyActions || []).map(a => a.label),
        },
        artifacts: {
          workflowJson: workflow,
          workflowPackageJson: pkg,
          runPlanMd: runPlan,
        },
      });
    } catch (e) { json(res, 400, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/observation/import') {
    try {
      const { observation } = await readBody(req);
      if (!observation) return json(res, 400, { error: 'observation field required' });
      const obs = normalizeObservation(observation);
      if (!safeWorkflowId(obs.workflowId)) return json(res, 400, { error: `invalid workflowId: ${obs.workflowId}` });

      const pkg = buildWorkflowPackageFromObservation(obs);
      const workflow = buildWorkflowConfigFromObservation(obs);
      const runPlan = buildRunPlanFromObservation(obs);

      const wfDir = path.join(REPO_ROOT, 'workflows', obs.workflowId);
      const plansDir = path.join(REPO_ROOT, 'output', 'plans', obs.workflowId);
      const obsOutDir = path.join(REPO_ROOT, 'output', 'observations', obs.workflowId);
      fs.mkdirSync(wfDir, { recursive: true });
      fs.mkdirSync(plansDir, { recursive: true });
      fs.mkdirSync(obsOutDir, { recursive: true });

      const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8');
      const writeText = (p, v) => fs.writeFileSync(p, v, 'utf8');

      const wfJsonPath      = path.join(wfDir, 'workflow.json');
      const pkgJsonPath     = path.join(wfDir, 'workflow-package.example.json');
      const runPlanPath     = path.join(plansDir, 'run-plan.md');
      const obsJsonPath     = path.join(obsOutDir, 'observation.json');

      writeJson(wfJsonPath, workflow);
      writeJson(pkgJsonPath, pkg);
      writeText(runPlanPath, runPlan);
      writeText(obsJsonPath, typeof observation === 'string' ? observation : JSON.stringify(observation, null, 2) + '\n');

      const relFiles = [
        `workflows/${obs.workflowId}/workflow.json`,
        `workflows/${obs.workflowId}/workflow-package.example.json`,
        `output/plans/${obs.workflowId}/run-plan.md`,
        `output/observations/${obs.workflowId}/observation.json`,
      ];

      json(res, 200, { ok: true, workflowId: obs.workflowId, files: relFiles });
      console.log(`[wizard] Imported observation → ${obs.workflowId}`);
    } catch (e) { json(res, 400, { error: e.message }); }
    return;
  }

  // ── Observation session endpoints (real capture bridge) ────────────────────
  //
  // POST /api/observation/session/start { source, startUrl?, workflowId? }
  //   - playwrightRecorder: launches a real Chromium browser via Playwright,
  //     navigates to startUrl, injects DOM listeners that emit canonical
  //     observation events into the session.
  //   - mock / atlasAssistedNotes / manualImport: records session_started and
  //     capture_source_selected events only. No simulated counters, no fake
  //     events. The UI must not present these as real capture.
  if (req.method === 'POST' && url.pathname === '/api/observation/session/start') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid JSON' }); }
    const { source = 'playwrightRecorder', startUrl, workflowId } = body || {};
    if (!CAPTURE_SOURCES.includes(source)) return json(res, 400, { error: `unknown capture source: ${source}` });
    if (source === 'playwrightRecorder' && (!startUrl || typeof startUrl !== 'string')) {
      return json(res, 400, { error: 'playwrightRecorder requires a startUrl' });
    }

    const sessionId = newSessionId();
    const session = {
      id: sessionId,
      source,
      workflowId: workflowId || null,
      startUrl: startUrl || null,
      startedAt: Date.now(),
      finishedAt: null,
      state: 'starting',
      events: [],
      browser: null, context: null, page: null,
    };
    obsSessions.set(sessionId, session);

    pushEventToSession(session, { source, type: 'session_started' });
    pushEventToSession(session, { source, type: 'capture_source_selected', payload: { captureSource: source } });

    if (source === 'playwrightRecorder') {
      try {
        await launchPlaywrightSession(session, startUrl);
        session.state = 'recording';
        console.log(`[wizard] Playwright observation session ${sessionId} recording: ${startUrl}`);
      } catch (e) {
        session.state = 'finished';
        session.finishedAt = Date.now();
        pushEventToSession(session, { source, type: 'session_finished', rawEvidence: { trigger: 'launch_failed', error: e.message } });
        return json(res, 500, { error: `failed to launch playwright: ${e.message}`, sessionId });
      }
    } else {
      session.state = 'recording';
      console.log(`[wizard] Observation session ${sessionId} (${source}) created without browser`);
    }

    return json(res, 200, { ok: true, sessionId, status: session.state, startUrl: session.startUrl, source: session.source, session: sessionSummary(session) });
  }

  // GET /api/observation/session/:id/events → real captured events + derived stats
  if (req.method === 'GET' && /^\/api\/observation\/session\/[^/]+\/events$/.test(url.pathname)) {
    const id = url.pathname.split('/')[4];
    const session = obsSessions.get(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    return json(res, 200, {
      ok: true,
      sessionId: id,
      state: session.state,
      source: session.source,
      startUrl: session.startUrl,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      events: session.events,
      stats: deriveStatsFromEvents(session.events),
    });
  }

  // POST /api/observation/session/:id/stop → close the playwright session cleanly
  if (req.method === 'POST' && /^\/api\/observation\/session\/[^/]+\/stop$/.test(url.pathname)) {
    const id = url.pathname.split('/')[4];
    const session = obsSessions.get(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    try {
      if (session.source === 'playwrightRecorder') {
        await stopPlaywrightSession(session, { reason: 'user_finished' });
      } else {
        pushEventToSession(session, { source: session.source, type: 'session_finished', rawEvidence: { trigger: 'user_finished' } });
        session.state = 'finished';
        session.finishedAt = Date.now();
      }
      const pkg = buildRecorderPackage({
        sessionId: id,
        source: session.source,
        startUrl: session.startUrl,
        workflowId: session.workflowId,
        startedAt: session.startedAt,
        finishedAt: session.finishedAt,
        events: session.events,
      });
      return json(res, 200, {
        ok: true,
        sessionId: id,
        state: session.state,
        events: session.events,
        stats: deriveStatsFromEvents(session.events),
        package: pkg,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // GET /api/observation/session/:id/package → recorder package for replay
  if (req.method === 'GET' && /^\/api\/observation\/session\/[^/]+\/package$/.test(url.pathname)) {
    const id = url.pathname.split('/')[4];
    const session = obsSessions.get(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const pkg = buildRecorderPackage({
      sessionId: id,
      source: session.source,
      startUrl: session.startUrl,
      workflowId: session.workflowId,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      events: session.events,
    });
    return json(res, 200, { ok: true, sessionId: id, package: pkg });
  }

  // POST /api/observation/events — accept normalized events from extension or local bridge
  if (req.method === 'POST' && url.pathname === '/api/observation/events') {
    try {
      const { sessionId, events } = await readBody(req);
      if (!sessionId) return json(res, 400, { error: 'sessionId required' });
      if (!Array.isArray(events)) return json(res, 400, { error: 'events must be an array' });
      const invalid = events.filter(e => !e.type || !CAPTURE_SOURCES.includes(e.source));
      if (invalid.length) return json(res, 400, { error: `${invalid.length} events have missing type or unknown source`, invalid: invalid.slice(0, 3) });
      const session = obsSessions.get(sessionId);
      if (session) {
        for (const ev of events) {
          pushEventToSession(session, { source: ev.source, type: ev.type, pageUrl: ev.pageUrl, pageTitle: ev.pageTitle, selector: ev.selector, confidence: ev.confidence, rawEvidence: ev.rawEvidence, userAnnotation: ev.userAnnotation });
        }
      }
      console.log(`[wizard] Received ${events.length} observation event(s) for session ${sessionId}`);
      json(res, 200, { ok: true, sessionId, accepted: events.length });
    } catch (e) { json(res, 400, { error: e.message }); }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log(`  Port ${PORT} is already in use.`);
    console.log(`  The wizard may already be running — open: http://localhost:${PORT}`);
    console.log('  If it is not, kill the process using that port and retry.');
    console.log('');
    process.exit(0);
  }
  console.error('  Server error:', err.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  Browsy Wizard');
  console.log(`  http://localhost:${PORT}`);
  console.log('');
  console.log('  Open the URL above in Chrome for best voice support.');
  console.log('  Ctrl+C to stop.');
  console.log('');
});

// Graceful shutdown — make sure no headless Chromiums are left running.
async function shutdown() {
  for (const session of obsSessions.values()) {
    if (session.source === 'playwrightRecorder' && session.browser) {
      try { await stopPlaywrightSession(session, { reason: 'server_shutdown' }); } catch {}
    }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
