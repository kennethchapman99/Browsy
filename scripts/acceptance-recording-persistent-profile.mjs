#!/usr/bin/env node
// Acceptance: persistent recording profile + clean tab launch + auth-block detect.
//
// Verifies the generic recorder runtime:
//   - launches a persistent Chrome profile (stable userDataDir per app/profile)
//   - opens exactly one tab per requested tab (no stray blank/duplicate tabs)
//   - reports an openedTabs array with the final URL for each tab
//   - flags auth-blocked when a target page shows the "this browser or app may
//     not be secure" / "couldn't sign you in" interstitial
//   - exposes a generic auth-setup flow that reuses the same persistent profile
// None of this is app/site specific — the test drives a local fixture server.

import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from '../src/api/generic-server.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const API_PORT = 16001 + Math.floor(Math.random() * 1000);
const CONTENT_PORT = 17001 + Math.floor(Math.random() * 1000);
const API = `http://localhost:${API_PORT}`;
const CONTENT = `http://localhost:${CONTENT_PORT}`;
const TS = Date.now();
const APP_ID = `persistent-profile-app-${TS}`;
const WORKFLOW_ID = `persistent-profile-wf-${TS}`;
const AUTH_PROFILE_ID = `test-profile-${TS}`;

let apiServer = null;
let contentServer = null;
let recordingSessionId = null;
let passed = 0;
let failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) { console.log(`PASS ${label}`); passed++; }
  else { console.error(`FAIL ${label}${detail ? ': ' + detail : ''}`); failed++; failures.push(label); }
}
async function api(method, route, body = null) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

function startContentServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url.startsWith('/blocked')) {
      res.writeHead(200);
      res.end('<html><body><h1>Sign in</h1><p>Couldn’t sign you in. This browser or app may not be secure.</p></body></html>');
      return;
    }
    res.writeHead(200);
    res.end('<html><body><h1>Normal page</h1><p>Everything is fine here.</p></body></html>');
  });
  return new Promise(resolve => server.listen(CONTENT_PORT, () => resolve(server)));
}

