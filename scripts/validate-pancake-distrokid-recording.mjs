#!/usr/bin/env node
// Manual validator for the Pancake Robot + DistroKid recording path.
//
// This intentionally does not automate DistroKid business actions. It creates
// and verifies Browsy API state around the human-driven login/recording flow.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const DEFAULT_BASE_URL = 'http://localhost:3001';
const DEFAULT_TARGET_URL = 'https://distrokid.com/new/';
const DEFAULT_APP_ID = 'pancake-robot';
const DEFAULT_WORKFLOW_ID = 'distrokid-album-submit-live-check';
const DEFAULT_AUTH_PROFILE_ID = 'distrokid';
const DEFAULT_TMP = '/tmp';

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'help';

if (command === 'help' || args.help) {
  printHelp();
  process.exit(0);
}

const cfg = {
  baseUrl: stripTrailingSlash(args['base-url'] || process.env.BROWSY_API_URL || DEFAULT_BASE_URL),
  targetUrl: args['target-url'] || process.env.DISTROKID_TARGET_URL || DEFAULT_TARGET_URL,
  appId: args['app-id'] || DEFAULT_APP_ID,
  appName: args['app-name'] || 'Pancake Robot',
  workflowId: args['workflow-id'] || DEFAULT_WORKFLOW_ID,
  workflowName: args['workflow-name'] || 'DistroKid Album Submit Live Check',
  authProfileId: args['auth-profile-id'] || DEFAULT_AUTH_PROFILE_ID,
  sessionFile: args['session-file'] || path.join(DEFAULT_TMP, 'browsy-distrokid-session.json'),
  authFile: args['auth-file'] || path.join(DEFAULT_TMP, 'browsy-distrokid-auth-prepare.json'),
  preflightFile: args['preflight-file'] || path.join(DEFAULT_TMP, 'browsy-distrokid-preflight.json'),
  startFile: args['start-file'] || path.join(DEFAULT_TMP, 'browsy-distrokid-recording-start.json'),
  stopFile: args['stop-file'] || path.join(DEFAULT_TMP, 'browsy-distrokid-recording-stop.json'),
  reportFile: args['report-file'] || path.join(DEFAULT_TMP, 'browsy-distrokid-validation-report.json'),
  headless: args.headless === 'true' || args.headless === true,
};

const results = [];
try {
  if (command === 'create-session') await createSession();
  else if (command === 'prepare-auth') await prepareAuth();
  else if (command === 'preflight') await preflight();
  else if (command === 'start-recording') await startRecording();
  else if (command === 'stop-recording') await stopRecording();
  else if (command === 'check-artifacts') await checkArtifacts();
  else if (command === 'report') await writeReport();
  else if (command === 'status') await status();
  else if (command === 'close-profile') await closeProfile();
  else throw new Error(`unknown command: ${command}`);
} catch (err) {
  fail('command failed', err.message || String(err));
}

printResults();
if (results.some(r => !r.ok)) process.exit(1);
process.exit(0);

async function createSession() {
  const body = {
    appId: cfg.appId,
    appName: cfg.appName,
    workflowId: cfg.workflowId,
    workflowName: cfg.workflowName,
    targetUrl: cfg.targetUrl,
    recordingSetup: {
      authProfileId: cfg.authProfileId,
      tabs: [{
        id: 'distrokidUpload',
        title: 'DistroKid Upload',
        url: cfg.targetUrl,
        siteId: 'distrokid',
        requiresAuth: true,
        authProfileId: cfg.authProfileId,
        authCheckUrl: cfg.targetUrl,
      }],
    },
    payloadSchema: { type: 'object', properties: {}, required: [] },
    humanCheckpoints: [{ id: 'beforeFinalSubmit', label: 'Stop before final submit' }],
    completionPolicy: {
      action: 'wait_for_human_submission',
      notes: 'Manual validation only; do not submit to DistroKid.',
    },
  };
  const json = await post('/api/recordings/start', body);
  writeJsonFile(cfg.sessionFile, json);
  check('session response ok', json.ok === true, JSON.stringify(json));
  check('recordingSessionId returned', typeof json.recordingSessionId === 'string' && json.recordingSessionId.length > 0);
  check('auth profile is distrokid', json.recordingSetup?.authProfileId === cfg.authProfileId);
  check('target tab is not blank', !isBlankUrl(json.recordingSetup?.tabs?.[0]?.url), json.recordingSetup?.tabs?.[0]?.url);
  check('Record Automation control opens wizard', isValidRecordAutomationControl(json), JSON.stringify(json.recordAutomationControl || {}));
  note(`wrote ${cfg.sessionFile}`);
  note(`recordingSessionId ${json.recordingSessionId}`);
  note(`open Browsy wizard ${json.wizardUrl || `${cfg.baseUrl}/recordings/${json.recordingSessionId}`}`);
  note(`DistroKid target ${json.recordingSetup?.tabs?.[0]?.url || cfg.targetUrl}`);
  note('next command npm run validate:pancake-distrokid-recording -- prepare-auth');
}

