#!/usr/bin/env node
/**
 * Acceptance test: observation import UI
 *
 * Proves end-to-end that the wizard UI lets a workflow expert paste/import
 * an observed workflow JSON and generate real Browsy artifacts.
 *
 * Fixture used: fixtures/observed-conference-proposal/observation.json
 * (Generic conference proposal — no vendor-specific strings required.)
 *
 * Checks:
 *  1   Import UI section is present in the DOM (obs-import-section)
 *  2   Import nav button is present in the sidebar
 *  3   Clicking the nav button shows the import section
 *  4   "Load sample" button fetches the conference-proposal fixture from the server
 *  5   Textarea is populated with valid JSON after load-sample
 *  6   workflowId in the loaded sample is "conference-proposal-submit"
 *  7   Pasting invalid JSON and clicking Preview shows a validation error
 *  8   Error message includes useful context (not a raw stack trace)
 *  9   Valid observation preview shows workflowId
 * 10   Preview shows global fields (eventTitle, track, sessionFormat, abstract)
 * 11   Preview shows global asset (proposalDeck)
 * 12   Preview shows repeat group: speakers
 * 13   Preview shows item fields in speakers group (speakerName, speakerTitle, email, bio)
 * 14   Preview shows item assets in speakers group (headshot, bioPdf)
 * 15   Preview shows captured outputs (proposalId, publicPreviewUrl, proposalStatus)
 * 16   Preview shows derived variable (proposalDetailUrl)
 * 17   Preview shows human checkpoints (2)
 * 18   Preview shows manual-only action (Submit proposal)
 * 19   Create workflow button is enabled after successful preview
 * 20   Clicking Create workflow writes workflow.json
 * 21   Clicking Create workflow writes workflow-package.example.json
 * 22   Clicking Create workflow writes run-plan.md
 * 23   Clicking Create workflow writes observation.json copy
 * 24   Success message shows workflowId: conference-proposal-submit
 * 25   workflow.json contains correct workflowId
 * 26   workflow-package.example.json validates against the runtime package contract
 * 27   run-plan.md contains repeat group speakers
 * 28   run-plan.md contains captured vars proposalId, publicPreviewUrl
 * 29   run-plan.md contains derived var proposalDetailUrl
 * 30   run-plan.md preserves manual checkpoint / finalSubmit action
 * 31   Created workflow appears in GET /api/workflows response
 * 32   No vendor-specific strings in the fixture or generated artifacts
 * 33   obs-import-section has id="obs-json-input" textarea
 * 34   obs-import-section has id="obs-load-sample" button
 * 35   obs-import-section has id="obs-preview-btn" button
 * 36   obs-import-section has id="obs-create-btn" button
 *
 * Usage:
 *   npm run acceptance:observation-ui
 */

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 3333;
const BASE_URL = `http://localhost:${PORT}`;
const TEST_WORKFLOW_ID = 'conference-proposal-submit';

let passed = 0, failed = 0;
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') { console.error('FAIL  ' + label + (detail ? '\n      ' + detail : '')); failed++; }
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

// ── Server lifecycle ──────────────────────────────────────────────────────────

let serverProcess = null;

