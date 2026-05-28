import http from 'http';
import { parseArgs } from '../core/args.mjs';
import { registerApp, getApp, listApps } from '../registry/app-registry.mjs';
import { importWorkflowPackage } from '../registry/package-importer.mjs';
import { registerWorkflow, getWorkflow, listWorkflows, getWorkflowVersion, parseWorkflowRef } from '../registry/workflow-registry.mjs';
import { createRun, getRun, stopRun, cancelRun, approveRun, getRunArtifacts } from '../registry/run-registry.mjs';
import { executeRun } from '../registry/run-executor.mjs';
import { buildRunCreateResponse, buildRunResult, buildWorkflowContract } from '../registry/run-result.mjs';
import { materializeWorkflowPackageFromObservation } from '../core/observation-materializer.mjs';
import {
  startRecordingSession,
  beginRecordingSession,
  getRecordingSession,
  stopRecordingSession,
  importRecordingSession,
  getRecordingContract,
  listRecordingSessions,
} from '../registry/recording-registry.mjs';

export const DEFAULT_PORT = 3001;

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
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
  res.end(html);
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

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function renderRecordingPage(recordingSessionId) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Browsy Recording ${escapeHtml(recordingSessionId)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f7f7f8; color: #111827; }
    main { max-width: 1120px; margin: 0 auto; padding: 32px; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 16px; padding: 20px; margin: 16px 0; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
    .pill { display: inline-block; border-radius: 999px; padding: 4px 10px; background: #eef2ff; color: #3730a3; font-size: 12px; margin: 2px 4px 2px 0; }
    button, a.button { border: 0; border-radius: 10px; padding: 10px 14px; background: #111827; color: white; cursor: pointer; text-decoration: none; display: inline-block; margin: 4px 6px 4px 0; }
    button.secondary, a.secondary { background: #4b5563; }
    button.ghost { background: #e5e7eb; color: #111827; }
    pre, textarea { width: 100%; box-sizing: border-box; background: #0b1020; color: #d1e7ff; border-radius: 12px; padding: 12px; overflow: auto; }
    textarea { min-height: 180px; border: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    table { width: 100%; border-collapse: collapse; }
    td, th { text-align: left; border-bottom: 1px solid #e5e7eb; padding: 8px; vertical-align: top; }
    .muted { color: #6b7280; }
    .ok { color: #047857; font-weight: 700; }
    .warn { color: #b45309; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>Browsy Recording Session</h1>
    <p class="muted">Generic app-initiated recording bridge. No app/site-specific logic is used here.</p>

    <section class="card" data-testid="recording-summary">
      <div class="grid">
        <div><strong>Session</strong><br><span id="recordingSessionId">${escapeHtml(recordingSessionId)}</span></div>
        <div><strong>Status</strong><br><span id="status" data-testid="recording-status">Loading...</span></div>
        <div><strong>App</strong><br><span id="app"></span></div>
        <div><strong>Workflow</strong><br><span id="workflow"></span></div>
      </div>
    </section>

    <section class="card">
      <h2>Actions</h2>
      <button id="checkAuthBtn" data-testid="check-auth-button" class="ghost">Check Auth</button>
      <button id="startRecordingBtn" data-testid="start-recording-button">Start Recording</button>
      <button id="stopRecordingBtn" data-testid="stop-recording-button" class="secondary">Stop Recording</button>
      <button id="importWorkflowBtn" data-testid="import-workflow-button">Import Workflow</button>
      <button id="viewContractBtn" data-testid="view-contract-button" class="ghost">View Contract</button>
      <a id="recorderLink" data-testid="recorder-link" class="button secondary" target="_blank" rel="noreferrer">Open Recorder</a>
      <div id="actionResult" data-testid="action-result" class="muted"></div>
    </section>

    <section class="card">
      <h2>Tabs</h2>
      <table data-testid="tabs-table"><thead><tr><th>ID</th><th>Title</th><th>URL</th><th>Auth</th></tr></thead><tbody id="tabsBody"></tbody></table>
    </section>

    <section class="card">
      <h2>Payload Fields</h2>
      <div id="payloadFields" data-testid="payload-fields"></div>
    </section>

    <section class="card">
      <h2>File Bindings</h2>
      <div id="fileBindings" data-testid="file-bindings"></div>
    </section>

    <section class="card">
      <h2>Expected Outputs</h2>
      <div id="expectedOutputs" data-testid="expected-outputs"></div>
    </section>

    <section class="card">
      <h2>Human Checkpoints</h2>
      <div id="humanCheckpoints" data-testid="human-checkpoints"></div>
    </section>

    <section class="card">
      <h2>Observation / Events</h2>
      <p class="muted">Paste observed data here for manual stop/import flows. If blank, Browsy builds a setup-derived observation.</p>
      <textarea id="observationInput" data-testid="observation-input" placeholder='{"schemaVersion":"browsy.observation.v1", ...}'></textarea>
    </section>

    <section class="card">
      <h2>Contract / Result</h2>
      <pre id="contractOutput" data-testid="contract-output">{}</pre>
    </section>
  </main>

<script>
const recordingSessionId = ${JSON.stringify(recordingSessionId)};
let currentRecording = null;
function el(id) { return document.getElementById(id); }
function renderList(target, items, formatter) {
  target.innerHTML = '';
  if (!items || !items.length) { target.innerHTML = '<span class="muted">None</span>'; return; }
  for (const item of items) {
    const span = document.createElement('span');
    span.className = 'pill';
    span.textContent = formatter(item);
    target.appendChild(span);
  }
}
async function api(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
  return data;
}
function parseObservation() {
  const raw = el('observationInput').value.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  return parsed.events ? { events: parsed.events, observation: parsed.observation } : { observation: parsed };
}
async function load() {
  const data = await api('/api/recordings/' + encodeURIComponent(recordingSessionId));
  const r = data.recording;
  currentRecording = r;
  el('status').textContent = r.status;
  el('status').className = r.status === 'imported' ? 'ok' : r.status === 'recording' ? 'warn' : '';
  el('app').textContent = (r.appName || r.appId) + ' / ' + r.appId;
  el('workflow').textContent = (r.workflowName || r.workflowId) + ' / ' + r.workflowId;
  el('recorderLink').href = r.recorderUrl || '#';
  el('recorderLink').textContent = r.recorderUrl ? 'Open Recorder' : 'Recorder URL unavailable';
  const tabsBody = el('tabsBody');
  tabsBody.innerHTML = '';
  for (const tab of (r.recordingSetup && r.recordingSetup.tabs) || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + tab.id + '</td><td>' + (tab.title || '') + '</td><td>' + tab.url + '</td><td>' + (tab.requiresAuth ? 'Required' : 'No') + '</td>';
    tabsBody.appendChild(tr);
  }
  renderList(el('payloadFields'), Object.keys((r.payloadSchema && r.payloadSchema.properties) || {}).map(k => ({ id: k })), x => x.id);
  renderList(el('fileBindings'), r.fileBindings || [], x => x.id + ' ← ' + x.source);
  renderList(el('expectedOutputs'), r.expectedOutputs || [], x => x.id);
  renderList(el('humanCheckpoints'), r.humanCheckpoints || [], x => x.id);
}
el('checkAuthBtn').onclick = async () => {
  el('actionResult').textContent = 'Auth requirements: ' + JSON.stringify((currentRecording && currentRecording.auth) || []);
};
el('startRecordingBtn').onclick = async () => {
  const data = await api('/api/recordings/' + encodeURIComponent(recordingSessionId) + '/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  el('actionResult').textContent = 'Recording started. Open recorderUrl: ' + (data.launch && data.launch.recorderUrl);
  if (data.launch && data.launch.recorderUrl) window.open(data.launch.recorderUrl, '_blank');
  await load();
};
el('stopRecordingBtn').onclick = async () => {
  const payload = parseObservation();
  const data = await api('/api/recordings/' + encodeURIComponent(recordingSessionId) + '/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  el('actionResult').textContent = 'Stopped: ' + data.recording.status;
  await load();
};
el('importWorkflowBtn').onclick = async () => {
  const data = await api('/api/recordings/' + encodeURIComponent(recordingSessionId) + '/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ overwrite: true, autoRegisterApp: true }) });
  el('actionResult').textContent = 'Imported workflowRef: ' + data.workflowRef;
  el('contractOutput').textContent = JSON.stringify(data.contract || data.recording, null, 2);
  await load();
};
el('viewContractBtn').onclick = async () => {
  const data = await api('/api/recordings/' + encodeURIComponent(recordingSessionId) + '/contract');
  el('contractOutput').textContent = JSON.stringify(data.contract, null, 2);
};
load().catch(err => { el('actionResult').textContent = err.message; });
</script>
</body>
</html>`;
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

export function createServer({ port = DEFAULT_PORT } = {}) {
  return http.createServer(async (req, res) => {
    const { method, url } = req;
    try {
      let p = route('/recordings/:recordingSessionId', url);
      if (p && method === 'GET') {
        const session = getRecordingSession(p.recordingSessionId);
        if (!session) return sendHtml(res, 404, '<h1>Recording session not found</h1>');
        return sendHtml(res, 200, renderRecordingPage(p.recordingSessionId));
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

      if (method === 'POST' && url === '/api/recordings/start') {
        const body = await json(req);
        const session = startRecordingSession(body, { baseUrl: baseUrl(req, port) });
        return send(res, 201, { ok: true, ...session, recording: session });
      }

      p = route('/api/recordings/:recordingSessionId/start', url);
      if (p && method === 'POST') {
        const launch = beginRecordingSession(p.recordingSessionId, await json(req));
        return send(res, 200, { ok: true, recording: launch, launch: launch.launch });
      }

      p = route('/api/recordings/:recordingSessionId', url);
      if (p && method === 'GET') {
        const session = getRecordingSession(p.recordingSessionId);
        if (!session) return send(res, 404, { ok: false, error: 'recording session not found' });
        return send(res, 200, { ok: true, recording: session });
      }

      p = route('/api/recordings/:recordingSessionId/stop', url);
      if (p && method === 'POST') {
        const session = stopRecordingSession(p.recordingSessionId, await json(req));
        return send(res, 200, { ok: true, recording: session });
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
  server.listen(port, () => {
    console.log(`Browsy Registry API listening on http://localhost:${port}`);
  });
  return server;
}

export function startServerFromCli() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port) || Number(process.env.BROWSY_PORT) || DEFAULT_PORT;
  return startServer({ port });
}
