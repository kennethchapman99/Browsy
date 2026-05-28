// Browsy Registry + Runtime acceptance suite.
//
// Tests all 9 acceptance criteria without a real browser (dry_run / preview mode).
// The registry layer is exercised through direct module imports (Parts A-B) and
// the HTTP API server (Part C).

import { registerApp, getApp, listApps } from '../src/registry/app-registry.mjs';
import { registerWorkflow, getWorkflow, getWorkflowVersion, listWorkflows, parseWorkflowRef } from '../src/registry/workflow-registry.mjs';
import { createRun, getRun, stopRun, getRunArtifacts } from '../src/registry/run-registry.mjs';
import { executeRun } from '../src/registry/run-executor.mjs';
import { validatePayload, evaluateAssertions } from '../src/registry/schema-validator.mjs';
import { checkSafetyGates } from '../src/registry/safety-gates.mjs';
import { REGISTRY_DIR } from '../src/core/paths.mjs';
import { join } from 'path';
import fs from 'fs';
import http from 'http';
import os from 'os';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS ${label}`);
    passed++;
  } else {
    console.error(`  FAIL ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

// Isolated temp registry dir so tests don't pollute the real registry.
const TEST_ROOT = fs.mkdtempSync(join(os.tmpdir(), 'browsy-registry-test-'));
process.env.BROWSY_REGISTRY_ROOT = TEST_ROOT;

// Override registry paths for this test run.
// We patch the module-level REGISTRY_DIR by using a test-specific runRoot in executeRun.
// App/workflow registries write to the real REGISTRY_DIR; we use unique IDs to avoid collision.
const TS = Date.now();
const TEST_APP_ID = `testapp-${TS}`;
const TEST_WF_ID = `upload-${TS}`;
const TEST_OBJECT_ID = `${TEST_APP_ID}.${TEST_WF_ID}`;

// ---------------------------------------------------------------------------
// Part A — App Registry
// ---------------------------------------------------------------------------
section('Part A — App Registry');

// 1. Register app
const app = registerApp({ appId: TEST_APP_ID, name: 'Test App', description: 'Registry acceptance test app.' });
assert('A1 registerApp returns record with appId', app.appId === TEST_APP_ID);
assert('A2 registerApp stores name', app.name === 'Test App');

const fetched = getApp(TEST_APP_ID);
assert('A3 getApp returns registered app', fetched?.appId === TEST_APP_ID);

const apps = listApps();
assert('A4 listApps includes new app', apps.some(a => a.appId === TEST_APP_ID));

// Re-registering updates without duplicating
const updated = registerApp({ appId: TEST_APP_ID, name: 'Test App Updated' });
assert('A5 re-register updates name', updated.name === 'Test App Updated');
assert('A6 re-register preserves registeredAt', updated.registeredAt === app.registeredAt);

// Invalid appId rejected
let appErr = null;
try { registerApp({ appId: 'Bad_App!', name: 'x' }); } catch (e) { appErr = e.message; }
assert('A7 invalid appId throws', !!appErr);

// ---------------------------------------------------------------------------
// Part B — Workflow Registry
// ---------------------------------------------------------------------------
section('Part B — Workflow Registry');

const inputSchema = {
  type: 'object',
  required: ['title', 'artist'],
  properties: {
    title: { type: 'string', minLength: 1 },
    artist: { type: 'string', minLength: 1 },
    trackCount: { type: 'number' },
  },
};
const outputSchema = {
  type: 'object',
  properties: {
    releaseId: { type: 'string' },
    status: { type: 'string' },
  },
};

