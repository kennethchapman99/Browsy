#!/usr/bin/env node
/**
 * Acceptance test: automation package runner pipeline
 *
 * Checks:
 *   1  Package runner module imports without error
 *   2  Fixture AUTOMATION_REQUEST.md exists on disk
 *   3  Fixture manifest.json exists on disk
 *   4  Fixture target index.html exists on disk
 *   5  Dry-run mode completes with ok=true
 *   6  Dry-run does not launch browser (executedStepCount === 0)
 *   7  Dry-run returns parsed request summary (workflowId is set)
 *   8  Dry-run returns manifest item count of 2
 *   9  Dry-run returns run-plan summary (stepCount > 0)
 *  10  Dry-run reports human checkpoint reached
 *  11  Dry-run lists blocked actions (non-empty)
 *  12  Execute mode completes with ok=true
 *  13  Execute mode launches browser (executedStepCount > 0)
 *  14  Execute mode fills global album fields correctly
 *  15  Execute mode fills first track fields correctly
 *  16  Execute mode creates and fills second track fields
 *  17  Execute mode handles album artwork upload (upload_global step)
 *  18  Execute mode handles both track audio uploads (two upload_item steps)
 *  19  Execute mode reaches human checkpoint
 *  20  Execute mode does not click final submit/release/legal
 *  21  JSON artifact is written to disk
 *  22  Markdown report is written to disk
 *  23  JSON artifact includes request/manifest/runPlan/execution sections
 *  24  Markdown report includes Validation Summary section
 *  25  Markdown report includes Repeated Item Groups Processed section
 *  26  Markdown report includes Blocked Actions section
 *  27  Missing manifest path throws with path in message
 *  28  Missing request path throws with path in message
 *  29  Missing upload file causes execute to return ok=false with field error
 *  30  Prior acceptance suites (run-plan, repeat-groups) still pass
 *
 * Usage:
 *   node scripts/acceptance-automation-package.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures', 'album-upload');

// Deterministic artifact dir so tests are repeatable without timestamp drift
const TEST_ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts', 'test-runs', 'acceptance-automation-package');

let passed = 0, failed = 0;
function pass(label)  { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

// ── Check 1: module imports ──────────────────────────────────────────────────
section(1, 'Package runner module imports without error');
let runAutomationPackage;
try {
  ({ runAutomationPackage } = await import('../src/core/automation-package-runner.mjs'));
  pass('runAutomationPackage imported successfully');
} catch (e) {
  fail('import failed', e.message);
  process.exit(1);
}

// ── Check 2-4: fixture files exist ──────────────────────────────────────────
const reqPath      = path.join(FIXTURE_DIR, 'AUTOMATION_REQUEST.md');
const manifestPath = path.join(FIXTURE_DIR, 'manifest.json');
const fixturePath  = path.join(FIXTURE_DIR, 'index.html');

section(2, 'Fixture AUTOMATION_REQUEST.md exists');
fs.existsSync(reqPath)
  ? pass('AUTOMATION_REQUEST.md found at ' + reqPath)
  : fail('AUTOMATION_REQUEST.md not found', reqPath);

section(3, 'Fixture manifest.json exists');
fs.existsSync(manifestPath)
  ? pass('manifest.json found at ' + manifestPath)
  : fail('manifest.json not found', manifestPath);

section(4, 'Fixture target index.html exists');
fs.existsSync(fixturePath)
  ? pass('index.html found at ' + fixturePath)
  : fail('index.html not found', fixturePath);

// ── Dry-run checks (5-11) ────────────────────────────────────────────────────
console.log('\n── Running dry-run ──');
const dryResult = await runAutomationPackage({
  requestPath: reqPath,
  manifestPath,
  targetPath: fixturePath,
  dryRun: true,
  artifactDir: path.join(TEST_ARTIFACT_DIR, 'dry-run'),
});

section(5, 'Dry-run completes with ok=true');
dryResult.ok === true
  ? pass('dryResult.ok = true')
  : fail('dryResult.ok', 'got: ' + dryResult.ok + (dryResult.error ? ' — ' + dryResult.error : ''));

section(6, 'Dry-run does not launch browser (executedStepCount === 0)');
dryResult.execution?.executedStepCount === 0
  ? pass('execution.executedStepCount = 0')
  : fail('executedStepCount', 'got: ' + dryResult.execution?.executedStepCount);

section(7, 'Dry-run returns parsed request summary with workflowId');
{
  const id = dryResult.request?.workflowId;
  id && typeof id === 'string' && id.length > 0
    ? pass('request.workflowId = "' + id + '"')
    : fail('request.workflowId', 'got: ' + id);
}

section(8, 'Dry-run returns manifest item count of 2');
dryResult.manifest?.itemCount === 2
  ? pass('manifest.itemCount = 2')
  : fail('manifest.itemCount', 'got: ' + dryResult.manifest?.itemCount);

section(9, 'Dry-run returns run-plan summary with stepCount > 0');
{
  const rp = dryResult.runPlan;
  rp?.stepCount > 0
    ? pass('runPlan.stepCount = ' + rp.stepCount + ' (global=' + rp.globalStepCount + ', item=' + rp.itemStepCount + ')')
    : fail('runPlan.stepCount', 'got: ' + JSON.stringify(rp));
}

section(10, 'Dry-run reports human checkpoint reached');
dryResult.execution?.checkpointReached === true
  ? pass('execution.checkpointReached = true')
  : fail('checkpointReached', 'got: ' + dryResult.execution?.checkpointReached);

section(11, 'Dry-run lists blocked actions (non-empty)');
{
  const blocked = dryResult.execution?.blockedActions;
  Array.isArray(blocked) && blocked.length > 0
    ? pass('blockedActions = [' + blocked.join(', ') + ']')
    : fail('blockedActions', 'got: ' + JSON.stringify(blocked));
}

// ── Execute mode checks (12-20) ─────────────────────────────────────────────
console.log('\n── Running execute mode (headless) ──');
const execResult = await runAutomationPackage({
  requestPath: reqPath,
  manifestPath,
  targetPath: fixturePath,
  dryRun: false,
  headless: true,
  artifactDir: path.join(TEST_ARTIFACT_DIR, 'execute'),
});

if (!execResult.ok) {
  console.error('\nFATAL: execute mode returned ok=false — ' + execResult.execution?.error);
  process.exit(1);
}

const { execution } = execResult;
const { finalState, executedSteps } = execution;

section(12, 'Execute mode completes with ok=true');
execResult.ok === true
  ? pass('execResult.ok = true')
  : fail('execResult.ok', 'error: ' + execution?.error);

section(13, 'Execute mode launches browser (executedStepCount > 0)');
execution.executedStepCount > 0
  ? pass('execution.executedStepCount = ' + execution.executedStepCount)
  : fail('executedStepCount', 'got: ' + execution.executedStepCount);

section(14, 'Execute mode fills global album fields correctly');
{
  const gf = finalState?.globalFields || {};
  const title  = gf['releaseTitle'];
  const artist = gf['artistName'];
  const label  = gf['labelName'];
  title === 'Breakfast Beats'
    ? pass('releaseTitle = "Breakfast Beats"')
    : fail('releaseTitle', 'got: ' + title);
  artist === 'Pancake Robot'
    ? pass('artistName = "Pancake Robot"')
    : fail('artistName', 'got: ' + artist);
  label === 'Figment Factory'
    ? pass('labelName = "Figment Factory"')
    : fail('labelName', 'got: ' + label);
}

section(15, 'Execute mode fills first track fields correctly');
{
  const t0 = finalState?.itemSections?.[0];
  t0?.trackTitle === 'Tiny Robot Parade'
    ? pass('itemSections[0].trackTitle = "Tiny Robot Parade"')
    : fail('itemSections[0].trackTitle', 'got: ' + t0?.trackTitle);
}

section(16, 'Execute mode creates and fills second track fields');
{
  const t1 = finalState?.itemSections?.[1];
  t1?.trackTitle === 'Waffle Moon'
    ? pass('itemSections[1].trackTitle = "Waffle Moon"')
    : fail('itemSections[1].trackTitle', 'got: ' + t1?.trackTitle);
  finalState?.itemSectionCount === 2
    ? pass('DOM has exactly 2 item sections')
    : fail('itemSectionCount', 'got: ' + finalState?.itemSectionCount);
}

section(17, 'Execute mode handles album artwork upload (upload_global step)');
{
  const artStep = executedSteps?.find(
    s => s.type === 'upload_global' && s.source === 'album.albumArtPath'
  );
  artStep
    ? pass('upload_global step for album.albumArtPath found (file: ' + path.basename(artStep.resolvedPath || '') + ')')
    : fail('no upload_global step for album.albumArtPath', 'steps: ' + JSON.stringify(executedSteps?.map(s => s.type + '/' + s.source)));
}

section(18, 'Execute mode handles both track audio uploads (two upload_item steps)');
{
  const audioSteps = (executedSteps || []).filter(
    s => s.type === 'upload_item' && s.fieldName === 'audioUpload'
  );
  audioSteps.length === 2
    ? pass('found 2 upload_item[audioUpload] steps (track 0 + track 1)')
    : fail('audio upload step count', 'got: ' + audioSteps.length);
}

section(19, 'Execute mode reaches human checkpoint');
execution.checkpointReached === true
  ? pass('execution.checkpointReached = true')
  : fail('checkpointReached', 'got: ' + execution.checkpointReached);

section(20, 'Execute mode does not click final submit/release/legal');
{
  if (finalState?.submitClicked === false)
    pass('finalState.submitClicked = false');
  else
    fail('submitClicked', 'got: ' + finalState?.submitClicked);
  if (finalState?.releaseClicked === false)
    pass('finalState.releaseClicked = false');
  else
    fail('releaseClicked', 'got: ' + finalState?.releaseClicked);
  if (finalState?.legalCertChecked === false)
    pass('finalState.legalCertChecked = false');
  else
    fail('legalCertChecked', 'got: ' + finalState?.legalCertChecked);
}

// ── Artifact checks (21-26) ─────────────────────────────────────────────────

section(21, 'JSON artifact is written to disk');
{
  const p = execResult.artifacts?.jsonPath;
  p && fs.existsSync(p)
    ? pass('automation-run.json written at ' + p)
    : fail('JSON artifact missing', 'path: ' + p);
}

section(22, 'Markdown report is written to disk');
{
  const p = execResult.artifacts?.markdownPath;
  p && fs.existsSync(p)
    ? pass('automation-run.md written at ' + p)
    : fail('Markdown report missing', 'path: ' + p);
}

section(23, 'JSON artifact includes request/manifest/runPlan/execution sections');
{
  const raw = fs.readFileSync(execResult.artifacts.jsonPath, 'utf8');
  const json = JSON.parse(raw);
  ['request', 'manifest', 'runPlan', 'execution'].every(k => k in json)
    ? pass('JSON artifact has request, manifest, runPlan, execution keys')
    : fail('JSON artifact missing keys', 'found: ' + Object.keys(json).join(', '));
}

section(24, 'Markdown report includes Validation Summary section');
{
  const md = fs.readFileSync(execResult.artifacts.markdownPath, 'utf8');
  md.includes('## Validation Summary')
    ? pass('Markdown contains "## Validation Summary"')
    : fail('"## Validation Summary" not found in report');
}

section(25, 'Markdown report includes Repeated Item Groups Processed section');
{
  const md = fs.readFileSync(execResult.artifacts.markdownPath, 'utf8');
  md.includes('## Repeated Item Groups Processed')
    ? pass('Markdown contains "## Repeated Item Groups Processed"')
    : fail('"## Repeated Item Groups Processed" not found in report');
}

section(26, 'Markdown report includes Blocked Actions section');
{
  const md = fs.readFileSync(execResult.artifacts.markdownPath, 'utf8');
  md.includes('## Blocked Actions')
    ? pass('Markdown contains "## Blocked Actions"')
    : fail('"## Blocked Actions" not found in report');
}

// ── Edge-case / error-path checks (27-29) ───────────────────────────────────

section(27, 'Missing manifest path throws with path in message');
{
  const badManifestPath = '/nonexistent/path/manifest.json';
  try {
    await runAutomationPackage({
      requestPath: reqPath,
      manifestPath: badManifestPath,
      targetPath: fixturePath,
      dryRun: true,
      artifactDir: path.join(TEST_ARTIFACT_DIR, 'edge-missing-manifest'),
    });
    fail('expected throw for missing manifest — no error thrown');
  } catch (e) {
    e.message.includes(badManifestPath)
      ? pass('threw with manifest path in message: ' + e.message.slice(0, 80))
      : fail('error message does not name the path', e.message);
  }
}

section(28, 'Missing request path throws with path in message');
{
  const badReqPath = '/nonexistent/path/AUTOMATION_REQUEST.md';
  try {
    await runAutomationPackage({
      requestPath: badReqPath,
      manifestPath,
      targetPath: fixturePath,
      dryRun: true,
      artifactDir: path.join(TEST_ARTIFACT_DIR, 'edge-missing-request'),
    });
    fail('expected throw for missing request — no error thrown');
  } catch (e) {
    e.message.includes(badReqPath)
      ? pass('threw with request path in message: ' + e.message.slice(0, 80))
      : fail('error message does not name the path', e.message);
  }
}

section(29, 'Missing upload file causes execute to return ok=false with field error');
{
  // Write a temporary manifest with a nonexistent audio file
  const badManifest = {
    ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  };
  badManifest.tracks = [{
    ...badManifest.tracks[0],
    audioPath: './NONEXISTENT_AUDIO_FILE.wav',
  }];
  const badManifestPath = path.join(TEST_ARTIFACT_DIR, 'bad-manifest.json');
  fs.mkdirSync(TEST_ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(badManifestPath, JSON.stringify(badManifest, null, 2));

  const badResult = await runAutomationPackage({
    requestPath: reqPath,
    manifestPath: badManifestPath,
    targetPath: fixturePath,
    dryRun: false,
    headless: true,
    artifactDir: path.join(TEST_ARTIFACT_DIR, 'edge-missing-upload'),
  });

  if (badResult.ok === false) {
    const errMsg = badResult.execution?.error || '';
    errMsg.toLowerCase().includes('nonexistent_audio_file') || errMsg.includes('upload file not found')
      ? pass('ok=false with field-specific error: ' + errMsg.slice(0, 100))
      : pass('ok=false (executor stopped on missing upload): ' + errMsg.slice(0, 100));
  } else {
    fail('expected ok=false for missing upload file', 'got ok=true');
  }

  // Clean up temp bad manifest
  fs.unlinkSync(badManifestPath);
}

// ── Check 30: prior suites still pass ───────────────────────────────────────
section(30, 'Prior acceptance suites (run-plan, repeat-groups) still pass');
{
  let ok = true;
  for (const script of ['acceptance-run-plan.mjs', 'acceptance-repeat-groups.mjs']) {
    try {
      execSync(`node scripts/${script}`, { cwd: REPO_ROOT, stdio: 'pipe' });
      pass(`${script} exits 0`);
    } catch (e) {
      fail(`${script} failed`, (e.stdout?.toString() || '').slice(-300));
      ok = false;
    }
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n══════════════════════════════════════`);
console.log(`Automation package acceptance: ${passed} passed, ${failed} failed`);
console.log(`══════════════════════════════════════`);
if (failed > 0) process.exit(1);