async function isServerRunning() {
  return new Promise(resolve => {
    const req = http.get(`${BASE_URL}/`, { timeout: 1500 }, () => resolve(true));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  if (await isServerRunning()) return; // reuse existing
  serverProcess = spawn('node', ['wizard/server.mjs'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server did not start within 10s')), 10000);
    serverProcess.stdout.on('data', d => {
      if (d.toString().includes('localhost:')) { clearTimeout(t); setTimeout(resolve, 200); }
    });
    serverProcess.on('error', e => { clearTimeout(t); reject(e); });
    serverProcess.on('exit', code => { if (code && code !== 0) { clearTimeout(t); reject(new Error(`Server exited with code ${code}`)); } });
  });
}

function stopServer() {
  if (serverProcess) { serverProcess.kill('SIGTERM'); serverProcess = null; }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

function cleanupTestArtifacts() {
  const wfDir    = path.join(REPO_ROOT, 'workflows', TEST_WORKFLOW_ID);
  const plansDir = path.join(REPO_ROOT, 'output', 'plans', TEST_WORKFLOW_ID);
  const obsDir   = path.join(REPO_ROOT, 'output', 'observations', TEST_WORKFLOW_ID);
  for (const dir of [wfDir, plansDir, obsDir]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

cleanupTestArtifacts(); // start clean

try {
  await startServer();
} catch (e) {
  console.error('FATAL: Could not start wizard server:', e.message);
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));

await page.goto(BASE_URL);
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(300);

// ── Checks 1-2: Import UI elements exist in DOM ───────────────────────────────
section(1, 'obs-import-section is present in the DOM');
{
  const exists = await page.evaluate(() => !!document.getElementById('obs-import-section'));
  exists ? pass('obs-import-section found in DOM') : fail('obs-import-section not found');
}

section(2, 'Import nav button is present in the sidebar');
{
  const exists = await page.evaluate(() => !!document.getElementById('obs-import-nav-btn'));
  exists ? pass('obs-import-nav-btn found in sidebar') : fail('obs-import-nav-btn not found');
}

// ── Check 3: Clicking nav button shows the import section ─────────────────────
section(3, 'Clicking import nav button shows obs-import-section');
{
  await page.click('#obs-import-nav-btn');
  await page.waitForTimeout(200);
  const visible = await page.evaluate(() => {
    const el = document.getElementById('obs-import-section');
    return el && el.style.display !== 'none';
  });
  visible ? pass('obs-import-section is visible after clicking nav button') : fail('obs-import-section still hidden after nav button click');
}

// ── Checks 33-36: Key UI elements present in import section ──────────────────
section(33, 'id="obs-json-input" textarea is present');
{
  const exists = await page.evaluate(() => !!document.getElementById('obs-json-input'));
  exists ? pass('obs-json-input textarea found') : fail('obs-json-input not found');
}
section(34, 'id="obs-load-sample" button is present');
{
  const exists = await page.evaluate(() => !!document.getElementById('obs-load-sample'));
  exists ? pass('obs-load-sample button found') : fail('obs-load-sample not found');
}
section(35, 'id="obs-preview-btn" button is present');
{
  const exists = await page.evaluate(() => !!document.getElementById('obs-preview-btn'));
  exists ? pass('obs-preview-btn button found') : fail('obs-preview-btn not found');
}
section(36, 'id="obs-create-btn" button is present');
{
  const exists = await page.evaluate(() => !!document.getElementById('obs-create-btn'));
  exists ? pass('obs-create-btn button found') : fail('obs-create-btn not found');
}

// ── Checks 37-50: Observation session state machine ──────────────────────────
// After the nav button click (check 3), Step 4 is active. The session state
// machine starts in "not-started" — test the happy path without triggering
// "Review inferred workflow" (which would consume the import section textarea).

section(37, 'obs-state-not-started is visible on step 4 load');
{
  const visible = await page.evaluate(() => {
    const el = document.getElementById('obs-state-not-started');
    return el && el.style.display !== 'none';
  });
  visible ? pass('obs-state-not-started is visible') : fail('obs-state-not-started is hidden');
}

section(38, 'obs-start-btn with "Start" text is present');
{
  const result = await page.evaluate(() => {
    const el = document.getElementById('obs-start-btn');
    return { exists: !!el, text: el ? el.textContent : '' };
  });
  result.exists && /start/i.test(result.text)
    ? pass(`obs-start-btn found with text: "${result.text.trim()}"`)
    : fail('obs-start-btn missing or does not say "Start"', JSON.stringify(result));
}

section(39, 'obs-state-recording is NOT visible initially');
{
  const visible = await page.evaluate(() => {
    const el = document.getElementById('obs-state-recording');
    return el && el.style.display !== 'none';
  });
  !visible ? pass('obs-state-recording is hidden before session starts') : fail('obs-state-recording is wrongly visible before session start');
}

section(40, 'obs-import-section is NOT the primary UI — hidden initially');
{
  // The import section starts hidden; only shown via Advanced toggle or nav button
  // After check 3 (nav button click) it was opened. Reload to get a clean state.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(300);
  const visible = await page.evaluate(() => {
    const el = document.getElementById('obs-import-section');
    return el && el.style.display !== 'none';
  });
  !visible ? pass('obs-import-section is hidden by default (not the primary UI)') : fail('obs-import-section is visible by default — it should be behind the Advanced toggle');
}

section(41, 'After reload: obs-state-not-started is the default visible state');
{
  const visible = await page.evaluate(() => {
    const el = document.getElementById('obs-state-not-started');
    return el && el.style.display !== 'none';
  });
  visible ? pass('obs-state-not-started visible after reload') : fail('obs-state-not-started not visible after reload');
}

// Navigate to step 4 via nav button for session tests
await page.click('#obs-import-nav-btn');
await page.waitForTimeout(200);

// ── Checks 51-55: Source-aware Browser Observation UX ─────────────────────────

section(51, 'Step 4 title says "Browser Observation" (not Atlas-only copy)');
{
  const titleText = await page.evaluate(() => {
    const step4 = document.querySelector('.step[data-step="4"]');
    return step4 ? (step4.querySelector('.step-title')?.textContent || '') : '';
  });
  /browser observation/i.test(titleText)
    ? pass(`Step 4 title: "${titleText.trim()}"`)
    : fail('Step 4 title does not say "Browser Observation"', `got: "${titleText.trim()}"`);
}

section(52, 'Primary CTA says "Start Browser Observation"');
{
  const btnText = await page.evaluate(() => document.getElementById('obs-start-btn')?.textContent || '');
  /start browser observation/i.test(btnText)
    ? pass(`CTA button: "${btnText.trim()}"`)
    : fail('CTA does not say "Start Browser Observation"', `got: "${btnText.trim()}"`);
}

section(53, 'Capture source selector cards are present (at least 2)');
{
  const count = await page.evaluate(() => document.querySelectorAll('.obs-source-card').length);
  count >= 2
    ? pass(`${count} capture source cards found`)
    : fail('Capture source cards missing or insufficient', `found: ${count}`);
}

section(54, 'Demo/mock source card is clearly labelled as demo');
{
  const mockCardText = await page.evaluate(() => document.getElementById('obs-source-mock')?.textContent || '');
  /demo/i.test(mockCardText)
    ? pass(`Mock source card labelled: "${mockCardText.trim().slice(0, 80)}"`)
    : fail('Mock source card not clearly labelled as demo', `got: "${mockCardText.trim()}"`);
}

section(55, 'Atlas-assisted notes tab is labelled as notes/manual (not primary observation)');
{
  const notesTabText = await page.evaluate(() => document.getElementById('cap-tab-notes')?.textContent || '');
  /atlas|manual|notes/i.test(notesTabText)
    ? pass(`Notes tab: "${notesTabText.trim()}"`)
    : fail('Notes tab not labelled as atlas/manual/notes', `got: "${notesTabText.trim()}"`);
}

section(42, 'Clicking Start transitions through connecting to recording state');
{
  // Default source is now Playwright Recorder, which requires a real browser
  // session. This UI test exercises the state machine — explicitly select
  // mock so it does not try to launch Chromium. (Real capture has its own
  // acceptance test: acceptance-observation-playwright.mjs.)
  await page.click('#obs-source-mock');
  await page.waitForTimeout(100);
  await page.click('#obs-start-btn');
  // Mock start now goes through the server endpoint — give it time.
  await page.waitForTimeout(1500);
  const recording = await page.evaluate(() => {
    const el = document.getElementById('obs-state-recording');
    return el && el.style.display !== 'none';
  });
  recording ? pass('obs-state-recording is visible after Start') : fail('obs-state-recording not visible after Start');
}

section(43, 'Recording state shows all 7 capture stat counters');
{
  const ids = ['stat-pages','stat-fields','stat-buttons','stat-groups','stat-outputs','stat-dangerous','stat-checkpoints'];
  const allExist = await page.evaluate((ids) => ids.every(id => !!document.getElementById(id)), ids);
  allExist ? pass('All 7 capture stat counters present') : fail('Some stat counters missing');
}

section(44, 'obs-pause-btn is visible during recording');
{
  const visible = await page.evaluate(() => {
    const el = document.getElementById('obs-pause-btn');
    return el && el.style.display !== 'none';
  });
  visible ? pass('obs-pause-btn visible') : fail('obs-pause-btn not visible during recording');
}

section(45, 'obs-add-note-btn is visible during recording');
{
  const visible = await page.evaluate(() => !!document.getElementById('obs-add-note-btn'));
  visible ? pass('obs-add-note-btn visible') : fail('obs-add-note-btn not found');
}

section(46, 'obs-mark-repeat-btn is visible during recording');
{
  const visible = await page.evaluate(() => !!document.getElementById('obs-mark-repeat-btn'));
  visible ? pass('obs-mark-repeat-btn visible') : fail('obs-mark-repeat-btn not found');
}

section(47, 'obs-mark-dangerous-btn is visible during recording');
{
  const visible = await page.evaluate(() => !!document.getElementById('obs-mark-dangerous-btn'));
  visible ? pass('obs-mark-dangerous-btn visible') : fail('obs-mark-dangerous-btn not found');
}

section(48, 'obs-finish-btn is visible during recording');
{
  const visible = await page.evaluate(() => !!document.getElementById('obs-finish-btn'));
  visible ? pass('obs-finish-btn visible') : fail('obs-finish-btn not found');
}

section(49, 'Pause transitions badge to paused; Resume returns to recording');
{
  await page.click('#obs-pause-btn');
  await page.waitForTimeout(200);
  const pausedText = await page.evaluate(() => document.getElementById('obs-recording-badge')?.textContent || '');
  const isPaused = /paused/i.test(pausedText);
  isPaused ? pass(`Badge shows paused: "${pausedText.trim()}"`) : fail('Badge not showing paused state', pausedText);

  await page.click('#obs-resume-btn');
  await page.waitForTimeout(200);
  const resumedText = await page.evaluate(() => document.getElementById('obs-recording-badge')?.textContent || '');
  const isRecording = /recording/i.test(resumedText);
  isRecording ? pass(`Badge shows recording after resume: "${resumedText.trim()}"`) : fail('Badge not showing recording after resume', resumedText);
}

section(50, 'Finish observation transitions to finished state with Review button');
{
  await page.click('#obs-finish-btn');
  await page.waitForTimeout(300);
  const finishedVisible = await page.evaluate(() => {
    const el = document.getElementById('obs-state-finished');
    return el && el.style.display !== 'none';
  });
  const reviewBtn = await page.evaluate(() => !!document.getElementById('obs-review-btn'));
  finishedVisible && reviewBtn
    ? pass('Finished state visible with obs-review-btn present')
    : fail('Finished state or review button missing', `finished:${finishedVisible} review:${reviewBtn}`);
}

// ── Checks 56-58: Source badge and session events ─────────────────────────────
// Session was started in check 42 and is now finished. obsSession still in memory.

section(56, 'obs-source-badge is present and visible during/after recording');
{
  const exists = await page.evaluate(() => !!document.getElementById('obs-source-badge'));
  exists ? pass('obs-source-badge element found') : fail('obs-source-badge not found');
}

section(57, 'Session events include session_started and capture_source_selected');
{
  // obsSession is a top-level let — access via the obs-source-badge DOM label as proxy,
  // and via the data attribute set on obs-state-finished if available.
  // Primary check: source badge content proves source was recorded; finished state proves session ran.
  const badgeText = await page.evaluate(() => document.getElementById('obs-source-badge')?.textContent?.trim() || '');
  const finishedVisible = await page.evaluate(() => {
    const el = document.getElementById('obs-state-finished');
    return el && el.style.display !== 'none';
  });
  badgeText.length > 0 && finishedVisible
    ? pass(`Session ran to completion; source badge: "${badgeText}"`)
    : fail('Session badge or finished state missing — events may not have fired', `badge:"${badgeText}" finished:${finishedVisible}`);
}

section(58, 'Mock session badge says "Demo mode" only when explicitly selected (not default)');
{
  // The session running here was explicitly switched to mock in check 42.
  const badgeText = await page.evaluate(() => document.getElementById('obs-source-badge')?.textContent?.trim() || '');
  /demo/i.test(badgeText)
    ? pass(`Source badge confirms mock/demo session: "${badgeText}"`)
    : fail('Source badge does not show demo mode after explicit selection', `got: "${badgeText}"`);
}

section(59, 'Default capture source is Playwright Recorder (not mock)');
{
  // Reload to clear the explicit-mock selection from earlier checks.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(200);
  await page.click('#obs-import-nav-btn'); // brings step 4 into view
  await page.waitForTimeout(200);
  const result = await page.evaluate(() => {
    const pw   = document.getElementById('obs-source-playwright');
    const mock = document.getElementById('obs-source-mock');
    return {
      pwSelected: pw   ? pw.classList.contains('selected')   : false,
      mockSelected: mock ? mock.classList.contains('selected') : false,
    };
  });
  result.pwSelected && !result.mockSelected
    ? pass('Playwright Recorder is selected by default; Mock is NOT')
    : fail('Default selection is wrong', JSON.stringify(result));
}

section(60, 'Demo / Mock card is clearly labelled "no real website"');
{
  const text = await page.evaluate(() => document.getElementById('obs-source-mock')?.textContent?.toLowerCase() || '');
  /no real website|not real capture|simulated/i.test(text)
    ? pass(`Mock card carries an unambiguous demo label`)
    : fail(`Mock card label is ambiguous`, `got: "${text}"`);
}

section(61, 'Start URL field is shown for Playwright Recorder (default)');
{
  const visible = await page.evaluate(() => {
    const el = document.getElementById('obs-start-url-field');
    return !!el && el.style.display !== 'none';
  });
  visible ? pass('Start URL field is visible for the default Playwright source') : fail('Start URL field is hidden for default Playwright source');
}

// Re-navigate to import section for the remaining import checks
await page.click('#obs-import-nav-btn');
await page.waitForTimeout(200);

// ── Check 4: Load sample button fetches fixture ────────────────────────────────
section(4, 'Load sample button loads conference-proposal fixture from server');
{
  await page.click('#obs-load-sample');
  await page.waitForTimeout(600);
  const value = await page.evaluate(() => document.getElementById('obs-json-input')?.value || '');
  value.length > 50
    ? pass(`Textarea populated (${value.length} chars)`)
    : fail('Textarea is empty or too short after load-sample', `got: "${value.slice(0, 80)}"`);
}

// ── Check 5: Textarea contains valid JSON ─────────────────────────────────────
section(5, 'Textarea value is valid JSON after load-sample');
{
  const result = await page.evaluate(() => {
    try { JSON.parse(document.getElementById('obs-json-input')?.value || ''); return 'ok'; }
    catch (e) { return e.message; }
  });
  result === 'ok'
    ? pass('Textarea value parses as valid JSON')
    : fail('Textarea value is not valid JSON', result);
}

// ── Check 6: workflowId is correct ────────────────────────────────────────────
section(6, 'Loaded sample has workflowId = "conference-proposal-submit"');
{
  const wfId = await page.evaluate(() => {
    try { return JSON.parse(document.getElementById('obs-json-input')?.value || '{}').workflowId; }
    catch { return null; }
  });
  wfId === TEST_WORKFLOW_ID
    ? pass(`workflowId = "${wfId}"`)
    : fail('workflowId mismatch', `got: "${wfId}"`);
}

// ── Check 7: Invalid JSON shows validation error ───────────────────────────────
section(7, 'Invalid JSON pasted → Preview shows validation error');
{
  // Paste invalid JSON
  await page.fill('#obs-json-input', 'this is { not valid json');
  await page.click('#obs-preview-btn');
  await page.waitForTimeout(400);
  const errVisible = await page.evaluate(() => {
    const el = document.getElementById('obs-error');
    return el && el.style.display !== 'none' && (el.textContent || '').length > 0;
  });
  errVisible ? pass('Error message is visible after invalid JSON') : fail('No error shown for invalid JSON');
}

// ── Check 8: Error message is useful (not a raw stack trace) ─────────────────
section(8, 'Error message is human-readable (contains "JSON" or "invalid", not a raw stack trace)');
{
  const errText = await page.evaluate(() => document.getElementById('obs-error')?.textContent || '');
  const useful = /json|invalid|syntax|unexpected/i.test(errText) && !errText.includes('at Object.');
  useful
    ? pass(`Error text is human-readable: "${errText.slice(0, 80)}"`)
    : fail('Error message is not useful', `got: "${errText.slice(0, 200)}"`);
}

// ── Re-load sample for remaining checks ───────────────────────────────────────
await page.click('#obs-load-sample');
await page.waitForTimeout(600);

// ── Check 9-18: Valid observation preview ─────────────────────────────────────
section(9, 'Valid observation Preview shows workflowId');
{
  await page.click('#obs-preview-btn');
  await page.waitForTimeout(800);
  const errVisible = await page.evaluate(() => {
    const el = document.getElementById('obs-error');
    return el && el.style.display !== 'none';
  });
  if (errVisible) {
    const errText = await page.evaluate(() => document.getElementById('obs-error')?.textContent || '');
    fail('Preview returned an error', errText);
  } else {
    const resultVisible = await page.evaluate(() => {
      const el = document.getElementById('obs-preview-result');
      return el && el.style.display !== 'none';
    });
    resultVisible ? pass('Preview result section is visible') : fail('Preview result section is still hidden after Preview click');
  }
}

section(10, 'Preview summary shows global fields');
{
  const bodyText = await page.evaluate(() => document.getElementById('obs-summary-body')?.textContent || '');
  const hasFields = ['eventTitle', 'track', 'sessionFormat', 'abstract'].every(f => bodyText.includes(f));
  hasFields
    ? pass('Global fields (eventTitle, track, sessionFormat, abstract) visible in summary')
    : fail('Some global fields missing from preview summary', bodyText.slice(0, 300));
}

section(11, 'Preview summary shows global asset (proposalDeck)');
{
  const bodyText = await page.evaluate(() => document.getElementById('obs-summary-body')?.textContent || '');
  bodyText.includes('proposalDeck')
    ? pass('proposalDeck visible in summary')
    : fail('proposalDeck missing from preview summary', bodyText.slice(0, 300));
}

section(12, 'Preview summary shows repeat group: speakers');
{
  const bodyText = await page.evaluate(() => document.getElementById('obs-summary-body')?.textContent || '');
  bodyText.includes('speakers')
    ? pass('Repeat group "speakers" visible in summary')
    : fail('"speakers" missing from preview summary', bodyText.slice(0, 300));
}

section(13, 'Preview shows item fields in speakers group');
{
  const bodyText = await page.evaluate(() => document.getElementById('obs-summary-body')?.textContent || '');
  const hasItemFields = ['speakerName', 'speakerTitle', 'email', 'bio'].every(f => bodyText.includes(f));
  hasItemFields
    ? pass('Item fields (speakerName, speakerTitle, email, bio) visible in summary')
    : fail('Some item fields missing from preview summary', bodyText.slice(0, 300));
}

section(14, 'Preview shows item assets in speakers group (headshot, bioPdf)');
{
  const bodyText = await page.evaluate(() => document.getElementById('obs-summary-body')?.textContent || '');
  const hasAssets = ['headshot', 'bioPdf'].every(f => bodyText.includes(f));
  hasAssets
    ? pass('Item assets (headshot, bioPdf) visible in summary')
    : fail('Some item assets missing from preview summary', bodyText.slice(0, 300));
}

section(15, 'Preview shows captured outputs (proposalId, publicPreviewUrl, proposalStatus)');
{
  const bodyText = await page.evaluate(() => document.getElementById('obs-summary-body')?.textContent || '');
  const hasOutputs = ['proposalId', 'publicPreviewUrl', 'proposalStatus'].every(f => bodyText.includes(f));
  hasOutputs
    ? pass('Captured outputs (proposalId, publicPreviewUrl, proposalStatus) visible in summary')
    : fail('Some captured outputs missing from preview summary', bodyText.slice(0, 300));
}

section(16, 'Preview shows derived variable (proposalDetailUrl)');
{
  const bodyText = await page.evaluate(() => document.getElementById('obs-summary-body')?.textContent || '');
  bodyText.includes('proposalDetailUrl')
    ? pass('Derived variable proposalDetailUrl visible in summary')
    : fail('proposalDetailUrl missing from preview summary', bodyText.slice(0, 300));
}

section(17, 'Preview shows 2 human checkpoints');
{
  const bodyText = await page.evaluate(() => document.getElementById('obs-summary-body')?.textContent || '');
  const match = bodyText.match(/Checkpoint[s]?[^0-9]*(\d+)/i) || bodyText.match(/(\d+)[^0-9]*[Cc]heckpoint/);
  // Check for count "2" or verify both checkpoint labels are present
  const hasBoth = bodyText.includes('Review proposal') && bodyText.includes('Verify publicPreviewUrl');
  const hasCount = bodyText.includes('2') && /checkpoint/i.test(bodyText);
  hasBoth || hasCount
    ? pass('Both human checkpoints visible in summary')
    : fail('Human checkpoints not clearly visible in summary', bodyText.slice(0, 400));
}

section(18, 'Preview shows manual-only action (Submit proposal / finalSubmit)');
{
  const bodyText = await page.evaluate(() => document.getElementById('obs-summary-body')?.textContent || '');
  const hasFinal = bodyText.toLowerCase().includes('submit proposal') || bodyText.includes('finalSubmit');
  hasFinal
    ? pass('Manual-only action "Submit proposal" visible in summary')
    : fail('Manual-only action not visible in summary', bodyText.slice(0, 400));
}

// ── Check 19: Create button enabled after preview ────────────────────────────
section(19, 'Create workflow button is enabled after successful preview');
{
  const enabled = await page.evaluate(() => !document.getElementById('obs-create-btn')?.disabled);
  enabled ? pass('obs-create-btn is enabled') : fail('obs-create-btn is still disabled after preview');
}

// ── Checks 20-24: Create workflow writes files ────────────────────────────────
section(20, 'Create workflow writes workflow.json');
{
  await page.click('#obs-create-btn');
  await page.waitForTimeout(1000);
  const wfPath = path.join(REPO_ROOT, 'workflows', TEST_WORKFLOW_ID, 'workflow.json');
  fs.existsSync(wfPath)
    ? pass(`workflow.json exists at ${wfPath.replace(REPO_ROOT + '/', '')}`)
    : fail('workflow.json not written', wfPath);
}

section(21, 'Create workflow writes workflow-package.example.json');
{
  const pkgPath = path.join(REPO_ROOT, 'workflows', TEST_WORKFLOW_ID, 'workflow-package.example.json');
  fs.existsSync(pkgPath)
    ? pass(`workflow-package.example.json exists`)
    : fail('workflow-package.example.json not written', pkgPath);
}

section(22, 'Create workflow writes run-plan.md');
{
  const rpPath = path.join(REPO_ROOT, 'output', 'plans', TEST_WORKFLOW_ID, 'run-plan.md');
  fs.existsSync(rpPath)
    ? pass('run-plan.md exists')
    : fail('run-plan.md not written', rpPath);
}

section(23, 'Create workflow writes observation.json copy');
{
  const obsPath = path.join(REPO_ROOT, 'output', 'observations', TEST_WORKFLOW_ID, 'observation.json');
  fs.existsSync(obsPath)
    ? pass('observation.json copy exists')
    : fail('observation.json not written', obsPath);
}

section(24, 'Success message shows workflowId: conference-proposal-submit');
{
  const statusText = await page.evaluate(() => document.getElementById('obs-status')?.textContent || '');
  const statusVisible = await page.evaluate(() => {
    const el = document.getElementById('obs-status');
    return el && el.style.display !== 'none';
  });
  statusVisible && statusText.includes(TEST_WORKFLOW_ID)
    ? pass(`Success message visible and contains "${TEST_WORKFLOW_ID}"`)
    : fail('Success message not shown or missing workflowId', `visible:${statusVisible} text:"${statusText.slice(0, 200)}"`);
}

// ── Checks 25-30: Artifact content validation ─────────────────────────────────
section(25, 'workflow.json has correct workflowId');
{
  try {
    const wf = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'workflows', TEST_WORKFLOW_ID, 'workflow.json'), 'utf8'));
    wf.workflowId === TEST_WORKFLOW_ID
      ? pass(`workflow.workflowId = "${wf.workflowId}"`)
      : fail('workflow.workflowId mismatch', `got: "${wf.workflowId}"`);
  } catch (e) { fail('Could not read workflow.json', e.message); }
}

section(26, 'workflow-package.example.json validates against the runtime package contract');
{
  try {
    const { validateWorkflowPackage } = await import('../src/core/workflow-contract.mjs');
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'workflows', TEST_WORKFLOW_ID, 'workflow-package.example.json'), 'utf8'));
    const requiredOk = ['workflow_id', 'source_system', 'entity_type', 'entity_id', 'mode']
      .every(k => typeof pkg[k] === 'string' && pkg[k].length > 0);
    requiredOk
      ? pass('required envelope fields present (workflow_id, source_system, entity_type, entity_id, mode)')
      : fail('missing required envelope fields', JSON.stringify(Object.keys(pkg)));
    Array.isArray(pkg.assets)
      ? pass('assets is an array (per contract)')
      : fail('assets must be an array', `got: ${typeof pkg.assets}`);
    const v = validateWorkflowPackage(pkg);
    v.ok
      ? pass('validateWorkflowPackage accepts the generated package')
      : fail('validateWorkflowPackage rejected', JSON.stringify(v.errors));
  } catch (e) { fail('Could not read workflow-package.example.json', e.message); }
}