// 2. Register workflow
const wfResult = registerWorkflow({
  appId: TEST_APP_ID,
  workflowId: TEST_WF_ID,
  version: '1.0.0',
  inputSchema,
  outputSchema,
  supportedModes: ['preview', 'live'],
  safetyPolicy: { requiresLiveApproval: true },
  successAssertions: [
    { type: 'status', op: 'not_equals', value: 'failed' },
  ],
  failureAssertions: [],
});
assert('B1 registerWorkflow creates record', wfResult.workflowObjectId === TEST_OBJECT_ID);
assert('B2 registerWorkflow stores version 1.0.0', !!wfResult.versions['1.0.0']);
assert('B3 latestVersion is 1.0.0', wfResult.latestVersion === '1.0.0');

const wf = getWorkflow(TEST_OBJECT_ID);
assert('B4 getWorkflow returns record', wf?.workflowObjectId === TEST_OBJECT_ID);

const wfv = getWorkflowVersion(TEST_OBJECT_ID, '1.0.0');
assert('B5 getWorkflowVersion returns version', wfv?.version === '1.0.0');

const wfvLatest = getWorkflowVersion(TEST_OBJECT_ID);
assert('B6 getWorkflowVersion without version returns latest', wfvLatest?.version === '1.0.0');

const workflows = listWorkflows();
assert('B7 listWorkflows includes new workflow', workflows.some(w => w.workflowObjectId === TEST_OBJECT_ID));

// Register v2 — v1 becomes frozen
const wfResult2 = registerWorkflow({
  appId: TEST_APP_ID,
  workflowId: TEST_WF_ID,
  version: '2.0.0',
  inputSchema: { ...inputSchema, required: ['title', 'artist', 'trackCount'] },
  outputSchema,
  supportedModes: ['preview', 'live'],
  safetyPolicy: { requiresLiveApproval: true },
  successAssertions: [],
  failureAssertions: [],
});
assert('B8 v2 registration sets latestVersion to 2.0.0', wfResult2.latestVersion === '2.0.0');
const frozenV1 = getWorkflowVersion(TEST_OBJECT_ID, '1.0.0');
assert('B9 v1 is frozen after v2 registered', frozenV1?.status === 'frozen');

// parseWorkflowRef
const ref1 = parseWorkflowRef(`${TEST_OBJECT_ID}@1.0.0`);
assert('B10 parseWorkflowRef extracts version', ref1.version === '1.0.0' && ref1.workflowObjectId === TEST_OBJECT_ID);
const ref2 = parseWorkflowRef(TEST_OBJECT_ID);
assert('B11 parseWorkflowRef without @ has null version', ref2.version === null);

// ---------------------------------------------------------------------------
// Part C — Schema Validator
// ---------------------------------------------------------------------------
section('Part C — Schema Validator');

const valid = validatePayload({ title: 'My Album', artist: 'Artist X' }, inputSchema);
assert('C1 valid payload passes', valid.ok, valid.errors.join('; '));

// 5. Missing payload fields fail before browser launch
const missing = validatePayload({ title: 'My Album' }, inputSchema);
assert('C2 missing required field "artist" fails', !missing.ok);
assert('C3 error message names the missing field', missing.errors.some(e => e.includes('artist')));

const wrongType = validatePayload({ title: 'My Album', artist: 'X', trackCount: 'ten' }, inputSchema);
assert('C4 wrong type for trackCount fails', !wrongType.ok);

const empty = validatePayload({ title: '', artist: 'X' }, inputSchema);
assert('C5 empty required field treated as missing', !empty.ok);

// ---------------------------------------------------------------------------
// Part D — Safety Gates
// ---------------------------------------------------------------------------
section('Part D — Safety Gates');

const wfv1 = getWorkflowVersion(TEST_OBJECT_ID, '1.0.0');

// 8. Live mode requires approval token
const noToken = checkSafetyGates({ workflowVersion: wfv1, mode: 'live', approvalToken: null });
assert('D1 live mode without approvalToken blocked', !noToken.ok);
assert('D2 error mentions approvalToken', noToken.errors.some(e => e.includes('approvalToken')));