async function prepareAuth() {
  const json = await post('/api/auth-profiles/prepare', {
    appId: cfg.appId,
    workflowId: cfg.workflowId,
    authProfileId: cfg.authProfileId,
    targetUrl: cfg.targetUrl,
    options: { headless: cfg.headless },
  });
  writeJsonFile(cfg.authFile, json);
  check('auth prepare response ok', json.ok === true, JSON.stringify(json));
  check('auth setup mode returned', json.profile?.mode === 'auth_setup', JSON.stringify(json.profile || {}));
  check('auth userDataDir returned', typeof json.profile?.userDataDir === 'string' && json.profile.userDataDir.length > 0);
  check('auth userDataDir exists', exists(json.profile?.userDataDir), json.profile?.userDataDir);
  check('auth target final URL not blank', !isBlankUrl(json.profile?.finalUrl), json.profile?.finalUrl);
  if (json.profile?.savedAuthState) {
    check('savedAuthState path exists', exists(json.profile.savedAuthState), json.profile.savedAuthState);
  } else {
    note('savedAuthState not returned yet; close the auth browser, then run preflight/start checks.');
  }
  note(`wrote ${cfg.authFile}`);
  note(`auth userDataDir ${json.profile?.userDataDir || '(missing)'}`);
  note(`auth storageStatePath ${json.profile?.storageStatePath || '(missing)'}`);
  note('after manual DistroKid login, run npm run validate:pancake-distrokid-recording -- preflight');
}

async function preflight() {
  const json = await post('/api/auth-profiles/preflight', {
    appId: cfg.appId,
    workflowId: cfg.workflowId,
    authProfileId: cfg.authProfileId,
    targetUrl: cfg.targetUrl,
    options: { headless: true },
    rules: [
      { when: 'urlIncludes', value: '/signin', code: 'auth_required' },
      { when: 'urlIncludes', value: '/login', code: 'auth_required' },
      { when: 'textIncludes', value: 'sign in', code: 'auth_required' },
    ],
  });
  writeJsonFile(cfg.preflightFile, json);
  check('preflight response envelope ok', json.ok === true, JSON.stringify(json));
  check('preflight authenticated', json.preflight?.ok === true && json.preflight?.code === 'authenticated', JSON.stringify(json.preflight || {}));
  check('preflight final URL not blank', !isBlankUrl(json.preflight?.finalUrl), json.preflight?.finalUrl);
  check('preflight final URL not login', !/\/signin|\/login/i.test(String(json.preflight?.finalUrl || '')), json.preflight?.finalUrl);
  note(`wrote ${cfg.preflightFile}`);
  note(`preflight finalUrl ${json.preflight?.finalUrl || '(missing)'}`);
  note('next command npm run validate:pancake-distrokid-recording -- start-recording');
}