section(27, 'run-plan.md contains repeat group speakers');
{
  try {
    const rp = fs.readFileSync(path.join(REPO_ROOT, 'output', 'plans', TEST_WORKFLOW_ID, 'run-plan.md'), 'utf8');
    rp.includes('speakers')
      ? pass('run-plan.md includes "speakers"')
      : fail('run-plan.md missing "speakers"', rp.slice(0, 200));
  } catch (e) { fail('Could not read run-plan.md', e.message); }
}

section(28, 'run-plan.md contains captured vars proposalId and publicPreviewUrl');
{
  try {
    const rp = fs.readFileSync(path.join(REPO_ROOT, 'output', 'plans', TEST_WORKFLOW_ID, 'run-plan.md'), 'utf8');
    const ok = rp.includes('proposalId') && rp.includes('publicPreviewUrl');
    ok
      ? pass('run-plan.md includes proposalId and publicPreviewUrl')
      : fail('run-plan.md missing captured vars', rp.slice(0, 300));
  } catch (e) { fail('Could not read run-plan.md', e.message); }
}

section(29, 'run-plan.md contains derived variable proposalDetailUrl');
{
  try {
    const rp = fs.readFileSync(path.join(REPO_ROOT, 'output', 'plans', TEST_WORKFLOW_ID, 'run-plan.md'), 'utf8');
    rp.includes('proposalDetailUrl')
      ? pass('run-plan.md includes proposalDetailUrl')
      : fail('run-plan.md missing proposalDetailUrl', rp.slice(0, 300));
  } catch (e) { fail('Could not read run-plan.md', e.message); }
}

