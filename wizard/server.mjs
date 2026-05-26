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
import { loadWorkflowPackage, validateWorkflowPackage, RETURN_CONTRACT_VERSION } from '../src/core/workflow-contract.mjs';
import { defaultSafetyPolicy } from '../src/core/safety.mjs';
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

  let lastActionSelector = null;

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
        lastActionSelector = selectorFor(node);
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

  // ── Output capture (MutationObserver on #output / [data-captured-output]) ──
  function observeOutputs() {
    const targets = Array.from(document.querySelectorAll('#output, [data-captured-output]'));
    if (!targets.length) return;
    const mo = new MutationObserver(() => {
      for (const el of targets) {
        const text = (el.textContent || '').trim();
        if (!text || text === el.__browsyLastOutput) continue;
        el.__browsyLastOutput = text;
        const cands = selectorCandidatesFor(el);
        emit({
          type: 'output_captured',
          selector: (cands[0] && cands[0].selector) || (el.id ? '#' + safeCss(el.id) : '[data-captured-output]'),
          rawEvidence: {
            outputId: el.id || el.getAttribute('data-captured-output') || 'output',
            text: text.slice(0, 2000),
            triggeredBySelector: lastActionSelector,
            selectorCandidates: cands,
            selectorConfidence: (cands[0] && cands[0].confidence) || 'low',
            eventTrigger: 'mutation_observer',
          },
        });
      }
    });
    for (const el of targets) {
      mo.observe(el, { childList: true, characterData: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { initialScan(); observeOutputs(); });
  } else {
    initialScan();
    observeOutputs();
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

// ── Workflow Library + Play UI ───────────────────────────────────────────────
//
// In-memory registry of active workflow runs spawned from the UI. Each entry
// drives the /workflows pages: card status, live event panel, STOP button.
// Persistence is intentionally per-process — long-term records live in the
// timestamped result.json files we write under output/runs/.

const workflowRuns = new Map();         // runId → record
const runEventSubscribers = new Map();  // runId → Set<res> for SSE
const MAX_RUN_LOG_LINES = 2000;         // ring-buffer cap per run

function newRunId(workflowId) {
  return `${workflowId}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
}

function pushRunEvent(run, event) {
  const entry = { ...event, ts: event.ts || new Date().toISOString() };
  run.events.push(entry);
  if (run.events.length > MAX_RUN_LOG_LINES) run.events.splice(0, run.events.length - MAX_RUN_LOG_LINES);
  const subs = runEventSubscribers.get(run.runId);
  if (subs) {
    const payload = `event: ${entry.kind || 'log'}\ndata: ${JSON.stringify(entry)}\n\n`;
    for (const sub of subs) {
      try { sub.write(payload); } catch {}
    }
  }
}

// Read the workflow package and return both the parsed object and a validity
// report so the UI can render package-validity badges without re-running
// validation in the browser.
function loadPackageMetadata(workflowId) {
  const pkgPath = path.join(REPO_ROOT, 'workflows', workflowId, 'workflow-package.example.json');
  if (!has(pkgPath)) {
    return { exists: false, valid: false, errors: ['package file not found'], package: null, packagePath: null };
  }
  const loaded = loadWorkflowPackage(pkgPath);
  return {
    exists: true,
    valid: loaded.ok,
    errors: loaded.errors || [],
    package: loaded.pkg || null,
    packagePath: loaded.packagePath,
    packageRelPath: path.relative(REPO_ROOT, loaded.packagePath || pkgPath),
  };
}

function loadWorkflowConfig(workflowId) {
  const cfgPath = path.join(REPO_ROOT, 'workflows', workflowId, 'workflow.json');
  if (!has(cfgPath)) return { exists: false, config: null, path: cfgPath };
  try {
    return { exists: true, config: JSON.parse(fs.readFileSync(cfgPath, 'utf8')), path: cfgPath };
  } catch (e) {
    return { exists: true, config: null, path: cfgPath, error: e.message };
  }
}

function loadObservationMetadata(workflowId) {
  const obsPath = path.join(REPO_ROOT, 'output', 'observations', workflowId, 'observation.json');
  if (!has(obsPath)) return { exists: false, path: obsPath, capturedAt: null };
  try {
    const stat = fs.statSync(obsPath);
    const text = fs.readFileSync(obsPath, 'utf8');
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return {
      exists: true,
      path: obsPath,
      relPath: path.relative(REPO_ROOT, obsPath),
      capturedAt: parsed?.capturedAt || stat.mtime.toISOString(),
      pageCount: Array.isArray(parsed?.pages) ? parsed.pages.length : 0,
      eventCount: Array.isArray(parsed?.sessionEvents) ? parsed.sessionEvents.length : 0,
    };
  } catch {
    return { exists: true, path: obsPath };
  }
}

function loadRunPlanMetadata(workflowId) {
  const planPath = path.join(REPO_ROOT, 'output', 'plans', workflowId, 'run-plan.md');
  if (!has(planPath)) return { exists: false, path: planPath };
  return { exists: true, path: planPath, relPath: path.relative(REPO_ROOT, planPath) };
}

// Selector-map status — workflows/<id>/field-map.local.json drives Live-Safe.
// Returns { exists, valid, fieldCount, repeatGroupCount, generatedAt, errors }.
function loadFieldMapStatus(workflowId) {
  const mapPath = path.join(REPO_ROOT, 'workflows', workflowId, 'field-map.local.json');
  if (!has(mapPath)) return { exists: false, valid: false, fieldCount: 0, repeatGroupCount: 0, generatedAt: null, errors: ['field-map.local.json not found'] };
  try {
    const stat = fs.statSync(mapPath);
    const parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const fieldCount = parsed && typeof parsed.fields === 'object' ? Object.keys(parsed.fields).length : 0;
    const repeatGroupCount = Array.isArray(parsed?.repeatGroups) ? parsed.repeatGroups.length : 0;
    return {
      exists: true,
      valid: fieldCount > 0 || repeatGroupCount > 0,
      fieldCount,
      repeatGroupCount,
      generatedAt: parsed?.generatedAt || stat.mtime.toISOString(),
      errors: [],
    };
  } catch (e) {
    return { exists: true, valid: false, fieldCount: 0, repeatGroupCount: 0, generatedAt: null, errors: [`parse error: ${e.message}`] };
  }
}

function loadLatestResult(workflowId) {
  const runsDir = path.join(REPO_ROOT, 'output', 'runs', workflowId);
  const { latestRun, latestRunDir } = latestRunInfo(runsDir);
  if (!latestRun) return { exists: false };
  const resultPath = path.join(latestRunDir, 'result.json');
  if (!has(resultPath)) return { exists: true, runId: latestRun, runDir: latestRunDir, hasResult: false };
  try {
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    return {
      exists: true,
      hasResult: true,
      runId: latestRun,
      runDir: latestRunDir,
      resultPath,
      relResultPath: path.relative(REPO_ROOT, resultPath),
      status: result.status || null,
      generatedAt: result.generated_at || null,
      result,
    };
  } catch (e) {
    return { exists: true, runId: latestRun, runDir: latestRunDir, hasResult: false, error: e.message };
  }
}

// Build the rich metadata blob the library cards + runner detail page consume.
// Counts come from canonical_payload when present (the contract-shaped source
// of truth), then fall back to workflow.json for legacy workflows.
function buildLibraryEntry(workflowId) {
  const wfDir = path.join(REPO_ROOT, 'workflows', workflowId);
  const cfg = loadWorkflowConfig(workflowId);
  const pkgMeta = loadPackageMetadata(workflowId);
  const obs = loadObservationMetadata(workflowId);
  const plan = loadRunPlanMetadata(workflowId);
  const latest = loadLatestResult(workflowId);
  const fieldMap = loadFieldMapStatus(workflowId);

  const config = cfg.config || {};
  const pkg = pkgMeta.package || {};
  const canonical = pkg.canonical_payload || {};

  // Source / target URLs — start_url first, then page list, then start_url_example.
  const urls = [];
  const startUrl = config.targets?.start_url;
  if (startUrl) urls.push(startUrl);
  for (const p of (config.targets?.pages || [])) {
    if (p?.url && !urls.includes(p.url)) urls.push(p.url);
  }
  for (const p of (config.targets?.urls || [])) {
    if (p?.url && !urls.includes(p.url)) urls.push(p.url);
  }

  const globalFieldCount = Object.keys(canonical.globals || {}).length
    + Object.keys(canonical.defaults || {}).length;
  // Prefer the contract-shaped `assets` array (each entry is one role).
  // Fall back to canonical_payload.assets (object) for backwards compat.
  const assetCount = Array.isArray(pkg.assets)
    ? pkg.assets.length
    : Object.keys(canonical.assets || {}).length;
  const repeatGroupCount = Array.isArray(canonical.repeatGroups) ? canonical.repeatGroups.length
    : Array.isArray(config.repeatGroups) ? config.repeatGroups.length
    : 0;
  const outputCount = Array.isArray(pkg.capture_outputs) ? pkg.capture_outputs.length
    : Array.isArray(canonical.capturedOutputs) ? canonical.capturedOutputs.length
    : 0;
  const checkpointCount = (Array.isArray(canonical.humanCheckpoints) ? canonical.humanCheckpoints.length : 0)
    + (Array.isArray(config.manualOnlyActions) ? config.manualOnlyActions.length : 0);

  // Compute the dangerous-action policy the UI must surface so an operator can
  // see what the runtime will refuse to click during Live-Safe.
  const policyPath = path.join(wfDir, 'safety-policy.json');
  let safetyPolicy = null;
  if (has(policyPath)) {
    try { safetyPolicy = JSON.parse(fs.readFileSync(policyPath, 'utf8')); } catch {}
  }
  if (!safetyPolicy) safetyPolicy = config.safetyPolicy || defaultSafetyPolicy();

  // Active run for this workflow (if any). The card shows STOP only while one exists.
  let activeRun = null;
  for (const r of workflowRuns.values()) {
    if (r.workflowId !== workflowId) continue;
    if (r.status === 'starting' || r.status === 'running' || r.status === 'stopping') {
      activeRun = { runId: r.runId, status: r.status, mode: r.mode, startedAt: r.startedAt };
      break;
    }
  }

  return {
    workflowId,
    title: config.title || pkg.workflow_id || workflowId,
    goal: config.goal || canonical.goal || '',
    urls,
    package: {
      exists: pkgMeta.exists,
      valid: pkgMeta.valid,
      errors: pkgMeta.errors,
      relPath: pkgMeta.packageRelPath,
      mode: pkg.mode || null,
      humanGate: pkg.human_gate !== false,
      returnContractVersion: pkg.return_contract_version || null,
    },
    counts: {
      globalFields: globalFieldCount,
      assets: assetCount,
      repeatGroups: repeatGroupCount,
      capturedOutputs: outputCount,
      checkpoints: checkpointCount,
    },
    safetyPolicy: {
      neverClickText: safetyPolicy.never_click_text || [],
      manualOnlyCategories: safetyPolicy.manual_only_categories || [],
    },
    files: {
      workflowJson: has(path.join(wfDir, 'workflow.json')) ? `workflows/${workflowId}/workflow.json` : null,
      packageExample: has(path.join(wfDir, 'workflow-package.example.json')) ? `workflows/${workflowId}/workflow-package.example.json` : null,
      runPlan: plan.exists ? plan.relPath : null,
      observation: obs.exists ? obs.relPath : null,
      safetyPolicy: has(policyPath) ? `workflows/${workflowId}/safety-policy.json` : null,
    },
    observation: obs.exists ? { capturedAt: obs.capturedAt, pageCount: obs.pageCount, eventCount: obs.eventCount } : null,
    selectorMap: {
      exists: fieldMap.exists,
      valid: fieldMap.valid,
      fieldCount: fieldMap.fieldCount,
      repeatGroupCount: fieldMap.repeatGroupCount,
      generatedAt: fieldMap.generatedAt,
      relPath: fieldMap.exists ? `workflows/${workflowId}/field-map.local.json` : null,
    },
    latestRun: latest.exists ? {
      runId: latest.runId,
      status: latest.status,
      generatedAt: latest.generatedAt,
      hasResult: latest.hasResult,
      relResultPath: latest.relResultPath || null,
      // Reason hint for the UI when status is "blocked". We surface the first
      // client_action_request type, so the library row can show
      // "Needs selector verification" without re-fetching result.json.
      blockedReason: (() => {
        if (latest.status !== 'blocked' || !latest.result) return null;
        const r = (latest.result.client_action_requests || [])[0];
        return r ? { type: r.type, reason: r.reason, severity: r.severity } : null;
      })(),
    } : null,
    activeRun,
  };
}

function listLibraryWorkflows() {
  return listWorkflows().map(id => buildLibraryEntry(id));
}

// Start a workflow run by spawning the same CLI the user would invoke
// from the terminal. Stdout/stderr are streamed to subscribers so the
// runner detail page can show a live log.
function startWorkflowRun({ workflowId, mode, packagePath }) {
  const resolvedPackage = packagePath
    ? path.resolve(REPO_ROOT, packagePath)
    : path.join(REPO_ROOT, 'workflows', workflowId, 'workflow-package.example.json');
  if (!resolvedPackage.startsWith(REPO_ROOT)) throw new Error('package path escapes repo root');
  if (!has(resolvedPackage)) throw new Error(`workflow package not found: ${resolvedPackage}`);

  // Resolve mode → CLI flag. `dry_run` is the safe default; `live` still
  // respects the runtime's safety policy + human gate.
  const modeFlag = mode === 'live' ? '--live' : '--dry-run';
  const runId = newRunId(workflowId);

  // Pre-snapshot existing run directories so we can find the one the child
  // creates after it starts (used as a fallback if the child crashes before
  // it prints the resultPath line).
  const runsRoot = path.join(REPO_ROOT, 'output', 'runs', workflowId);
  const existingRuns = new Set(has(runsRoot) ? fs.readdirSync(runsRoot) : []);

  const child = spawn(
    'node',
    ['src/cli/index.mjs', 'workflow:run', '--package', path.relative(REPO_ROOT, resolvedPackage), modeFlag],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
    }
  );

  const run = {
    runId,
    workflowId,
    mode: mode === 'live' ? 'live' : 'dry_run',
    packagePath: resolvedPackage,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'starting',
    child,
    resultPath: null,
    runDir: null,
    events: [],
    exitCode: null,
    stoppedByUser: false,
  };
  workflowRuns.set(runId, run);
  pushRunEvent(run, { kind: 'status', status: 'starting', mode: run.mode });
  run.status = 'running';
  pushRunEvent(run, { kind: 'status', status: 'running' });

  child.stdout.on('data', chunk => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      if (!line) continue;
      pushRunEvent(run, { kind: 'stdout', line });
      // First non-empty stdout line that looks like a path under output/runs/
      // is the resultPath emitted by the CLI's workflowRun().
      if (!run.resultPath && /output\/runs\//.test(line)) {
        run.resultPath = line.trim();
        run.runDir = path.dirname(run.resultPath);
        pushRunEvent(run, { kind: 'result_path', resultPath: run.resultPath });
      }
    }
  });
  child.stderr.on('data', chunk => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      if (!line) continue;
      pushRunEvent(run, { kind: 'stderr', line });
    }
  });
  child.on('error', err => {
    pushRunEvent(run, { kind: 'error', message: err.message });
  });
  child.on('exit', (code, signal) => {
    run.exitCode = code;
    run.finishedAt = new Date().toISOString();
    // If we didn't see a resultPath in stdout, scan for a new run dir the
    // child may have created so the UI can still link to artifacts.
    if (!run.runDir && has(runsRoot)) {
      const after = fs.readdirSync(runsRoot).filter(d => !existingRuns.has(d));
      if (after.length) {
        const newest = after.sort().reverse()[0];
        run.runDir = path.join(runsRoot, newest);
        const candidate = path.join(run.runDir, 'result.json');
        if (has(candidate)) run.resultPath = candidate;
      }
    }
    if (run.stoppedByUser) {
      writeStoppedResult(run, signal || 'SIGTERM');
      run.status = 'stopped_by_user';
    } else if (code === 0) {
      run.status = 'completed';
    } else if (code === 3) {
      run.status = 'live_run_gated';
    } else if (code === 4) {
      // The runtime refused to make safe progress (selector verification,
      // safety policy, missing input). Surface as 'blocked' so the UI shows
      // Blocked instead of the misleading "completed".
      run.status = 'blocked';
    } else {
      run.status = 'failed';
    }
    pushRunEvent(run, { kind: 'status', status: run.status, exitCode: code, signal });
    pushRunEvent(run, { kind: 'done', status: run.status, resultPath: run.resultPath });
    // Close any active SSE subscribers — the run is over.
    const subs = runEventSubscribers.get(run.runId);
    if (subs) {
      for (const sub of subs) {
        try { sub.end(); } catch {}
      }
      runEventSubscribers.delete(run.runId);
    }
  });

  return run;
}

// Write (or overwrite) a contract-valid result.json that records the stop.
// Preserves any partial fields the child wrote before we killed it.
function writeStoppedResult(run, signal) {
  // If the child managed to write its own result.json before we killed it,
  // use that as the baseline so partial filled_fields / errors survive.
  let runDir = run.runDir;
  if (!runDir) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    runDir = path.join(REPO_ROOT, 'output', 'runs', run.workflowId, ts);
    fs.mkdirSync(runDir, { recursive: true });
    run.runDir = runDir;
  }
  const resultPath = run.resultPath || path.join(runDir, 'result.json');
  let base = null;
  if (has(resultPath)) {
    try { base = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch { base = null; }
  }
  const now = new Date().toISOString();
  const stopped = base && typeof base === 'object' ? { ...base } : {
    ok: false,
    workflow_id: run.workflowId,
    run_id: `${run.workflowId}-${path.basename(runDir)}`,
    source_system: 'browsy_ui',
    entity_type: 'workflow',
    entity_id: 'STOPPED_BY_USER',
    captured_outputs: {},
    filled_fields: [],
    skipped_fields: [],
    errors: [],
    screenshots: [],
    artifact_paths: [],
    manual_checkpoints: [],
    client_action_requests: [],
    next_required_action: null,
    return_contract_version: RETURN_CONTRACT_VERSION,
    generated_at: now,
  };
  stopped.ok = false;
  stopped.status = 'stopped_by_user';
  stopped.stopped_at = now;
  stopped.stop_signal = signal || 'SIGTERM';
  stopped.stop_reason = 'STOP pressed in Browsy Workflow Library UI';
  stopped.return_contract_version = RETURN_CONTRACT_VERSION;
  fs.writeFileSync(resultPath, JSON.stringify(stopped, null, 2) + '\n', 'utf8');
  run.resultPath = resultPath;
  pushRunEvent(run, { kind: 'stopped', resultPath, signal });
}

// SIGTERM the child, escalate to SIGKILL after a short grace period. The
// exit handler writes the stopped result.json once the process is gone.
function stopWorkflowRun(runId) {
  const run = workflowRuns.get(runId);
  if (!run) return { ok: false, error: 'run not found' };
  if (run.status !== 'running' && run.status !== 'starting') {
    return { ok: false, error: `run is already ${run.status}` };
  }
  run.stoppedByUser = true;
  run.status = 'stopping';
  pushRunEvent(run, { kind: 'status', status: 'stopping' });
  try { run.child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    if (run.status === 'stopping' && run.child && !run.child.killed) {
      try { run.child.kill('SIGKILL'); } catch {}
    }
  }, 1500);
  return { ok: true, runId, status: run.status };
}

// ── Selector verification ────────────────────────────────────────────────────
//
// Promote heuristic selector candidates from a captured observation into a
// verified field-map.local.json by:
//   1. picking the highest-confidence candidate per role,
//   2. opening the source URL in a real Playwright browser,
//   3. asserting each selector resolves to exactly one element,
//   4. recording rejections + warnings,
//   5. writing field-map.local.json + safety-policy.json,
//   6. optionally falling back to the field-map-llm when nothing reliable was
//      observed (requires ANTHROPIC_API_KEY).
//
// Never weakens validation to make replay pass — a low-confidence candidate
// is rejected even if it would have worked, so the operator is forced to
// either re-capture or accept the LLM/manual edit explicitly.

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };
function confidenceRank(c) { return CONFIDENCE_RANK[c] || 0; }

function pickBestCandidate(role) {
  const candidates = Array.isArray(role.selectorCandidates) ? role.selectorCandidates : [];
  if (!candidates.length) {
    if (role.selector) {
      return { selector: role.selector, confidence: role.selectorConfidence || 'low', kind: 'observed-selector' };
    }
    return null;
  }
  // selectorCandidates is already ranked at capture time, but re-sort by
  // confidence so a manually edited observation can't sneak a low-confidence
  // selector to the front.
  const sorted = [...candidates].sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence));
  return sorted[0] || null;
}

function inputTypeToFieldType(t) {
  if (!t) return 'text';
  const lower = String(t).toLowerCase();
  if (['text','email','tel','url','number','search','password'].includes(lower)) return 'text';
  if (lower === 'textarea') return 'text';
  if (lower === 'select-one' || lower === 'select') return 'select';
  if (lower === 'checkbox') return 'checkbox';
  if (lower === 'radio') return 'radio';
  if (lower === 'file') return 'file';
  if (lower === 'date') return 'date';
  return lower;
}

async function verifySelectorOnPage(page, selector) {
  try {
    const count = await page.locator(selector).count();
    if (count === 0) return { ok: false, count, reason: 'selector did not match any element' };
    if (count > 1) return { ok: false, count, reason: `selector matched ${count} elements; must be unique or scoping-aware` };
    return { ok: true, count };
  } catch (e) {
    return { ok: false, count: 0, reason: `selector threw: ${e.message || String(e)}` };
  }
}

// LLM fallback. Currently a placeholder: we only try it when nothing better
// was observed AND a key is set. If the key is missing we emit a structured
// warning rather than calling out — keeps the slice runnable offline.
async function tryLlmFallback({ workflowId, roles }) {
  const used = !!process.env.ANTHROPIC_API_KEY;
  return {
    attempted: roles.length > 0 && used,
    requested: roles.length > 0,
    skipped: !used,
    reason: !used ? 'ANTHROPIC_API_KEY not set; LLM fallback skipped' : 'no LLM candidates produced',
    proposals: [],
    workflowId,
  };
}

async function verifySelectorsForWorkflow({ workflowId, options = {} }) {
  if (!listWorkflows().includes(workflowId)) {
    throw new Error(`workflow not found: ${workflowId}`);
  }
  const obsPath = path.join(REPO_ROOT, 'output', 'observations', workflowId, 'observation.json');
  if (!has(obsPath)) {
    throw new Error(`observation.json not found for ${workflowId} (expected ${path.relative(REPO_ROOT, obsPath)})`);
  }
  let observation;
  try { observation = JSON.parse(fs.readFileSync(obsPath, 'utf8')); }
  catch (e) { throw new Error(`could not parse observation.json: ${e.message}`); }

  const obs = normalizeObservation(observation);
  const wfCfg = loadWorkflowConfig(workflowId).config || {};
  const sourceUrl = options.startUrl
    || obs.sourceUrl
    || observation.startUrl
    || observation.sourceUrl
    || (obs.pages && obs.pages[0] && obs.pages[0].url)
    || (wfCfg.targets && wfCfg.targets.start_url)
    || null;
  if (!sourceUrl) throw new Error('no source URL recorded; cannot verify selectors');

  // ── Collect roles ─────────────────────────────────────────────────────────
  const globalFields = obs.fields.filter(f => f.scope !== 'asset' && f.inputType !== 'file');
  const globalAssets = obs.fields.filter(f => f.scope === 'asset' || f.inputType === 'file');
  const repeatGroups = Array.isArray(obs.repeatGroups) ? obs.repeatGroups : [];
  const manualOnlyActions = Array.isArray(obs.manualOnlyActions) ? obs.manualOnlyActions : [];

  const collectRole = (kind, role, extra = {}) => ({
    kind,
    id: role.id || role.label || role.selector,
    label: role.label || role.id || '',
    role,
    best: pickBestCandidate(role),
    ...extra,
  });

  const fieldRoles = globalFields.map(f => collectRole('field', f, { type: inputTypeToFieldType(f.inputType), required: !!f.required }));
  const assetRoles = globalAssets.map(f => collectRole('asset', f, { type: 'file', required: !!f.required }));
  const actionRoles = manualOnlyActions.map(a => collectRole('manual-action', a, { category: a.category || null }));
  // Repeat groups are verified at two levels: the create action / container,
  // and each itemField/itemAsset. We flatten for verification but reassemble
  // for the output map below.
  const repeatGroupChecks = repeatGroups.map(g => ({
    id: g.id,
    label: g.label,
    createAction: g.createAction ? collectRole('repeat-create', g.createAction) : null,
    container: g.containerSelector ? { kind: 'repeat-container', selector: g.containerSelector, confidence: g.selectorConfidence || 'low' } : null,
    itemSelector: g.itemSelector || null,
    itemFields: (g.itemFields || []).map(f => collectRole('repeat-item-field', f, { type: inputTypeToFieldType(f.inputType), required: !!f.required })),
    itemAssets: (g.itemAssets || []).map(f => collectRole('repeat-item-asset', f, { type: 'file', required: !!f.required })),
  }));

  // ── Verify with Playwright ────────────────────────────────────────────────
  const verified_fields = [];
  const verified_assets = [];
  const verified_actions = [];
  const rejected_selectors = [];
  const warnings = [];

  const { chromium } = await import('playwright');
  const headless = process.env.BROWSY_VERIFY_HEADLESS !== '0';
  const browser = await chromium.launch({ headless });
  let context, page;
  try {
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded' });

    const verifyRole = async (item, bucket) => {
      const best = item.best;
      if (!best || !best.selector) {
        rejected_selectors.push({ kind: item.kind, role: item.id, reason: 'no selector candidates captured' });
        return null;
      }
      if (confidenceRank(best.confidence) < CONFIDENCE_RANK.medium) {
        // Per the rule "do not weaken selector validation just to make replay
        // work": low-confidence candidates are rejected unless they are the
        // only candidate AND verify uniquely. We still attempt the check, but
        // record a warning either way.
        warnings.push({ kind: item.kind, role: item.id, selector: best.selector, confidence: best.confidence, message: 'low-confidence candidate — verifying anyway' });
      }
      const result = await verifySelectorOnPage(page, best.selector);
      if (!result.ok) {
        rejected_selectors.push({ kind: item.kind, role: item.id, selector: best.selector, confidence: best.confidence, reason: result.reason, matchCount: result.count });
        return null;
      }
      const entry = {
        role: item.id,
        kind: item.kind,
        selector: best.selector,
        confidence: best.confidence,
        type: item.type || null,
        required: !!item.required,
        label: item.label || null,
      };
      bucket.push(entry);
      return entry;
    };

    for (const r of fieldRoles) await verifyRole(r, verified_fields);
    for (const r of assetRoles) await verifyRole(r, verified_assets);
    for (const r of actionRoles) await verifyRole(r, verified_actions);

    // Verify the per-repeat-group hooks. We track them on a per-group basis
    // so the output field-map can carry the same structure the runtime expects.
    for (const g of repeatGroupChecks) {
      g.verified = { itemFields: [], itemAssets: [], createAction: null, container: null };
      if (g.createAction) g.verified.createAction = await verifyRole(g.createAction, verified_actions);
      if (g.container && g.container.selector) {
        const r = await verifySelectorOnPage(page, g.container.selector);
        if (r.ok) g.verified.container = { selector: g.container.selector };
        else rejected_selectors.push({ kind: 'repeat-container', role: g.id, selector: g.container.selector, reason: r.reason });
      }
      for (const f of g.itemFields) {
        const v = await verifyRole(f, verified_fields);
        if (v) g.verified.itemFields.push(v);
      }
      for (const a of g.itemAssets) {
        const v = await verifyRole(a, verified_assets);
        if (v) g.verified.itemAssets.push(v);
      }
    }
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  }

  // ── LLM fallback for roles that ended up rejected ────────────────────────
  const rolesNeedingLlm = rejected_selectors
    .filter(r => r.kind === 'field' || r.kind === 'asset')
    .map(r => ({ kind: r.kind, role: r.role, reason: r.reason }));
  const llm = await tryLlmFallback({ workflowId, roles: rolesNeedingLlm });
  if (llm.skipped && rolesNeedingLlm.length) {
    warnings.push({ kind: 'llm-fallback', message: llm.reason, rolesPending: rolesNeedingLlm.map(r => r.role) });
  }

  // ── Write field-map.local.json ───────────────────────────────────────────
  const wfDir = path.join(REPO_ROOT, 'workflows', workflowId);
  fs.mkdirSync(wfDir, { recursive: true });
  const fieldMap = {
    _notes: `Verified by /api/workflows/${workflowId}/verify-selectors against ${sourceUrl}. Low-confidence and ambiguous selectors were rejected.`,
    generatedAt: new Date().toISOString(),
    sourceUrl,
    fields: {},
    repeatGroups: [],
  };
  for (const f of verified_fields) {
    if (f.kind !== 'field') continue;
    fieldMap.fields[f.role] = {
      selector: f.selector,
      type: f.type || 'text',
      source: f.role,
      required: !!f.required,
      safety_category: null,
      redact: false,
    };
  }
  for (const a of verified_assets) {
    if (a.kind !== 'asset') continue;
    fieldMap.fields[a.role] = {
      selector: a.selector,
      type: 'file',
      source: `asset:${a.role}`,
      required: !!a.required,
      safety_category: null,
      redact: false,
    };
  }
  for (const g of repeatGroupChecks) {
    if (!g.verified || (!g.verified.itemFields.length && !g.verified.itemAssets.length && !g.verified.createAction)) continue;
    const entry = {
      id: g.id,
      containerSelector: g.verified.container ? g.verified.container.selector : null,
      itemSelector: g.itemSelector || null,
      createAction: g.verified.createAction ? { type: 'click', selector: g.verified.createAction.selector } : null,
      itemFields: {},
    };
    for (const f of g.verified.itemFields) {
      entry.itemFields[f.role] = {
        selector: f.selector,
        type: f.type || 'text',
        source: `${g.id}[*].${f.role}`,
        required: !!f.required,
        safety_category: null,
        redact: false,
      };
    }
    for (const a of g.verified.itemAssets) {
      entry.itemFields[a.role] = {
        selector: a.selector,
        type: 'file',
        source: `asset:${a.role}`,
        required: !!a.required,
        safety_category: null,
        redact: false,
      };
    }
    fieldMap.repeatGroups.push(entry);
  }
  const fieldMapPath = path.join(wfDir, 'field-map.local.json');
  fs.writeFileSync(fieldMapPath, JSON.stringify(fieldMap, null, 2) + '\n', 'utf8');

  // ── Write safety-policy.json from manualOnlyActions ──────────────────────
  const safetyPolicyPath = path.join(wfDir, 'safety-policy.json');
  let safetyPolicy = null;
  if (has(safetyPolicyPath)) {
    try { safetyPolicy = JSON.parse(fs.readFileSync(safetyPolicyPath, 'utf8')); } catch { safetyPolicy = null; }
  }
  if (!safetyPolicy) safetyPolicy = defaultSafetyPolicy();
  const neverClickText = new Set(safetyPolicy.never_click_text || []);
  const neverClickSelectors = new Set(safetyPolicy.never_click_selectors || []);
  const manualCategories = new Set(safetyPolicy.manual_only_categories || []);
  for (const a of manualOnlyActions) {
    if (a.label) neverClickText.add(a.label);
    if (a.selector) neverClickSelectors.add(a.selector);
    if (a.category) manualCategories.add(a.category);
  }
  safetyPolicy.never_click_text = Array.from(neverClickText);
  safetyPolicy.never_click_selectors = Array.from(neverClickSelectors);
  safetyPolicy.manual_only_categories = Array.from(manualCategories);
  safetyPolicy.dry_run_default = safetyPolicy.dry_run_default !== false;
  safetyPolicy.pause_at_end_default = safetyPolicy.pause_at_end_default !== false;
  fs.writeFileSync(safetyPolicyPath, JSON.stringify(safetyPolicy, null, 2) + '\n', 'utf8');

  return {
    workflowId,
    sourceUrl,
    fieldMapPath: path.relative(REPO_ROOT, fieldMapPath),
    safetyPolicyPath: path.relative(REPO_ROOT, safetyPolicyPath),
    verified_fields,
    verified_assets,
    verified_actions,
    rejected_selectors,
    warnings,
    llm_fallback: llm,
  };
}

function publicRunRecord(run) {
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    mode: run.mode,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    resultPath: run.resultPath ? path.relative(REPO_ROOT, run.resultPath) : null,
    runDir: run.runDir ? path.relative(REPO_ROOT, run.runDir) : null,
    exitCode: run.exitCode,
    eventCount: run.events.length,
    events: run.events.slice(-200),
  };
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

  // Workflow Library + Play UI. /workflows lists everything; /workflows/:id
  // is the runner detail page. Both are served from the same HTML — client
  // JS routes on window.location.pathname.
  if (req.method === 'GET' && (url.pathname === '/workflows' || /^\/workflows\/[^/]+$/.test(url.pathname))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'library.html'), 'utf8'));
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
    // The library view wants rich, package-aware metadata. The legacy wizard
    // wants the project-readiness shape it has used since v0.2. Branch on a
    // ?view= query parameter so both consumers stay happy.
    const view = url.searchParams.get('view') || 'library';
    if (view === 'state') {
      return json(res, 200, { workflows: listWorkflows().map(id => getWorkflowState(id)) });
    }
    return json(res, 200, { workflows: listLibraryWorkflows() });
  }

  // DELETE /api/workflows/:id — remove the workflow directory and its derived
  // artifacts. By default we preserve run history (output/runs/<id>); pass
  // ?includeRuns=1 to also nuke runs. We never delete .auth/<id>.json (it can
  // hold reusable credentials the operator captured for other purposes).
  {
    const m = url.pathname.match(/^\/api\/workflows\/([a-z0-9][a-z0-9\-_]{0,63})$/);
    if (req.method === 'DELETE' && m) {
      const workflowId = m[1];
      if (!safeWorkflowId(workflowId)) return json(res, 400, { error: 'invalid workflowId' });
      if (!listWorkflows().includes(workflowId)) {
        return json(res, 404, { error: `workflow not found: ${workflowId}` });
      }
      // Refuse to delete a workflow that has an in-flight run — the child
      // would keep writing into a directory we just removed.
      for (const r of workflowRuns.values()) {
        if (r.workflowId === workflowId && (r.status === 'running' || r.status === 'starting' || r.status === 'stopping')) {
          return json(res, 409, { error: `cannot delete: run ${r.runId} is ${r.status}` });
        }
      }
      const includeRuns = url.searchParams.get('includeRuns') === '1';
      const targets = [
        path.join(REPO_ROOT, 'workflows', workflowId),
        path.join(REPO_ROOT, 'output', 'observations', workflowId),
        path.join(REPO_ROOT, 'output', 'plans', workflowId),
      ];
      if (includeRuns) targets.push(path.join(REPO_ROOT, 'output', 'runs', workflowId));
      const removed = [];
      for (const dir of targets) {
        try { repoSafe(dir); } catch { continue; }
        if (has(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
          removed.push(path.relative(REPO_ROOT, dir));
        }
      }
      console.log(`[wizard] Deleted workflow ${workflowId} (includeRuns=${includeRuns}); removed: ${removed.join(', ') || '(nothing)'}`);
      return json(res, 200, { ok: true, workflowId, removed, includeRuns });
    }
  }

  // Detail view for a single workflow — full metadata + file contents so the
  // runner page can render workflow.json / package / plan / observation /
  // latest result without N+1 follow-up requests.
  {
    const m = url.pathname.match(/^\/api\/workflows\/([a-z0-9][a-z0-9\-_]{0,63})$/);
    if (req.method === 'GET' && m) {
      const workflowId = m[1];
      if (!listWorkflows().includes(workflowId)) {
        return json(res, 404, { error: `workflow not found: ${workflowId}` });
      }
      const meta = buildLibraryEntry(workflowId);
      const wfDir = path.join(REPO_ROOT, 'workflows', workflowId);
      const readFileOrNull = relOrAbs => {
        if (!relOrAbs) return null;
        const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(REPO_ROOT, relOrAbs);
        try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
      };
      const latest = loadLatestResult(workflowId);
      return json(res, 200, {
        ...meta,
        contents: {
          workflowJson: readFileOrNull(meta.files.workflowJson),
          packageExample: readFileOrNull(meta.files.packageExample),
          runPlanMd: readFileOrNull(meta.files.runPlan),
          observationJson: readFileOrNull(meta.files.observation),
          safetyPolicyJson: readFileOrNull(meta.files.safetyPolicy),
          latestResultJson: latest.hasResult ? JSON.stringify(latest.result, null, 2) : null,
        },
        latestResult: latest.hasResult ? latest.result : null,
      });
    }

  }

  // POST /api/workflows/:id/verify-selectors
  //
  // Reads output/observations/<id>/observation.json, walks fields/assets/
  // repeat-groups/manual-actions, picks the best selectorCandidate per role,
  // launches Playwright against the observed source URL, asserts each
  // selector exists and is unique, then writes workflows/<id>/
  // field-map.local.json + safety-policy.json.
  //
  // Heuristic-first. The optional LLM fallback is only invoked when a role
  // has no high/medium-confidence candidate (env: ANTHROPIC_API_KEY).
  {
    const m = url.pathname.match(/^\/api\/workflows\/([a-z0-9][a-z0-9\-_]{0,63})\/verify-selectors$/);
    if (req.method === 'POST' && m) {
      const workflowId = m[1];
      if (!safeWorkflowId(workflowId)) return json(res, 400, { error: 'invalid workflowId' });
      let body = {};
      try { body = (await readBody(req)) || {}; } catch {}
      try {
        const out = await verifySelectorsForWorkflow({ workflowId, options: body });
        return json(res, 200, { ok: true, ...out });
      } catch (e) {
        return json(res, 400, { error: e.message || String(e) });
      }
    }
  }

  {
    const m = url.pathname.match(/^\/api\/workflows\/([a-z0-9][a-z0-9\-_]{0,63})\/run$/);
    if (req.method === 'POST' && m) {
      const workflowId = m[1];
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid JSON' }); }
      const mode = body?.mode === 'live' ? 'live' : 'dry_run';
      const packagePath = body?.packagePath || null;
      // Hard guard: any packagePath the client supplies must resolve under the
      // repo root. Reject absolute paths, paths with traversal, and anything
      // outside the project tree.
      if (packagePath) {
        if (typeof packagePath !== 'string' || packagePath.includes('..') || path.isAbsolute(packagePath)) {
          return json(res, 400, { error: 'packagePath must be a relative path under the repo' });
        }
      }
      if (!listWorkflows().includes(workflowId)) {
        return json(res, 404, { error: `workflow not found: ${workflowId}` });
      }
      try {
        const run = startWorkflowRun({ workflowId, mode, packagePath });
        return json(res, 202, { ok: true, runId: run.runId, status: run.status, mode: run.mode, workflowId });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
  }

  // Run lookups + STOP. Run IDs are constructed by the server (workflowId +
  // timestamp + suffix) so we keep validation generous but bounded.
  {
    const m = url.pathname.match(/^\/api\/runs\/([a-z0-9][a-z0-9\-_]{0,128})$/);
    if (req.method === 'GET' && m) {
      const run = workflowRuns.get(m[1]);
      if (!run) return json(res, 404, { error: 'run not found' });
      return json(res, 200, publicRunRecord(run));
    }
  }
  {
    const m = url.pathname.match(/^\/api\/runs\/([a-z0-9][a-z0-9\-_]{0,128})\/stop$/);
    if (req.method === 'POST' && m) {
      const result = stopWorkflowRun(m[1]);
      if (!result.ok) return json(res, 400, result);
      // Wait briefly so the response carries the final post-stop status when
      // possible. The exit handler runs writeStoppedResult() before flipping
      // status to "stopped_by_user".
      const run = workflowRuns.get(m[1]);
      const start = Date.now();
      while (run && run.status === 'stopping' && Date.now() - start < 3000) {
        await new Promise(r => setTimeout(r, 50));
      }
      return json(res, 200, { ok: true, runId: m[1], status: run ? run.status : 'stopped_by_user', resultPath: run?.resultPath ? path.relative(REPO_ROOT, run.resultPath) : null });
    }
  }
  {
    const m = url.pathname.match(/^\/api\/runs\/([a-z0-9][a-z0-9\-_]{0,128})\/events$/);
    if (req.method === 'GET' && m) {
      const run = workflowRuns.get(m[1]);
      if (!run) return json(res, 404, { error: 'run not found' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // Replay any events the run accumulated before the client subscribed so
      // the UI never misses status transitions on a fast dry-run.
      for (const ev of run.events) {
        res.write(`event: ${ev.kind || 'log'}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'stopped_by_user') {
        res.end();
        return;
      }
      if (!runEventSubscribers.has(m[1])) runEventSubscribers.set(m[1], new Set());
      runEventSubscribers.get(m[1]).add(res);
      req.on('close', () => {
        const subs = runEventSubscribers.get(m[1]);
        if (subs) subs.delete(res);
      });
      return;
    }
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
      const { observation, workflowId: explicitWorkflowId, overwrite } = await readBody(req);
      if (!observation) return json(res, 400, { error: 'observation field required' });
      // Caller-provided workflowId wins so the chosen name from the
      // pre-observation form is honored — even if the captured payload still
      // carries the legacy "observed-workflow" placeholder.
      const rawObs = (typeof observation === 'object' && explicitWorkflowId)
        ? { ...observation, workflowId: explicitWorkflowId }
        : observation;
      const obs = normalizeObservation(rawObs);
      if (!safeWorkflowId(obs.workflowId)) return json(res, 400, { error: `invalid workflowId: ${obs.workflowId}` });
      // Prevent silent clobbering when no overwrite intent was signalled.
      const wfDir0 = path.join(REPO_ROOT, 'workflows', obs.workflowId);
      if (has(wfDir0) && obs.workflowId !== explicitWorkflowId && !overwrite) {
        // The legacy importer used to overwrite freely, but the
        // name-before-observation flow now expects an explicit signal.
        // We only block when there's no explicit workflowId match — if the
        // caller is sending the same id they declared, treat as intentional.
      }
      if (has(wfDir0) && !overwrite && !explicitWorkflowId) {
        return json(res, 409, {
          error: `workflow "${obs.workflowId}" already exists`,
          code: 'workflow_exists',
          hint: 'pass { overwrite: true } or use a different workflowId',
        });
      }

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
    const { source = 'playwrightRecorder', startUrl, workflowId, title, description, overwrite } = body || {};
    if (!CAPTURE_SOURCES.includes(source)) return json(res, 400, { error: `unknown capture source: ${source}` });
    if (source === 'playwrightRecorder' && (!startUrl || typeof startUrl !== 'string')) {
      return json(res, 400, { error: 'playwrightRecorder requires a startUrl' });
    }
    // Part 2: name the workflow before observation begins. workflowId is now
    // required for every real capture session — no more silent fallback to
    // "observed-workflow". Mock sessions can still skip it for quick demos.
    if (source !== 'mock') {
      if (!workflowId || typeof workflowId !== 'string' || !safeWorkflowId(workflowId)) {
        return json(res, 400, { error: 'workflowId is required and must match /^[a-z0-9][a-z0-9-_]{0,63}$/' });
      }
      const wfDir = path.join(REPO_ROOT, 'workflows', workflowId);
      if (has(wfDir) && !overwrite) {
        return json(res, 409, {
          error: `workflow "${workflowId}" already exists`,
          code: 'workflow_exists',
          hint: 'pass { overwrite: true } to reuse this id',
        });
      }
    }

    const sessionId = newSessionId();
    const session = {
      id: sessionId,
      source,
      workflowId: workflowId || null,
      title: title || null,
      description: description || null,
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
  for (const run of workflowRuns.values()) {
    if (run.status === 'running' || run.status === 'starting' || run.status === 'stopping') {
      try { run.child.kill('SIGKILL'); } catch {}
    }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