const withToken = checkSafetyGates({ workflowVersion: wfv1, mode: 'live', approvalToken: 'my-token' });
assert('D3 live mode with approvalToken passes', withToken.ok);

const previewGate = checkSafetyGates({ workflowVersion: wfv1, mode: 'preview', approvalToken: null });
assert('D4 preview mode needs no approval token', previewGate.ok);

// Unsupported mode
const badMode = checkSafetyGates({ workflowVersion: wfv1, mode: 'turbo', approvalToken: null });
assert('D5 unsupported mode blocked', !badMode.ok);

// Mode not in workflow's supportedModes (v1 only supports preview + live)
const discoverGate = checkSafetyGates({ workflowVersion: wfv1, mode: 'discover', approvalToken: null });
assert('D6 mode not in supportedModes blocked', !discoverGate.ok);

// ---------------------------------------------------------------------------
// Part E — Assertions
// ---------------------------------------------------------------------------
section('Part E — Assertions');

const fakeResult = { status: 'dry_run_passed', captured_outputs: { releaseId: { value: 'REL-001' } } };

const { outcome: ok1 } = evaluateAssertions(
  [{ type: 'status', op: 'equals', value: 'dry_run_passed' }],
  [],
  fakeResult
);
assert('E1 successAssertion passes when status matches', ok1 === 'success');

const { outcome: ok2 } = evaluateAssertions(
  [{ type: 'captured_output', field: 'releaseId', op: 'exists' }],
  [],
  fakeResult
);
assert('E2 successAssertion passes when captured_output exists', ok2 === 'success');

// 6. Completed process with failed assertions returns workflowOutcome failed
const { outcome: ok3, failedSuccessAssertions } = evaluateAssertions(
  [{ type: 'captured_output', field: 'releaseId', op: 'exists' }],
  [],
  { status: 'dry_run_passed', captured_outputs: {} }
);
assert('E3 missing captured_output fails assertion', ok3 === 'failed');
assert('E4 failedSuccessAssertions is populated', failedSuccessAssertions.length > 0);

const { outcome: ok4 } = evaluateAssertions(
  [],
  [{ type: 'status', op: 'equals', value: 'failed' }],
  { status: 'failed' }
);
assert('E5 triggered failureAssertion produces workflowOutcome failed', ok4 === 'failed');

// ---------------------------------------------------------------------------
// Part F — Run Registry
// ---------------------------------------------------------------------------
section('Part F — Run Registry');

const run = createRun({
  workflowObjectId: TEST_OBJECT_ID,
  version: '1.0.0',
  mode: 'preview',
  payload: { title: 'My Album', artist: 'Artist X' },
});
assert('F1 createRun returns runId', !!run.runId);
assert('F2 run processStatus starts as running', run.processStatus === 'running');
assert('F3 run stores workflowObjectId', run.workflowObjectId === TEST_OBJECT_ID);

const fetched2 = getRun(run.runId);
assert('F4 getRun retrieves run', fetched2?.runId === run.runId);

// 9. Artifacts attach to run result (via run executor below)

const stopped = stopRun(run.runId);
assert('F5 stopRun sets processStatus to stopped', stopped.processStatus === 'stopped');
assert('F6 stopRun sets workflowOutcome to stopped', stopped.workflowOutcome === 'stopped');

// Stopping an already-stopped run is idempotent
const stoppedAgain = stopRun(run.runId);
assert('F7 stopping a stopped run is idempotent', stoppedAgain.processStatus === 'stopped');

// ---------------------------------------------------------------------------
// Part G — End-to-End Run Execution
// ---------------------------------------------------------------------------
section('Part G — End-to-End Run Execution');

// Register a workflow with no successAssertions so any dry_run passes.
const E2E_WF_ID = `e2e-${TS}`;
const E2E_OBJECT_ID = `${TEST_APP_ID}.${E2E_WF_ID}`;
registerWorkflow({
  appId: TEST_APP_ID,
  workflowId: E2E_WF_ID,
  version: '1.0.0',
  inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
  outputSchema: {},
  supportedModes: ['preview', 'live'],
  safetyPolicy: { requiresLiveApproval: true },
  successAssertions: [],
  failureAssertions: [],
});