async function startRecording() {
  const sessionId = requireSessionId();
  if (!checkAuthProfileAvailable()) return;
  const json = await post(`/api/recordings/${encodeURIComponent(sessionId)}/start`, {
    headless: cfg.headless,
    authProfileId: cfg.authProfileId,
  });
  writeJsonFile(cfg.startFile, json);
  const launch = json.launch || {};
  const openedTabs = Array.isArray(launch.openedTabs) ? launch.openedTabs : [];
  check('start recording response ok', json.ok === true, JSON.stringify(json));
  check('real Playwright recorder launched', launch.mode === 'real_playwright_recorder', launch.mode);
  check('persistent profile used', launch.persistentProfile === true, JSON.stringify(launch));
  check('launch verification passed', launch.verification?.ok === true, JSON.stringify(launch.verification || {}));
  check('verification has no blank tabs', (launch.verification?.blankTabs || []).length === 0, JSON.stringify(launch.verification?.blankTabs || []));
  check('opened tabs present', openedTabs.length > 0, JSON.stringify(openedTabs));
  for (const tab of openedTabs) {
    check(`opened tab ${tab.id || '?'} is not blank`, !isBlankUrl(tab.finalUrl), JSON.stringify(tab));
    check(`opened tab ${tab.id || '?'} is not login`, !/\/signin|\/login/i.test(String(tab.finalUrl || '')), JSON.stringify(tab));
  }
  note(`wrote ${cfg.startFile}`);
  note(`persistentProfile ${String(launch.persistentProfile === true)}`);
  note(`openedTabs ${openedTabs.map(tab => `${tab.id || '?'}=${tab.finalUrl || '(missing)'}`).join(', ') || '(none)'}`);
  note('complete the bounded recording manually, stop before final actions, then run npm run validate:pancake-distrokid-recording -- stop-recording');
}

async function stopRecording() {
  const sessionId = requireSessionId();
  const json = await post(`/api/recordings/${encodeURIComponent(sessionId)}/stop`, {});
  writeJsonFile(cfg.stopFile, json);
  check('stop recording response ok', json.ok === true, JSON.stringify(json));
  check('runtime stopped', json.runtime?.status === 'stopped', JSON.stringify(json.runtime || {}));
  check('savedAuthState exists', exists(json.runtime?.savedAuthState), json.runtime?.savedAuthState);
  checkArtifactsForSession(sessionId, json.runtime);
  const report = writeValidationReport(sessionId);
  note(`wrote ${cfg.stopFile}`);
  note(`savedAuthState ${json.runtime?.savedAuthState || '(missing)'}`);
  note(`wrote validation report ${cfg.reportFile}`);
  note(`validation report overall ${report.overallStatus}`);
  note('next command npm run validate:pancake-distrokid-recording -- check-artifacts');
}

async function checkArtifacts() {
  const sessionId = requireSessionId();
  const runtime = readOptionalJson(cfg.stopFile)?.runtime || null;
  checkArtifactsForSession(sessionId, runtime);
  const report = writeValidationReport(sessionId);
  note(`wrote validation report ${cfg.reportFile}`);
  note(`validation report overall ${report.overallStatus}`);
}

async function writeReport() {
  const sessionId = requireSessionId();
  const report = writeValidationReport(sessionId);
  check('validation report written', exists(cfg.reportFile), cfg.reportFile);
  note(`wrote validation report ${cfg.reportFile}`);
  note(`validation report overall ${report.overallStatus}`);
}

async function status() {
  const state = readValidationState();
  const profile = authProfileInfo();
  const profileProcesses = findProfileProcesses(profile.userDataDir);
  note(`sessionFile ${state.files.session ? 'present' : 'missing'} ${cfg.sessionFile}`);
  note(`authFile ${state.files.auth ? 'present' : 'missing'} ${cfg.authFile}`);
  note(`preflightFile ${state.files.preflight ? 'present' : 'missing'} ${cfg.preflightFile}`);
  note(`startFile ${state.files.start ? 'present' : 'missing'} ${cfg.startFile}`);
  note(`stopFile ${state.files.stop ? 'present' : 'missing'} ${cfg.stopFile}`);
  note(`reportFile ${state.files.report ? 'present' : 'missing'} ${cfg.reportFile}`);
  note(`recordingSessionId ${state.sessionId || '(missing)'}`);
  note(`authProfileUserDataDir ${profile.userDataDir}`);
  note(`authProfileInUse ${profileProcesses.length ? profileProcesses.map(p => p.pid).join(',') : 'false'}`);
  note(`overall ${state.overall}`);
  note(`next command ${profileProcesses.length && state.overall === 'auth_verified_recording_needed' ? 'npm run validate:pancake-distrokid-recording -- close-profile' : state.nextCommand}`);
}

