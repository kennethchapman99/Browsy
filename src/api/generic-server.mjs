import http from 'http';
import { parseArgs } from '../core/args.mjs';
import { registerApp, getApp, listApps } from '../registry/app-registry.mjs';
import { importWorkflowPackage } from '../registry/package-importer.mjs';
import { registerWorkflow, getWorkflow, listWorkflows, getWorkflowVersion, parseWorkflowRef } from '../registry/workflow-registry.mjs';
import { createRun, getRun, stopRun, cancelRun, approveRun, getRunArtifacts, updateRun } from '../registry/run-registry.mjs';
import { executeRun, confirmSubmitForRun } from '../registry/run-executor.mjs';
import { buildRunCreateResponse, buildRunResult, buildWorkflowContract } from '../registry/run-result.mjs';
import { materializeWorkflowPackageFromObservation } from '../core/observation-materializer.mjs';
import { renderEditableRecordingPage } from './recording-page.mjs';
import {
  startRecordingSession,
  beginRecordingSession,
  getRecordingSession,
  updateRecordingSessionSetup,
  validateRecordingSessionForLaunch,
  stopRecordingSession,
  abandonRecordingSession,
  importRecordingSession,
  getRecordingContract,
  listRecordingSessions,
} from '../registry/recording-registry.mjs';
import {
  startPlaywrightRecording,
  stopPlaywrightRecording,
  abandonPlaywrightRecording,
  getActivePlaywrightRecording,
  isPlaywrightRecordingActive,
  openAuthSetupProfile,
  runAuthPreflight,
  inspectAuthProfile,
  recoverAuthProfileLock,
} from '../recording/playwright-recording-runtime.mjs';

export const DEFAULT_PORT = 3001;

// Recording sessions that are left in `recording` status clutter the wizard and
// scare callers ("still open but idle"). We auto-reap them so nobody has to babysit
// stale state. Two thresholds, both chosen so a *real* in-progress recording is never
// killed:
//   - A session whose Playwright browser is gone (no live context — e.g. after a
//     server restart the recorder child process is already dead) can't be a real
//     recording, so we reap it after a short grace that only exists to avoid racing
//     a launch that's mid-flight.
//   - A session with a live browser is only reaped after a generous idle window,
//     since the on-disk updatedAt advances on every recorded event.
const RECORDING_IDLE_LIMIT_MS = Number(process.env.BROWSY_RECORDING_IDLE_MS || 60 * 60 * 1000);
const RECORDING_ORPHAN_GRACE_MS = Number(process.env.BROWSY_RECORDING_ORPHAN_MS || 5 * 60 * 1000);
const RECORDING_REAP_INTERVAL_MS = Number(process.env.BROWSY_RECORDING_REAP_INTERVAL_MS || 5 * 60 * 1000);

export async function reapStaleRecordingSessions({ now = Date.now() } = {}) {
  const reaped = [];
  let sessions;
  try { sessions = listRecordingSessions(); } catch { return reaped; }
  for (const s of sessions) {
    if (s.status !== 'recording') continue;
    const live = isPlaywrightRecordingActive(s.recordingSessionId);
    const lastActivity = Date.parse(s.updatedAt || s.startedAt || s.createdAt || '') || 0;
    const idleMs = now - lastActivity;
    const limit = live ? RECORDING_IDLE_LIMIT_MS : RECORDING_ORPHAN_GRACE_MS;
    if (idleMs < limit) continue;
    const idleMin = Math.round(idleMs / 60000);
    const reason = live
      ? `auto-reaped: recording idle ${idleMin}m (limit ${Math.round(limit / 60000)}m)`
      : `auto-reaped: orphaned recording, no live browser (idle ${idleMin}m)`;
    try {
      if (live) { try { await abandonPlaywrightRecording(s.recordingSessionId, { reason }); } catch {} }
      abandonRecordingSession(s.recordingSessionId, { reason });
      reaped.push({ recordingSessionId: s.recordingSessionId, live, idleMs, reason });
      console.log('[browsy:recording-reaper] abandoned stale recording', {
        recordingSessionId: s.recordingSessionId, live, idleMinutes: idleMin,
      });
    } catch (err) {
      console.error('[browsy:recording-reaper] failed to reap', s.recordingSessionId, err?.message);
    }
  }
  return reaped;
}