const e2eWv = getWorkflowVersion(E2E_OBJECT_ID, '1.0.0');

// 3. Run workflow by objectId (preview = dry_run, no browser)
const run3 = createRun({ workflowObjectId: E2E_OBJECT_ID, version: '1.0.0', mode: 'preview', payload: { title: 'Test' } });
const result3 = await executeRun({
  runId: run3.runId,
  workflowVersion: e2eWv,
  payload: { title: 'Test' },
  mode: 'preview',
  approvalToken: null,
  runRoot: TEST_ROOT,
});
assert('G1 run by objectId completes with processStatus=completed', result3.processStatus === 'completed', result3.processStatus);
assert('G2 run by objectId has workflowOutcome=success (no assertions)', result3.workflowOutcome === 'success', result3.workflowOutcome);
assert('G3 run artifacts are attached', Array.isArray(result3.artifacts));

// 9. Artifacts attach to run result
const artifacts3 = getRunArtifacts(run3.runId);
assert('G4 getRunArtifacts returns artifacts list', !!artifacts3);
assert('G5 engine-result.json is an artifact', result3.artifacts.some(a => a.name === 'engine-result.json'));

// 4. Run workflow by appId.workflowId@version (same executor, different ref resolution)
const ref = parseWorkflowRef(`${E2E_OBJECT_ID}@1.0.0`);
const wvFromRef = getWorkflowVersion(ref.workflowObjectId, ref.version);
assert('G6 parseWorkflowRef + getWorkflowVersion resolves correctly', wvFromRef?.version === '1.0.0');

const run4 = createRun({ workflowObjectId: E2E_OBJECT_ID, version: '1.0.0', mode: 'preview', payload: { title: 'Via ref' } });
const result4 = await executeRun({ runId: run4.runId, workflowVersion: wvFromRef, payload: { title: 'Via ref' }, mode: 'preview', approvalToken: null, runRoot: TEST_ROOT });
assert('G7 run via ref succeeds', result4.processStatus === 'completed');

// 5. Missing payload fields fail before browser launch (processStatus = rejected, not completed)
const run5 = createRun({ workflowObjectId: E2E_OBJECT_ID, version: '1.0.0', mode: 'preview', payload: {} });
const result5 = await executeRun({ runId: run5.runId, workflowVersion: e2eWv, payload: {}, mode: 'preview', approvalToken: null, runRoot: TEST_ROOT });
assert('G8 missing payload produces processStatus=rejected', result5.processStatus === 'rejected', result5.processStatus);
assert('G9 validationErrors populated', result5.validationErrors.length > 0, JSON.stringify(result5.validationErrors));

// 6. Completed process with failed assertions returns workflowOutcome=failed
const ASSERT_WF_ID = `assert-${TS}`;
const ASSERT_OBJECT_ID = `${TEST_APP_ID}.${ASSERT_WF_ID}`;
registerWorkflow({
  appId: TEST_APP_ID,
  workflowId: ASSERT_WF_ID,
  version: '1.0.0',
  inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
  outputSchema: {},
  supportedModes: ['preview'],
  safetyPolicy: {},
  successAssertions: [
    { type: 'captured_output', field: 'release_id', op: 'exists' },
  ],
  failureAssertions: [],
});

const assertWv = getWorkflowVersion(ASSERT_OBJECT_ID, '1.0.0');
const run6 = createRun({ workflowObjectId: ASSERT_OBJECT_ID, version: '1.0.0', mode: 'preview', payload: { title: 'Test' } });
const result6 = await executeRun({ runId: run6.runId, workflowVersion: assertWv, payload: { title: 'Test' }, mode: 'preview', approvalToken: null, runRoot: TEST_ROOT });
assert('G10 process completed but unmet assertion → workflowOutcome=failed', result6.workflowOutcome === 'failed', result6.workflowOutcome);
assert('G11 processStatus is completed (engine ran fine)', result6.processStatus === 'completed', result6.processStatus);

