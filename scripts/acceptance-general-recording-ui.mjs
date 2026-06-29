#!/usr/bin/env node
// Acceptance: general Browsy recording creation UI.
// Verifies a user can start from /recordings/new without another app creating
// the recording session first.

import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

import { createServer } from '../src/api/server.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const PORT = 15001 + Math.floor(Math.random() * 1000);
const CONTENT_PORT = PORT + 500;
const BASE = `http://localhost:${PORT}`;
const CONTENT = `http://localhost:${CONTENT_PORT}`;
const TS = Date.now();
const APP_ID = `general-app-${TS}`;
const WORKFLOW_ID = `general-flow-${TS}`;

let passed = 0;
let failed = 0;
let server = null;
let contentServer = null;
let browser = null;
let recordingSessionId = null;
const failures = [];

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

function startContentServer() {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>General Target</h1></body></html>');
  });
  return new Promise(resolve => s.listen(CONTENT_PORT, () => resolve(s)));
}

try {
  server = createServer({ port: PORT });
  await new Promise(resolve => server.listen(PORT, resolve));
  contentServer = await startContentServer();

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${BASE}/recordings/new`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-testid="new-recording-page"]');

  assert('/recordings/new renders', (await page.textContent('body')).includes('Record a general automation'));
  assert('new page has create button', await page.locator('[data-testid="create-recording-button"]').count() === 1);
  assert('new page has tabs table', await page.locator('[data-testid="tabs-table"] tbody tr').count() === 1);

  await page.fill('[data-testid="app-id"]', APP_ID);
  await page.fill('[data-testid="app-name"]', 'General App');
  await page.fill('[data-testid="workflow-id"]', WORKFLOW_ID);
  await page.fill('[data-testid="workflow-name"]', 'General Flow');

  const firstRow = page.locator('[data-testid="tabs-table"] tbody tr').first();
  await firstRow.locator('[data-field="id"]').fill('target');
  await firstRow.locator('[data-field="title"]').fill('Target App');
  await firstRow.locator('[data-field="url"]').fill(`${CONTENT}/target/{recordId}`);
  await firstRow.locator('[data-field="siteId"]').fill('target-app');

  await page.click('[data-testid="add-param-button"]');
  await page.locator('[data-param-key]').last().fill('recordId');
  await page.locator('[data-param-value]').last().fill('REC-123');

  await page.click('[data-testid="create-recording-button"]');
  await page.waitForURL(/\/recordings\/rec_/);
  recordingSessionId = page.url().split('/recordings/')[1];

  assert('create redirects to recording setup page', page.url().startsWith(`${BASE}/recordings/rec_`), page.url());
  await page.waitForSelector('[data-testid="recording-summary"]');
  assert('created setup page is setup-only', (await page.textContent('body')).includes('URL parameters'));
  assert('created page has Start Recording', await page.locator('[data-testid="start-recording-button"]').count() === 1);
  assert('URL parameter carried into setup page', (await page.textContent('[data-testid="url-params"]')).includes('recordId'));
  assert('URL template resolves on setup page', (await page.textContent('[data-testid="tabs-table"]')).includes(`${CONTENT}/target/REC-123`));

  const sessionPath = path.join(REPO_ROOT, 'output', 'recordings', recordingSessionId, 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert('session stored general app id', session.appId === APP_ID, session.appId);
  assert('session stored general workflow id', session.workflowId === WORKFLOW_ID, session.workflowId);
  assert('session stored starting tab', session.recordingSetup?.tabs?.[0]?.id === 'target', JSON.stringify(session.recordingSetup?.tabs));
} finally {
  if (browser) await browser.close();
  if (contentServer) await new Promise(resolve => contentServer.close(resolve));
  if (server) await new Promise(resolve => server.close(resolve));
  if (recordingSessionId) fs.rmSync(path.join(REPO_ROOT, 'output', 'recordings', recordingSessionId), { recursive: true, force: true });
}

console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
