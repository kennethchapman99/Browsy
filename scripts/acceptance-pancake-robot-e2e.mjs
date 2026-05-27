#!/usr/bin/env node
// E2E acceptance test: Pancake Robot call contract.
//
// Proves the full lifecycle a caller (e.g. Pancake Robot) will execute:
//   1. Register an app            → POST /api/apps/register
//   2. Import workflow package     → POST /api/apps/:appId/workflows/import
//   3. Fetch the contract          → CLI: browsy workflow contract <ref>
//   4. Trigger a run               → POST /api/apps/:appId/workflows/:workflowId/runs  (canonical)
//   5. Fetch run status            → GET /api/runs/:runId
//
// Uses workflows/local-form-demo as the fixture (no real browser needed).

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const FIXTURE_PKG = path.join(REPO_ROOT, 'workflows', 'local-form-demo');

// ---------------------------------------------------------------------------
// Harness
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

function section(title) { console.log(`\n── ${title} ──`); }

// Isolated registry so this test never pollutes the real registry.
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'browsy-pr-e2e-'));
process.env.BROWSY_REGISTRY_ROOT = TEST_ROOT;

const TS = Date.now();
const APP_ID = `pancake-test-${TS}`;
const WF_ID = `upload-demo-${TS}`;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function apiRequest(server, method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const port = addr.port;
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = http.request({ hostname: '127.0.0.1', port, method, path: urlPath, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Start a fresh server (imports server module after env var is set).
const { createServer } = await import('../src/api/server.mjs');
const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));

// ---------------------------------------------------------------------------
// Step 1 — Register app
// ---------------------------------------------------------------------------
section('Step 1 — Register app');
{
  const r = await apiRequest(server, 'POST', '/api/apps/register', {
    appId: APP_ID,
    name: 'Pancake Test App',
  });
  assert('POST /api/apps/register → 201', r.status === 201, String(r.status));
  assert('response has appId', r.body?.app?.appId === APP_ID);
}

// ---------------------------------------------------------------------------
// Step 2 — Import workflow package
// ---------------------------------------------------------------------------
section('Step 2 — Import workflow package');
let workflowRef = null;
{
  const r = await apiRequest(server, 'POST', `/api/apps/${APP_ID}/workflows/import`, {
    packagePath: FIXTURE_PKG,
    workflowId: WF_ID,
    version: '1.0.0',
  });
  assert('POST /api/apps/:appId/workflows/import → 201', r.status === 201, String(r.status));
  assert('import ok', r.body?.imported?.ok === true, JSON.stringify(r.body));
  workflowRef = r.body?.imported?.workflowRef;
  assert('workflowRef returned', typeof workflowRef === 'string' && workflowRef.includes('@'));
}

// ---------------------------------------------------------------------------
// Step 3 — Fetch contract via CLI
// ---------------------------------------------------------------------------
section('Step 3 — Fetch contract via CLI (browsy workflow contract)');
{
  const wfObjectId = `${APP_ID}.${WF_ID}`;
  const result = spawnSync(
    process.execPath,
    ['src/cli/index.mjs', 'workflow', 'contract', wfObjectId, '--format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } }
  );
  let contract = null;
  try { contract = JSON.parse(result.stdout); } catch { /* handled below */ }
  assert('CLI exits 0', result.status === 0, result.stderr?.slice(0, 200));
  assert('contract has workflowRef', typeof contract?.workflowRef === 'string');
  assert('contract has runEndpoint', typeof contract?.runEndpoint === 'string');
  assert('contract has requiredPayloadFields', Array.isArray(contract?.requiredPayloadFields));
}

// ---------------------------------------------------------------------------
// Step 4 — Trigger run via canonical endpoint
// ---------------------------------------------------------------------------
section('Step 4 — Trigger run via POST /api/apps/:appId/workflows/:workflowId/runs');
let runId = null;
{
  const r = await apiRequest(
    server,
    'POST',
    `/api/apps/${APP_ID}/workflows/${WF_ID}/runs`,
    { mode: 'preview', payload: {} }
  );
  assert('POST /api/apps/:appId/workflows/:workflowId/runs → 201', r.status === 201, String(r.status));
  assert('response has runId', typeof r.body?.runId === 'string');
  assert('run.mode is preview', r.body?.run?.mode === 'preview');
  runId = r.body?.runId;
}

// Step 4b — wrong appId/workflowId → 404
{
  const r = await apiRequest(server, 'POST', `/api/apps/${APP_ID}/workflows/no-such-wf/runs`, {});
  assert('unknown workflowId → 404', r.status === 404, String(r.status));
}

// ---------------------------------------------------------------------------
// Step 5 — Fetch run status
// ---------------------------------------------------------------------------
section('Step 5 — Fetch run status via GET /api/runs/:runId');
{
  // Allow the async execution to complete.
  await new Promise(r => setTimeout(r, 500));

  const r = await apiRequest(server, 'GET', `/api/runs/${runId}`);
  assert('GET /api/runs/:runId → 200', r.status === 200, String(r.status));
  assert('run.runId matches', r.body?.run?.runId === runId);
  const ps = r.body?.run?.processStatus;
  const TERMINAL = ['completed', 'failed', 'rejected', 'running'];
  assert(`run.processStatus is a known status (${ps})`, TERMINAL.includes(ps));
}

// Step 5b — unknown runId → 404
{
  const r = await apiRequest(server, 'GET', '/api/runs/run-does-not-exist');
  assert('unknown runId → 404', r.status === 404, String(r.status));
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
server.close();
fs.rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(`\n${'─'.repeat(60)}`);
console.log(`Pancake Robot E2E: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