function json(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    ...corsHeaders(),
  });
  res.end(html);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}

function route(pattern, url) {
  const a = pattern.split('/');
  const b = url.split('?')[0].split('/');
  if (a.length !== b.length) return null;
  const out = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) out[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return out;
}

function baseUrl(req, port) {
  return `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || `localhost:${port}`}`;
}

function launchRun(workflowObjectId, wv, body) {
  const app = getApp(wv.appId);
  const options = body.options || {};
  const run = createRun({
    workflowObjectId,
    version: wv.version,
    mode: body.mode || 'preview',
    payload: body.payload || {},
    options,
    sessionProfileId: body.sessionProfileId || null,
    callerId: body.callerId || null,
    correlationId: body.correlationId || null,
    callbackUrl: body.callbackUrl || options.callbackUrl || app?.callbackUrl || null,
  });
  executeRun({
    runId: run.runId,
    workflowVersion: wv,
    payload: body.payload || {},
    mode: body.mode || 'preview',
    approvalToken: body.approvalToken || null,
  }).catch(() => {});
  return run;
}

async function approveAndResume(runId, body) {
  const approved = approveRun(runId, body);
  const wv = getWorkflowVersion(approved.workflowObjectId, approved.version);
  if (wv) {
    executeRun({
      runId: approved.runId,
      workflowVersion: wv,
      payload: body.payload || approved.payload || {},
      mode: body.mode || approved.mode || 'live',
      approvalToken: body.approvalToken || 'approved',
    }).catch(() => {});
  }
  return approved;
}

async function startRecording(recordingSessionId, body) {
  validateRecordingSessionForLaunch(recordingSessionId);
  const session = getRecordingSession(recordingSessionId);
  if (!session) throw new Error('recording session not found');

  const tabs = session.recordingSetup?.tabs || [];
  const authProfiles = [...new Set((session.auth || []).map(a => a.authProfileId || a.siteId).filter(Boolean))];
  for (const authProfileId of authProfiles) {
    let recovery = recoverAuthProfileLock({ appId: session.appId, workflowId: session.workflowId, authProfileId });
    let profile = inspectAuthProfile({ appId: session.appId, workflowId: session.workflowId, authProfileId });
    // A stale lock (owner PID confirmed dead, or aged out) is never a real
    // holder — overlapping launch attempts can re-thrash it between recover and
    // inspect. Force-clear and re-check before refusing to launch.
    if (profile.locked && profile.stale) {
      console.log('[browsy:recording] forcing stale auth-profile lock release', {
        authProfileId, lockOwner: profile.lockOwner, lockAgeMs: profile.lockAgeMs,
      });
      recovery = recoverAuthProfileLock({ appId: session.appId, workflowId: session.workflowId, authProfileId, force: true });
      profile = inspectAuthProfile({ appId: session.appId, workflowId: session.workflowId, authProfileId });
    }
    if (profile.locked) {
      return {
        ok: false,
        launchFailed: true,
        code: 'auth_profile_locked',
        error: `Auth profile "${authProfileId}" is locked. Close the existing browser profile and retry.`,
        authProfile: profile,
        profileLockRecovery: recovery,
        recording: null,
        launch: null,
      };
    }
  }
  console.log('[browsy:recording] /start received', {
    recordingSessionId,
    appId: session.appId,
    workflowId: session.workflowId,
    tabCount: tabs.length,
    targetUrls: tabs.map(t => t.url),
  });

  if (!tabs.length) {
    return { ok: false, launchFailed: true, error: 'recording session has no tabs configured', recording: null, launch: null };
  }

  if (body.mode === 'manual' || body.playwright === false) {
    const recording = beginRecordingSession(recordingSessionId, body);
    return { ok: true, recording, launch: recording.launch, active: null };
  }
  try {
    const launch = await startPlaywrightRecording({ recordingSessionId, session, options: body });
    const recording = beginRecordingSession(recordingSessionId, { launch });
    return { ok: true, recording, launch, active: getActivePlaywrightRecording(recordingSessionId) };
  } catch (err) {
    // Verification failures (about:blank tabs, nav errors) are a hard launch
    // failure — do NOT mask as a successful manual-mode launch.
    if (err.launchVerification) {
      const failedLaunch = {
        createdAt: new Date().toISOString(),
        mode: 'real_playwright_recorder',
        launchFailed: true,
        launchError: err.message,
        verification: err.launchVerification,
        tabs,
        auth: session.auth || [],
      };
      return { ok: false, launchFailed: true, error: err.message, verification: err.launchVerification, launch: failedLaunch };
    }
    // Environment/browser unavailable: fall back to manual mode so operator can
    // still import via the wizard URL.
      const fallbackLaunch = {
        createdAt: new Date().toISOString(),
        mode: 'manual_playwright_recorder',
        tabs,
        auth: session.auth || [],
        launchError: err.message,
      instructions: ['Playwright launch failed; use this Browsy recording session page to stop/import the recording.'],
    };
    const recording = beginRecordingSession(recordingSessionId, { launch: fallbackLaunch });
    return { ok: true, recording, launch: fallbackLaunch, active: null };
  }
}

