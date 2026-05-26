#!/usr/bin/env node
// Browsy Registry HTTP API
//
// Start: node src/api/server.mjs [--port 3001]
//
// Routes:
//   POST  /api/apps/register
//   GET   /api/apps
//   POST  /api/workflows/register
//   GET   /api/workflows
//   GET   /api/workflows/:workflowObjectId
//   POST  /api/workflows/:workflowRef/runs     (ref = "objId" or "appId.wfId@ver")
//   GET   /api/runs/:runId
//   POST  /api/runs/:runId/stop
//   GET   /api/runs/:runId/artifacts

import http from 'http';
import { parseArgs } from '../core/args.mjs';
import { registerApp, getApp, listApps } from '../registry/app-registry.mjs';
import { registerWorkflow, getWorkflow, listWorkflows, getWorkflowVersion, parseWorkflowRef } from '../registry/workflow-registry.mjs';
import { createRun, getRun, stopRun, getRunArtifacts, listRuns } from '../registry/run-registry.mjs';
import { executeRun } from '../registry/run-executor.mjs';

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const PORT = Number(args.port) || Number(process.env.BROWSY_PORT) || 3001;

// ---------------------------------------------------------------------------
// Minimal router
// ---------------------------------------------------------------------------

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function ok(res, data) { send(res, 200, { ok: true, ...data }); }
function created(res, data) { send(res, 201, { ok: true, ...data }); }
function badRequest(res, message) { send(res, 400, { ok: false, error: message }); }
function notFound(res, message = 'not found') { send(res, 404, { ok: false, error: message }); }
function serverError(res, err) { send(res, 500, { ok: false, error: err.message }); }

// Match a URL pattern with named :param segments. Returns params or null.
function matchRoute(pattern, url) {
  const patParts = pattern.split('/');
  const urlParts = url.split('?')[0].split('/');
  if (patParts.length !== urlParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
    } else if (patParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleRequest(req, res) {
  const { method, url } = req;

  try {
    // POST /api/apps/register
    if (method === 'POST' && url === '/api/apps/register') {
      const body = await parseBody(req);
      const app = registerApp(body);
      return created(res, { app });
    }

    // GET /api/apps
    if (method === 'GET' && url.startsWith('/api/apps') && !url.includes('/api/apps/')) {
      return ok(res, { apps: listApps() });
    }

    // POST /api/workflows/register
    if (method === 'POST' && url === '/api/workflows/register') {
      const body = await parseBody(req);
      const result = registerWorkflow(body);
      return created(res, { workflow: result });
    }

    // GET /api/workflows  (with optional ?appId= filter)
    if (method === 'GET' && (url === '/api/workflows' || url.startsWith('/api/workflows?'))) {
      const appId = new URL(url, 'http://x').searchParams.get('appId') || null;
      return ok(res, { workflows: listWorkflows(appId) });
    }

    // POST /api/workflows/:workflowRef/runs
    {
      const params = matchRoute('/api/workflows/:workflowRef/runs', url.split('?')[0]);
      if (params && method === 'POST') {
        const body = await parseBody(req);
        const { workflowObjectId, version: refVersion } = parseWorkflowRef(params.workflowRef);
        const version = body.version || refVersion || null;

        const wv = getWorkflowVersion(workflowObjectId, version);
        if (!wv) return notFound(res, `workflow "${workflowObjectId}" version "${version || 'latest'}" not found`);

        const run = createRun({
          workflowObjectId,
          version: wv.version,
          mode: body.mode || 'preview',
          payload: body.payload || {},
          sessionProfileId: body.sessionProfileId || null,
          callerId: body.callerId || null,
        });

        // Execute asynchronously — for long-running browser workflows, callers poll GET /api/runs/:runId.
        // For the registry acceptance suite, the executor is fast (dry_run).
        executeRun({
          runId: run.runId,
          workflowVersion: wv,
          payload: body.payload || {},
          mode: body.mode || 'preview',
          approvalToken: body.approvalToken || null,
        }).catch(() => {});

        return created(res, { runId: run.runId, run });
      }
    }

    // GET /api/workflows/:workflowObjectId
    {
      const params = matchRoute('/api/workflows/:workflowObjectId', url.split('?')[0]);
      if (params && method === 'GET') {
        const wf = getWorkflow(params.workflowObjectId);
        if (!wf) return notFound(res, `workflow "${params.workflowObjectId}" not found`);
        return ok(res, { workflow: wf });
      }
    }

    // GET /api/runs/:runId
    {
      const params = matchRoute('/api/runs/:runId', url.split('?')[0]);
      if (params && method === 'GET') {
        const run = getRun(params.runId);
        if (!run) return notFound(res, `run "${params.runId}" not found`);
        return ok(res, { run });
      }
    }

    // POST /api/runs/:runId/stop
    {
      const params = matchRoute('/api/runs/:runId/stop', url.split('?')[0]);
      if (params && method === 'POST') {
        try {
          const run = stopRun(params.runId);
          return ok(res, { run });
        } catch (e) {
          return notFound(res, e.message);
        }
      }
    }

    // GET /api/runs/:runId/artifacts
    {
      const params = matchRoute('/api/runs/:runId/artifacts', url.split('?')[0]);
      if (params && method === 'GET') {
        const result = getRunArtifacts(params.runId);
        if (!result) return notFound(res, `run "${params.runId}" not found`);
        return ok(res, result);
      }
    }

    notFound(res, `${method} ${url} not found`);
  } catch (err) {
    serverError(res, err);
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

export function createServer() {
  return http.createServer(handleRequest);
}

if (process.argv[1] && new URL(import.meta.url).pathname === new URL('file://' + process.argv[1]).pathname) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`Browsy Registry API listening on http://localhost:${PORT}`);
    console.log('Routes:');
    console.log('  POST /api/apps/register');
    console.log('  GET  /api/apps');
    console.log('  POST /api/workflows/register');
    console.log('  GET  /api/workflows');
    console.log('  GET  /api/workflows/:workflowObjectId');
    console.log('  POST /api/workflows/:workflowRef/runs');
    console.log('  GET  /api/runs/:runId');
    console.log('  POST /api/runs/:runId/stop');
    console.log('  GET  /api/runs/:runId/artifacts');
  });
}
