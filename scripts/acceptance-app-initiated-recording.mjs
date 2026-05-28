#!/usr/bin/env node
// Acceptance: generic app-initiated recording setup.
// Verifies an external app can create a Browsy recording session without any
// app/site-specific code in Browsy.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  startRecordingSession,
  getRecordingSession,
  listRecordingSessions,
} from '../src/registry/recording-registry.mjs';
import { exists, readJson } from '../src/core/paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const TS = Date.now();
const APP_ID = `generic-app-${TS}`;
const WORKFLOW_ID = `generic-workflow-${TS}`;

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

const request = {
  appId: APP_ID,
  appName: 'Generic Calling App',
  workflowId: WORKFLOW_ID,
  workflowName: 'Generic Workflow',
  callbackUrl: 'http://localhost:9999/api/browsy/callback',
  recordingSetup: {
    tabs: [
      {
        id: 'sourceApp',
        title: 'Source App',
        url: 'http://localhost:7777/context/123',
        requiresAuth: false,
      },
      {
        id: 'targetSite',
        title: 'Target Site',
        url: 'https://example.com/start',
        siteId: 'target-site',
        requiresAuth: true,
        authCheckUrl: 'https://example.com/account',
      },
    ],
  },
  payloadSchema: {
    type: 'object',
    required: ['recordId', 'sourceUrl'],
    properties: {
      recordId: { type: 'string', title: 'Record ID' },
      sourceUrl: { type: 'string', title: 'Source URL' },
    },
  },
  fileBindings: [
    { id: 'primaryUpload', label: 'Primary upload', source: 'payload.primaryFilePath', required: true },
  ],
  expectedOutputs: [
    { id: 'confirmationId', label: 'Confirmation ID' },
  ],
  humanCheckpoints: [
    { id: 'finalSubmit', label: 'Final submit', reason: 'manual approval required' },
  ],
};

let session = null;
try {
  session = startRecordingSession(request, { baseUrl: 'http://localhost:3001' });

  assert('start returns recordingSessionId', /^rec_/.test(session.recordingSessionId || ''));
  assert('status is setup_ready', session.status === 'setup_ready', session.status);
  assert('wizardUrl returned', session.wizardUrl?.includes(`/recordings/${session.recordingSessionId}`));
  assert('workflowRefPreview returned', session.workflowRefPreview === `${APP_ID}.${WORKFLOW_ID}`);
  assert('recordingSetup tabs persisted', session.recordingSetup?.tabs?.length === 2);
  assert('auth requirement detected', session.auth?.length === 1 && session.auth[0].siteId === 'target-site');
  assert('payload schema persisted', session.payloadSchema?.required?.includes('recordId'));
  assert('file binding persisted', session.fileBindings?.[0]?.id === 'primaryUpload');
  assert('expected output persisted', session.expectedOutputs?.[0]?.id === 'confirmationId');
  assert('human checkpoint persisted', session.humanCheckpoints?.[0]?.id === 'finalSubmit');

  const sessionDir = path.join(REPO_ROOT, 'output', 'recordings', session.recordingSessionId);
  assert('session.json written', exists(path.join(sessionDir, 'session.json')));
  assert('setup.json written', exists(path.join(sessionDir, 'setup.json')));

  const setup = readJson(path.join(sessionDir, 'setup.json'));
  assert('setup.json appId correct', setup.appId === APP_ID);
  assert('setup.json workflowId correct', setup.workflowId === WORKFLOW_ID);

  const loaded = getRecordingSession(session.recordingSessionId);
  assert('getRecordingSession returns session', loaded?.recordingSessionId === session.recordingSessionId);

  const listed = listRecordingSessions();
  assert('listRecordingSessions includes session', listed.some(r => r.recordingSessionId === session.recordingSessionId));
} finally {
  if (session?.recordingSessionId) {
    fs.rmSync(path.join(REPO_ROOT, 'output', 'recordings', session.recordingSessionId), { recursive: true, force: true });
  }
}

console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
