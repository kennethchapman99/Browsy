#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from '../src/api/generic-server.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const PORT = 15001 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const TS = Date.now();
const APP_ID = `real-recorder-${TS}`;
const WORKFLOW_ID = `real-playwright-${TS}`;
let server = null;
let recordingSessionId = null;
let passed = 0;
let failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) { console.log(`PASS ${label}`); passed++; }
  else { console.error(`FAIL ${label}${detail ? ': ' + detail : ''}`); failed++; failures.push(label); }
}
async function api(method, route, body = null) {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}
async function waitForEvents() {
  const p = path.join(REPO_ROOT, 'output', 'recordings', recordingSessionId, 'events.json');
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (fs.existsSync(p)) {
      const events = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(events) && events.length >= 2) return events;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return [];
}

try {
  server = createServer({ port: PORT });
  await new Promise(resolve => server.listen(PORT, resolve));
  const created = await api('POST', '/api/recordings/start', {
    appId: APP_ID,
    appName: 'Real Recorder Smoke App',
    workflowId: WORKFLOW_ID,
    workflowName: 'Real Playwright Smoke',
    recordingSetup: { tabs: [{ id: 'blank', title: 'Blank Page', url: 'about:blank' }] },
    payloadSchema: { type: 'object', properties: {}, required: [] },
    expectedOutputs: [{ id: 'confirmationId', label: 'Confirmation ID' }],
  });
  assert('session created', created.res.status === 201 && created.json.ok === true, JSON.stringify(created.json));
  recordingSessionId = created.json.recordingSessionId;
  const started = await api('POST', `/api/recordings/${recordingSessionId}/start`, { headless: true });
  assert('start returns ok', started.res.ok && started.json.ok === true, JSON.stringify(started.json));
  assert('launch mode is known', ['real_playwright_recorder', 'manual_playwright_recorder'].includes(started.json.launch?.mode), started.json.launch?.mode);
  if (started.json.launch?.mode === 'real_playwright_recorder') {
    const events = await waitForEvents();
    assert('events were persisted', events.length >= 2, JSON.stringify(events));
    assert('page_opened was captured', events.some(e => e.type === 'page_opened'));
    assert('page_seen or navigation was captured', events.some(e => e.type === 'page_seen' || e.type === 'page_navigated'));
  } else {
    assert('fallback includes launchError', !!started.json.launch?.launchError, JSON.stringify(started.json.launch));
  }
  const stopped = await api('POST', `/api/recordings/${recordingSessionId}/stop`, {});
  assert('stop returns ok', stopped.res.ok && stopped.json.ok === true, JSON.stringify(stopped.json));
  assert('observation written', fs.existsSync(path.join(REPO_ROOT, 'output', 'recordings', recordingSessionId, 'observation.json')));
} finally {
  if (recordingSessionId) fs.rmSync(path.join(REPO_ROOT, 'output', 'recordings', recordingSessionId), { recursive: true, force: true });
  if (server) await new Promise(resolve => server.close(resolve));
}
console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('Failures:'); for (const f of failures) console.error('  - ' + f); process.exit(1); }
