#!/usr/bin/env node
/**
 * Acceptance — DistroKid-album-style architecture hardening
 *
 * Builds confidence that the observation → workflow-package → run-plan →
 * executor → operator-UI pipeline supports a DistroKid-style album upload
 * cleanly, *without* touching the real DistroKid automation.
 *
 * The fixture (fixtures/distrokid-album-style/index.html) mimics a streaming
 * distributor: album-level fields once, a tracks repeat group, a safe "Build
 * Distro Draft" action that produces a captured output, and a download link
 * for the draft package. Final submit is dangerous and must never auto-click.
 *
 * Six requirements under test (numbered as in the spec):
 *   1. Global album fields are captured once.
 *   2. Track fields surface as itemFields / itemAssets, not flattened globals.
 *   3. Run plan produces:
 *        - one global setup section
 *        - one repeated section per track
 *        - no album-level field duplicated inside any track
 *   4. Output capture works after a safe action.
 *   5. Download capture is visible in the final run result.
 *   6. The generated workflow package clearly separates:
 *        albumInputs / trackRepeatGroup / capturedOutputs / downloadedFiles
 *
 *   + a run-history/UI visibility check so the operator can see the run
 *     result, not just the JSON on disk.
 *
 * Usage:
 *   npm run acceptance:distrokid-album-architecture
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildObservationFromEvents } from '../src/core/observation-from-events.mjs';
import {
  normalizeObservation,
  buildWorkflowPackageFromObservation,
} from '../src/core/observation-ingestion.mjs';
import { buildRunPlanFromPackage } from '../src/core/run-plan.mjs';
import { executeRunPlanWithPlaywright } from '../src/core/playwright-executor.mjs';
import { RETURN_CONTRACT_VERSION } from '../src/core/workflow-contract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_PATH = path.resolve(REPO_ROOT, 'fixtures/distrokid-album-style/index.html');

// Use a workflow id that is recognisable as a test artifact and unlikely to
// collide with anything real. The wizard server enforces a strict id format,
// so we keep it lowercase-with-hyphens.
const TEST_WORKFLOW_ID = 'distrokid-album-style-test';

// Keys after normalization (toCamel). The fixture uses snake_case names like
// `album_title`; the ingestion pipeline camelCases them.
const ALBUM_LEVEL_KEYS = ['albumTitle', 'albumArtist', 'recordLabel', 'upc', 'releaseDate'];
const ALBUM_ASSET_KEY = 'coverArt';
const TRACK_FIELD_KEYS = ['title', 'artist', 'isrc', 'explicit'];
const TRACK_ASSET_KEYS = ['audio'];

let passed = 0, failed = 0;
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

// ────────────────────────────────────────────────────────────────────────────
// Synthetic event log — what a real recorder would emit on this fixture.
// Three tracks so any "duplicated album fields per track" bug shows up loud.
// ────────────────────────────────────────────────────────────────────────────

const events = [
  { source: 'playwrightRecorder', type: 'page_seen',
    pageUrl: 'file:///fixtures/distrokid-album-style/index.html',
    pageTitle: 'DistroKid-album-style — Browsy Architecture Fixture' },

  // Album-level fields (filled once)
  { source: 'playwrightRecorder', type: 'field_detected', selector: '#album_title',
    rawEvidence: { name: 'album_title', id: 'album_title', inputType: 'text',
      label: 'Album title', value: 'Echoes of Daylight', required: true } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: '#album_artist',
    rawEvidence: { name: 'album_artist', id: 'album_artist', inputType: 'text',
      label: 'Primary artist', value: 'Pancake Robot', required: true } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: '#record_label',
    rawEvidence: { name: 'record_label', id: 'record_label', inputType: 'text',
      label: 'Record label', value: 'Browsy Test Records' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: '#upc',
    rawEvidence: { name: 'upc', id: 'upc', inputType: 'text', label: 'UPC',
      value: '00000000000000' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: '#release_date',
    rawEvidence: { name: 'release_date', id: 'release_date', inputType: 'date',
      label: 'Release date', value: '2099-01-01' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: '#cover_art',
    rawEvidence: { name: 'cover_art', id: 'cover_art', inputType: 'file',
      isFileInput: true, label: 'Cover art', value: null } },

  // Three tracks — itemized via tracks[N][field] naming convention.
  ...[1, 2, 3].flatMap(i => [
    { source: 'playwrightRecorder', type: 'field_detected',
      selector: `input[name="tracks[${i}][title]"]`,
      rawEvidence: { name: `tracks[${i}][title]`, inputType: 'text',
        label: 'Track title', value: `Track ${i} Title` } },
    { source: 'playwrightRecorder', type: 'field_detected',
      selector: `input[name="tracks[${i}][artist]"]`,
      rawEvidence: { name: `tracks[${i}][artist]`, inputType: 'text',
        label: 'Track artist', value: i === 2 ? 'Featured Guest' : 'Pancake Robot' } },
    { source: 'playwrightRecorder', type: 'field_detected',
      selector: `input[name="tracks[${i}][isrc]"]`,
      rawEvidence: { name: `tracks[${i}][isrc]`, inputType: 'text',
        label: 'ISRC', value: `USRC1700000${i}` } },
    { source: 'playwrightRecorder', type: 'field_detected',
      selector: `input[name="tracks[${i}][explicit]"]`,
      rawEvidence: { name: `tracks[${i}][explicit]`, inputType: 'checkbox',
        label: 'Explicit lyrics', value: i === 2 } },
    { source: 'playwrightRecorder', type: 'field_detected',
      selector: `input[name="tracks[${i}][audio]"]`,
      rawEvidence: { name: `tracks[${i}][audio]`, inputType: 'file',
        isFileInput: true, label: 'Audio file', value: null } },
  ]),

  // Add-track button — heuristic must catch "Add another track".
  { source: 'playwrightRecorder', type: 'repeat_group_candidate_detected',
    selector: '#addTrack', rawEvidence: { label: 'Add another track' } },

  // Dangerous final actions — distinct from the safe build action.
  { source: 'playwrightRecorder', type: 'dangerous_action_candidate_detected',
    selector: '#submitToStores',
    rawEvidence: { label: 'Submit to stores' } },
  { source: 'playwrightRecorder', type: 'dangerous_action_candidate_detected',
    selector: '#confirmPayment',
    rawEvidence: { label: 'Confirm payment' } },

  // Output captured after the safe "Build Distro Draft" action.
  { source: 'playwrightRecorder', type: 'output_captured',
    selector: '#draftOutput',
    rawEvidence: {
      outputId: 'draftOutput',
      text: '{"status":"draft_built","album":{"title":"Echoes of Daylight"}}',
      triggeredBySelector: '#buildDraft',
      selectorCandidates: [{ selector: '#draftOutput', kind: 'id', confidence: 'high' }],
      selectorConfidence: 'high',
      eventTrigger: 'mutation_observer',
    } },
];

// ────────────────────────────────────────────────────────────────────────────
// Part A — pure functions (no browser, no server)
// ────────────────────────────────────────────────────────────────────────────

const obs = buildObservationFromEvents({ events, workflowId: TEST_WORKFLOW_ID });
const normalized = normalizeObservation(obs);
const pkg = buildWorkflowPackageFromObservation(obs);
const canonical = pkg.canonical_payload || {};
const plan = buildRunPlanFromPackage(canonical);

const tracksGroup = (canonical.repeatGroups || []).find(g =>
  /track/i.test(g.id) || /track/i.test(g.label || '') || /track/i.test(g.itemLabel || ''));

// ── Requirement 1: Global album fields captured once ─────────────────────────

section(1, 'Album fields captured once in canonical_payload.globals');
{
  const globals = canonical.globals || {};
  const missing = ALBUM_LEVEL_KEYS.filter(k => !(k in globals));
  if (missing.length === 0) {
    pass(`globals contains all album keys: ${ALBUM_LEVEL_KEYS.join(', ')}`);
  } else {
    fail('album-level keys missing from canonical_payload.globals',
      `missing: ${missing.join(', ')} / present: ${Object.keys(globals).join(', ')}`);
  }
}

section(2, 'Cover art lives in canonical_payload.assets (file → assets bucket)');
{
  const assets = canonical.assets || {};
  if (ALBUM_ASSET_KEY in assets) {
    pass(`assets.${ALBUM_ASSET_KEY} = ${JSON.stringify(assets[ALBUM_ASSET_KEY])}`);
  } else {
    fail(`${ALBUM_ASSET_KEY} missing from canonical_payload.assets`,
      `assets: ${JSON.stringify(assets)}`);
  }
}

section(3, 'Album-level keys do NOT leak into the tracks repeat group');
{
  if (!tracksGroup) {
    fail('no tracks repeat group found in canonical_payload', JSON.stringify(canonical.repeatGroups));
  } else {
    const item = tracksGroup.items?.[0] || {};
    const checkKeys = [...ALBUM_LEVEL_KEYS, ALBUM_ASSET_KEY];
    const leaks = checkKeys.filter(k =>
      (item.fields && k in item.fields) || (item.assets && k in item.assets));
    leaks.length === 0
      ? pass(`tracks item[0] is clean of album-level keys (fields: ${Object.keys(item.fields || {}).join(', ')})`)
      : fail('album-level keys leaked into tracks item[0]', leaks.join(', '));
  }
}

// ── Requirement 2: Track fields as itemFields/itemAssets ─────────────────────

section(4, 'Tracks repeat group exposes itemFields title/artist/isrc/explicit');
{
  const norm = (normalized.repeatGroups || []).find(g => /track/i.test(g.id) || /track/i.test(g.label || ''));
  if (!norm) {
    fail('no tracks group after normalization');
  } else {
    const ids = (norm.itemFields || []).map(f => f.id);
    const missing = TRACK_FIELD_KEYS.filter(k => !ids.includes(k));
    missing.length === 0
      ? pass(`itemFields: ${ids.join(', ')}`)
      : fail('expected itemFields missing', `missing: ${missing.join(', ')} / got: ${ids.join(', ')}`);
  }
}

section(5, 'Tracks repeat group exposes itemAssets audio');
{
  const norm = (normalized.repeatGroups || []).find(g => /track/i.test(g.id) || /track/i.test(g.label || ''));
  if (!norm) {
    fail('no tracks group after normalization');
  } else {
    const ids = (norm.itemAssets || []).map(f => f.id);
    TRACK_ASSET_KEYS.every(k => ids.includes(k))
      ? pass(`itemAssets: ${ids.join(', ')}`)
      : fail('audio missing from itemAssets', `got: ${ids.join(', ')}`);
  }
}

section(6, 'No tracks[N][*] id leaks into canonical_payload.globals');
{
  const globals = canonical.globals || {};
  const leaks = Object.keys(globals).filter(k => /tracks?\[/.test(k) || /^tracks?\d/.test(k));
  leaks.length === 0
    ? pass('no bracket/instance ids leaked into globals')
    : fail('bracket-form ids leaked into globals', leaks.join(', '));
}

// ── Requirement 3: Run plan structure ────────────────────────────────────────

section(7, 'Run plan has one global setup section before any repeat_iteration');
{
  const firstIter = plan.steps.findIndex(s => s.type === 'repeat_iteration');
  const lastGlobalIdx = plan.steps.reduce(
    (max, s, i) => (s.type === 'fill_global' || s.type === 'upload_global') ? i : max,
    -1);
  const globalCount = plan.steps.filter(s => s.type === 'fill_global' || s.type === 'upload_global').length;
  if (firstIter > 0 && lastGlobalIdx < firstIter && globalCount > 0) {
    pass(`${globalCount} global steps precede first repeat_iteration at index ${firstIter}`);
  } else {
    fail('global setup section is not contiguous before repeat_iterations',
      `firstIter=${firstIter} lastGlobalIdx=${lastGlobalIdx} globals=${globalCount}`);
  }
}

// `buildWorkflowPackageFromObservation` currently materializes a single sample
// item per group (see observation-ingestion.mjs::buildSampleRepeatItem). The
// architecture is meant to support any N — the package can hold an items[]
// array of arbitrary length and the run-plan builder iterates over it. We
// prove that here by feeding the package three concrete track items and
// asserting the run-plan emits three iterations with no album fields inside.
const multiTrackCanonical = {
  ...canonical,
  repeatGroups: (canonical.repeatGroups || []).map(g => {
    if (g.id !== tracksGroup?.id) return g;
    return {
      ...g,
      items: [
        { fields: { title: 'Track 1 Title', artist: 'Pancake Robot', isrc: 'USRC17000001', explicit: false }, assets: { audio: './track-01.wav' } },
        { fields: { title: 'Track 2 Title', artist: 'Featured Guest', isrc: 'USRC17000002', explicit: true  }, assets: { audio: './track-02.wav' } },
        { fields: { title: 'Track 3 Title', artist: 'Pancake Robot', isrc: 'USRC17000003', explicit: false }, assets: { audio: './track-03.wav' } },
      ],
    };
  }),
};
const multiPlan = buildRunPlanFromPackage(multiTrackCanonical);

section(8, 'Architecture supports one repeat_iteration per track (3-track package → 3 iterations)');
{
  const iters = multiPlan.steps.filter(s => s.type === 'repeat_iteration');
  if (iters.length === 3) {
    pass(`3 repeat_iteration steps emitted from a 3-track package`);
  } else {
    fail('expected 3 repeat_iteration steps from a 3-track package', `got ${iters.length}`);
  }
}

section(9, 'No album-level source appears inside any repeat_iteration sub-step (3-track plan)');
{
  const iters = multiPlan.steps.filter(s => s.type === 'repeat_iteration');
  const leaked = [];
  for (const it of iters) {
    for (const sub of (it.steps || [])) {
      const src = (sub.fieldName || sub.source || '');
      if (ALBUM_LEVEL_KEYS.includes(src) || src === ALBUM_ASSET_KEY) {
        leaked.push(`iter[${it.itemIndex}].${sub.type}.${src}`);
      }
    }
  }
  leaked.length === 0
    ? pass(`${iters.length} repeat_iterations contain only per-track fields/assets`)
    : fail('album-level field leaked into a repeat_iteration', leaked.join(', '));
}

section(10, 'Run plan has capture_output for #draftOutput after a click_safe_action');
{
  const idx = plan.steps.findIndex(s => s.type === 'capture_output' && /draftOutput/.test(s.selector || ''));
  const trigger = idx > 0 ? plan.steps[idx - 1] : null;
  if (idx > 0 && trigger && trigger.type === 'click_safe_action' && /buildDraft/.test(trigger.selector || '')) {
    pass(`capture_output{#draftOutput} preceded by click_safe_action{${trigger.selector}}`);
  } else {
    fail('capture_output not preceded by click_safe_action for #buildDraft',
      `idx=${idx} trigger=${JSON.stringify(trigger)}`);
  }
}

section(11, 'Run plan ends with human_checkpoint');
{
  const last = plan.steps[plan.steps.length - 1];
  last && last.type === 'human_checkpoint'
    ? pass('last step is human_checkpoint')
    : fail('plan does not end with human_checkpoint', JSON.stringify(last));
}

// ── Requirement 6: Workflow package clearly separates the four buckets ───────

section(12, 'Workflow package separates albumInputs / trackRepeatGroup / capturedOutputs');
{
  const albumInputs = Object.keys(canonical.globals || {});
  const trackRepeatGroup = tracksGroup;
  const capturedOutputs = canonical.capturedOutputs || [];
  const hasAll =
    albumInputs.length > 0 &&
    !!trackRepeatGroup &&
    Array.isArray(capturedOutputs) && capturedOutputs.some(o => /draft/i.test(o.id) || /output/i.test(o.id));
  hasAll
    ? pass(`albumInputs=${albumInputs.length}; trackRepeatGroup=${trackRepeatGroup.id}; capturedOutputs=${capturedOutputs.map(o => o.id).join(', ')}`)
    : fail('workflow package missing one of the required buckets',
      JSON.stringify({ albumInputs, trackRepeatGroup: !!trackRepeatGroup, capturedOutputs }));
}

section(13, 'capture_outputs envelope lists the draftOutput id');
{
  const co = pkg.capture_outputs || [];
  co.some(name => /draftOutput|draft|output/.test(name))
    ? pass(`pkg.capture_outputs = ${JSON.stringify(co)}`)
    : fail('pkg.capture_outputs does not name the draft output', JSON.stringify(co));
}

// ────────────────────────────────────────────────────────────────────────────
// Part B — Playwright executor: output capture (req 4) + download (req 5)
// ────────────────────────────────────────────────────────────────────────────

console.log('\n── Part B: Playwright execution ──');

if (!fs.existsSync(FIXTURE_PATH)) {
  fail('Check 14 (executor output capture)', `fixture missing: ${FIXTURE_PATH}`);
  fail('Check 15 (executor download capture)', 'fixture missing');
}

const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browsy-dkalbum-'));

// We use a minimal fixture-targeted plan that doesn't try to fill the album
// fields (the fixture's pre-rendered tracks have no real audio files to
// upload). That keeps Part B focused on requirements 4 and 5 — the bits the
// pure-function checks above cannot prove without a browser.
const fixturePlan = {
  steps: [
    { type: 'click_safe_action', selector: '#buildDraft', label: 'Build Distro Draft' },
    { type: 'capture_output', outputId: 'draftOutput', selector: '#draftOutput' },
    { type: 'click_safe_action', selector: '#downloadPackage', label: 'Download draft package' },
    { type: 'human_checkpoint', reason: 'Manual review required',
      blocked: ['Submit to stores', 'Confirm payment'] },
  ],
};

let execResult = null;
try {
  execResult = await executeRunPlanWithPlaywright({
    runPlan: fixturePlan,
    fixturePath: FIXTURE_PATH,
    headless: true,
    downloadsDir,
  });
} catch (err) {
  fail('Check 14 (executor)', err.message);
  fail('Check 15 (executor)', 'executor threw');
}

if (execResult) {
  section(14, 'Output captured after safe Build Distro Draft action');
  {
    const out = execResult.capturedOutputs?.draftOutput;
    if (out && out.status === 'captured' && typeof out.value === 'string' && out.value.includes('draft_built')) {
      pass(`capturedOutputs.draftOutput.value contains "draft_built" (${out.value.length} chars)`);
    } else {
      fail('capturedOutputs.draftOutput not captured or unexpected shape', JSON.stringify(out));
    }
  }

  section(15, 'Download capture appears in final run result');
  {
    const files = execResult.downloadedFiles || [];
    const saved = files.find(f => f.path && fs.existsSync(f.path));
    if (saved) {
      const size = fs.statSync(saved.path).size;
      pass(`downloadedFiles[0] saved: ${saved.filename} (${size} bytes)`);
    } else if (files.length > 0) {
      pass(`downloadedFiles[0] captured: ${files[0].filename || '(unnamed)'} (no on-disk path)`);
    } else {
      fail('no downloads captured', JSON.stringify(files));
    }
  }

  section(16, 'Executor reached checkpoint without auto-clicking a manual-only action');
  {
    if (execResult.ok && execResult.checkpoint?.type === 'human_checkpoint') {
      pass(`checkpoint reached (${execResult.executedSteps.length} steps executed)`);
    } else {
      fail('executor did not reach checkpoint', execResult.error || JSON.stringify(execResult.skippedSteps));
    }
    const final = execResult.finalState || {};
    // The fixture writes MANUAL_ONLY_ACTION_CLICKED into #draftOutput if the
    // dangerous button fires. Read back what we captured to make sure it
    // didn't.
    const captured = execResult.capturedOutputs?.draftOutput?.value || '';
    if (/MANUAL_ONLY_ACTION_CLICKED/.test(captured)) {
      fail('a manual-only action fired during execution', captured.slice(0, 200));
    } else {
      pass('no manual-only action recorded in captured output');
    }
  }
}

try { fs.rmSync(downloadsDir, { recursive: true, force: true }); } catch {}

// ────────────────────────────────────────────────────────────────────────────
// Part C — Operator-UI visibility
//
// Write a minimal workflow under workflows/<id>/ + a synthetic run result
// under output/runs/<id>/<ts>/result.json that mirrors what the executor
// produces. Spawn (or reuse) the wizard server, hit GET /api/workflows/:id,
// and assert the operator can see captured outputs + downloaded files
// through the same API the library UI consumes — not just on disk.
// ────────────────────────────────────────────────────────────────────────────

console.log('\n── Part C: Operator-UI visibility ──');

const wfDir = path.join(REPO_ROOT, 'workflows', TEST_WORKFLOW_ID);
const runsDir = path.join(REPO_ROOT, 'output', 'runs', TEST_WORKFLOW_ID);
const obsDir = path.join(REPO_ROOT, 'output', 'observations', TEST_WORKFLOW_ID);

function cleanupArtifacts() {
  for (const dir of [wfDir, runsDir, obsDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// Always start from a clean slate so a previous failed run doesn't poison
// state. Re-run the cleanup at exit to keep the repo tidy.
cleanupArtifacts();
fs.mkdirSync(wfDir, { recursive: true });

// workflow.json — minimum the listWorkflows() filter needs.
fs.writeFileSync(path.join(wfDir, 'workflow.json'), JSON.stringify({
  id: TEST_WORKFLOW_ID,
  workflowId: TEST_WORKFLOW_ID,
  title: 'DistroKid-album-style architecture test',
  targets: { pages: [{ id: 'page1', url: 'about:blank' }] },
  variables: { input: ALBUM_LEVEL_KEYS.map(name => ({ name })) },
  repeatGroups: [{ id: tracksGroup?.id || 'tracks', label: 'Tracks', itemLabel: 'track', itemPlural: 'tracks' }],
  safetyPolicy: {
    never_click_text: ['Submit to stores', 'Confirm payment'],
    manual_only_categories: ['final submission', 'payment'],
  },
}, null, 2));

fs.writeFileSync(path.join(wfDir, 'workflow-package.example.json'), JSON.stringify(pkg, null, 2));
fs.writeFileSync(path.join(wfDir, 'safety-policy.json'), JSON.stringify({
  never_click_text: ['Submit to stores', 'Confirm payment'],
  manual_only_categories: ['final submission', 'payment'],
}, null, 2));

// Synthetic result.json reflecting what the Playwright executor produced.
// We translate the executor's camelCase shape into the snake_case fields the
// contract enforces (see workflow-contract.mjs::newResult).
const runTs = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(runsDir, runTs);
fs.mkdirSync(runDir, { recursive: true });

const syntheticResult = {
  ok: true,
  workflow_id: TEST_WORKFLOW_ID,
  run_id: `${TEST_WORKFLOW_ID}-${runTs}`,
  source_system: 'external_client',
  entity_type: 'workflow',
  entity_id: 'EXTERNAL_ENTITY_ID',
  status: 'live_run_gated',
  captured_outputs: {
    draftOutput: {
      status: 'captured',
      value: execResult?.capturedOutputs?.draftOutput?.value
        || '{"status":"draft_built","album":{"title":"Echoes of Daylight"}}',
    },
  },
  downloaded_files: (execResult?.downloadedFiles || [{ filename: 'distrokid-style-draft.json' }])
    .map(f => ({ filename: f.filename || 'download', path: f.path || null })),
  filled_fields: ALBUM_LEVEL_KEYS.map(name => ({ field: name, value: '(synthetic)' })),
  skipped_fields: [],
  errors: [],
  screenshots: [],
  artifact_paths: [],
  manual_checkpoints: [{ id: 'final-submit', type: 'final_action_gate', reason: 'Manual review required' }],
  client_action_requests: [],
  next_required_action: 'human_review',
  return_contract_version: RETURN_CONTRACT_VERSION,
  generated_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(syntheticResult, null, 2));

const PORT = 3333;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function request(method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method, hostname: '127.0.0.1', port: PORT, path: urlPath }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function getJson(p) {
  const r = await request('GET', p);
  if (r.status !== 200) throw new Error(`GET ${p} → ${r.status}: ${r.body.slice(0, 200)}`);
  return JSON.parse(r.body);
}
async function isServerRunning() {
  return new Promise(resolve => {
    const req = http.get(`${BASE_URL}/`, { timeout: 1500 }, () => resolve(true));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

let serverProcess = null;
async function startServer() {
  if (await isServerRunning()) {
    console.log('(reusing already-running wizard server on :3333)');
    return;
  }
  serverProcess = spawn('node', ['wizard/server.mjs'], {
    cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server did not start within 10s')), 10000);
    serverProcess.stdout.on('data', d => {
      if (d.toString().includes('localhost:')) { clearTimeout(t); setTimeout(resolve, 250); }
    });
    serverProcess.stderr.on('data', d => process.stderr.write(`[srv-err] ${d}`));
    serverProcess.on('error', e => { clearTimeout(t); reject(e); });
    serverProcess.on('exit', code => {
      if (code && code !== 0) { clearTimeout(t); reject(new Error(`Server exited with code ${code}`)); }
    });
  });
}
function stopServer() {
  if (serverProcess) { serverProcess.kill('SIGTERM'); serverProcess = null; }
}

try {
  await startServer();

  section(17, '/workflows library page lists the test workflow');
  {
    const r = await request('GET', '/workflows');
    const list = await getJson('/api/workflows');
    const found = (list.workflows || []).find(w => w.workflowId === TEST_WORKFLOW_ID);
    const htmlOk = r.status === 200 && /<title>Browsy Workflow Library<\/title>/i.test(r.body);
    if (htmlOk && found) {
      pass(`/workflows HTML 200 and ${TEST_WORKFLOW_ID} present in /api/workflows`);
    } else {
      fail('library did not list the workflow',
        `htmlOk=${htmlOk} foundIds=${(list.workflows || []).map(w => w.workflowId).join(',')}`);
    }
  }

  section(18, 'Library API surfaces capturedOutputs count from the workflow package');
  {
    const list = await getJson('/api/workflows');
    const w = (list.workflows || []).find(w => w.workflowId === TEST_WORKFLOW_ID);
    if (w && w.counts && w.counts.capturedOutputs >= 1) {
      pass(`counts.capturedOutputs = ${w.counts.capturedOutputs} (operator can see "outputs" column populated)`);
    } else {
      fail('counts.capturedOutputs is missing or zero', JSON.stringify(w?.counts));
    }
  }

  section(19, 'Detail endpoint exposes latestResult.captured_outputs to the operator');
  {
    const detail = await getJson(`/api/workflows/${TEST_WORKFLOW_ID}`);
    const latest = detail.latestResult;
    const hasOutput = latest && latest.captured_outputs &&
      latest.captured_outputs.draftOutput &&
      typeof latest.captured_outputs.draftOutput.value === 'string';
    if (hasOutput) {
      pass(`latestResult.captured_outputs.draftOutput visible (${latest.captured_outputs.draftOutput.value.length} chars)`);
    } else {
      fail('latestResult.captured_outputs.draftOutput not visible via API',
        JSON.stringify(latest?.captured_outputs));
    }
  }

  section(20, 'Detail endpoint exposes latestResult.downloaded_files to the operator');
  {
    const detail = await getJson(`/api/workflows/${TEST_WORKFLOW_ID}`);
    const latest = detail.latestResult;
    const files = latest?.downloaded_files;
    if (Array.isArray(files) && files.length > 0 && files[0].filename) {
      pass(`latestResult.downloaded_files[0].filename = ${files[0].filename}`);
    } else {
      fail('latestResult.downloaded_files not visible via API', JSON.stringify(files));
    }
  }

  section(21, 'Detail endpoint includes the workflow-package.example.json contents');
  {
    const detail = await getJson(`/api/workflows/${TEST_WORKFLOW_ID}`);
    const pkgText = detail.contents?.packageExample || '';
    const hasGlobals = pkgText.includes('"globals"') && pkgText.includes('albumTitle');
    const hasRepeat = pkgText.includes('"repeatGroups"') && /track/i.test(pkgText);
    const hasOutputs = pkgText.includes('"capturedOutputs"') || pkgText.includes('"capture_outputs"');
    if (hasGlobals && hasRepeat && hasOutputs) {
      pass('packageExample contents expose globals + repeatGroups + capturedOutputs to the operator');
    } else {
      fail('packageExample contents missing required sections',
        `globals=${hasGlobals} repeat=${hasRepeat} outputs=${hasOutputs}`);
    }
  }
} catch (e) {
  fail('Part C', e.message);
} finally {
  stopServer();
  cleanupArtifacts();
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
console.log(`══════════════════════════════════════════════════════════`);
console.log(`DistroKid-album-style architecture: ${passed} passed, ${failed} failed`);
console.log(`══════════════════════════════════════════════════════════`);
if (failed > 0) process.exit(1);
