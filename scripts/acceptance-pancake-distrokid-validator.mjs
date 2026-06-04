#!/usr/bin/env node
// Acceptance: manual Pancake/DistroKid validator helper against a local auth fixture.

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createServer } from '../src/api/generic-server.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const API_PORT = 19000 + Math.floor(Math.random() * 1000);
const CONTENT_PORT = 20000 + Math.floor(Math.random() * 1000);
const API = `http://localhost:${API_PORT}`;
const CONTENT = `http://localhost:${CONTENT_PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'browsy-live-validator-'));
const SESSION_FILE = path.join(TMP, 'session.json');
const AUTH_FILE = path.join(TMP, 'auth.json');
const PREFLIGHT_FILE = path.join(TMP, 'preflight.json');
const START_FILE = path.join(TMP, 'start.json');
const STOP_FILE = path.join(TMP, 'stop.json');
const REPORT_FILE = path.join(TMP, 'report.json');
const APP_ID = `pancake-validator-${Date.now()}`;
const WORKFLOW_ID = `distrokid-validator-${Date.now()}`;
const AUTH_PROFILE_ID = `distrokid-validator-${Date.now()}`;

let apiServer = null;
let contentServer = null;
let passed = 0;
let failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) { console.log(`PASS ${label}`); passed++; }
  else { console.error(`FAIL ${label}${detail ? ': ' + detail : ''}`); failed++; failures.push(label); }
}

function startContentServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url.startsWith('/login')) {
      res.setHeader('Set-Cookie', 'fixture_auth=1; Path=/; SameSite=Lax; Max-Age=3600');
      res.writeHead(200);
      res.end('<html><body><h1>Signed in</h1></body></html>');
      return;
    }
    if (req.url.startsWith('/dashboard')) {
      if (!/fixture_auth=1/.test(req.headers.cookie || '')) {
        res.writeHead(302, { Location: '/login' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('<html><body><h1>DistroKid-like dashboard</h1><input id="title" value="test"/></body></html>');
      return;
    }
    res.writeHead(200);
    res.end('<html><body><h1>Fixture</h1></body></html>');
  });
  return new Promise(resolve => server.listen(CONTENT_PORT, () => resolve(server)));
}

function runValidator(command, extra = []) {
  const args = [
    'scripts/validate-pancake-distrokid-recording.mjs',
    command,
    '--base-url', API,
    '--target-url', `${CONTENT}/dashboard`,
    '--app-id', APP_ID,
    '--workflow-id', WORKFLOW_ID,
    '--auth-profile-id', AUTH_PROFILE_ID,
    '--session-file', SESSION_FILE,
    '--auth-file', AUTH_FILE,
    '--preflight-file', PREFLIGHT_FILE,
    '--start-file', START_FILE,
    '--stop-file', STOP_FILE,
    '--report-file', REPORT_FILE,
    '--headless', 'true',
    ...extra,
  ];
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ status: 1, stdout, stderr: stderr + String(error.message || error) }));
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

try {
  apiServer = createServer({ port: API_PORT });
  await new Promise(resolve => apiServer.listen(API_PORT, resolve));
  contentServer = await startContentServer();

  const help = await runValidator('help');
  assert('validator help exits 0', help.status === 0, help.stderr);
  assert('validator help mentions start-recording', help.stdout.includes('start-recording'));
  assert('validator help mentions status', help.stdout.includes('status'));
  assert('validator help mentions close-profile', help.stdout.includes('close-profile'));

  const initialStatus = await runValidator('status');
  assert('initial status exits 0', initialStatus.status === 0, initialStatus.stderr || initialStatus.stdout);
  assert('initial status points to create-session', initialStatus.stdout.includes('overall not_started') && initialStatus.stdout.includes('next command npm run validate:pancake-distrokid-recording -- create-session'), initialStatus.stdout);

  const initialClose = await runValidator('close-profile');
  assert('close-profile without browser exits 0', initialClose.status === 0, initialClose.stderr || initialClose.stdout);
  assert('close-profile reports no browser when free', initialClose.stdout.includes('no running browser process found'), initialClose.stdout);

  const created = await runValidator('create-session');
  assert('create-session exits 0', created.status === 0, created.stderr || created.stdout);
  assert('create-session prints wizard URL', created.stdout.includes(`open Browsy wizard ${API}/recordings/`), created.stdout);
  assert('create-session prints next command', created.stdout.includes('next command npm run validate:pancake-distrokid-recording -- prepare-auth'), created.stdout);
  assert('create-session validates Record Automation control', created.stdout.includes('Record Automation control opens wizard'), created.stdout);
  assert('session file written', fs.existsSync(SESSION_FILE), SESSION_FILE);
  const session = readJson(SESSION_FILE);
  assert('session is Pancake app scoped', session.appId === APP_ID, JSON.stringify(session));
  assert('session target is fixture dashboard', session.recordingSetup?.tabs?.[0]?.url === `${CONTENT}/dashboard`, JSON.stringify(session.recordingSetup));
  assert('session has Record Automation control', session.recordAutomationControl?.label === 'Record Automation' && session.recordAutomationControl?.href === session.wizardUrl, JSON.stringify(session.recordAutomationControl));

  const unauthenticatedPreflight = await runValidator('preflight');
  assert('preflight fails before auth', unauthenticatedPreflight.status === 1, unauthenticatedPreflight.stdout);

  const prepared = await runValidator('prepare-auth', ['--target-url', `${CONTENT}/login`]);
  assert('prepare-auth exits 0', prepared.status === 0, prepared.stderr || prepared.stdout);
  assert('prepare-auth prints preflight next command', prepared.stdout.includes('run npm run validate:pancake-distrokid-recording -- preflight'), prepared.stdout);
  assert('auth file written', fs.existsSync(AUTH_FILE), AUTH_FILE);
  const auth = readJson(AUTH_FILE);
  assert('auth profile saved state exists', fs.existsSync(auth.profile?.savedAuthState || ''), JSON.stringify(auth.profile));

  const preflight = await runValidator('preflight');
  assert('preflight exits 0 after auth', preflight.status === 0, preflight.stderr || preflight.stdout);
  assert('preflight prints start-recording next command', preflight.stdout.includes('next command npm run validate:pancake-distrokid-recording -- start-recording'), preflight.stdout);
  const preflightJson = readJson(PREFLIGHT_FILE);
  assert('preflight reaches authenticated dashboard', preflightJson.preflight?.ok === true && /\/dashboard$/.test(preflightJson.preflight?.finalUrl || ''), JSON.stringify(preflightJson.preflight));

  fs.rmSync(auth.profile.storageStatePath, { force: true });
  assert('storageState removed before start-recording', !fs.existsSync(auth.profile.storageStatePath), auth.profile.storageStatePath);

  const started = await runValidator('start-recording');
  assert('start-recording exits 0', started.status === 0, started.stderr || started.stdout);
  assert('start-recording prints opened tab summary', started.stdout.includes('openedTabs') && started.stdout.includes('/dashboard'), started.stdout);
  const start = readJson(START_FILE);
  assert('start-recording uses persistent profile automatically', start.launch?.persistentProfile === true, JSON.stringify(start.launch));
  assert('start-recording opens no blank tabs', start.launch?.verification?.ok === true && start.launch.verification.blankTabs.length === 0, JSON.stringify(start.launch?.verification));
  assert('start-recording lands on dashboard', /\/dashboard$/.test(start.launch?.openedTabs?.[0]?.finalUrl || ''), JSON.stringify(start.launch?.openedTabs));

  const stopped = await runValidator('stop-recording');
  assert('stop-recording exits 0', stopped.status === 0, stopped.stderr || stopped.stdout);
  assert('stop-recording prints artifact next command', stopped.stdout.includes('next command npm run validate:pancake-distrokid-recording -- check-artifacts'), stopped.stdout);
  const stop = readJson(STOP_FILE);
  assert('stop-recording saved auth state', fs.existsSync(stop.runtime?.savedAuthState || ''), JSON.stringify(stop.runtime));
  assert('stop-recording writes validation report', fs.existsSync(REPORT_FILE), REPORT_FILE);
  const stopReport = readJson(REPORT_FILE);
  assert('validation report awaits final-action attestation', stopReport.overallStatus === 'needs_manual_attestation', JSON.stringify(stopReport));
  assert('validation report covers Record Automation control', stopReport.requirements?.some(item => item.id === 'record_automation_control_available' && item.status === 'passed'), JSON.stringify(stopReport.requirements));
  assert('validation report covers blank-tab requirement', stopReport.requirements?.some(item => item.id === 'recording_opened_without_blank_tabs' && item.status === 'passed'), JSON.stringify(stopReport.requirements));

  const artifacts = await runValidator('check-artifacts');
  assert('check-artifacts exits 0', artifacts.status === 0, artifacts.stderr || artifacts.stdout);
  assert('check-artifacts prints validation report path', artifacts.stdout.includes(`wrote validation report ${REPORT_FILE}`), artifacts.stdout);

  const attested = await runValidator('report', ['--attest-no-final-actions', 'true']);
  assert('attested report exits 0', attested.status === 0, attested.stderr || attested.stdout);
  const attestedReport = readJson(REPORT_FILE);
  assert('attested report passes overall', attestedReport.overallStatus === 'passed', JSON.stringify(attestedReport));

  const finalStatus = await runValidator('status');
  assert('final status exits 0', finalStatus.status === 0, finalStatus.stderr || finalStatus.stdout);
  assert('final status reports passed with no next command', finalStatus.stdout.includes('overall passed') && finalStatus.stdout.includes('next command none'), finalStatus.stdout);
} finally {
  const session = fs.existsSync(SESSION_FILE) ? readJson(SESSION_FILE) : null;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(path.join(REPO_ROOT, 'output', 'auth-profiles', APP_ID), { recursive: true, force: true });
  if (session?.recordingSessionId) fs.rmSync(path.join(REPO_ROOT, 'output', 'recordings', session.recordingSessionId), { recursive: true, force: true });
  if (contentServer) await new Promise(resolve => contentServer.close(resolve));
  if (apiServer) await new Promise(resolve => apiServer.close(resolve));
}

console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