async function closeProfile() {
  const profile = authProfileInfo();
  const processes = findProfileProcesses(profile.userDataDir);
  if (!processes.length) {
    note(`no running browser process found for ${profile.userDataDir}`);
    return;
  }
  const rootProcesses = processes.filter(proc => !processes.some(other => other.pid === proc.ppid));
  for (const proc of rootProcesses) {
    try {
      process.kill(proc.pid, 'SIGTERM');
      note(`sent SIGTERM to pid ${proc.pid}`);
    } catch (error) {
      fail(`failed to close pid ${proc.pid}`, error.message || String(error));
    }
  }
  await sleep(1500);
  const remaining = findProfileProcesses(profile.userDataDir);
  check('auth profile no longer in use', remaining.length === 0, remaining.map(proc => `${proc.pid} ${proc.command}`).join('\n'));
  if (!remaining.length) note('next command npm run validate:pancake-distrokid-recording -- start-recording');
}

function checkArtifactsForSession(sessionId, runtime = null) {
  const dir = path.join(process.cwd(), 'output', 'recordings', sessionId);
  check('recording output dir exists', exists(dir), dir);
  check('events.json exists', exists(path.join(dir, 'events.json')), path.join(dir, 'events.json'));
  check('runtime-status.json exists', exists(path.join(dir, 'runtime-status.json')), path.join(dir, 'runtime-status.json'));
  const status = readOptionalJson(path.join(dir, 'runtime-status.json'));
  check('runtime-status stopped', status?.status === 'stopped', JSON.stringify(status || {}));
  const screenshotsDir = path.join(dir, 'screenshots');
  const screenshots = exists(screenshotsDir) ? fs.readdirSync(screenshotsDir).filter(name => name.endsWith('.png')) : [];
  check('screenshots captured', screenshots.length > 0, screenshotsDir);
  if (runtime?.savedAuthState) check('runtime savedAuthState exists', exists(runtime.savedAuthState), runtime.savedAuthState);
}