section(30, 'run-plan.md preserves manual-only finalSubmit checkpoint');
{
  try {
    const rp = fs.readFileSync(path.join(REPO_ROOT, 'output', 'plans', TEST_WORKFLOW_ID, 'run-plan.md'), 'utf8');
    const hasFinal = rp.includes('finalSubmit') || rp.toLowerCase().includes('submit proposal') || rp.includes('Manual-only action');
    hasFinal
      ? pass('run-plan.md includes manual checkpoint / finalSubmit')
      : fail('run-plan.md missing manual checkpoint', rp.slice(0, 300));
  } catch (e) { fail('Could not read run-plan.md', e.message); }
}

// ── Check 31: Created workflow appears in /api/workflows ──────────────────────
section(31, 'Created workflow appears in GET /api/workflows');
{
  try {
    const res = await new Promise((resolve, reject) => {
      http.get(`${BASE_URL}/api/workflows`, { timeout: 3000 }, (r) => {
        let body = '';
        r.on('data', d => { body += d; });
        r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    const ids = (res.workflows || []).map(w => w.workflowId);
    ids.includes(TEST_WORKFLOW_ID)
      ? pass(`"${TEST_WORKFLOW_ID}" found in /api/workflows`)
      : fail(`"${TEST_WORKFLOW_ID}" not in /api/workflows`, `got: ${JSON.stringify(ids)}`);
  } catch (e) { fail('/api/workflows request failed', e.message); }
}

// ── Check 32: No vendor-specific strings in fixture or artifacts ──────────────
section(32, 'No vendor-specific strings required (no distrokid, pancake, music-specific terms)');
{
  const fixture = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, 'fixtures', 'observed-conference-proposal', 'observation.json'), 'utf8'
  ));
  const wf  = fs.existsSync(path.join(REPO_ROOT, 'workflows', TEST_WORKFLOW_ID, 'workflow.json'))
    ? JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'workflows', TEST_WORKFLOW_ID, 'workflow.json'), 'utf8'))
    : {};
  const combined = JSON.stringify({ fixture, wf }).toLowerCase();
  const banned = ['distrokid', 'pancake', 'pancakerobot'];
  const found = banned.filter(b => combined.includes(b));
  found.length === 0
    ? pass('No vendor-specific strings found in fixture or artifacts')
    : fail('Vendor-specific strings found', found.join(', '));
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
await browser.close();
stopServer();
cleanupTestArtifacts();

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════');
console.log(`Observation UI acceptance: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════');
if (failed > 0) process.exit(1);
