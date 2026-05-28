#!/usr/bin/env node
// Acceptance suite: workflow package import + real registry execution
//
// Checks:
//   1. Import an existing fixture workflow package
//   2. Reject an invalid package with clear errors
//   3. List workflows shows the imported workflow
//   4. Running an imported workflow creates a run
//   5. Bad payload fails validation before browser execution
//   6. Valid payload reaches the real execution adapter
//   7. Run status can be fetched
//   8. Run artifacts can be fetched
//   9. workflow contract <workflowRef> outputs usable client integration details
//
// Uses workflows/local-form-demo/ as the test fixture (has workflow.json,
// manifest.schema.json, and field-map.local.json — no browser required in dry_run).

import fs from 'fs';
import os from 'os';
import pathModule from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

import { validateWorkflowPackageDir, importWorkflowPackage } from '../src/registry/package-importer.mjs';
import { registerApp } from '../src/registry/app-registry.mjs';
import { registerWorkflow, listWorkflows, getWorkflowVersion } from '../src/registry/workflow-registry.mjs';
import { createRun, getRun, getRunArtifacts } from '../src/registry/run-registry.mjs';
import { executeRun } from '../src/registry/run-executor.mjs';
import { exists, readJson } from '../src/core/paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = pathModule.resolve(pathModule.dirname(__filename), '..');
const FIXTURE_PKG = pathModule.join(REPO_ROOT, 'workflows', 'local-form-demo');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

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

function section(title) { console.log(`\n── ${title} ──`); }

const TEST_ROOT = fs.mkdtempSync(pathModule.join(os.tmpdir(), 'browsy-pkg-import-'));
const TS = Date.now();
const TEST_APP_ID = `import-test-${TS}`;
const TEST_WF_ID = `form-demo-${TS}`;
const WOBJ = `${TEST_APP_ID}.${TEST_WF_ID}`;

// Pre-register app for all checks
registerApp({ appId: TEST_APP_ID, name: 'Import Test App' });

// ---------------------------------------------------------------------------
// Check 1 — Import an existing fixture workflow package
// ---------------------------------------------------------------------------
section('Check 1 — Import an existing fixture workflow package');
{
  const result = importWorkflowPackage({
    packagePath: FIXTURE_PKG,
    appId: TEST_APP_ID,
    workflowId: TEST_WF_ID,
    version: '1.0.0',
  });

  assert('import returns ok', result.ok === true, (result.errors || []).join('; '));
  assert('import returns workflowRef', typeof result.workflowRef === 'string' && result.workflowRef.includes('@'));
  assert('import returns packagePath', result.packagePath === FIXTURE_PKG);
  assert('import returns packageWorkflowId', result.packageWorkflowId === 'local-form-demo');
  assert('import returns requiredInputs array', Array.isArray(result.requiredInputs));
  assert('import returns supportedModes', Array.isArray(result.supportedModes) && result.supportedModes.length > 0);
}

// ---------------------------------------------------------------------------
// Check 2 — Reject an invalid package with clear errors
// ---------------------------------------------------------------------------
section('Check 2 — Reject an invalid package with clear errors');
{
  // Non-existent path
  const r1 = validateWorkflowPackageDir('/does/not/exist/xyz123');
  assert('missing path → ok=false', r1.ok === false);
  assert('missing path has error', r1.errors.some(e => e.includes('not found')));

  // Empty directory (missing required files)
  const emptyDir = fs.mkdtempSync(pathModule.join(os.tmpdir(), 'browsy-empty-'));
  const r2 = validateWorkflowPackageDir(emptyDir);
  assert('empty dir → ok=false', r2.ok === false);
  assert('reports missing workflow.json', r2.errors.some(e => e.includes('workflow.json')));
  assert('reports missing manifest.schema.json', r2.errors.some(e => e.includes('manifest.schema.json')));
  fs.rmSync(emptyDir, { recursive: true });

  // workflow.json missing id field
  const noIdDir = fs.mkdtempSync(pathModule.join(os.tmpdir(), 'browsy-noid-'));
  fs.writeFileSync(pathModule.join(noIdDir, 'workflow.json'), JSON.stringify({ description: 'no id here' }));
  fs.writeFileSync(pathModule.join(noIdDir, 'manifest.schema.json'), JSON.stringify({ type: 'object' }));
  const r3 = validateWorkflowPackageDir(noIdDir);
  assert('missing id field → ok=false', r3.ok === false);
  assert('reports missing id', r3.errors.some(e => e.includes('"id"')));
  fs.rmSync(noIdDir, { recursive: true });

  // Unregistered app without autoRegisterApp
  const r4 = importWorkflowPackage({
    packagePath: FIXTURE_PKG,
    appId: 'no-such-app-xyz',
    workflowId: 'test',
    version: '1.0.0',
  });
  assert('unregistered app → ok=false', r4.ok === false);
  assert('error mentions app id', r4.errors.some(e => e.includes('no-such-app-xyz')));

  // Invalid appId format via autoRegisterApp
  const r5 = importWorkflowPackage({
    packagePath: FIXTURE_PKG,
    appId: 'Bad_AppID!',
    workflowId: 'test',
    version: '1.0.0',
    autoRegisterApp: true,
    appName: 'Bad App',
  });
  assert('invalid appId format → ok=false', r5.ok === false);
}