function writeValidationReport(sessionId) {
  const session = readOptionalJson(cfg.sessionFile) || {};
  const auth = readOptionalJson(cfg.authFile) || {};
  const preflight = readOptionalJson(cfg.preflightFile) || {};
  const start = readOptionalJson(cfg.startFile) || {};
  const stop = readOptionalJson(cfg.stopFile) || {};
  const outputDir = path.join(process.cwd(), 'output', 'recordings', sessionId);
  const eventsPath = path.join(outputDir, 'events.json');
  const runtimeStatusPath = path.join(outputDir, 'runtime-status.json');
  const screenshotsDir = path.join(outputDir, 'screenshots');
  const screenshots = exists(screenshotsDir) ? fs.readdirSync(screenshotsDir).filter(name => name.endsWith('.png')).map(name => path.join(screenshotsDir, name)) : [];
  const launch = start.launch || {};
  const openedTabs = Array.isArray(launch.openedTabs) ? launch.openedTabs : [];
  const runtime = stop.runtime || {};
  const authStatePath = runtime.savedAuthState || auth.profile?.savedAuthState || auth.profile?.storageStatePath || null;
  const requirements = [
    req('pancake_session_created', session.ok === true && session.appId === cfg.appId && !!session.recordingSessionId, {
      appId: session.appId,
      recordingSessionId: session.recordingSessionId,
      sessionFile: cfg.sessionFile,
    }),
    req('record_automation_control_available', isValidRecordAutomationControl(session), {
      wizardUrl: session.wizardUrl || `${cfg.baseUrl}/recordings/${sessionId}`,
      recordAutomationControl: session.recordAutomationControl || null,
    }),
    req('distrokid_auth_state_saved', exists(authStatePath), {
      authStatePath,
      userDataDir: auth.profile?.userDataDir || null,
    }),
    req('auth_state_reused_by_preflight', preflight.preflight?.ok === true && preflight.preflight?.code === 'authenticated' && !/\/signin|\/login/i.test(String(preflight.preflight?.finalUrl || '')), {
      finalUrl: preflight.preflight?.finalUrl || null,
      code: preflight.preflight?.code || null,
    }),
    req('recording_reused_persistent_profile', launch.persistentProfile === true, {
      persistentProfile: launch.persistentProfile,
      mode: launch.mode || null,
    }),
    req('recording_opened_without_blank_tabs', launch.verification?.ok === true && Array.isArray(launch.verification?.blankTabs) && launch.verification.blankTabs.length === 0 && openedTabs.every(tab => !isBlankUrl(tab.finalUrl)), {
      verification: launch.verification || null,
      openedTabs,
    }),
    req('recording_stopped_and_saved_auth_state', runtime.status === 'stopped' && exists(runtime.savedAuthState), {
      runtimeStatus: runtime.status || null,
      savedAuthState: runtime.savedAuthState || null,
    }),
    req('recording_artifacts_exist', exists(eventsPath) && exists(runtimeStatusPath) && screenshots.length > 0, {
      outputDir,
      eventsPath,
      runtimeStatusPath,
      screenshots,
    }),
    {
      id: 'human_final_action_boundary_attested',
      status: args['attest-no-final-actions'] === 'true' || args['attest-no-final-actions'] === true ? 'passed' : 'needs_manual_attestation',
      evidence: {
        requiredAttestation: 'Operator confirms no Submit/Publish/Finalize/Release/Pay/Purchase/Checkout/I agree/I certify action was clicked.',
        passWith: '--attest-no-final-actions true',
      },
    },
  ];
  const failed = requirements.filter(item => item.status === 'failed');
  const needsManual = requirements.filter(item => item.status === 'needs_manual_attestation');
  const report = {
    schemaVersion: 'browsy.pancakeDistrokidValidation.v1',
    generatedAt: new Date().toISOString(),
    appId: cfg.appId,
    workflowId: cfg.workflowId,
    authProfileId: cfg.authProfileId,
    recordingSessionId: sessionId,
    overallStatus: failed.length ? 'failed' : needsManual.length ? 'needs_manual_attestation' : 'passed',
    requirements,
    files: {
      sessionFile: cfg.sessionFile,
      authFile: cfg.authFile,
      preflightFile: cfg.preflightFile,
      startFile: cfg.startFile,
      stopFile: cfg.stopFile,
      reportFile: cfg.reportFile,
    },
  };
  writeJsonFile(cfg.reportFile, report);
  writeTextFile(cfg.reportFile.replace(/\.json$/i, '.md'), renderReportMarkdown(report));
  return report;
}

