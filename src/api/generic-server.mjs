import http from 'http';
import { parseArgs } from '../core/args.mjs';
import { registerApp, getApp, listApps } from '../registry/app-registry.mjs';
import { importWorkflowPackage } from '../registry/package-importer.mjs';
import { registerWorkflow, getWorkflow, listWorkflows, getWorkflowVersion, parseWorkflowRef } from '../registry/workflow-registry.mjs';
import { createRun, getRun, stopRun, cancelRun, approveRun, getRunArtifacts } from '../registry/run-registry.mjs';
import { executeRun } from '../registry/run-executor.mjs';
import { buildRunCreateResponse, buildRunResult, buildWorkflowContract } from '../registry/run-result.mjs';
import { materializeWorkflowPackageFromObservation } from '../core/observation-materializer.mjs';

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
      if (method === 'POST' && url === '/api/apps/register') {
        return send(res, 201, { ok: true, app: registerApp(await json(req)) });
      }
      if (method === 'GET' && url === '/api/apps') {
        return send(res, 200, { ok: true, apps: listApps() });
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

      let p = route('/api/apps/:appId/workflows/import', url);
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
      return send(res, 500, { ok: false, error: err.message });
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
