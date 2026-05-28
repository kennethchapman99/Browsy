#!/usr/bin/env node
// Manual kitchen-sink UI test.
//
// Drives the SAME path an external caller (e.g. Pancake Robot) uses —
// createRun -> executeRun in preview mode — which routes through the hardened
// runReplay wrapper and replays recorded steps in a REAL chromium browser
// against the local kitchen-sink fixture (file:// URL).
//
//   node scripts/manual-kitchen-sink-ui.mjs            # headless
//   BROWSY_HEADED=1 node scripts/manual-kitchen-sink-ui.mjs   # watch the browser
//
// Exits 0 if every contract assertion passes, 1 otherwise. Screenshots for each
// step are printed at the end for visual review.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { createRun, getRunResult } from '../src/registry/run-registry.mjs';
import { executeRun } from '../src/registry/run-executor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../fixtures/kitchen-sink-workflow/index.html');
const fixtureUrl = 'file://' + FIXTURE;

let passed = 0, failed = 0;
const pass = l => { console.log('PASS  ' + l); passed++; };
const fail = (l, d = '') => { console.error('FAIL  ' + l + (d ? '\n      ' + d : '')); failed++; };

// A temp file to exercise the uploadFile step against #primary_image.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browsy-ks-ui-'));
const uploadFile = path.join(tmpDir, 'cover.png');
fs.writeFileSync(uploadFile, Buffer.from('89504e470d0a1a0a', 'hex'));

// Recorded steps as the recorder would emit them. Generic step types only —
// nothing app-specific. Order matters: generateDraft must run before the
// download link's href is populated.
const recordedSteps = [
  { id: 'nav', order: 1, type: 'navigate', tabId: 'tab1', url: fixtureUrl, waitUntil: 'domcontentloaded' },
  { id: 'fill_album_title', order: 2, type: 'fill', tabId: 'tab1', selector: '#album_title', binding: 'album_title', value: '{{inputs.album_title}}' },
  { id: 'select_brand', order: 3, type: 'select', tabId: 'tab1', selector: '#brand_profile_id', binding: 'brand_profile_id', value: '{{inputs.brand_profile_id}}' },
  { id: 'upload_primary_image', order: 4, type: 'uploadFile', tabId: 'tab1', selector: '#primary_image', binding: 'primary_image' },
  { id: 'click_generateDraft', order: 5, type: 'click', tabId: 'tab1', selector: '#generateDraft', label: 'Generate Draft' },
  { id: 'capture_output', order: 6, type: 'extractText', tabId: 'tab1', selector: '#output', output: 'output', required: true },
  { id: 'click_downloadDraft', order: 7, type: 'click', tabId: 'tab1', selector: '#downloadDraft', label: 'Download Draft JSON' },
  { id: 'manual_review', order: 8, type: 'approve', label: 'Manual review before Submit/Publish', reason: 'human approval required', beforeAction: 'submitRelease' },
];

const workflowVersion = {
  appId: 'kitchen-sink-app',
  workflowId: 'kitchen-sink-workflow',
  workflowObjectId: 'kitchen-sink-app.kitchen-sink-workflow',
  version: 1,
  supportedModes: ['preview', 'live', 'dry_run'],
  tabs: [{ id: 'tab1', requiresAuth: false }],
  recordedSteps,
  expectedOutputs: [{ id: 'output', selector: '#output', required: true }],
  auth: [],
  safetyPolicy: {},
};

const payload = {
  album_title: 'Demo Album From Replay',
  brand_profile_id: 'pancake-robot',
  primary_image: uploadFile,
};

const run = createRun({
  workflowObjectId: workflowVersion.workflowObjectId,
  version: workflowVersion.version,
  mode: 'preview',
  payload,
  options: { headless: process.env.BROWSY_HEADED !== '1' },
});

console.log('runId:', run.runId, '\nfixture:', fixtureUrl, '\n');

await executeRun({ runId: run.runId, workflowVersion, payload, mode: 'preview' });

const result = getRunResult(run.runId);

// ── Assertions on the PUBLIC result contract (what an external caller gets) ──
console.log('── Public result contract ──');

if (result.status === 'completed') pass(`run completed (status=${result.status})`);
else fail('run did not complete', JSON.stringify({ status: result.status, blockingReason: result.blockingReason }));

if ((result.failedSteps || []).length === 0) pass('no failed steps');
else fail(`${result.failedSteps.length} failed step(s)`, JSON.stringify(result.failedSteps, null, 2));

const out = (result.outputs || {}).output;
if (out && out.status === 'captured' && typeof out.value === 'string' && out.value.includes('draft_generated')) {
  pass(`output captured (${out.value.length} chars), contains draft_generated`);
  if (out.value.includes('Demo Album From Replay')) pass('captured output reflects replayed album_title payload');
  else fail('captured output missing replayed album_title', out.value.slice(0, 200));
} else {
  fail('output not captured as the #output JSON', JSON.stringify(out));
}

const uploaded = result.uploadedFiles || [];
if (uploaded.some(u => u.path === uploadFile)) pass(`upload replayed: ${uploaded.map(u => u.role).join(', ')}`);
else fail('uploadFile step did not replay', JSON.stringify(uploaded));

const downloads = (result.artifacts || {}).downloads || [];
const savedDownload = downloads.find(d => d.path && fs.existsSync(d.path));
if (savedDownload) pass(`download saved: ${savedDownload.name} (${fs.statSync(savedDownload.path).size} bytes)`);
else fail('no download saved', JSON.stringify(downloads));

const checkpoints = result.checkpoints || [];
if (checkpoints.some(c => c.beforeAction === 'submitRelease' || /manual/i.test(c.label || ''))) pass(`manual checkpoint materialized: ${checkpoints.map(c => c.label).join(', ')}`);
else fail('manual checkpoint missing', JSON.stringify(checkpoints));

console.log('\n── Artifact dedup ──');
const screenshots = (result.artifacts || {}).screenshots || [];
const screenshotPaths = screenshots.map(s => s.path);
if (screenshotPaths.length > 0 && screenshotPaths.length === new Set(screenshotPaths).size) pass(`screenshots deduped (${screenshotPaths.length} unique)`);
else fail('screenshots missing or duplicated', JSON.stringify(screenshotPaths));

const downloadPaths = downloads.map(d => d.path).filter(Boolean);
if (downloadPaths.length === new Set(downloadPaths).size) pass(`downloads deduped (${downloadPaths.length} unique)`);
else fail('duplicate downloads', JSON.stringify(downloadPaths));

console.log('\nScreenshots for visual review:');
for (const s of screenshots) console.log('  ' + s.path);

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
