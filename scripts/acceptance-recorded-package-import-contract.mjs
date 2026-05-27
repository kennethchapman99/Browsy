#!/usr/bin/env node
// Acceptance: a wizard-recorded workflow package imports into the registry
// contract even when it has no manifest.schema.json.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateWorkflowPackageDir, importWorkflowPackage } from '../src/registry/package-importer.mjs';
import { getWorkflowVersion } from '../src/registry/workflow-registry.mjs';
import { buildWorkflowContract } from '../src/registry/run-result.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`PASS ${label}`);
    passed++;
  } else {
    console.error(`FAIL ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

const packagePath = path.join(REPO_ROOT, 'workflows', 'observed-workflow');
const validation = validateWorkflowPackageDir(packagePath);

assert('recorded package validates without manifest.schema.json', validation.ok, JSON.stringify(validation.errors || []));
assert('metadata derives tabs from workflow targets', (validation.metadata?.tabs || []).length >= 4);
assert('metadata derives repeat groups from recorded package/config', (validation.metadata?.repeatGroups || []).length >= 2);
assert('metadata derives payload bindings from canonical globals', validation.metadata?.payloadBindings?.albumTitle === 'globals.albumTitle');
assert('metadata derives example payload from canonical globals', validation.metadata?.examplePayload?.albumTitle === 'C');

const ts = Date.now();
const appId = `recorded-contract-${ts}`;
const workflowId = `observed-workflow-${ts}`;
const imported = importWorkflowPackage({
  packagePath,
  appId,
  workflowId,
  version: '1.0.0',
  autoRegisterApp: true,
  appName: 'Recorded Contract Test App',
});

assert('importWorkflowPackage succeeds for recorded package', imported.ok, JSON.stringify(imported.errors || []));
assert('import result includes workflowRef', imported.workflowRef === `${appId}.${workflowId}@1.0.0`, imported.workflowRef);
assert('import result includes tabs', (imported.tabs || []).length >= 4);
assert('import result includes payload bindings', imported.payloadBindings?.brand === 'globals.brand');
assert('import result includes repeat groups', (imported.repeatGroups || []).length >= 2);

const wv = getWorkflowVersion(`${appId}.${workflowId}`, '1.0.0');
const contract = buildWorkflowContract(wv, { baseUrl: 'http://localhost:3001' });

assert('contract exposes canonical run endpoint', contract.runEndpoint === `POST http://localhost:3001/api/apps/${appId}/workflows/${workflowId}/runs`);
assert('contract exposes derived tabs', contract.tabs.length >= 4);
assert('contract exposes derived payload bindings', contract.payloadBindings.albumTitle === 'globals.albumTitle');
assert('contract exposes derived repeat groups', contract.repeatGroups.length >= 2);
assert('contract example body uses recorded caller shape', contract.exampleHTTPBody.payload.albumTitle === 'C');
assert('contract required fields include inferred globals', contract.requiredPayloadFields.includes('brand') && contract.requiredPayloadFields.includes('albumTitle'));

console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
