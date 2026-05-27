#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { ensureAuthProfile, readAuthProfile, writeAuthProfile } from '../src/core/auth.mjs';
import { authProfileDir, authProfileStorageStatePath, authProfileUserDataDir, WORKFLOWS_DIR } from '../src/core/paths.mjs';
import { validateRecordingSetup } from '../src/core/recording-setup.mjs';
import { runWorkflowPackage } from '../src/core/workflow-run.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TMP_WORKFLOW_ID = 'acceptance-auth-recording-sessions';
const workflowDir = path.join(WORKFLOWS_DIR, TMP_WORKFLOW_ID);
const packagePath = path.join(workflowDir, 'workflow-package.example.json');
const runRoot = path.join(REPO_ROOT, 'artifacts', 'test-runs', 'acceptance-auth-recording-sessions');
const siteId = 'acceptance-distrokid';
const siteDir = authProfileDir(siteId);

function clean() {
  fs.rmSync(workflowDir, { recursive: true, force: true });
  fs.rmSync(siteDir, { recursive: true, force: true });
  fs.rmSync(runRoot, { recursive: true, force: true });
}

function pass(msg) { console.log(`PASS ${msg}`); }

try {
  clean();

  ensureAuthProfile(siteId, {
    siteName: 'Acceptance DistroKid',
    baseUrl: 'https://distrokid.com',
    authCheckUrl: 'https://distrokid.com/new',
  });
  let profile = readAuthProfile(siteId);
  assert.equal(profile.status, 'missing');
  assert.equal(fs.existsSync(authProfileUserDataDir(siteId)), true);
  pass('auth profile creation yields missing status with local-only userDataDir');

  fs.mkdirSync(path.dirname(authProfileStorageStatePath(siteId)), { recursive: true });
  fs.writeFileSync(authProfileStorageStatePath(siteId), JSON.stringify({ cookies: [], origins: [] }, null, 2) + '\n', 'utf8');
  writeAuthProfile(siteId, { status: 'valid', lastSavedAt: new Date().toISOString() });
  profile = readAuthProfile(siteId);
  assert.equal(profile.status, 'valid');
  assert.equal(profile.hasStorageState, true);
  pass('auth status valid shape is reported after storage-state export');

  const validSetup = validateRecordingSetup({
    workflowId: 'distrokid_album_art_upload',
    appId: 'pancake-robot',
    tabs: [
      { siteId: 'pancake-robot', title: 'Pancake Robot Release', url: 'http://localhost:3737/releases/album/ALBUM', requiresAuth: false },
      { siteId: 'distrokid', title: 'DistroKid Upload', url: 'https://distrokid.com/new', requiresAuth: true },
    ],
  });
  assert.equal(validSetup.ok, true);
  assert.equal(validSetup.setup.tabs.length, 2);
  assert.equal(validateRecordingSetup({ workflowId: 'x', tabs: [{ siteId: 'bad', url: 'ftp://nope', requiresAuth: true }] }).ok, false);
  pass('recording setup manifest validation covers valid and invalid shapes');

  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(path.join(workflowDir, 'workflow.json'), JSON.stringify({
    id: TMP_WORKFLOW_ID,
    auth: {
      mode: 'auth-profiles',
      required_sites: [
        { siteId: 'missing-auth-site', siteName: 'Missing Auth Site', authCheckUrl: 'https://example.com/login', requiresAuth: true }
      ]
    }
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(workflowDir, 'field-map.local.json'), JSON.stringify({ fields: {} }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(workflowDir, 'workflow-package.example.json'), JSON.stringify({
    workflow_id: TMP_WORKFLOW_ID,
    source_system: 'acceptance',
    entity_type: 'release',
    entity_id: 'rel_123',
    mode: 'dry_run',
  }, null, 2) + '\n', 'utf8');

  let result = await runWorkflowPackage({ packagePath, runRoot });
  assert.equal(result.status, 'blocked_auth_required');
  assert.equal(result.result.client_action_requests[0].type, 'blocked_auth_required');
  pass('workflow package run blocks cleanly when required auth profile is missing');

  fs.writeFileSync(path.join(workflowDir, 'workflow.json'), JSON.stringify({
    id: TMP_WORKFLOW_ID,
    auth: {
      mode: 'auth-profiles',
      required_sites: [
        { siteId, siteName: 'Acceptance DistroKid', authCheckUrl: 'https://distrokid.com/new', requiresAuth: true }
      ]
    }
  }, null, 2) + '\n', 'utf8');

  result = await runWorkflowPackage({ packagePath, runRoot });
  assert.equal(result.status, 'dry_run_passed');
  assert.equal(result.ok, true);
  pass('workflow package run proceeds when required auth exists');

  console.log('Authenticated recording sessions acceptance: 5 passed, 0 failed');
} catch (error) {
  console.error('FAIL', error.message);
  process.exitCode = 1;
} finally {
  clean();
}
