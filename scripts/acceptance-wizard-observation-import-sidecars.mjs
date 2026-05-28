#!/usr/bin/env node
// Acceptance: legacy wizard /api/observation/import emits materialized sidecars.
// This exercises the actual wizard server route for backward compatibility.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const WIZARD_URL = 'http://localhost:3333';
const TS = Date.now();
const WORKFLOW_ID = `wizard-sidecar-${TS}`;

let passed = 0;
let failed = 0;
const failures = [];
let child = null;

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

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function isWizardUp() {
  try {
    const res = await fetch(`${WIZARD_URL}/api/workflows`);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureWizard() {
  if (await isWizardUp()) return false;
  child = spawn(process.execPath, ['wizard/server.mjs'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  child.stdout.on('data', chunk => process.stdout.write(`[wizard] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[wizard] ${chunk}`));
  for (let i = 0; i < 50; i++) {
    if (await isWizardUp()) return true;
    await sleep(200);
  }
  throw new Error('wizard server did not start on http://localhost:3333');
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

const observation = {
  schemaVersion: 'browsy.observation.v1',
  workflowId: WORKFLOW_ID,
  title: 'Wizard Sidecar Compatibility',
  goal: 'Verify existing wizard import emits package sidecars.',
  recordingSetup: {
    tabs: [
      { id: 'sourceApp', title: 'Source App', url: 'http://localhost:3333/fixtures/kitchen-sink-workflow/index.html' },
      { id: 'targetSite', title: 'Target Site', url: 'http://localhost:3333/fixtures/local-form-demo/index.html', siteId: 'target-site', requiresAuth: true },
    ],
  },
  pages: [
    { id: 'sourceApp', purpose: 'Source App', url: 'http://localhost:3333/fixtures/kitchen-sink-workflow/index.html' },
    { id: 'targetSite', purpose: 'Target Site', url: 'http://localhost:3333/fixtures/local-form-demo/index.html' },
  ],
  sessionEvents: [
    event('page_seen', { pageId: 'sourceApp', pageUrl: 'http://localhost:3333/fixtures/kitchen-sink-workflow/index.html', pageTitle: 'Source App' }),
    event('page_seen', { pageId: 'targetSite', pageUrl: 'http://localhost:3333/fixtures/local-form-demo/index.html', pageTitle: 'Target Site' }),
    event('field_detected', {
      pageId: 'targetSite',
      selector: '#title',
      rawEvidence: {
        id: 'title',
        name: 'title',
        label: 'Title',
        inputType: 'text',
        selectorCandidates: [{ selector: '#title', kind: 'id', confidence: 'high' }],
        selectorConfidence: 'high',
      },
    }),
    event('file_selected', {
      pageId: 'targetSite',
      selector: '#attachment',
      rawEvidence: {
        id: 'attachment',
        name: 'attachment',
        label: 'Attachment',
        inputType: 'file',
        files: [{ name: 'example.png', size: 10, type: 'image/png' }],
        selectorCandidates: [{ selector: '#attachment', kind: 'id', confidence: 'high' }],
        selectorConfidence: 'high',
      },
    }),
    event('output_captured', {
      pageId: 'targetSite',
      selector: '#confirmation',
      rawEvidence: {
        outputId: 'confirmationId',
        text: 'CONFIRM-1',
        selectorCandidates: [{ selector: '#confirmation', kind: 'id', confidence: 'high' }],
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

try {
  await ensureWizard();

  const res = await fetch(`${WIZARD_URL}/api/observation/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflowId: WORKFLOW_ID, observation, overwrite: true }),
  });
  const body = await res.json();
  assert('legacy import returns ok', res.ok && body.ok === true, JSON.stringify(body));
  assert('legacy import returns workflowId', body.workflowId === WORKFLOW_ID, body.workflowId);

  const wfDir = path.join(REPO_ROOT, 'workflows', WORKFLOW_ID);
  const expected = [
    'workflow.json',
    'manifest.schema.json',
    'workflow-package.example.json',
    'replay-plan.json',
    'bindings.json',
    'field-map.local.json',
    'safety-policy.json',
  ];
  for (const file of expected) {
    assert(`${file} exists`, fs.existsSync(path.join(wfDir, file)));
  }

  const workflow = JSON.parse(fs.readFileSync(path.join(wfDir, 'workflow.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(wfDir, 'workflow-package.example.json'), 'utf8'));
  const replay = JSON.parse(fs.readFileSync(path.join(wfDir, 'replay-plan.json'), 'utf8'));
  const bindings = JSON.parse(fs.readFileSync(path.join(wfDir, 'bindings.json'), 'utf8'));

  assert('workflow has tabs', workflow.tabs?.length >= 2);
  assert('workflow has recordedSteps', workflow.recordedSteps?.length >= 4);
  assert('workflow has fileUploadBindings', workflow.fileUploadBindings?.length >= 1);
  assert('workflow has expectedOutputs', workflow.expectedOutputs?.length >= 1);
  assert('workflow has humanApprovalCheckpoints', workflow.humanApprovalCheckpoints?.length >= 1);
  assert('package has recordedSteps', pkg.recordedSteps?.length >= 4);
  assert('replay plan has steps', replay.steps?.length >= 4);
  assert('bindings has variables/files/outputs', !!bindings.variables?.title && !!bindings.files?.attachment && !!bindings.outputs?.confirmationId);
} finally {
  fs.rmSync(path.join(REPO_ROOT, 'workflows', WORKFLOW_ID), { recursive: true, force: true });
  fs.rmSync(path.join(REPO_ROOT, 'output', 'plans', WORKFLOW_ID), { recursive: true, force: true });
  fs.rmSync(path.join(REPO_ROOT, 'output', 'observations', WORKFLOW_ID), { recursive: true, force: true });
  if (child) child.kill('SIGTERM');
}

console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
