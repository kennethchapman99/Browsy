#!/usr/bin/env node
// Acceptance: recording session UI bridge.
// Verifies /recordings/:id renders a generic app-initiated setup and drives
// start/stop/import/contract without app/site-specific code.

import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

import { createServer } from '../src/api/generic-server.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const PORT = 14001 + Math.floor(Math.random() * 1000);
const CONTENT_PORT = PORT + 500;
const BASE = `http://localhost:${PORT}`;
const CONTENT = `http://localhost:${CONTENT_PORT}`;
const TS = Date.now();
const APP_ID = `ui-app-${TS}`;
const WORKFLOW_ID = `ui-workflow-${TS}`;

let passed = 0;
let failed = 0;
const failures = [];
let server = null;
let contentServer = null;
let browser = null;
let recordingSessionId = null;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`PASS ${label}`);
    passed++;
  } else {
    console.error(`FAIL ${label}${detail ? ': ' + detail : ''}`);
    failed++;
    failures.push(label);
  }
}

async function api(method, route, body = null) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

function event(type, extra = {}) {
  return {
    id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: `session-${TS}`,
    timestamp: new Date(Date.now() + Math.floor(Math.random() * 1000)).toISOString(),
    source: 'playwrightRecorder',
    type,
    ...extra,
  };
}

const setupPayload = {
  appId: APP_ID,
  appName: 'UI Generic App',
  workflowId: WORKFLOW_ID,
  workflowName: 'UI Generic Workflow',
  recordingSetup: {
    tabs: [
      { id: 'sourceApp', title: 'Source App', url: `${CONTENT}/source` },
      { id: 'targetSite', title: 'Target Site', url: `${CONTENT}/form`, siteId: 'target-site', requiresAuth: false },
    ],
  },
  payloadSchema: {
    type: 'object',
    required: ['recordId', 'primaryUpload'],
    properties: {
      recordId: { type: 'string', title: 'Record ID' },
      primaryUpload: { type: 'string', title: 'Primary upload path' },
    },
  },
  fileBindings: [
    { id: 'primaryUpload', label: 'Primary upload', source: 'payload.primaryUpload', required: true },
  ],
  expectedOutputs: [
    { id: 'confirmationId', label: 'Confirmation ID' },
  ],
  humanCheckpoints: [
    { id: 'finalSubmit', label: 'Final submit', reason: 'manual approval required' },
  ],
};

const observation = {
  schemaVersion: 'browsy.observation.v1',
  workflowId: WORKFLOW_ID,
  title: 'UI Generic Workflow',
  goal: 'Generic UI bridge workflow.',
  recordingSetup: setupPayload.recordingSetup,
  pages: [
    { id: 'sourceApp', purpose: 'Source App', url: `${CONTENT}/source` },
    { id: 'targetSite', purpose: 'Target Site', url: `${CONTENT}/form` },
  ],
  sessionEvents: [
    event('page_seen', { pageId: 'sourceApp', pageUrl: `${CONTENT}/source`, pageTitle: 'Source App' }),
    event('page_seen', { pageId: 'targetSite', pageUrl: `${CONTENT}/form`, pageTitle: 'Target Site' }),
    event('field_detected', {
      pageId: 'targetSite',
      selector: '#recordId',
      rawEvidence: {
        id: 'recordId',
        name: 'recordId',
        label: 'Record ID',
        inputType: 'text',
        selectorCandidates: [{ selector: '#recordId', kind: 'id', confidence: 'high' }],
        selectorConfidence: 'high',
      },
    }),
    event('file_selected', {
      pageId: 'targetSite',
      selector: '#primaryUpload',
      rawEvidence: {
        id: 'primaryUpload',
        name: 'primaryUpload',
        label: 'Primary upload',
        inputType: 'file',
        files: [{ name: 'upload.png', size: 10, type: 'image/png' }],
        selectorCandidates: [{ selector: '#primaryUpload', kind: 'id', confidence: 'high' }],
        selectorConfidence: 'high',
      },
    }),
    event('output_captured', {
      pageId: 'targetSite',
      selector: '#confirmationId',
      rawEvidence: {
        outputId: 'confirmationId',
        text: 'CONFIRM-UI',
        selectorCandidates: [{ selector: '#confirmationId', kind: 'id', confidence: 'high' }],
        selectorConfidence: 'high',
      },
    }),
    event('dangerous_action_candidate_detected', {
      pageId: 'targetSite',
      selector: '#submit',
      rawEvidence: {
        label: 'Submit final',
        selectorCandidates: [{ selector: '#submit', kind: 'id', confidence: 'high' }],
        selectorConfidence: 'high',
      },
    }),
  ],
};

