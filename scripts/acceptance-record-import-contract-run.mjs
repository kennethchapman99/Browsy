#!/usr/bin/env node
// Acceptance: app-initiated recording → stop/import → contract → run/status/artifacts.
// Uses only generic fixture app/site concepts; no app/site-specific code.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createServer } from '../src/api/generic-server.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const PORT = 13001 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const TS = Date.now();
const APP_ID = `generic-run-${TS}`;
const WORKFLOW_ID = `record-import-run-${TS}`;

let passed = 0;
let failed = 0;
const failures = [];
let server = null;
let recordingSessionId = null;
let runId = null;

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

async function request(method, route, body = null) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
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
  appName: 'Generic Run App',
  workflowId: WORKFLOW_ID,
  workflowName: 'Record Import Run Workflow',
  recordingSetup: {
    tabs: [
      { id: 'sourceApp', title: 'Source App', url: 'http://localhost:3000/source/123' },
      { id: 'targetSite', title: 'Target Site', url: 'https://example.com/start', siteId: 'target-site', requiresAuth: true, authCheckUrl: 'https://example.com/account' },
    ],
  },
  payloadSchema: {
    type: 'object',
    required: ['recordId', 'sourceUrl', 'primaryUpload'],
    properties: {
      recordId: { type: 'string', title: 'Record ID' },
      sourceUrl: { type: 'string', title: 'Source URL' },
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
  title: 'Record Import Run Workflow',
  goal: 'Generic app-initiated recorded workflow.',
  recordingSetup: setupPayload.recordingSetup,
  pages: [
    { id: 'sourceApp', purpose: 'Source App', url: 'http://localhost:3000/source/123' },
    { id: 'targetSite', purpose: 'Target Site', url: 'https://example.com/start' },
  ],
  sessionEvents: [
    event('page_seen', { pageId: 'sourceApp', pageUrl: 'http://localhost:3000/source/123', pageTitle: 'Source App' }),
    event('page_seen', { pageId: 'targetSite', pageUrl: 'https://example.com/start', pageTitle: 'Target Site' }),
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
    event('field_detected', {
      pageId: 'targetSite',
      selector: '#sourceUrl',
      rawEvidence: {
        id: 'sourceUrl',
        name: 'sourceUrl',
        label: 'Source URL',
        inputType: 'text',
        selectorCandidates: [{ selector: '#sourceUrl', kind: 'id', confidence: 'high' }],
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
        files: [{ name: 'upload.png', size: 100, type: 'image/png' }],
        selectorCandidates: [{ selector: '#primaryUpload', kind: 'id', confidence: 'high' }],
        selectorConfidence: 'high',
      },
    }),
    event('action_detected', {
      pageId: 'targetSite',
      selector: '#preview',
      rawEvidence: {
        label: 'Preview',
        selectorCandidates: [{ selector: '#preview', kind: 'id', confidence: 'high' }],
        selectorConfidence: 'high',
      },
    }),
    event('output_captured', {
      pageId: 'targetSite',
      selector: '#confirmationId',
      rawEvidence: {
        outputId: 'confirmationId',
        text: 'CONFIRM-123',
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
    event('download_saved', {
      pageId: 'targetSite',
      rawEvidence: { suggestedFilename: 'receipt.json', savedPath: '/tmp/receipt.json', size: 50 },
    }),
  ],
};

try {
  server = createServer({ port: PORT });
  await new Promise(resolve => server.listen(PORT, resolve));

  const started = await request('POST', '/api/recordings/start', setupPayload);
  assert('POST /api/recordings/start returns 201', started.res.status === 201, JSON.stringify(started.json));
  assert('start response ok', started.json.ok === true);
  recordingSessionId = started.json.recordingSessionId;
  assert('start response has recordingSessionId', /^rec_/.test(recordingSessionId || ''));
  assert('start response has wizardUrl', started.json.wizardUrl?.includes(`/recordings/${recordingSessionId}`));

  const fetched = await request('GET', `/api/recordings/${recordingSessionId}`);
  assert('GET /api/recordings/:id works', fetched.res.ok && fetched.json.recording?.recordingSessionId === recordingSessionId);

  const stopped = await request('POST', `/api/recordings/${recordingSessionId}/stop`, { observation });
  assert('POST /api/recordings/:id/stop works', stopped.res.ok && stopped.json.recording?.status === 'stopped', JSON.stringify(stopped.json));

  const imported = await request('POST', `/api/recordings/${recordingSessionId}/import`, { overwrite: true, autoRegisterApp: true });
  assert('POST /api/recordings/:id/import returns 201', imported.res.status === 201, JSON.stringify(imported.json));
  assert('import response ok', imported.json.ok === true);
  assert('workflowRef returned', imported.json.workflowRef === `${APP_ID}.${WORKFLOW_ID}@1.0.0`, imported.json.workflowRef);
  assert('contract returned', imported.json.contract?.workflowId === WORKFLOW_ID);

  const wfDir = path.join(REPO_ROOT, 'workflows', WORKFLOW_ID);
  for (const file of ['workflow.json', 'manifest.schema.json', 'workflow-package.example.json', 'replay-plan.json', 'bindings.json', 'field-map.local.json', 'safety-policy.json']) {
    assert(`${file} materialized`, fs.existsSync(path.join(wfDir, file)));
  }

  const contractResult = await request('GET', `/api/recordings/${recordingSessionId}/contract`);
  assert('GET /api/recordings/:id/contract works', contractResult.res.ok && contractResult.json.contract?.workflowRef === `${APP_ID}.${WORKFLOW_ID}@1.0.0`);
  assert('contract has tabs', contractResult.json.contract?.tabs?.length >= 2);
  assert('contract has recordedSteps', contractResult.json.contract?.recordedSteps?.length >= 6);
  assert('contract has fileUploadBindings', contractResult.json.contract?.fileUploadBindings?.length >= 1);
  assert('contract has expectedOutputs', contractResult.json.contract?.expectedOutputs?.length >= 1);
  assert('contract has checkpoints', contractResult.json.contract?.humanApprovalCheckpoints?.length >= 1);

  const run = await request('POST', `/api/apps/${APP_ID}/workflows/${WORKFLOW_ID}/runs`, {
    mode: 'preview',
    payload: {
      recordId: 'REC-123',
      sourceUrl: 'http://localhost:3000/source/123',
      primaryUpload: './upload.png',
    },
  });
  assert('POST canonical run endpoint returns 201', run.res.status === 201, JSON.stringify(run.json));
  assert('run response ok', run.json.ok === true);
  runId = run.json.runId;
  assert('runId returned', !!runId);

  let status = null;
  for (let i = 0; i < 20; i++) {
    status = await request('GET', `/api/runs/${runId}`);
    const publicStatus = status.json.result?.status || status.json.run?.status;
    if (['completed', 'blocked', 'failed', 'waiting_for_approval_to_submit'].includes(publicStatus)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert('GET /api/runs/:runId works', status?.res.ok === true, JSON.stringify(status?.json));
  assert('status has result', !!status?.json?.result);
  assert('result exposes materialized package summary', !!status?.json?.result?.materializedPackage);
  assert('result exposes uploadedFiles', status?.json?.result?.uploadedFiles?.length >= 1);
  assert('result exposes outputs', Object.keys(status?.json?.result?.outputs || {}).length >= 1);
  assert('result exposes checkpoints', status?.json?.result?.checkpoints?.length >= 1);

  const artifacts = await request('GET', `/api/runs/${runId}/artifacts`);
  assert('GET /api/runs/:runId/artifacts works', artifacts.res.ok === true, JSON.stringify(artifacts.json));
  assert('artifacts include engine-result.json', artifacts.json.artifacts?.some(a => a.name === 'engine-result.json'));
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  if (recordingSessionId) fs.rmSync(path.join(REPO_ROOT, 'output', 'recordings', recordingSessionId), { recursive: true, force: true });
  fs.rmSync(path.join(REPO_ROOT, 'workflows', WORKFLOW_ID), { recursive: true, force: true });
  fs.rmSync(path.join(REPO_ROOT, 'output', 'plans', WORKFLOW_ID), { recursive: true, force: true });
  fs.rmSync(path.join(REPO_ROOT, 'output', 'observations', WORKFLOW_ID), { recursive: true, force: true });
  fs.rmSync(path.join(REPO_ROOT, 'registry', 'apps', `${APP_ID}.json`), { force: true });
  fs.rmSync(path.join(REPO_ROOT, 'registry', 'workflows', `${APP_ID}.${WORKFLOW_ID}.json`), { force: true });
  if (runId) fs.rmSync(path.join(REPO_ROOT, 'registry', 'runs', runId), { recursive: true, force: true });
}

console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