// ---------------------------------------------------------------------------
// Check 3 — List workflows shows the imported workflow
// ---------------------------------------------------------------------------
section('Check 3 — List workflows shows the imported workflow');
{
  const wfs = listWorkflows(TEST_APP_ID);
  const found = wfs.find(w => w.workflowId === TEST_WF_ID);
  assert('imported workflow in listWorkflows', !!found, `looking for workflowId=${TEST_WF_ID}`);
  assert('latestVersion is 1.0.0', found?.latestVersion === '1.0.0');

  const wv = getWorkflowVersion(WOBJ, '1.0.0');
  assert('getWorkflowVersion resolves imported version', !!wv);
  assert('version record stores packagePath', wv?.packagePath === FIXTURE_PKG);
  assert('version record stores packageWorkflowId', wv?.packageWorkflowId === 'local-form-demo');
}

// Shared workflow version for subsequent checks
const wv = getWorkflowVersion(WOBJ, '1.0.0');
const testPayload = { id: 'ITEM_123' };

// ---------------------------------------------------------------------------
// Check 4 — Running an imported workflow creates a run record
// ---------------------------------------------------------------------------
section('Check 4 — Running an imported workflow creates a run');
{
  const run = createRun({ workflowObjectId: WOBJ, version: '1.0.0', mode: 'preview', payload: testPayload });
  assert('createRun returns runId', typeof run.runId === 'string' && run.runId.length > 0);
  assert('run starts as running', run.processStatus === 'running');
  assert('run stores workflowObjectId', run.workflowObjectId === WOBJ);
}

// ---------------------------------------------------------------------------
// Check 5 — Bad payload fails validation before browser execution
// ---------------------------------------------------------------------------
section('Check 5 — Bad payload fails before browser execution');
{
  // Register a version with strict required fields
  const STRICT_WF_ID = `strict-${TS}`;
  registerWorkflow({
    appId: TEST_APP_ID,
    workflowId: STRICT_WF_ID,
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      required: ['title', 'artist'],
      properties: {
        title: { type: 'string', minLength: 1 },
        artist: { type: 'string', minLength: 1 },
      },
    },
    packagePath: FIXTURE_PKG,
    packageWorkflowId: 'local-form-demo',
    supportedModes: ['preview'],
  });

  const strictWv = getWorkflowVersion(`${TEST_APP_ID}.${STRICT_WF_ID}`, '1.0.0');
  const run5 = createRun({ workflowObjectId: `${TEST_APP_ID}.${STRICT_WF_ID}`, version: '1.0.0', mode: 'preview', payload: {} });
  const result5 = await executeRun({
    runId: run5.runId,
    workflowVersion: strictWv,
    payload: {},
    mode: 'preview',
    approvalToken: null,
    runRoot: TEST_ROOT,
  });

  assert('empty payload → processStatus=rejected', result5.processStatus === 'rejected', result5.processStatus);
  assert('validationErrors populated', result5.validationErrors?.length > 0);
  assert('error names missing field "title"', result5.validationErrors.some(e => e.includes('title')));
  assert('no run-time artifacts created (rejected before engine)', result5.artifacts?.length === 0 || result5.processStatus === 'rejected');
}