function startContentServer() {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Content page</h1></body></html>');
  });
  return new Promise(resolve => s.listen(CONTENT_PORT, () => resolve(s)));
}

try {
  server = createServer({ port: PORT });
  await new Promise(resolve => server.listen(PORT, resolve));
  contentServer = await startContentServer();

  const started = await api('POST', '/api/recordings/start', setupPayload);
  assert('start API creates session', started.res.status === 201 && started.json.ok === true, JSON.stringify(started.json));
  recordingSessionId = started.json.recordingSessionId;
  assert('wizardUrl points to /recordings/:id', started.json.wizardUrl === `${BASE}/recordings/${recordingSessionId}`, started.json.wizardUrl);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const popups = [];
  page.on('popup', p => popups.push(p));
  await page.goto(`${BASE}/recordings/${recordingSessionId}`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-testid="recording-summary"]');

  assert('/recordings/:id page renders app', (await page.textContent('#app')).includes(APP_ID));
  assert('/recordings/:id page renders workflow', (await page.textContent('#workflow')).includes(WORKFLOW_ID));
  assert('source data is first nav item', await page.locator('[data-nav="1"]').textContent() === '1. Source data');
  assert('tabs/auth is second nav item', await page.locator('[data-nav="2"]').textContent() === '2. Tabs and auth');
  assert('source data question renders first with app name', (await page.textContent('body')).includes('What info do I need to grab from UI Generic App?'));
  assert('Start Recording button exists', await page.locator('[data-testid="start-recording-button"]').count() === 1);
  assert('Open recorder button is not rendered', await page.getByText('Open recorder', { exact: true }).count() === 0);
  assert('Stop Recording button exists', await page.locator('[data-testid="stop-recording-button"]').count() === 1);
  assert('Abandon Recording button exists', await page.locator('[data-testid="abandon-recording-button"]').count() === 1);
  assert('Release Stale Lock button exists', await page.locator('[data-testid="release-stale-lock-button"]').count() === 1);
  assert('Import Workflow button exists', await page.locator('[data-testid="import-workflow-button"]').count() === 1);
  assert('View Contract button exists', await page.locator('[data-testid="view-contract-button"]').count() === 1);
  assert('tabs render', (await page.locator('[data-testid="tabs-table"] tbody tr').count()) === 2);

  await page.fill('[data-testid="field-contract-intent"]', 'release date, number of tracks, for each track: audio file, title, AI disclosure, credits');
  assert('payload fields render', (await page.textContent('[data-testid="payload-fields"]')).includes('recordId'));
  assert('file bindings render', (await page.textContent('[data-testid="file-bindings"]')).includes('primaryUpload'));

  await page.click('[data-nav="2"]');
  assert('guided tabs/auth question renders after source data', (await page.textContent('body')).includes('What tabs do you need open, which ones require auth?'));
  await page.fill('[data-testid="auth-profile-id"]', `ui-profile-${TS}`);
  await page.click('[data-testid="check-auth-button"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="action-result"]')?.textContent.includes('Auth profile ui-profile-'));
  assert('Check Auth inspects profile path and health', (await page.textContent('[data-testid="action-result"]')).includes('Path:'));
  await page.click('[data-testid="release-stale-lock-button"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="action-result"]')?.textContent.includes('Stale lock release result'));
  assert('Release Stale Lock safely no-ops when unlocked', (await page.textContent('[data-testid="action-result"]')).includes('Locked after release: false'));

  await page.click('[data-nav="3"]');
  assert('completion question renders', (await page.textContent('body')).includes('What should Browsy do when done?'));
  await page.selectOption('[data-testid="completion-action"]', 'write_outputs_to_source_app');
  await page.fill('[data-testid="completion-notes"]', 'write confirmation ID back to the source record');
  assert('expected outputs render', (await page.textContent('[data-testid="expected-outputs"]')).includes('confirmationId'));
  assert('human checkpoints render', (await page.textContent('[data-testid="human-checkpoints"]')).includes('finalSubmit'));

  await page.click('[data-nav="4"]');
  await page.click('[data-testid="start-recording-button"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="recording-status"]')?.textContent === 'recording');
  assert('Start Recording changes status to recording', (await page.textContent('[data-testid="recording-status"]')) === 'recording');
  const startActionText = await page.textContent('[data-testid="action-result"]');
  assert('start action reports real recorder mode', startActionText.includes('real_playwright_recorder'));
  assert('start action does not expose recorderUrl', !startActionText.includes('recorderUrl'));

  await page.evaluate(() => window.showStep?.(4));
  await page.evaluate((value) => {
    document.querySelector('[data-testid="observation-input"]').value = value;
  }, JSON.stringify(observation));
  await page.click('[data-testid="stop-recording-button"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="recording-status"]')?.textContent === 'stopped');
  assert('Stop Recording changes status to stopped', (await page.textContent('[data-testid="recording-status"]')) === 'stopped');
  const savedObservation = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'output', 'recordings', recordingSessionId, 'observation.json'), 'utf8'));
  assert('observation preserves source field intent', savedObservation.fieldContractIntent?.includes('number of tracks'));
  assert('observation preserves completion policy', savedObservation.completionPolicy?.action === 'write_outputs_to_source_app');

  await page.click('[data-nav="5"]');
  await page.click('[data-testid="import-workflow-button"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="recording-status"]')?.textContent === 'imported');
  assert('Import Workflow changes status to imported', (await page.textContent('[data-testid="recording-status"]')) === 'imported');
  assert('Import output includes workflowRef', (await page.textContent('[data-testid="action-result"]')).includes(`${APP_ID}.${WORKFLOW_ID}@1.0.0`));

  await page.click('[data-testid="view-contract-button"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="contract-output"]')?.textContent.includes('recordedSteps'));
  const contractText = await page.textContent('[data-testid="contract-output"]');
  const contract = JSON.parse(contractText);
  assert('contract has tabs', contract.tabs?.length >= 2);
  assert('contract has recordedSteps', contract.recordedSteps?.length >= 5);
  assert('contract has fileUploadBindings', contract.fileUploadBindings?.length >= 1);
  assert('contract has expectedOutputs', contract.expectedOutputs?.length >= 1);
  assert('contract has humanApprovalCheckpoints', contract.humanApprovalCheckpoints?.length >= 1);

  const wfDir = path.join(REPO_ROOT, 'workflows', WORKFLOW_ID);
  for (const file of ['workflow.json', 'manifest.schema.json', 'workflow-package.example.json', 'replay-plan.json', 'bindings.json', 'field-map.local.json', 'safety-policy.json']) {
    assert(`${file} exists`, fs.existsSync(path.join(wfDir, file)));
  }
} finally {
  if (browser) await browser.close();
  if (contentServer) await new Promise(resolve => contentServer.close(resolve));
  if (server) await new Promise(resolve => server.close(resolve));
  if (recordingSessionId) fs.rmSync(path.join(REPO_ROOT, 'output', 'recordings', recordingSessionId), { recursive: true, force: true });
  fs.rmSync(path.join(REPO_ROOT, 'workflows', WORKFLOW_ID), { recursive: true, force: true });
  fs.rmSync(path.join(REPO_ROOT, 'output', 'plans', WORKFLOW_ID), { recursive: true, force: true });
  fs.rmSync(path.join(REPO_ROOT, 'output', 'observations', WORKFLOW_ID), { recursive: true, force: true });
  fs.rmSync(path.join(REPO_ROOT, 'registry', 'apps', `${APP_ID}.json`), { force: true });
  fs.rmSync(path.join(REPO_ROOT, 'registry', 'workflows', `${APP_ID}.${WORKFLOW_ID}.json`), { force: true });
}

console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