export function createServer({ port = DEFAULT_PORT } = {}) {
  return http.createServer(async (req, res) => {
    const { method, url } = req;
    try {
      if (method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }

      let p = route('/recordings/:recordingSessionId', url);
      if (p && method === 'GET') {
        const session = getRecordingSession(p.recordingSessionId);
        if (!session) return sendHtml(res, 404, '<h1>Recording session not found</h1>');
        return sendHtml(res, 200, renderEditableRecordingPage(p.recordingSessionId));
      }

      if (method === 'POST' && url === '/api/apps/register') {
        return send(res, 201, { ok: true, app: registerApp(await json(req)) });
      }
      if (method === 'GET' && url === '/api/apps') {
        return send(res, 200, { ok: true, apps: listApps() });
      }

      if (method === 'GET' && (url === '/api/recordings' || url.startsWith('/api/recordings?'))) {
        return send(res, 200, { ok: true, recordings: listRecordingSessions() });
      }

      if (method === 'GET' && url === '/api/health') {
        return send(res, 200, {
          ok: true,
          service: 'browsy-registry-api',
          port,
          baseUrl: baseUrl(req, port),
          command: `BROWSY_PORT=${port} npm run api`,
        });
      }

      if (method === 'POST' && url === '/api/auth-profiles/prepare') {
        const body = await json(req);
        if (!body.targetUrl) return send(res, 400, { ok: false, error: 'targetUrl is required' });
        try {
          const profile = await openAuthSetupProfile({
            appId: body.appId || null,
            workflowId: body.workflowId || null,
            authProfileId: body.authProfileId || null,
            targetUrl: body.targetUrl,
            options: body.options || {},
          });
          return send(res, 200, { ok: true, profile });
        } catch (err) {
          return send(res, err.code === 'auth_profile_locked' ? 409 : 502, { ok: false, code: err.code || undefined, error: err.message, profileLock: err.profileLock || undefined });
        }
      }

      if (method === 'POST' && url === '/api/auth-profiles/preflight') {
        const body = await json(req);
        if (!body.targetUrl) return send(res, 400, { ok: false, error: 'targetUrl is required' });
        try {
          const preflight = await runAuthPreflight({
            appId: body.appId || null,
            workflowId: body.workflowId || null,
            authProfileId: body.authProfileId || null,
            targetUrl: body.targetUrl,
            rules: Array.isArray(body.rules) ? body.rules : undefined,
            options: body.options || {},
          });
          // ok=true means authenticated; ok=false is a *successful* preflight that
          // detected an unauthenticated state — both return HTTP 200 with the verdict.
          return send(res, 200, { ok: true, preflight });
        } catch (err) {
          return send(res, err.code === 'auth_profile_locked' ? 409 : 502, { ok: false, code: err.code || undefined, error: err.message, profileLock: err.profileLock || undefined });
        }
      }

      if (method === 'POST' && url === '/api/auth-profiles/inspect') {
        const body = await json(req);
        if (!body.authProfileId) return send(res, 400, { ok: false, error: 'authProfileId is required' });
        return send(res, 200, { ok: true, profile: inspectAuthProfile({ appId: body.appId || null, workflowId: body.workflowId || null, authProfileId: body.authProfileId }) });
      }

      if (method === 'POST' && url === '/api/auth-profiles/release-stale-lock') {
        const body = await json(req);
        if (!body.authProfileId) return send(res, 400, { ok: false, error: 'authProfileId is required' });
        const recovery = recoverAuthProfileLock({
          appId: body.appId || null,
          workflowId: body.workflowId || null,
          authProfileId: body.authProfileId,
          force: body.force === true,
        });
        if (!recovery.ok) return send(res, 409, { ok: false, code: 'auth_profile_locked', error: 'Auth profile lock is active or too recent to release safely.', recovery });
        return send(res, 200, { ok: true, recovery });
      }

      if (method === 'POST' && url === '/api/recordings/start') {
        const body = await json(req);
        try {
          const session = startRecordingSession(body, { baseUrl: baseUrl(req, port) });
          return send(res, 201, { ok: true, ...session, recording: session });
        } catch (err) {
          return send(res, 400, { ok: false, error: err.message, errors: err.errors || [err.message] });
        }
      }

      p = route('/api/recordings/:recordingSessionId/setup', url);
      if (p && method === 'PUT') {
        const recording = updateRecordingSessionSetup(p.recordingSessionId, await json(req));
        return send(res, 200, { ok: true, recording });
      }

      p = route('/api/recordings/:recordingSessionId/start', url);
      if (p && method === 'POST') {
        const result = await startRecording(p.recordingSessionId, await json(req));
        if (!result.ok) return send(res, result.code === 'auth_profile_locked' ? 409 : 502, { ok: false, ...result });
        return send(res, 200, { ok: true, ...result });
      }

      p = route('/api/recordings/:recordingSessionId', url);
      if (p && method === 'GET') {
        const session = getRecordingSession(p.recordingSessionId);
        if (!session) return send(res, 404, { ok: false, error: 'recording session not found' });
        return send(res, 200, { ok: true, recording: session, active: getActivePlaywrightRecording(p.recordingSessionId) });
      }

      p = route('/api/recordings/:recordingSessionId/stop', url);
      if (p && method === 'POST') {
        const body = await json(req);
        const runtime = await stopPlaywrightRecording(p.recordingSessionId);
        const session = stopRecordingSession(p.recordingSessionId, body);
        return send(res, 200, { ok: true, recording: session, runtime });
      }

      p = route('/api/recordings/:recordingSessionId/abandon', url);
      if (p && method === 'POST') {
        const body = await json(req);
        const runtime = await abandonPlaywrightRecording(p.recordingSessionId, { reason: body.reason || 'abandoned by caller' });
        const session = abandonRecordingSession(p.recordingSessionId, { ...body, events: body.events });
        return send(res, 200, { ok: true, recording: session, runtime });
      }

      p = route('/api/recordings/:recordingSessionId/import', url);
      if (p && method === 'POST') {
        const result = importRecordingSession(p.recordingSessionId, await json(req), { baseUrl: baseUrl(req, port) });
        if (!result.materialized?.ok) return send(res, 400, { ok: false, recording: result, error: 'recording import failed' });
        return send(res, 201, { ok: true, recording: result, workflowRef: result.workflowRef, contract: result.contract });
      }

      p = route('/api/recordings/:recordingSessionId/contract', url);
      if (p && method === 'GET') {
        const contract = getRecordingContract(p.recordingSessionId, { baseUrl: baseUrl(req, port) });
        if (!contract) return send(res, 404, { ok: false, error: 'recording contract not found; import the recording first' });
        return send(res, 200, { ok: true, contract });
      }

      if (method === 'POST' && url === '/api/observations/import') {
        const body = await json(req);
        if (!body.observation) return send(res, 400, { ok: false, error: 'observation is required' });
        const observation = body.workflowId && body.observation && typeof body.observation === 'object'
          ? { ...body.observation, workflowId: body.workflowId }
          : body.observation;
        const result = materializeWorkflowPackageFromObservation({
          observation,
          overwrite: body.overwrite === true,
          packageKind: body.packageKind || 'example',
          appId: body.appId || null,
          appName: body.appName || body.appId || null,
          version: body.version || '1.0.0',
          autoRegisterApp: body.autoRegisterApp === true,
        });
        if (!result.ok) {
          return send(res, 400, {
            ok: false,
            error: [
              ...(result.validation?.errors || []),
              ...(result.importResult?.errors || []),
            ].join('; ') || 'observation materialization failed',
            materialized: result,
          });
        }
        return send(res, 201, { ok: true, materialized: result, imported: result.importResult || null });
      }

      p = route('/api/apps/:appId/workflows/import', url);
      if (p && method === 'POST') {
        const body = await json(req);
        const result = importWorkflowPackage({
          packagePath: body.packagePath,
          appId: p.appId,
          workflowId: body.workflowId,
          version: body.version || '1.0.0',
          autoRegisterApp: !!body.autoRegisterApp,
          appName: body.appName || p.appId,
        });
        if (!result.ok) return send(res, 400, { ok: false, error: result.errors.join('; ') });
        return send(res, 201, { ok: true, imported: result });
      }

      p = route('/api/apps/:appId/workflows/:workflowId/contract', url);
      if (p && method === 'GET') {
        const version = new URL(url, 'http://x').searchParams.get('version') || null;
        const wv = getWorkflowVersion(`${p.appId}.${p.workflowId}`, version);
        if (!wv) return send(res, 404, { ok: false, error: 'workflow not found' });
        return send(res, 200, { ok: true, contract: buildWorkflowContract(wv, { baseUrl: baseUrl(req, port) }) });
      }

      p = route('/api/apps/:appId/workflows/:workflowId/runs', url);
      if (p && method === 'POST') {
        const body = await json(req);
        const workflowObjectId = `${p.appId}.${p.workflowId}`;
        const wv = getWorkflowVersion(workflowObjectId, body.version || null);
        if (!wv) return send(res, 404, { ok: false, error: 'workflow not found' });
        const run = launchRun(workflowObjectId, wv, body);
        return send(res, 201, { ok: true, ...buildRunCreateResponse(run), run });
      }

      if (method === 'POST' && url === '/api/workflows/register') {
        return send(res, 201, { ok: true, workflow: registerWorkflow(await json(req)) });
      }
      if (method === 'GET' && (url === '/api/workflows' || url.startsWith('/api/workflows?'))) {
        const appId = new URL(url, 'http://x').searchParams.get('appId') || null;
        return send(res, 200, { ok: true, workflows: listWorkflows(appId) });
      }

      p = route('/api/workflows/:workflowRef/runs', url);
      if (p && method === 'POST') {
        const body = await json(req);
        const { workflowObjectId, version: refVersion } = parseWorkflowRef(p.workflowRef);
        const wv = getWorkflowVersion(workflowObjectId, body.version || refVersion || null);
        if (!wv) return send(res, 404, { ok: false, error: 'workflow not found' });
        const run = launchRun(workflowObjectId, wv, body);
        return send(res, 201, { ok: true, ...buildRunCreateResponse(run), run });
      }

      p = route('/api/workflows/:workflowObjectId', url);
      if (p && method === 'GET') {
        const wf = getWorkflow(p.workflowObjectId);
        if (!wf) return send(res, 404, { ok: false, error: 'workflow not found' });
        return send(res, 200, { ok: true, workflow: wf });
      }

      p = route('/api/runs/:runId/approve', url);
      if (p && method === 'POST') {
        const run = await approveAndResume(p.runId, await json(req));
        return send(res, 200, { ok: true, ...buildRunCreateResponse(run), run });
      }

      // "Human finished the manual final submit" signal. On a live run the
      // executor fills the form and parks the browser open at the human checkpoint;
      // the person reviews, clicks submit, and finishes the tail (mixea +
      // HyperFollow) themselves. This finalizes the parked run as completed so the
      // caller stops waiting. Optionally accepts capturedOutputs the human reports.
      p = route('/api/runs/:runId/confirm-submit', url);
      if (p && method === 'POST') {
        const run = getRun(p.runId);
        if (!run) return send(res, 404, { ok: false, error: 'run not found' });
        if (!run.awaitingSubmitConfirm) {
          return send(res, 409, { ok: false, error: 'run is not awaiting submit confirmation' });
        }
        try {
          const body = await json(req).catch(() => ({}));
          const updated = await confirmSubmitForRun(p.runId, { capturedOutputs: body.capturedOutputs || {} });
          return send(res, 200, { ok: true, runId: p.runId, confirmed: true, result: buildRunResult(updated) });
        } catch (err) {
          return send(res, 500, { ok: false, runId: p.runId, error: err.message });
        }
      }

      p = route('/api/runs/:runId/cancel', url);
      if (p && method === 'POST') {
        const body = await json(req);
        const run = cancelRun(p.runId, body.reason || 'canceled by caller');
        return send(res, 200, { ok: true, run, result: buildRunResult(run) });
      }

      p = route('/api/runs/:runId/stop', url);
      if (p && method === 'POST') {
        const run = stopRun(p.runId);
        return send(res, 200, { ok: true, run, result: buildRunResult(run) });
      }

      p = route('/api/runs/:runId/artifacts', url);
      if (p && method === 'GET') {
        const artifacts = getRunArtifacts(p.runId);
        if (!artifacts) return send(res, 404, { ok: false, error: 'run not found' });
        return send(res, 200, { ok: true, ...artifacts });
      }

      p = route('/api/runs/:runId', url);
      if (p && method === 'GET') {
        const run = getRun(p.runId);
        if (!run) return send(res, 404, { ok: false, error: 'run not found' });
        return send(res, 200, { ok: true, run, result: buildRunResult(run) });
      }

      return send(res, 404, { ok: false, error: `${method} ${url} not found` });
    } catch (err) {
      return send(res, 500, { ok: false, error: err.message, errors: err.errors || undefined });
    }
  });
}

export function startServer({ port = DEFAULT_PORT } = {}) {
  const server = createServer({ port });
  server.on('error', error => {
    if (error?.code === 'EADDRINUSE') {
      console.error(`Browsy Registry API port ${port} is already in use. If the API is already running, keep using http://localhost:${port}.`);
      console.error(`To stop it, find the process with: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });
  server.listen(port, () => console.log(`Browsy Registry API listening on http://localhost:${port}`));
  // Clear orphaned recordings left by a prior process, then sweep on an interval.
  reapStaleRecordingSessions().catch(err => console.error('[browsy:recording-reaper] boot sweep failed', err?.message));
  const reaperTimer = setInterval(() => {
    reapStaleRecordingSessions().catch(err => console.error('[browsy:recording-reaper] sweep failed', err?.message));
  }, RECORDING_REAP_INTERVAL_MS);
  reaperTimer.unref?.();
  server.on('close', () => clearInterval(reaperTimer));
  return server;
}

export function startServerFromCli() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port) || Number(process.env.BROWSY_PORT) || DEFAULT_PORT;
  return startServer({ port });
}
