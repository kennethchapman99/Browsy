#!/usr/bin/env node
// Acceptance: generic runtime contract primitives only.

import { registerApp } from '../src/registry/app-registry.mjs';
import { registerWorkflow, getWorkflowVersion } from '../src/registry/workflow-registry.mjs';
import { createRun, approveRun, cancelRun, getRunResult } from '../src/registry/run-registry.mjs';
import { buildWorkflowContract } from '../src/registry/run-result.mjs';
import { validateGenericSteps } from '../src/registry/generic-actions.mjs';

let passed = 0;
let failed = 0;
function assert(label, condition, detail = '') {
  if (condition) { console.log(`PASS ${label}`); passed++; }
  else { console.error(`FAIL ${label}${detail ? ': ' + detail : ''}`); failed++; }
}

const ts = Date.now();
const appId = `generic-contract-${ts}`;
const workflowId = `workflow-${ts}`;
const workflowObjectId = `${appId}.${workflowId}`;

registerApp({
  appId,
  appName: 'Generic Contract Test App',
  allowedOrigins: ['http://localhost:3737'],
  workflowNamespace: appId,
  callbackUrl: 'http://localhost:3737/api/browsy/callback',
  artifactOutputDir: '/tmp/browsy-artifacts',
  configMetadata: { owner: 'acceptance' },
});

registerWorkflow({
  appId,
  workflowId,
  version: '1.0.0',
  name: 'Generic Contract Test Workflow',
  description: 'Portable generic workflow contract test.',
  inputSchema: {
    type: 'object',
    required: ['releaseId', 'tracks'],
    properties: {
      releaseId: { type: 'string' },
      tracks: { type: 'array' },
    },
  },
  outputSchema: { type: 'object' },
  supportedModes: ['preview', 'live', 'dry_run'],
  tabs: [{ id: 'source-app', urlTemplate: '{{sourceAppUrl}}' }],
  auth: [{ tabId: 'target-site', mode: 'human_required_if_not_authenticated' }],
  humanApprovalCheckpoints: [{ id: 'before-submit', status: 'waiting_for_approval_to_submit' }],
  recordedSteps: [{ type: 'fill', selector: '#title', value: '{{payload.releaseId}}' }],
  variableBindings: { title: '{{payload.releaseId}}' },
  fileUploadBindings: [{ selector: 'input[type=file]', path: '{{payload.artworkPath}}' }],
  expectedOutputs: [{ id: 'confirmation', type: 'text' }],
  validationRules: [{ type: 'assert', field: 'releaseId', op: 'exists' }],
  replaySettings: { leaveBrowserOpen: true },
});

const wv = getWorkflowVersion(workflowObjectId, '1.0.0');
const contract = buildWorkflowContract(wv, { baseUrl: 'http://localhost:3001' });

assert('contract has canonical run endpoint', contract.runEndpoint === `POST http://localhost:3001/api/apps/${appId}/workflows/${workflowId}/runs`);
assert('contract has approve endpoint', contract.approveEndpoint === 'POST http://localhost:3001/api/runs/:runId/approve');
assert('contract has cancel endpoint', contract.cancelEndpoint === 'POST http://localhost:3001/api/runs/:runId/cancel');
assert('contract preserves tabs', contract.tabs.length === 1);
assert('contract preserves auth prerequisites', contract.auth.length === 1);
assert('contract preserves approval checkpoints', contract.humanApprovalCheckpoints.length === 1);
assert('generic steps accept fill', validateGenericSteps([{ type: 'fill' }]).length === 0);
assert('generic steps reject site-specific action', validateGenericSteps([{ type: 'siteSpecificUpload' }]).length === 1);

const run = createRun({ workflowObjectId, version: '1.0.0', mode: 'live', payload: { releaseId: 'R1', tracks: [] } });
const approved = approveRun(run.runId, { approvedBy: 'acceptance' });
assert('approveRun returns running status', approved.status === 'running');
const canceled = cancelRun(run.runId, 'acceptance cleanup');
assert('cancelRun returns canceled status', canceled.status === 'canceled');
const result = getRunResult(run.runId);
assert('public result uses canceled status', result.status === 'canceled');
assert('public result includes artifact buckets', !!result.artifacts && Array.isArray(result.artifacts.screenshots));

console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
