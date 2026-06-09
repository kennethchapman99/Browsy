#!/usr/bin/env node
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');

let passed = 0;
let failed = 0;
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

function randomPort() {
  return 22000 + Math.floor(Math.random() * 20000);
}

function waitForOutput(child, pattern, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}; output:\n${output}`)), timeoutMs);
    const onData = chunk => {
      output += chunk.toString();
      if (pattern.test(output)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolve(output);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`process exited with ${code} before ${pattern}; output:\n${output}`));
    });
  });
}

function waitForExit(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for process exit')), timeoutMs);
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function killChild(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
}

async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json();
  return { res, body };
}

async function putJson(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { res, body: json };
}

async function withDummyServer(port, fn) {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not Browsy' }));
  });
  await new Promise(resolve => server.listen(port, resolve));
  try {
    return await fn();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

let browser = null;
let launcher = null;

try {
  const pancakePort = randomPort();
  const browsyPort = randomPort();
  const albumId = `ALBUM_LAUNCH_${Date.now()}`;

  launcher = spawn(process.execPath, ['bin/pancakerobot'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PANCAKE_ROBOT_PORT: String(pancakePort),
      BROWSY_PORT: String(browsyPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForOutput(launcher, /Pancake Robot listening/);
  const health = await fetchJson(`http://localhost:${browsyPort}/api/health`);
  assert('launcher starts Browsy health endpoint', health.res.status === 200 && health.body.ok === true, JSON.stringify(health.body));
  assert('health reports exact command', health.body.command === `BROWSY_PORT=${browsyPort} npm run api`, health.body.command);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${pancakePort}/releases/album/${albumId}`);
  await page.waitForSelector('#record');
  await page.click('#record');
  await page.waitForSelector('#status.ok a.button', { timeout: 10000 });
  const wizardUrl = await page.getAttribute('#status.ok a.button', 'href');
  assert('Pancake page creates Browsy recording session through browser CORS', Boolean(wizardUrl), String(wizardUrl));

  const sessionId = wizardUrl?.split('/recordings/')[1];
  const session = await fetchJson(`http://localhost:${browsyPort}/api/recordings/${sessionId}`);
  const recording = session.body.recording;
  assert('recording session exists', session.res.status === 200 && session.body.ok === true, JSON.stringify(session.body));
  assert('recording source URL is resolved album URL', recording.recordingSetup.tabs[0].url === `http://localhost:${pancakePort}/releases/album/${albumId}`, recording.recordingSetup.tabs[0].url);
  assert('recording callback URL is resolved album ingest URL', recording.callbackUrl === `http://localhost:${pancakePort}/releases/album/${albumId}/magic-release/ingest-result`, recording.callbackUrl);
  assert('recording callback URL template is preserved for editing', recording.callbackUrlTemplate === `http://localhost:${pancakePort}/releases/album/{album.id}/magic-release/ingest-result`, recording.callbackUrlTemplate);
  assert('recording keeps DistroKid auth profile', recording.recordingSetup.authProfileId === 'distrokid', recording.recordingSetup.authProfileId);
  assert('writebacks are optional for pre-submit workflow', Array.isArray(recording.writebackTargets) && recording.writebackTargets.length === 0, JSON.stringify(recording.writebackTargets));

  const editedCallbackTemplate = `http://localhost:${pancakePort}/releases/album/{album.id}/magic-release/ingest-result`;
  const saved = await putJson(`http://localhost:${browsyPort}/api/recordings/${sessionId}/setup`, {
    recordingSetup: recording.recordingSetup,
    callbackUrl: editedCallbackTemplate,
    fieldContractIntent: recording.fieldContractIntent,
    completionPolicy: recording.completionPolicy,
    writebackTargets: recording.writebackTargets,
  });
  const savedRecording = saved.body.recording;
  assert('save setup keeps edited callback URL template', saved.res.status === 200 && savedRecording.callbackUrlTemplate === editedCallbackTemplate, JSON.stringify(saved.body));
  assert('save setup keeps resolved callback URL for execution', savedRecording.callbackUrl === `http://localhost:${pancakePort}/releases/album/${albumId}/magic-release/ingest-result`, savedRecording.callbackUrl);

  await browser.close();
  browser = null;
  killChild(launcher);
  launcher = null;

  const blockedPort = randomPort();
  await withDummyServer(blockedPort, async () => {
    const blocked = spawn(process.execPath, ['bin/pancakerobot'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PANCAKE_ROBOT_PORT: String(randomPort()),
        BROWSY_PORT: String(blockedPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    blocked.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const code = await waitForExit(blocked);
    assert('launcher fails when Browsy port is occupied by non-Browsy service', code !== 0, String(code));
    assert('launcher reports expected port', stderr.includes(`Expected port: ${blockedPort}`), stderr);
    assert('launcher reports exact command', stderr.includes(`Command: BROWSY_PORT=${blockedPort} npm run api`), stderr);
  });
} finally {
  if (browser) await browser.close().catch(() => {});
  if (launcher) killChild(launcher);
}

console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