function readValidationState() {
  const session = readOptionalJson(cfg.sessionFile) || {};
  const auth = readOptionalJson(cfg.authFile) || {};
  const preflight = readOptionalJson(cfg.preflightFile) || {};
  const start = readOptionalJson(cfg.startFile) || {};
  const stop = readOptionalJson(cfg.stopFile) || {};
  const report = readOptionalJson(cfg.reportFile) || {};
  const sessionId = session.recordingSessionId || session.recording?.recordingSessionId || null;
  const files = {
    session: exists(cfg.sessionFile),
    auth: exists(cfg.authFile),
    preflight: exists(cfg.preflightFile),
    start: exists(cfg.startFile),
    stop: exists(cfg.stopFile),
    report: exists(cfg.reportFile),
  };
  const authStatePath = stop.runtime?.savedAuthState || auth.profile?.savedAuthState || auth.profile?.storageStatePath || null;
  const launch = start.launch || {};
  const openedTabs = Array.isArray(launch.openedTabs) ? launch.openedTabs : [];
  const sessionReady = session.ok === true && isValidRecordAutomationControl(session);
  const authSaved = exists(authStatePath);
  const authReused = preflight.preflight?.ok === true && preflight.preflight?.code === 'authenticated' && !/\/signin|\/login/i.test(String(preflight.preflight?.finalUrl || ''));
  const started = start.ok === true && launch.persistentProfile === true && launch.verification?.ok === true && openedTabs.every(tab => !isBlankUrl(tab.finalUrl));
  const stopped = stop.ok === true && stop.runtime?.status === 'stopped' && exists(stop.runtime?.savedAuthState);
  const reportPassed = report.overallStatus === 'passed';
  const reportNeedsAttestation = report.overallStatus === 'needs_manual_attestation';
  let overall = 'not_started';
  let nextCommand = 'npm run validate:pancake-distrokid-recording -- create-session';
  if (!sessionReady) {
    overall = files.session ? 'session_incomplete' : 'not_started';
  } else if (!authSaved) {
    overall = 'session_ready_auth_needed';
    nextCommand = 'npm run validate:pancake-distrokid-recording -- prepare-auth';
  } else if (!authReused) {
    overall = 'auth_saved_preflight_needed';
    nextCommand = 'npm run validate:pancake-distrokid-recording -- preflight';
  } else if (!started) {
    overall = 'auth_verified_recording_needed';
    nextCommand = 'npm run validate:pancake-distrokid-recording -- start-recording';
  } else if (!stopped) {
    overall = 'recording_started_stop_needed';
    nextCommand = 'npm run validate:pancake-distrokid-recording -- stop-recording';
  } else if (reportPassed) {
    overall = 'passed';
    nextCommand = 'none';
  } else if (reportNeedsAttestation || !files.report) {
    overall = 'needs_manual_attestation';
    nextCommand = 'npm run validate:pancake-distrokid-recording -- report --attest-no-final-actions true';
  } else {
    overall = report.overallStatus || 'report_needed';
    nextCommand = 'npm run validate:pancake-distrokid-recording -- report';
  }
  return { files, sessionId, overall, nextCommand };
}

function checkAuthProfileAvailable() {
  const profile = authProfileInfo();
  const processes = findProfileProcesses(profile.userDataDir);
  if (!processes.length) {
    check('auth profile is not already open', true, profile.userDataDir);
    return true;
  }
  fail('auth profile is already open', processes.map(proc => `${proc.pid} ${proc.command}`).join('\n'));
  note('close the DistroKid auth/recording browser window or run npm run validate:pancake-distrokid-recording -- close-profile');
  note('start-recording was not sent to Browsy, so no new about:blank tabs were opened by this command');
  return false;
}

function authProfileInfo() {
  const auth = readOptionalJson(cfg.authFile) || {};
  const userDataDir = auth.profile?.userDataDir || path.join(process.cwd(), 'output', 'auth-profiles', safeSegment(cfg.appId), safeSegment(cfg.authProfileId), 'user-data');
  return { userDataDir };
}

function findProfileProcesses(userDataDir) {
  if (!userDataDir) return [];
  let output = '';
  try {
    output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  return output.split('\n')
    .filter(line => line.includes(userDataDir))
    .map(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
    })
    .filter(proc => proc && proc.pid !== process.pid && !/\srg\s|validate-pancake-distrokid-recording\.mjs/.test(proc.command));
}