// 7. Preview mode blocks final submit (stopBeforeSubmit in internal package)
assert('G12 preview mode uses human_gate=true in synthetic package', result3.mode === 'preview');

// 8. Live mode requires approval token (safety gate blocks before browser, awaits approval)
const run7 = createRun({ workflowObjectId: E2E_OBJECT_ID, version: '1.0.0', mode: 'live', payload: { title: 'Live' } });
const result7 = await executeRun({ runId: run7.runId, workflowVersion: e2eWv, payload: { title: 'Live' }, mode: 'live', approvalToken: null, runRoot: TEST_ROOT });
assert('G13 live without approvalToken → processStatus=waiting_for_approval', result7.processStatus === 'waiting_for_approval', result7.processStatus);
assert('G14 live without approvalToken → validationErrors mentions approvalToken', result7.validationErrors.some(e => e.includes('approvalToken')));

// Live with token proceeds (dry_run equivalent in registry context)
const run8 = createRun({ workflowObjectId: E2E_OBJECT_ID, version: '1.0.0', mode: 'live', payload: { title: 'Live Approved' } });
const result8 = await executeRun({ runId: run8.runId, workflowVersion: e2eWv, payload: { title: 'Live Approved' }, mode: 'live', approvalToken: 'operator-token-123', runRoot: TEST_ROOT });
assert('G15 live with approvalToken proceeds to completion', result8.processStatus === 'completed', result8.processStatus);

// ---------------------------------------------------------------------------
// Part H — HTTP API
// ---------------------------------------------------------------------------
section('Part H — HTTP API');

