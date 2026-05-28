#!/usr/bin/env node
// Acceptance suite: Observation Compiler + Workflow Package Materializer
//
// Verifies that a generic recorded observation becomes a real portable workflow
// package that the existing registry/import/runtime stack can consume.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { materializeWorkflowPackageFromObservation } from '../src/core/observation-materializer.mjs';
import { registerApp } from '../src/registry/app-registry.mjs';
import { importWorkflowPackage } from '../src/registry/package-importer.mjs';
import { getWorkflowVersion } from '../src/registry/workflow-registry.mjs';
import { createRun, getRunArtifacts } from '../src/registry/run-registry.mjs';
import { executeRun } from '../src/registry/run-executor.mjs';
import { buildWorkflowContract, buildRunResult } from '../src/registry/run-result.mjs';
import { exists, readJson } from '../src/core/paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const TS = Date.now();
const WORKFLOW_ID = `materialized-observation-${TS}`;
const APP_ID = `materializer-test-${TS}`;
const WOBJ = `${APP_ID}.${WORKFLOW_ID}`;

let passed = 0;
let failed = 0;
const failures = [];

function section(title) { console.log(`\n── ${title} ──`); }
function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS ${label}`);
    passed++;
  } else {
    console.error(`  FAIL ${label}${detail ? ': ' + detail : ''}`);
    failed++;
    failures.push(label);
  }
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
  title: 'Materialized Observation Workflow',
  goal: 'Fill a generic form, upload a file, capture an output, and stop at a review checkpoint.',
  recordingSetup: {
    tabs: [
      {
        id: 'sourceTab',
        title: 'Source App',
        url: 'http://localhost:3333/fixtures/kitchen-sink-workflow/index.html',
        requiresAuth: false,
      },
      {
        id: 'targetTab',
        title: 'Target App',
        url: 'http://localhost:3333/fixtures/local-form-demo/index.html',
        siteId: 'target-app',
        requiresAuth: true,
        authCheckUrl: 'http://localhost:3333/fixtures/local-form-demo/index.html',
      },
    ],
  },
  pages: [
    { id: 'source', purpose: 'Source app', url: 'http://localhost:3333/fixtures/kitchen-sink-workflow/index.html' },
    { id: 'target', purpose: 'Target form', url: 'http://localhost:3333/fixtures/local-form-demo/index.html' },
  ],
  sessionEvents: [
    event('page_seen', { pageId: 'sourceTab', pageUrl: 'http://localhost:3333/fixtures/kitchen-sink-workflow/index.html', pageTitle: 'Source App' }),
    event('page_seen', { pageId: 'targetTab', pageUrl: 'http://localhost:3333/fixtures/local-form-demo/index.html', pageTitle: 'Target App' }),
    event('field_detected', {
      pageId: 'targetTab',
      pageUrl: 'http://localhost:3333/fixtures/local-form-demo/index.html',
      selector: '#title',
      rawEvidence: {
        id: 'title',
        name: 'title',
        label: 'Title',
        inputType: 'text',
        selectorCandidates: [
          { selector: '#title', kind: 'id', confidence: 'high' },
          { selector: 'input[name="title"]', kind: 'name', confidence: 'medium' },
        ],
        selectorConfidence: 'high',
      },
    }),
    event('field_detected', {
      pageId: 'targetTab',
      pageUrl: 'http://localhost:3333/fixtures/local-form-demo/index.html',
      selector: '#description',
      rawEvidence: {
        id: 'description',
        name: 'description',
        label: 'Description',
        inputType: 'textarea',
        selectorCandidates: [
          { selector: '#description', kind: 'id', confidence: 'high' },
        ],
        selectorConfidence: 'high',
      },
    }),
    event('file_selected', {
      pageId: 'targetTab',
      pageUrl: 'http://localhost:3333/fixtures/local-form-demo/index.html',
      selector: '#attachment',
      rawEvidence: {
        id: 'attachment',
        name: 'attachment',
        label: 'Attachment',
        inputType: 'file',
        accept: '.png,.jpg',
        files: [{ name: 'cover.png', size: 12345, type: 'image/png', lastModified: 1770000000000 }],
        selectorCandidates: [
          { selector: '#attachment', kind: 'id', confidence: 'high' },
        ],
        selectorConfidence: 'high',
      },
    }),
    event('action_detected', {
      pageId: 'targetTab',
      pageUrl: 'http://localhost:3333/fixtures/local-form-demo/index.html',
      selector: '#preview',
      rawEvidence: {
        label: 'Preview',
        selectorCandidates: [{ selector: '#preview', kind: 'id', confidence: 'high' }],
        selectorConfidence: 'high',
      },
    }),
    event('output_captured', {
      pageId: 'targetTab',
      pageUrl: 'http://localhost:3333/fixtures/local-form-demo/index.html',
      selector: '#output',
      rawEvidence: {
        outputId: 'confirmationCode',
        text: 'CONFIRM-12345',
        triggeredBySelector: '#preview',
        selectorCandidates: [{ selector: '#output', kind: 'id', confidence: 'high' }],
        selectorConfidence: 'high',
      },
    }),
    event('dangerous_action_candidate_detected', {
      pageId: 'targetTab',
      pageUrl: 'http://localhost:3333/fixtures/local-form-demo/index.html',
      selector: '#submit',
      rawEvidence: {
        label: 'Submit final',
        matchedKeyword: 'submit',
        selectorCandidates: [{ selector: '#submit', kind: 'id', confidence: 'high' }],
        selectorConfidence: 'high',
      },
    }),
    event('download_saved', {
      pageId: 'targetTab',
      pageUrl: 'http://localhost:3333/fixtures/local-form-demo/index.html',
      rawEvidence: {
        suggestedFilename: 'receipt.json',
        savedPath: '/tmp/receipt.json',
        size: 200,
      },
    }),
  ],
};

try {
  section('Check 1 — materialize observation package on disk');
  const materialized = materializeWorkflowPackageFromObservation({
    observation,
    repoRoot: REPO_ROOT,
    overwrite: true,
  });
  assert('materializer returns ok', materialized.ok === true, JSON.stringify(materialized.validation?.errors || []));
  assert('workflow.json exists', exists(path.join(materialized.workflowDir, 'workflow.json')));
  assert('manifest.schema.json exists', exists(path.join(materialized.workflowDir, 'manifest.schema.json')));
  assert('workflow-package.example.json exists', exists(path.join(materialized.workflowDir, 'workflow-package.example.json')));
  assert('replay-plan.json exists', exists(path.join(materialized.workflowDir, 'replay-plan.json')));
  assert('bindings.json exists', exists(path.join(materialized.workflowDir, 'bindings.json')));

  const workflowJson = readJson(path.join(materialized.workflowDir, 'workflow.json'));
  const manifestSchema = readJson(path.join(materialized.workflowDir, 'manifest.schema.json'));
  const packageJson = readJson(path.join(materialized.workflowDir, 'workflow-package.example.json'));
  const replayPlan = readJson(path.join(materialized.workflowDir, 'replay-plan.json'));

  assert('workflow preserves observed tabs', workflowJson.tabs?.length >= 2);
  assert('workflow preserves recorded steps', workflowJson.recordedSteps?.length >= 6);
  assert('workflow preserves uploads', workflowJson.fileUploadBindings?.length >= 1);
  assert('workflow preserves outputs', workflowJson.expectedOutputs?.length >= 1);
  assert('workflow preserves checkpoints', workflowJson.humanApprovalCheckpoints?.length >= 1);
  assert('workflow has replay settings', !!workflowJson.replaySettings?.defaultMode);
  assert('manifest requires observed inputs', manifestSchema.required?.includes('title') && manifestSchema.required?.includes('attachment'));
  assert('package contains recordedSteps', packageJson.recordedSteps?.length === workflowJson.recordedSteps.length);
  assert('package contains bindings', !!packageJson.bindings?.variables?.title);
  assert('package contains file upload bindings', packageJson.fileUploadBindings?.length >= 1);
  assert('replay plan contains steps', replayPlan.steps?.length === workflowJson.recordedSteps.length);

  section('Check 2 — import materialized package through registry');
  registerApp({ appId: APP_ID, name: 'Materializer Acceptance App' });
  const imported = importWorkflowPackage({
    packagePath: materialized.workflowDir,
    appId: APP_ID,
    workflowId: WORKFLOW_ID,
    version: '1.0.0',
  });
  assert('registry import succeeds', imported.ok === true, JSON.stringify(imported.errors || []));
  assert('registry import returns stable ref', imported.workflowRef === `${WOBJ}@1.0.0`);

  section('Check 3 — contract populated from materialized package');
  const wv = getWorkflowVersion(WOBJ, '1.0.0');
  const contract = buildWorkflowContract(wv, { baseUrl: 'http://localhost:3001' });
  assert('contract has non-empty tabs', contract.tabs?.length >= 2);
  assert('contract has non-empty recordedSteps', contract.recordedSteps?.length >= 6);
  assert('contract has non-empty bindings', Object.keys(contract.bindings || {}).length >= 1);
  assert('contract has non-empty uploads', contract.fileUploadBindings?.length >= 1);
  assert('contract has non-empty outputs', contract.expectedOutputs?.length >= 1);
  assert('contract has non-empty checkpoints', contract.humanApprovalCheckpoints?.length >= 1);

  section('Check 4 — run uses generated materialized package content');
  const payload = {
    title: 'Materialized title',
    description: 'Materialized description',
    attachment: './examples/cover.png',
  };
  const run = createRun({ workflowObjectId: WOBJ, version: '1.0.0', mode: 'preview', payload });
  const finalRun = await executeRun({
    runId: run.runId,
    workflowVersion: wv,
    payload,
    mode: 'preview',
    approvalToken: null,
  });
  assert('run process completes', finalRun.processStatus === 'completed', finalRun.processStatus);
  assert('engine result has materialized package summary', finalRun.internalRunResult?.materializedPackage?.stepCount >= 6);
  assert('engine result has filled data', finalRun.internalRunResult?.filled_fields?.length >= 2);
  assert('engine result has skipped/checkpoint data', finalRun.internalRunResult?.skipped_fields?.some(s => s.status === 'checkpoint'));
  assert('engine result has uploaded data', finalRun.internalRunResult?.uploaded_files?.length >= 1);
  assert('engine result has captured data', Object.keys(finalRun.internalRunResult?.captured_outputs || {}).length >= 1);
  assert('engine result has artifact data', finalRun.internalRunResult?.downloaded_files?.length >= 1);

  const publicResult = buildRunResult(finalRun);
  assert('public result includes uploadedFiles', publicResult.uploadedFiles?.length >= 1);
  assert('public result includes checkpoints', publicResult.checkpoints?.length >= 1);
  assert('public result includes outputs', Object.keys(publicResult.outputs || {}).length >= 1);

  const artifacts = getRunArtifacts(run.runId);
  assert('run artifacts endpoint data exists', artifacts?.artifacts?.some(a => a.name === 'engine-result.json'));

  section('Check 5 — portable enough for app/environment registration');
  const APP_ID_2 = `${APP_ID}-portable`;
  const WOBJ_2 = `${APP_ID_2}.${WORKFLOW_ID}`;
  registerApp({ appId: APP_ID_2, name: 'Portable Materializer Acceptance App' });
  const imported2 = importWorkflowPackage({
    packagePath: materialized.workflowDir,
    appId: APP_ID_2,
    workflowId: WORKFLOW_ID,
    version: '1.0.0',
  });
  const wv2 = getWorkflowVersion(WOBJ_2, '1.0.0');
  assert('same package imports under a second app', imported2.ok === true && !!wv2);
  assert('second app contract keeps package steps', buildWorkflowContract(wv2).recordedSteps?.length === contract.recordedSteps.length);
} finally {
  try { fs.rmSync(path.join(REPO_ROOT, 'workflows', WORKFLOW_ID), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(REPO_ROOT, 'output', 'plans', WORKFLOW_ID), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(REPO_ROOT, 'output', 'observations', WORKFLOW_ID), { recursive: true, force: true }); } catch {}
}

console.log('');
console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('All checks passed.');