function safeSegment(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function req(id, ok, evidence = {}) {
  return { id, status: ok ? 'passed' : 'failed', evidence };
}

function isValidRecordAutomationControl(session = {}) {
  const control = session.recordAutomationControl || {};
  return control.label === 'Record Automation'
    && control.action === 'open_browsy_new_automation_wizard'
    && !!session.wizardUrl
    && control.href === session.wizardUrl
    && control.recordingSessionId === session.recordingSessionId
    && !isBlankUrl(control.href);
}

function renderReportMarkdown(report) {
  const lines = [
    '# Pancake Robot + DistroKid Recording Validation Report',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Overall status: ${report.overallStatus}`,
    `- Recording session: ${report.recordingSessionId || '(missing)'}`,
    `- App: ${report.appId}`,
    `- Workflow: ${report.workflowId}`,
    `- Auth profile: ${report.authProfileId}`,
    '',
    '## Requirements',
    '',
  ];
  for (const item of report.requirements) {
    lines.push(`- ${item.status.toUpperCase()} ${item.id}`);
  }
  lines.push('', '## Evidence Files', '');
  for (const [key, value] of Object.entries(report.files)) lines.push(`- ${key}: ${value}`);
  lines.push('');
  return lines.join('\n');
}

async function post(route, body) {
  const res = await fetch(`${cfg.baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(`POST ${route} failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

function requireSessionId() {
  const explicit = args['session-id'] || process.env.RECORDING_SESSION_ID;
  if (explicit) return String(explicit);
  const json = readOptionalJson(cfg.sessionFile);
  const id = json?.recordingSessionId || json?.recording?.recordingSessionId;
  if (!id) throw new Error(`recording session id not found; pass --session-id or create ${cfg.sessionFile}`);
  return id;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeTextFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function readOptionalJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function exists(value) {
  return !!value && fs.existsSync(value);
}

function isBlankUrl(value) {
  const url = String(value || '').trim();
  return !url || url === 'about:blank' || url.startsWith('chrome://newtab');
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/$/, '');
}

function check(label, ok, detail = '') {
  results.push({ ok: !!ok, label, detail });
}

function note(message) {
  results.push({ ok: true, label: `note: ${message}`, detail: '' });
}

function fail(label, detail = '') {
  results.push({ ok: false, label, detail });
}

function printResults() {
  let passed = 0;
  let failed = 0;
  for (const result of results) {
    if (result.ok) {
      passed++;
      console.log(`PASS ${result.label}`);
    } else {
      failed++;
      console.error(`FAIL ${result.label}${result.detail ? ': ' + result.detail : ''}`);
    }
  }
  console.log(`Summary: ${passed} passed, ${failed} failed`);
}

function printHelp() {
  console.log(`Pancake Robot + DistroKid recording validator

Usage:
  node scripts/validate-pancake-distrokid-recording.mjs <command> [options]

Commands:
  create-session     Create a Browsy recording session for Pancake Robot + DistroKid.
  prepare-auth       Open the DistroKid auth browser profile for manual sign-in.
  preflight          Verify the saved auth profile reaches DistroKid authenticated.
  start-recording    Start the recording and validate no blank/login tabs.
  stop-recording     Stop the recording and validate saved auth/artifacts.
  check-artifacts    Re-check output artifacts for a stopped recording.
  report             Write a requirement-by-requirement validation report.
  status             Inspect existing validation files and print the next command.
  close-profile      Close the browser process currently holding the auth profile.
  help               Show this help.

Options:
  --base-url URL             Browsy API URL. Default: ${DEFAULT_BASE_URL}
  --target-url URL           DistroKid target URL. Default: ${DEFAULT_TARGET_URL}
  --session-id ID            Existing recording session id.
  --session-file PATH        Session JSON path. Default: /tmp/browsy-distrokid-session.json
  --report-file PATH         Validation report JSON path. Default: /tmp/browsy-distrokid-validation-report.json
  --auth-profile-id ID       Auth profile id. Default: ${DEFAULT_AUTH_PROFILE_ID}
  --attest-no-final-actions true
                            Mark the report's human final-action boundary attestation as passed.
  --headless true|false      Browser headless mode for prepare/start. Default: false

Typical live sequence:
  npm run api
  node scripts/validate-pancake-distrokid-recording.mjs create-session
  node scripts/validate-pancake-distrokid-recording.mjs prepare-auth
  # Sign in manually in the opened browser, then close it.
  node scripts/validate-pancake-distrokid-recording.mjs preflight
  node scripts/validate-pancake-distrokid-recording.mjs start-recording
  # Complete bounded human-driven test recording; stop before final actions.
  node scripts/validate-pancake-distrokid-recording.mjs stop-recording
  node scripts/validate-pancake-distrokid-recording.mjs status
  node scripts/validate-pancake-distrokid-recording.mjs report --attest-no-final-actions true
`);
}