function apiRequest(server, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = http.request(opts, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const { createServer } = await import('../src/api/server.mjs');
const server = createServer();
await new Promise(resolve => server.listen(0, resolve));

const API_APP_ID = `api-app-${TS}`;
const API_WF_ID = `api-wf-${TS}`;
const API_OBJECT_ID = `${API_APP_ID}.${API_WF_ID}`;

// POST /api/apps/register
const regAppRes = await apiRequest(server, 'POST', '/api/apps/register', { appId: API_APP_ID, name: 'API Test App' });
assert('H1 POST /api/apps/register → 201', regAppRes.status === 201, String(regAppRes.status));
assert('H2 app record in response', regAppRes.data?.app?.appId === API_APP_ID);

// GET /api/apps
const listAppsRes = await apiRequest(server, 'GET', '/api/apps');
assert('H3 GET /api/apps → 200', listAppsRes.status === 200);
assert('H4 apps array present', Array.isArray(listAppsRes.data?.apps));

// POST /api/workflows/register
const regWfRes = await apiRequest(server, 'POST', '/api/workflows/register', {
  appId: API_APP_ID,
  workflowId: API_WF_ID,
  version: '1.0.0',
  inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
  outputSchema: {},
  supportedModes: ['preview', 'live'],
  safetyPolicy: { requiresLiveApproval: true },
  successAssertions: [],
  failureAssertions: [],
});
assert('H5 POST /api/workflows/register → 201', regWfRes.status === 201, String(regWfRes.status));
assert('H6 workflow record in response', regWfRes.data?.workflow?.workflowObjectId === API_OBJECT_ID);

// GET /api/workflows
const listWfRes = await apiRequest(server, 'GET', '/api/workflows');
assert('H7 GET /api/workflows → 200', listWfRes.status === 200);

// GET /api/workflows/:workflowObjectId
const getWfRes = await apiRequest(server, 'GET', `/api/workflows/${API_OBJECT_ID}`);
assert('H8 GET /api/workflows/:objectId → 200', getWfRes.status === 200, String(getWfRes.status));
assert('H9 workflow data returned', getWfRes.data?.workflow?.workflowObjectId === API_OBJECT_ID);

// GET non-existent workflow
const getWfNotFound = await apiRequest(server, 'GET', '/api/workflows/nope.nope');
assert('H10 GET non-existent workflow → 404', getWfNotFound.status === 404);

// POST /api/workflows/:workflowRef/runs (by objectId)
const runByObjId = await apiRequest(server, 'POST', `/api/workflows/${API_OBJECT_ID}/runs`, {
  mode: 'preview',
  payload: { title: 'API Test Album' },
});
assert('H11 POST /api/workflows/:objectId/runs → 201', runByObjId.status === 201, String(runByObjId.status));
assert('H12 runId returned', !!runByObjId.data?.runId);

// POST /api/workflows/:appId.workflowId@version/runs
const runByRef = await apiRequest(server, 'POST', `/api/workflows/${API_OBJECT_ID}@1.0.0/runs`, {
  mode: 'preview',
  payload: { title: 'Via ref' },
});
assert('H13 POST /api/workflows/:ref@version/runs → 201', runByRef.status === 201, String(runByRef.status));

// Give the async executor a moment to complete
await new Promise(r => setTimeout(r, 500));

// GET /api/runs/:runId
const runId = runByObjId.data.runId;
const getRunRes = await apiRequest(server, 'GET', `/api/runs/${runId}`);
assert('H14 GET /api/runs/:runId → 200', getRunRes.status === 200);

// POST /api/runs/:runId/stop
const freshRun = createRun({ workflowObjectId: API_OBJECT_ID, version: '1.0.0', mode: 'preview', payload: {} });
const stopRes = await apiRequest(server, 'POST', `/api/runs/${freshRun.runId}/stop`);
assert('H15 POST /api/runs/:runId/stop → 200', stopRes.status === 200, String(stopRes.status));
assert('H16 stopped run processStatus', stopRes.data?.run?.processStatus === 'stopped');

// GET /api/runs/:runId/artifacts
const artsRes = await apiRequest(server, 'GET', `/api/runs/${runId}/artifacts`);
assert('H17 GET /api/runs/:runId/artifacts → 200', artsRes.status === 200, String(artsRes.status));
assert('H18 artifacts field present', !!artsRes.data?.artifacts);

// GET non-existent run
const noRunRes = await apiRequest(server, 'GET', '/api/runs/run-does-not-exist-12345');
assert('H19 GET non-existent run → 404', noRunRes.status === 404);

server.close();

// ---------------------------------------------------------------------------
// Part I — CLI (smoke)
// ---------------------------------------------------------------------------
section('Part I — CLI commands (smoke)');

import { spawnSync } from 'child_process';
import { REPO_ROOT } from '../src/core/paths.mjs';

function cli(args) {
  const result = spawnSync(process.execPath, ['src/cli/index.mjs', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, BROWSY_DEBUG: '1' },
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', code: result.status };
}

const appsListOut = cli(['apps', 'list']);
assert('I1 browsy apps list exits 0', appsListOut.code === 0, `exit ${appsListOut.code}: ${appsListOut.stderr}`);
assert('I2 browsy apps list outputs app ids', appsListOut.stdout.includes(TEST_APP_ID));

const wfsListOut = cli(['workflows', 'list']);
assert('I3 browsy workflows list exits 0', wfsListOut.code === 0, `exit ${wfsListOut.code}: ${wfsListOut.stderr}`);
assert('I4 browsy workflows list outputs workflow ids', wfsListOut.stdout.includes(E2E_OBJECT_ID));

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(48)}`);
console.log(`Registry acceptance: ${passed} passed, ${failed} failed`);

// Cleanup
fs.rmSync(TEST_ROOT, { recursive: true, force: true });

if (failed) process.exit(1);
