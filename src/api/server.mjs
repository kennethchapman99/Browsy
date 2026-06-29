#!/usr/bin/env node
// Browsy Registry HTTP API
//
// Generic app/workflow runtime. External apps call this API to register apps,
// import portable workflow packages, start runs, poll status, approve/cancel
// checkpoints, and retrieve structured outputs/artifacts.

import http from 'node:http';
import { parseArgs } from '../core/args.mjs';
import {
  DEFAULT_PORT,
  createServer as createGenericServer,
  reapStaleRecordingSessions,
} from './generic-server.mjs';
import { renderNewRecordingPage } from './recording-new-page.mjs';

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

export function createServer({ port = DEFAULT_PORT } = {}) {
  const generic = createGenericServer({ port });
  return http.createServer((req, res) => {
    const path = String(req.url || '').split('?')[0];
    if (req.method === 'GET' && (path === '/' || path === '/recordings/new')) {
      return sendHtml(res, 200, renderNewRecordingPage());
    }
    return generic.emit('request', req, res);
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
  server.listen(port, () => {
    console.log(`Browsy Registry API listening on http://localhost:${port}`);
    console.log(`Open http://localhost:${port}/recordings/new to record a general automation.`);
  });
  reapStaleRecordingSessions().catch(err => console.error('[browsy:recording-reaper] boot sweep failed', err?.message));
  const reaperTimer = setInterval(() => {
    reapStaleRecordingSessions().catch(err => console.error('[browsy:recording-reaper] sweep failed', err?.message));
  }, Number(process.env.BROWSY_RECORDING_REAP_INTERVAL_MS || 5 * 60 * 1000));
  reaperTimer.unref?.();
  server.on('close', () => clearInterval(reaperTimer));
  return server;
}

export function startServerFromCli() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port) || Number(process.env.BROWSY_PORT) || DEFAULT_PORT;
  return startServer({ port });
}

if (process.argv[1] && new URL(import.meta.url).pathname === new URL('file://' + process.argv[1]).pathname) {
  startServerFromCli();
}
