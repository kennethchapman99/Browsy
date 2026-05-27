#!/usr/bin/env node
// Browsy Registry HTTP API
//
// Generic app/workflow runtime. External apps call this API to register apps,
// import portable workflow packages, start runs, poll status, approve/cancel
// checkpoints, and retrieve structured outputs/artifacts.

import { createServer, startServerFromCli } from './generic-server.mjs';

export { createServer };

if (process.argv[1] && new URL(import.meta.url).pathname === new URL('file://' + process.argv[1]).pathname) {
  startServerFromCli();
}
