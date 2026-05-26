#!/usr/bin/env node
/**
 * Acceptance — observation evidence capture (Sprint 4).
 *
 * Locks down the per-state visual-evidence slice: every detected page state
 * can carry a screenshot path, DOM-snapshot path, and visible-text summary.
 * The new `page_snapshot_captured` event flows from the wizard's Playwright
 * recorder into the converted observation and into the human-readable
 * preview, with sane fallbacks when capture didn't run (headless tests, no
 * Playwright, capture disabled).
 *
 * Checks:
 *   1  Synthetic event log with full evidence (screenshot + DOM + visible
 *      text) is surfaced per page — screenshotsAvailable / domSnapshotsAvailable /
 *      visibleTextAvailable all true; snapshots[] carries the structured fields.
 *   2  Multiple snapshots per page (session_start + click_after + add_instance)
 *      all land on the page's evidence.snapshots[] in order, each with its
 *      `kind` and `hint`.
 *   3  Evidence missing (no page_snapshot_captured) → conversion still
 *      succeeds; preview renders "not captured" placeholders without throwing.
 *   4  Screenshot-only OR text-only OR dom-only snapshots are all tolerated;
 *      the corresponding *Available flags reflect what's actually present.
 *   5  Hard-dangerous actions remain manual-only even when evidence is rich
 *      (heuristic must not be loosened by snapshot presence).
 *   6  No absolute filesystem paths appear in synthesized events or in the
 *      rendered preview. All paths must be repo-relative.
 *   7  Preview markdown renders an Evidence section for each page including
 *      screenshot path, DOM snapshot path, visible text summary; "not
 *      captured" placeholder when missing.
 *   8  The captureVisualEvidence() adapter respects
 *      BROWSY_OBS_CAPTURE_SCREENSHOTS=0 / BROWSY_OBS_CAPTURE_DOM=0
 *      (no-page path returns shape-correct payload without throwing).
 *
 * Usage:
 *   npm run acceptance:observation-evidence-capture
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildObservationFromEvents } from '../src/core/observation-from-events.mjs';
import { renderObservationPreview } from '../src/core/observation-preview.mjs';
import { captureVisualEvidence, evidenceToRawEvidence, __testing } from '../src/adapters/observation/visual-evidence-adapter.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') { console.error('FAIL  ' + label + (detail ? '\n      ' + detail : '')); failed++; }
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

// ── Path-leak detector ──────────────────────────────────────────────────────
const ABS_PATH_RX = /(\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/tmp\/|~\/|[A-Z]:\\|file:\/\/)/;
function findAbsLeaks(node, trail = '') {
  const leaks = [];
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const at = trail ? `${trail}.${k}` : k;
      if (typeof v === 'string' && ABS_PATH_RX.test(v)) leaks.push({ at, value: v });
      else if (v && typeof v === 'object') leaks.push(...findAbsLeaks(v, at));
    }
  }
  return leaks;
}

// ── Event-log builders ──────────────────────────────────────────────────────
function ev(i, type, partial = {}) {
  return {
    id: `evt-${String(i).padStart(3, '0')}`,
    sessionId: 'session-test',
    timestamp: `+${i}`,
    type,
    source: 'playwrightRecorder',
    ...partial,
  };
}
function snapshotEvent(i, pageUrl, raw) {
  return ev(i, 'page_snapshot_captured', { pageUrl, rawEvidence: raw });
}

const RICH_PATH_SCREENSHOT = 'output/observations/_sessions/session-test/screenshots/001-session_start-initial_load.png';
const RICH_PATH_DOM        = 'output/observations/_sessions/session-test/dom/001-session_start-initial_load.html';

// ── Check 1 — Full evidence ────────────────────────────────────────────────
section(1, 'Full evidence (screenshot + DOM + visible text) lands on the page');
{
  const obs = buildObservationFromEvents({
    events: [
      ev(0, 'session_started'),
      ev(1, 'page_seen', { pageUrl: '/stage1', pageTitle: 'Stage 1' }),
      snapshotEvent(2, '/stage1', {
        kind: 'session_start',
        hint: 'initial_load',
        url: '/stage1',
        title: 'Stage 1',
        screenshotPath: RICH_PATH_SCREENSHOT,
        domSnapshotPath: RICH_PATH_DOM,
        visibleTextSummary: 'Release Upload — realistic fixture',
        viewport: { width: 1280, height: 720 },
        capturedAt: '2026-05-25T12:00:00.000Z',
      }),
    ],
    workflowId: 'evidence-rich',
    captureSource: 'playwrightRecorder',
  });
  const page = (obs.pages || [])[0];
  const ok =
    page && page.evidence
    && page.evidence.screenshotsAvailable === true
    && page.evidence.domSnapshotsAvailable === true
    && page.evidence.visibleTextAvailable === true
    && Array.isArray(page.evidence.snapshots)
    && page.evidence.snapshots.length === 1
    && page.evidence.snapshots[0].screenshotPath === RICH_PATH_SCREENSHOT
    && page.evidence.snapshots[0].domSnapshotPath === RICH_PATH_DOM
    && /realistic fixture/i.test(page.evidence.snapshots[0].visibleTextSummary || '');
  ok
    ? pass('evidence carries screenshotPath, domSnapshotPath, visibleTextSummary')
    : fail('rich evidence not surfaced', JSON.stringify(page?.evidence, null, 2));
}

// ── Check 2 — Multiple snapshots per page ──────────────────────────────────
section(2, 'Multiple snapshots per page land in order with kind + hint');
{
  const obs = buildObservationFromEvents({
    events: [
      ev(0, 'page_seen', { pageUrl: '/multi', pageTitle: 'Multi' }),
      snapshotEvent(1, '/multi', { kind: 'session_start', hint: 'initial_load', visibleTextSummary: 'before' }),
      ev(2, 'action_detected', { pageUrl: '/multi', selector: '#btn', rawEvidence: { label: 'Click me' } }),
      snapshotEvent(3, '/multi', { kind: 'click_after', hint: 'Click me', visibleTextSummary: 'after click' }),
      ev(4, 'repeat_group_candidate_detected', { pageUrl: '/multi', selector: '#add', rawEvidence: { label: '+ Add another track' } }),
      snapshotEvent(5, '/multi', { kind: 'add_instance', hint: '+ Add another track', visibleTextSummary: 'after add' }),
    ],
    workflowId: 'evidence-multi',
    captureSource: 'playwrightRecorder',
  });
  const page = (obs.pages || [])[0];
  const snaps = page && page.evidence && page.evidence.snapshots;
  const ok =
    Array.isArray(snaps) && snaps.length === 3
    && snaps[0].kind === 'session_start' && snaps[0].hint === 'initial_load'
    && snaps[1].kind === 'click_after'   && /Click/.test(snaps[1].hint)
    && snaps[2].kind === 'add_instance'  && /Add another/i.test(snaps[2].hint)
    && snaps.map(s => s.visibleTextSummary).join('|') === 'before|after click|after add';
  ok
    ? pass(`3 snapshots in order: ${snaps.map(s => s.kind).join(' → ')}`)
    : fail('snapshots not surfaced in order', JSON.stringify(snaps, null, 2));
}

// ── Check 3 — No evidence at all → graceful fallback ───────────────────────
section(3, 'Missing evidence does not break conversion');
{
  let obs, preview;
  try {
    obs = buildObservationFromEvents({
      events: [
        ev(0, 'session_started'),
        ev(1, 'page_seen', { pageUrl: '/no-evidence', pageTitle: 'No Evidence' }),
        ev(2, 'field_detected', { pageUrl: '/no-evidence', selector: '#title', rawEvidence: { id: 'title', name: 'title', inputType: 'text', value: 'X', required: true, selectorCandidates: [{ selector: '#title', kind: 'id', confidence: 'high' }], selectorConfidence: 'high' } }),
      ],
      workflowId: 'no-evidence',
      captureSource: 'playwrightRecorder',
    });
    preview = renderObservationPreview(obs);
  } catch (e) {
    fail('conversion/preview threw when evidence missing', e.message);
  }
  const page = obs && obs.pages && obs.pages[0];
  const ok =
    page && page.evidence
    && page.evidence.screenshotsAvailable === false
    && page.evidence.domSnapshotsAvailable === false
    && page.evidence.visibleTextAvailable === false
    && Array.isArray(page.evidence.snapshots) && page.evidence.snapshots.length === 0
    && typeof page.evidence.reason === 'string'
    && /not captured/i.test(preview || '');
  ok
    ? pass('page evidence flags are all false with a reason; preview shows "not captured"')
    : fail('fallback path broken', JSON.stringify({ evidence: page?.evidence, previewSnippet: (preview||'').slice(0, 300) }, null, 2));
}

// ── Check 4 — Partial evidence ─────────────────────────────────────────────
section(4, 'Partial evidence (one of screenshot / dom / text) is tolerated');
{
  const cases = [
    {
      label: 'screenshot-only',
      raw: { kind: 'session_start', screenshotPath: 'output/observations/_sessions/session-test/screenshots/x.png' },
      expect: { screenshotsAvailable: true, domSnapshotsAvailable: false, visibleTextAvailable: false },
    },
    {
      label: 'dom-only',
      raw: { kind: 'session_start', domSnapshotPath: 'output/observations/_sessions/session-test/dom/x.html' },
      expect: { screenshotsAvailable: false, domSnapshotsAvailable: true, visibleTextAvailable: false },
    },
    {
      label: 'text-only',
      raw: { kind: 'session_start', visibleTextSummary: 'just text' },
      expect: { screenshotsAvailable: false, domSnapshotsAvailable: false, visibleTextAvailable: true },
    },
  ];
  let allOk = true;
  for (const c of cases) {
    const obs = buildObservationFromEvents({
      events: [
        ev(0, 'page_seen', { pageUrl: '/p', pageTitle: 'P' }),
        snapshotEvent(1, '/p', c.raw),
      ],
      workflowId: 'partial',
      captureSource: 'playwrightRecorder',
    });
    const ev1 = obs.pages[0].evidence;
    const ok = Object.entries(c.expect).every(([k, v]) => ev1[k] === v);
    if (!ok) {
      fail(`partial evidence ${c.label} flags wrong`, JSON.stringify(ev1));
      allOk = false;
    }
  }
  if (allOk) pass(`screenshot-only / dom-only / text-only flags reflect what's actually present`);
}

// ── Check 5 — Dangerous heuristic survives even with full evidence ─────────
section(5, 'Hard-dangerous actions remain manual-only when evidence is rich');
{
  const obs = buildObservationFromEvents({
    events: [
      ev(0, 'page_seen', { pageUrl: '/review', pageTitle: 'Review' }),
      snapshotEvent(1, '/review', { kind: 'session_start', screenshotPath: 'output/observations/_sessions/session-test/screenshots/r.png' }),
      ev(2, 'dangerous_action_candidate_detected', { pageUrl: '/review', selector: '#submit', rawEvidence: { label: 'Submit & Publish Release', matchedKeyword: 'Submit', selectorCandidates: [{ selector: '#submit', kind: 'id', confidence: 'high' }], selectorConfidence: 'high' } }),
      // Nav-style label that must NOT become a dangerous action.
      ev(3, 'dangerous_action_candidate_detected', { pageUrl: '/review', selector: '#nav', rawEvidence: { label: 'Review release →', matchedKeyword: 'release', selectorCandidates: [{ selector: '#nav', kind: 'id', confidence: 'high' }], selectorConfidence: 'high' } }),
    ],
    workflowId: 'heuristic-still-tight',
    captureSource: 'playwrightRecorder',
  });
  const labels = (obs.manualOnlyActions || []).map(a => a.label);
  const hasPublish = labels.some(l => /Submit\s*&\s*Publish/i.test(l));
  const hasReviewNav = labels.some(l => /^Review release/i.test(l));
  hasPublish && !hasReviewNav
    ? pass(`manual-only contains "Submit & Publish Release" and not "Review release →" (${labels.join(' | ')})`)
    : fail('heuristic loosened or tightened wrongly', JSON.stringify(labels));
}

// ── Check 6 — Path leak guard ──────────────────────────────────────────────
section(6, 'No absolute filesystem paths in events or preview');
{
  const obs = buildObservationFromEvents({
    events: [
      ev(0, 'page_seen', { pageUrl: '/x', pageTitle: 'X' }),
      snapshotEvent(1, '/x', {
        kind: 'session_start',
        screenshotPath: 'output/observations/_sessions/session-test/screenshots/001.png',
        domSnapshotPath: 'output/observations/_sessions/session-test/dom/001.html',
        visibleTextSummary: 'safe text',
      }),
    ],
    workflowId: 'path-safe',
    captureSource: 'playwrightRecorder',
  });
  const eventLeaks = findAbsLeaks(obs.sessionEvents || []);
  const obsLeaks = findAbsLeaks(obs);
  const preview = renderObservationPreview(obs);
  const previewLeak = ABS_PATH_RX.test(preview);
  eventLeaks.length === 0 && obsLeaks.length === 0 && !previewLeak
    ? pass('no absolute paths in events, observation, or preview')
    : fail('absolute path leak', JSON.stringify({ eventLeaks, obsLeaks, previewLeak }));
}

// ── Check 7 — Preview renders evidence sections ────────────────────────────
section(7, 'Preview renders evidence section for every page state');
{
  const obs = buildObservationFromEvents({
    events: [
      ev(0, 'page_seen', { pageUrl: '/stage', pageTitle: 'Stage' }),
      snapshotEvent(1, '/stage', {
        kind: 'session_start',
        hint: 'initial_load',
        screenshotPath: 'output/observations/_sessions/session-test/screenshots/s.png',
        domSnapshotPath: 'output/observations/_sessions/session-test/dom/s.html',
        visibleTextSummary: 'Stage one is mounted',
        viewport: { width: 1280, height: 720 },
      }),
    ],
    workflowId: 'preview-evidence',
    captureSource: 'playwrightRecorder',
  });
  const md = renderObservationPreview(obs);
  const required = [
    'Evidence (session_start',
    'Screenshot:',
    '`output/observations/_sessions/session-test/screenshots/s.png`',
    'DOM snapshot:',
    '`output/observations/_sessions/session-test/dom/s.html`',
    'Visible text summary: Stage one is mounted',
    'Viewport: 1280×720',
  ];
  const missing = required.filter(r => !md.includes(r));
  missing.length === 0
    ? pass(`preview shows screenshot path, DOM path, visible text, viewport for all ${required.length} expected lines`)
    : fail('preview evidence section incomplete', JSON.stringify({ missing }));

  // Fallback case — preview must show "not captured" placeholders.
  const obs2 = buildObservationFromEvents({
    events: [ev(0, 'page_seen', { pageUrl: '/none', pageTitle: 'None' })],
    workflowId: 'no-evidence-preview',
    captureSource: 'playwrightRecorder',
  });
  const md2 = renderObservationPreview(obs2);
  const fallbackLines = ['Evidence: _none captured_', 'Screenshot: not captured', 'DOM snapshot: not captured', 'Visible text summary: not captured'];
  const fallbackMissing = fallbackLines.filter(r => !md2.includes(r));
  fallbackMissing.length === 0
    ? pass('preview falls back to "not captured" placeholders when evidence missing')
    : fail('preview fallback lines missing', JSON.stringify({ fallbackMissing }));
}

// ── Check 8 — captureVisualEvidence env flags + no-page path ───────────────
section(8, 'captureVisualEvidence respects opt-out flags and no-page path');
{
  // No page → returns shape, doesn't throw, error noted.
  const promise = captureVisualEvidence({ sessionId: 'session-test', repoRoot: REPO_ROOT, kind: 'page' });
  promise.then(result => {
    if (!result || result.error !== 'no Playwright page provided') {
      fail('no-page path did not return error payload', JSON.stringify(result));
      return;
    }
    // evidenceToRawEvidence on the same result must not throw and produce a shape.
    const raw = evidenceToRawEvidence(result);
    const ok = raw && raw.kind === 'page' && raw.screenshotPath === null && raw.domSnapshotPath === null;
    ok ? pass('no-page → safe payload + evidenceToRawEvidence produces null path fields') : fail('rawEvidence shape wrong', JSON.stringify(raw));

    // env-flag toggles
    const orig1 = process.env.BROWSY_OBS_CAPTURE_SCREENSHOTS;
    const orig2 = process.env.BROWSY_OBS_CAPTURE_DOM;
    try {
      process.env.BROWSY_OBS_CAPTURE_SCREENSHOTS = '0';
      process.env.BROWSY_OBS_CAPTURE_DOM = '0';
      if (__testing.screenshotsEnabled() === false && __testing.domSnapshotsEnabled() === false) {
        pass('BROWSY_OBS_CAPTURE_SCREENSHOTS=0 and BROWSY_OBS_CAPTURE_DOM=0 disable capture');
      } else {
        fail('env flags did not toggle off');
      }
    } finally {
      process.env.BROWSY_OBS_CAPTURE_SCREENSHOTS = orig1 || '';
      if (!orig1) delete process.env.BROWSY_OBS_CAPTURE_SCREENSHOTS;
      process.env.BROWSY_OBS_CAPTURE_DOM = orig2 || '';
      if (!orig2) delete process.env.BROWSY_OBS_CAPTURE_DOM;
    }
    finalize();
  }).catch(e => { fail('captureVisualEvidence threw unexpectedly', e.message); finalize(); });
}

function finalize() {
  console.log('\n══════════════════════════════════════');
  console.log(`Observation evidence capture: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════');
  if (failed > 0) process.exit(1);
}