try {
  apiServer = createServer({ port: API_PORT });
  await new Promise(resolve => apiServer.listen(API_PORT, resolve));
  contentServer = await startContentServer();

  const created = await api('POST', '/api/recordings/start', {
    appId: APP_ID,
    appName: 'Persistent Profile App',
    workflowId: WORKFLOW_ID,
    workflowName: 'Persistent Profile Workflow',
    recordingSetup: {
      authProfileId: AUTH_PROFILE_ID,
      tabs: [
        { id: 'normal', title: 'Normal', url: `${CONTENT}/normal`, requiresAuth: false },
        { id: 'blocked', title: 'Blocked Sign-in', url: `${CONTENT}/blocked`, siteId: 'google', requiresAuth: true, authProfileId: AUTH_PROFILE_ID },
      ],
    },
    payloadSchema: { type: 'object', properties: {}, required: [] },
  });
  assert('session created', created.res.status === 201 && created.json.ok === true, JSON.stringify(created.json));
  recordingSessionId = created.json.recordingSessionId;

  const started = await api('POST', `/api/recordings/${recordingSessionId}/start`, {
    headless: true,
    usePersistentProfile: true,
    authProfileId: AUTH_PROFILE_ID,
  });
  assert('start returns ok', started.res.ok && started.json.ok === true, JSON.stringify(started.json));
  const launch = started.json.launch || {};

  if (launch.mode === 'real_playwright_recorder') {
    assert('persistent profile used', launch.persistentProfile === true, JSON.stringify(launch.persistentProfile));
    assert('a browser channel is reported', typeof launch.channel === 'string' && launch.channel.length > 0, launch.channel);

    // One tab per requested tab — no stray blank/duplicate tabs.
    assert('pageCount equals requested tab count', launch.pageCount === 2, `pageCount=${launch.pageCount}`);
    assert('openedTabs has one entry per tab', Array.isArray(launch.openedTabs) && launch.openedTabs.length === 2, JSON.stringify(launch.openedTabs?.length));
    const noBlankTabs = (launch.openedTabs || []).every(tab => tab.finalUrl && tab.finalUrl !== 'about:blank' && !/about:blank|chrome:\/\/newtab/.test(tab.finalUrl));
    assert('no opened tab left on a blank/newtab URL', noBlankTabs, JSON.stringify((launch.openedTabs || []).map(t => t.finalUrl)));

    // Start URLs respected.
    const normalTab = (launch.openedTabs || []).find(t => t.id === 'normal');
    const blockedTab = (launch.openedTabs || []).find(t => t.id === 'blocked');
    assert('normal tab navigated to its start URL', !!normalTab && /\/normal$/.test(normalTab.finalUrl || ''), JSON.stringify(normalTab));

    // Auth-block detection (generic, no provider automation).
    assert('blocked tab is flagged auth-blocked', !!blockedTab && blockedTab.authBlocked === true, JSON.stringify(blockedTab));
    assert('blocked tab carries a blockedReason', !!blockedTab?.blockedReason, JSON.stringify(blockedTab?.blockedReason));
    assert('normal tab is not auth-blocked', !!normalTab && normalTab.authBlocked === false, JSON.stringify(normalTab?.authBlocked));
    assert('launch-level authBlocked reflects the blocked tab', launch.authBlocked === true, JSON.stringify(launch.authBlocked));

    // Stable, app/profile-scoped persistent profile path.
    const expectedDir = path.join(REPO_ROOT, 'output', 'auth-profiles', APP_ID, AUTH_PROFILE_ID, 'user-data');
    assert('persistent profile userDataDir is stable and app/profile-scoped',
      launch.authProfile?.userDataDir === expectedDir,
      `${launch.authProfile?.userDataDir} !== ${expectedDir}`);

    await api('POST', `/api/recordings/${recordingSessionId}/stop`, {});

    // Generic auth-setup flow reuses the SAME persistent profile (no recording).
    const prepared = await api('POST', '/api/auth-profiles/prepare', {
      appId: APP_ID,
      workflowId: WORKFLOW_ID,
      authProfileId: AUTH_PROFILE_ID,
      targetUrl: `${CONTENT}/normal`,
      options: { headless: true },
    });
    assert('auth-setup prepare returns ok', prepared.res.status === 200 && prepared.json.ok === true, JSON.stringify(prepared.json));
    const profile = prepared.json.profile || {};
    assert('auth-setup mode is auth_setup', profile.mode === 'auth_setup', profile.mode);
    assert('auth-setup returns a userDataDir', !!profile.userDataDir, JSON.stringify(profile.userDataDir));
    assert('auth-setup returns a storageStatePath', !!profile.storageStatePath, JSON.stringify(profile.storageStatePath));
    assert('auth-setup reuses the recording persistent profile', profile.userDataDir === expectedDir, `${profile.userDataDir} !== ${expectedDir}`);
    assert('auth-setup echoes the target URL', profile.targetUrl === `${CONTENT}/normal`, profile.targetUrl);

    // Auth preflight reuses the same persistent profile and classifies the page
    // generically. A "normal" page reads as authenticated; the "blocked" page
    // (Google-style "this browser or app may not be secure") reads as not.
    const preflightOk = await api('POST', '/api/auth-profiles/preflight', {
      appId: APP_ID, workflowId: WORKFLOW_ID, authProfileId: AUTH_PROFILE_ID,
      targetUrl: `${CONTENT}/normal`, options: { headless: true },
    });
    assert('preflight returns ok envelope', preflightOk.res.status === 200 && preflightOk.json.ok === true, JSON.stringify(preflightOk.json));
    const okPre = preflightOk.json.preflight || {};
    assert('preflight on a normal page is authenticated', okPre.ok === true && okPre.code === 'authenticated', JSON.stringify(okPre));
    assert('preflight reuses the recording persistent profile', okPre.userDataDir === expectedDir, `${okPre.userDataDir} !== ${expectedDir}`);
    assert('preflight does not leak page body text', okPre.bodyText === undefined, JSON.stringify(Object.keys(okPre)));

    const preflightBlocked = await api('POST', '/api/auth-profiles/preflight', {
      appId: APP_ID, workflowId: WORKFLOW_ID, authProfileId: AUTH_PROFILE_ID,
      targetUrl: `${CONTENT}/blocked`, options: { headless: true },
    });
    const blockedPre = preflightBlocked.json.preflight || {};
    assert('preflight on a blocked page is not authenticated', blockedPre.ok === false && blockedPre.code === 'auth_required', JSON.stringify(blockedPre));

    // Endpoint guard: preflight without a target URL is a clear 400 (no launch).
    const badPreflight = await api('POST', '/api/auth-profiles/preflight', { appId: APP_ID, authProfileId: AUTH_PROFILE_ID });
    assert('preflight without targetUrl is a 400', badPreflight.res.status === 400 && badPreflight.json.ok === false, JSON.stringify(badPreflight.json));
  } else {
    // No browser available in this environment — only the launch contract is testable.
    assert('fallback reports a launchError', !!launch.launchError, JSON.stringify(launch));
    console.log('NOTE: real browser unavailable; skipped persistent-profile/auth-block browser assertions.');
  }

  // Endpoint guard: prepare without a target URL is a clear 400 (no browser launch).
  const badPrepare = await api('POST', '/api/auth-profiles/prepare', { appId: APP_ID, authProfileId: AUTH_PROFILE_ID });
  assert('auth-setup prepare without targetUrl is a 400', badPrepare.res.status === 400 && badPrepare.json.ok === false, JSON.stringify(badPrepare.json));
} finally {
  if (recordingSessionId) fs.rmSync(path.join(REPO_ROOT, 'output', 'recordings', recordingSessionId), { recursive: true, force: true });
  fs.rmSync(path.join(REPO_ROOT, 'output', 'auth-profiles', APP_ID), { recursive: true, force: true });
  if (contentServer) await new Promise(resolve => contentServer.close(resolve));
  if (apiServer) await new Promise(resolve => apiServer.close(resolve));
}

console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('Failures:'); for (const f of failures) console.error('  - ' + f); process.exit(1); }
// openAuthSetupProfile intentionally leaves a persistent browser window open for
// the operator; force-exit so the test process doesn't hang on that handle.
process.exit(0);