// ---------------------------------------------------------------------------
// Check 6 — Valid payload reaches the real execution adapter
// ---------------------------------------------------------------------------
section('Check 6 — Valid payload reaches real execution adapter');
{
  const run6 = createRun({ workflowObjectId: WOBJ, version: '1.0.0', mode: 'dry_run', payload: testPayload });
  const result6 = await executeRun({
    runId: run6.runId,
    workflowVersion: wv,
    payload: testPayload,
    mode: 'dry_run',
    approvalToken: null,
    runRoot: TEST_ROOT,
  });

  // dry_run drives the materialized-package adapter (no real browser launch).
  assert('valid payload → processStatus=completed', result6.processStatus === 'completed', result6.processStatus);
  assert('engine-result.json artifact attached', result6.artifacts?.some(a => a.name === 'engine-result.json'));

  // Verify the engine-result reflects the imported package driving the adapter
  // (materialized dry-run content), proving the adapter is wired end-to-end.
  const engineFile = pathModule.join(TEST_ROOT, 'runs', run6.runId, 'engine-result.json');
  assert('engine-result.json written to runRoot', exists(engineFile), engineFile);
  const engineResult = readJson(engineFile);
  assert('adapter produced materialized dry-run result',
    engineResult.source_system === 'registry_dry_run',
    `got: ${engineResult.source_system}`
  );
  assert('adapter used the imported package steps',
    engineResult.materializedPackage?.stepCount === wv.recordedSteps.length,
    `got: ${engineResult.materializedPackage?.stepCount}`
  );
}

// ---------------------------------------------------------------------------
// Check 7 — Run status can be fetched
// ---------------------------------------------------------------------------
section('Check 7 — Run status can be fetched');
{
  const run7 = createRun({ workflowObjectId: WOBJ, version: '1.0.0', mode: 'dry_run', payload: testPayload });
  await executeRun({
    runId: run7.runId,
    workflowVersion: wv,
    payload: testPayload,
    mode: 'dry_run',
    approvalToken: null,
    runRoot: TEST_ROOT,
  });

  const fetched = getRun(run7.runId);
  assert('getRun returns run record', !!fetched);
  assert('run has processStatus', typeof fetched?.processStatus === 'string');
  assert('run has workflowOutcome', fetched?.workflowOutcome !== undefined);
  assert('run has completedAt', typeof fetched?.completedAt === 'string');
}

// ---------------------------------------------------------------------------
// Check 8 — Run artifacts can be fetched
// ---------------------------------------------------------------------------
section('Check 8 — Run artifacts can be fetched');
{
  const run8 = createRun({ workflowObjectId: WOBJ, version: '1.0.0', mode: 'dry_run', payload: testPayload });
  await executeRun({
    runId: run8.runId,
    workflowVersion: wv,
    payload: testPayload,
    mode: 'dry_run',
    approvalToken: null,
    runRoot: TEST_ROOT,
  });

  const arts = getRunArtifacts(run8.runId);
  assert('getRunArtifacts returns object', !!arts);
  assert('artifacts array present', Array.isArray(arts?.artifacts));
  assert('engine-result.json in artifacts', arts?.artifacts.some(a => a.name === 'engine-result.json'));
}

// ---------------------------------------------------------------------------
// Check 9 — workflow contract <workflowRef> outputs usable client integration
// ---------------------------------------------------------------------------
section('Check 9 — workflow contract output is usable');
{
  const cli = spawnSync(process.execPath, [
    pathModule.join(REPO_ROOT, 'src/cli/index.mjs'),
    'workflow', 'contract',
    `${WOBJ}@1.0.0`,
  ], { encoding: 'utf8' });

  let contract;
  try { contract = JSON.parse(cli.stdout); } catch (e) {
    contract = null;
  }

  assert('contract command exits 0', cli.status === 0, `exit=${cli.status} stderr=${cli.stderr?.trim()}`);
  assert('contract is valid JSON', !!contract, cli.stdout?.slice(0, 200));
  assert('contract.workflowRef present', typeof contract?.workflowRef === 'string');
  assert('contract.appId matches', contract?.appId === TEST_APP_ID);
  assert('contract.workflowId matches', contract?.workflowId === TEST_WF_ID);
  assert('contract.requiredPayloadFields is array', Array.isArray(contract?.requiredPayloadFields));
  assert('contract.optionalPayloadFields is array', Array.isArray(contract?.optionalPayloadFields));
  assert('contract.supportedModes is array', Array.isArray(contract?.supportedModes));
  assert('contract.exampleCLIRun present', typeof contract?.exampleCLIRun === 'string' && contract.exampleCLIRun.includes('browsy'));
  assert('contract.exampleHTTPCall present', typeof contract?.exampleHTTPCall === 'string' && contract.exampleHTTPCall.includes('/api/'));
  assert('contract.exampleHTTPBody present', contract?.exampleHTTPBody && typeof contract.exampleHTTPBody === 'object');
  assert('contract.runStatusEndpoint present', typeof contract?.runStatusEndpoint === 'string');
  assert('contract.artifactEndpoint present', typeof contract?.artifactEndpoint === 'string');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('');
console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:');
  for (const f of failures) console.error('  - ' + f);
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
console.log('All checks passed.');
try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
