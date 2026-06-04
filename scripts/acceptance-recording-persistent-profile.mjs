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
let authReuseRecordingSessionId = null;
let abandonedRecordingSessionId = null;
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
    if (req.url.startsWith('/login')) {
      res.setHeader('Set-Cookie', 'fixture_auth=1; Path=/; SameSite=Lax; Max-Age=3600');
      res.writeHead(200);
      res.end('<html><body><h1>Fixture login complete</h1><p>Signed in for test.</p></body></html>');
      return;
    }
    if (req.url.startsWith('/dashboard')) {
      if (!/fixture_auth=1/.test(req.headers.cookie || '')) {
        res.writeHead(302, { Location: '/login' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('<html><body><h1>Authenticated dashboard</h1><p>Signed in session reused.</p></body></html>');
      return;
    }
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
    assert('auth-setup writes storageStatePath', profile.savedAuthState === profile.storageStatePath && fs.existsSync(profile.storageStatePath), JSON.stringify(profile));
    assert('auth-setup reuses the recording persistent profile', profile.userDataDir === expectedDir, `${profile.userDataDir} !== ${expectedDir}`);
    assert('auth-setup echoes the target URL', profile.targetUrl === `${CONTENT}/normal`, profile.targetUrl);

    // Headless auth setup can also save a real cookie state. This mirrors the
    // DistroKid manual auth path with a deterministic local auth fixture.
    const loggedIn = await api('POST', '/api/auth-profiles/prepare', {
      appId: APP_ID,
      workflowId: WORKFLOW_ID,
      authProfileId: AUTH_PROFILE_ID,
      targetUrl: `${CONTENT}/login`,
      options: { headless: true },
    });
    assert('fixture auth setup returns ok', loggedIn.res.status === 200 && loggedIn.json.ok === true, JSON.stringify(loggedIn.json));
    assert('fixture auth setup saves storage state', fs.existsSync(loggedIn.json.profile?.storageStatePath || ''), JSON.stringify(loggedIn.json.profile));

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

    const preflightDashboard = await api('POST', '/api/auth-profiles/preflight', {
      appId: APP_ID, workflowId: WORKFLOW_ID, authProfileId: AUTH_PROFILE_ID,
      targetUrl: `${CONTENT}/dashboard`, options: { headless: true },
      rules: [{ type: 'urlNotIncludes', value: '/login', code: 'auth_required' }],
    });
    const dashboardPre = preflightDashboard.json.preflight || {};
    assert('preflight reuses fixture auth cookie', dashboardPre.ok === true && dashboardPre.code === 'authenticated' && /\/dashboard$/.test(dashboardPre.finalUrl || ''), JSON.stringify(dashboardPre));

    // A real operator-authenticated Chrome profile may have durable userDataDir
    // cookies even if storageState.json was not refreshed after login. Remove
    // the exported state to prove the recording launch reuses the persistent
    // profile automatically for auth-required tabs.
    fs.rmSync(loggedIn.json.profile.storageStatePath, { force: true });
    assert('fixture storageState removed before auth reuse recording', !fs.existsSync(loggedIn.json.profile.storageStatePath), loggedIn.json.profile.storageStatePath);

    const reuseCreated = await api('POST', '/api/recordings/start', {
      appId: APP_ID,
      appName: 'Persistent Profile App',
      workflowId: `${WORKFLOW_ID}-reuse`,
      workflowName: 'Persistent Profile Reuse Workflow',
      recordingSetup: {
        authProfileId: AUTH_PROFILE_ID,
        tabs: [
          { id: 'dashboard', title: 'Authenticated Dashboard', url: `${CONTENT}/dashboard`, siteId: 'fixture-auth', requiresAuth: true, authProfileId: AUTH_PROFILE_ID },
        ],
      },
      payloadSchema: { type: 'object', properties: {}, required: [] },
    });
    assert('auth reuse recording session created', reuseCreated.res.status === 201 && reuseCreated.json.ok === true, JSON.stringify(reuseCreated.json));
    authReuseRecordingSessionId = reuseCreated.json.recordingSessionId;

    const reusedStart = await api('POST', `/api/recordings/${authReuseRecordingSessionId}/start`, {
      headless: true,
      authProfileId: AUTH_PROFILE_ID,
    });
    assert('auth reuse recording start returns ok', reusedStart.res.status === 200 && reusedStart.json.ok === true, JSON.stringify(reusedStart.json));
    const reuseLaunch = reusedStart.json.launch || {};
    assert('auth reuse recording uses real Playwright launch', reuseLaunch.mode === 'real_playwright_recorder', reuseLaunch.mode);
    assert('auth reuse recording automatically uses persistent profile', reuseLaunch.persistentProfile === true, JSON.stringify(reuseLaunch));
    assert('auth reuse recording opens exactly one tab', reuseLaunch.pageCount === 1 && reuseLaunch.openedTabs?.length === 1, JSON.stringify(reuseLaunch.openedTabs));
    assert('auth reuse recording lands on dashboard, not login or blank',
      /\/dashboard$/.test(reuseLaunch.openedTabs?.[0]?.finalUrl || '') && !/about:blank|chrome:\/\/newtab|\/login/.test(reuseLaunch.openedTabs?.[0]?.finalUrl || ''),
      JSON.stringify(reuseLaunch.openedTabs?.[0]));
    assert('auth reuse recording verification passes', reuseLaunch.verification?.ok === true, JSON.stringify(reuseLaunch.verification));

    const reuseStopped = await api('POST', `/api/recordings/${authReuseRecordingSessionId}/stop`, {
      observation: {
        schemaVersion: 'browsy.observation.v1',
        workflowId: `${WORKFLOW_ID}-reuse`,
        title: 'Persistent Profile Reuse Workflow',
        pages: [{ id: 'dashboard', purpose: 'Authenticated Dashboard', url: `${CONTENT}/dashboard` }],
        sessionEvents: [{ id: `manual-${TS}`, type: 'page_seen', pageId: 'dashboard', pageUrl: `${CONTENT}/dashboard` }],
      },
    });
    assert('auth reuse recording stop returns ok', reuseStopped.res.status === 200 && reuseStopped.json.ok === true, JSON.stringify(reuseStopped.json));
    assert('auth reuse recording stop saves auth state', fs.existsSync(reuseStopped.json.runtime?.savedAuthState || ''), JSON.stringify(reuseStopped.json.runtime));

    const inspectUnlocked = await api('POST', '/api/auth-profiles/inspect', { appId: APP_ID, workflowId: WORKFLOW_ID, authProfileId: AUTH_PROFILE_ID });
    assert('auth profile inspect reports healthy when unlocked', inspectUnlocked.res.status === 200 && inspectUnlocked.json.profile?.healthy === true && inspectUnlocked.json.profile?.locked === false, JSON.stringify(inspectUnlocked.json));

    const lockFile = path.join(expectedDir, 'SingletonLock');
    fs.writeFileSync(lockFile, 'locked by acceptance test\n', 'utf8');
    const inspectLocked = await api('POST', '/api/auth-profiles/inspect', { appId: APP_ID, workflowId: WORKFLOW_ID, authProfileId: AUTH_PROFILE_ID });
    assert('auth profile inspect reports locked profile', inspectLocked.json.profile?.locked === true && inspectLocked.json.profile?.healthy === false, JSON.stringify(inspectLocked.json.profile));
    const releaseActive = await api('POST', '/api/auth-profiles/release-stale-lock', { appId: APP_ID, workflowId: WORKFLOW_ID, authProfileId: AUTH_PROFILE_ID });
    assert('release-stale-lock protects active/recent locks', releaseActive.res.status === 409 && releaseActive.json.recovery?.recoveryAction === 'protected', JSON.stringify(releaseActive.json));

    const lockedCreated = await api('POST', '/api/recordings/start', {
      appId: APP_ID,
      appName: 'Persistent Profile App',
      workflowId: `${WORKFLOW_ID}-locked`,
      workflowName: 'Persistent Profile Locked Workflow',
      recordingSetup: {
        authProfileId: AUTH_PROFILE_ID,
        tabs: [{ id: 'dashboard', title: 'Authenticated Dashboard', url: `${CONTENT}/dashboard`, siteId: 'fixture-auth', requiresAuth: true, authProfileId: AUTH_PROFILE_ID }],
      },
      payloadSchema: { type: 'object', properties: {}, required: [] },
    });
    const lockedStart = await api('POST', `/api/recordings/${lockedCreated.json.recordingSessionId}/start`, {
      headless: true,
      authProfileId: AUTH_PROFILE_ID,
    });
    assert('recording start refuses locked profile with 409', lockedStart.res.status === 409 && lockedStart.json.code === 'auth_profile_locked', JSON.stringify(lockedStart.json));
    fs.rmSync(lockFile, { force: true });

    const staleLockFile = path.join(expectedDir, 'SingletonLock');
    fs.symlinkSync('stale-host-99999999', staleLockFile);
    const inspectStale = await api('POST', '/api/auth-profiles/inspect', { appId: APP_ID, workflowId: WORKFLOW_ID, authProfileId: AUTH_PROFILE_ID });
    assert('auth profile inspect classifies dead-pid lock as stale', inspectStale.json.profile?.locked === true && inspectStale.json.profile?.stale === true, JSON.stringify(inspectStale.json.profile));
    const releaseStale = await api('POST', '/api/auth-profiles/release-stale-lock', { appId: APP_ID, workflowId: WORKFLOW_ID, authProfileId: AUTH_PROFILE_ID });
    assert('release-stale-lock clears dead-pid stale lock', releaseStale.res.status === 200 && releaseStale.json.recovery?.cleared === true && releaseStale.json.recovery?.lock?.locked === false, JSON.stringify(releaseStale.json));
    assert('release-stale-lock removes stale auth lock file', !fs.existsSync(staleLockFile), staleLockFile);

    fs.symlinkSync('stale-host-99999999', staleLockFile);

    const staleCreated = await api('POST', '/api/recordings/start', {
      appId: APP_ID,
      appName: 'Persistent Profile App',
      workflowId: `${WORKFLOW_ID}-stale-lock`,
      workflowName: 'Persistent Profile Stale Lock Workflow',
      recordingSetup: {
        authProfileId: AUTH_PROFILE_ID,
        tabs: [{ id: 'normal', title: 'Normal', url: `${CONTENT}/normal`, siteId: 'fixture-auth', requiresAuth: true, authProfileId: AUTH_PROFILE_ID }],
      },
      payloadSchema: { type: 'object', properties: {}, required: [] },
    });
    const staleStart = await api('POST', `/api/recordings/${staleCreated.json.recordingSessionId}/start`, {
      headless: true,
      authProfileId: AUTH_PROFILE_ID,
    });
    assert('recording start auto-clears stale auth lock', staleStart.res.status === 200 && staleStart.json.ok === true, JSON.stringify(staleStart.json));
    assert('stale auth lock file removed after recovery', !fs.existsSync(staleLockFile), staleLockFile);
    await api('POST', `/api/recordings/${staleCreated.json.recordingSessionId}/stop`, {});

    const abandonCreated = await api('POST', '/api/recordings/start', {
      appId: APP_ID,
      appName: 'Persistent Profile App',
      workflowId: `${WORKFLOW_ID}-abandon`,
      workflowName: 'Persistent Profile Abandon Workflow',
      recordingSetup: {
        authProfileId: AUTH_PROFILE_ID,
        tabs: [{ id: 'normal', title: 'Normal', url: `${CONTENT}/normal`, siteId: 'fixture-auth', requiresAuth: true, authProfileId: AUTH_PROFILE_ID }],
      },
      payloadSchema: { type: 'object', properties: {}, required: [] },
    });
    abandonedRecordingSessionId = abandonCreated.json.recordingSessionId;
    const abandonStart = await api('POST', `/api/recordings/${abandonedRecordingSessionId}/start`, {
      headless: true,
      authProfileId: AUTH_PROFILE_ID,
    });
    assert('abandon test recording starts', abandonStart.res.status === 200 && abandonStart.json.ok === true, JSON.stringify(abandonStart.json));
    const abandoned = await api('POST', `/api/recordings/${abandonedRecordingSessionId}/abandon`, { reason: 'acceptance abandon cleanup' });
    assert('abandon endpoint returns abandoned runtime', abandoned.res.status === 200 && abandoned.json.runtime?.status === 'abandoned', JSON.stringify(abandoned.json));
    assert('abandon endpoint marks session abandoned', abandoned.json.recording?.status === 'abandoned', JSON.stringify(abandoned.json.recording));
    const abandonedStatus = await api('GET', `/api/recordings/${abandonedRecordingSessionId}`);
    assert('abandoned recording is no longer active', abandonedStatus.json.active === null, JSON.stringify(abandonedStatus.json.active));
    const inspectAfterAbandon = await api('POST', '/api/auth-profiles/inspect', { appId: APP_ID, workflowId: WORKFLOW_ID, authProfileId: AUTH_PROFILE_ID });
    assert('auth profile healthy after abandon cleanup', inspectAfterAbandon.json.profile?.healthy === true && inspectAfterAbandon.json.profile?.locked === false, JSON.stringify(inspectAfterAbandon.json.profile));

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
  if (abandonedRecordingSessionId) fs.rmSync(path.join(REPO_ROOT, 'output', 'recordings', abandonedRecordingSessionId), { recursive: true, force: true });
  if (authReuseRecordingSessionId) fs.rmSync(path.join(REPO_ROOT, 'output', 'recordings', authReuseRecordingSessionId), { recursive: true, force: true });
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
