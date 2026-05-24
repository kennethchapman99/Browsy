#!/usr/bin/env node
/**
 * Acceptance test: DistroKid-like album upload example workflow
 *
 * Checks:
 *   1  DistroKid example fixture.html exists
 *   2  sample-package.json exists
 *   3  Asset files exist (cover.png, track-01.wav, track-02.wav)
 *   4  runPackage imports without error
 *   5  Dry-run completes with ok=true
 *   6  Dry-run workflowId = "distrokid-album-upload"
 *   7  Dry-run itemCount = 2 (two tracks)
 *   8  Dry-run checkpoint reached
 *   9  Execute mode completes with ok=true
 *  10  Album global fields filled correctly (releaseTitle, artistName)
 *  11  Item section count = 2
 *  12  First track has trackTitle = "Morning Light"
 *  13  First track has songwriter = "Example Artist" (from defaults)
 *  14  First track has language = "English" (from defaults)
 *  15  Second track has trackTitle = "Evening Calm"
 *  16  Second track has songwriter = "Jane Composer" (item override beats default)
 *  17  Second track has language = "English" (from defaults, not overridden)
 *  18  Cover art uploaded (upload_global step for coverArt)
 *  19  Both track audio files uploaded (2 upload_item steps for audioFile)
 *  20  Human checkpoint reached
 *  21  Final submit not clicked
 *  22  JSON artifact written
 *  23  Markdown report written
 *  24  Markdown contains "## Repeated Item Groups Processed"
 *  25  Markdown contains "## Defaults Applied"
 *  26  Core modules (src/core/) do NOT contain "distrokid" (case-insensitive)
 *  27  Core modules do NOT contain "pancake" (case-insensitive)
 *  28  Prior suites (run-plan, repeat-groups, automation-package) still pass
 *
 * Usage:
 *   node scripts/acceptance-distrokid-album-example.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');
const EXAMPLE_DIR = path.join(REPO_ROOT, 'examples', 'workflows', 'distrokid-album-upload');
const TEST_ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts', 'test-runs', 'acceptance-distrokid-album-example');

let passed = 0, failed = 0;
function pass(label)  { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

const fixturePath   = path.join(EXAMPLE_DIR, 'fixture.html');
const packagePath   = path.join(EXAMPLE_DIR, 'sample-package.json');
const coverPath     = path.join(EXAMPLE_DIR, 'assets', 'cover.png');
const track01Path   = path.join(EXAMPLE_DIR, 'assets', 'track-01.wav');
const track02Path   = path.join(EXAMPLE_DIR, 'assets', 'track-02.wav');

// ── Check 1-3: files exist ────────────────────────────────────────────────────
section(1, 'fixture.html exists');
fs.existsSync(fixturePath)
  ? pass('fixture.html found')
  : fail('fixture.html not found', fixturePath);

section(2, 'sample-package.json exists');
fs.existsSync(packagePath)
  ? pass('sample-package.json found')
  : fail('sample-package.json not found', packagePath);

section(3, 'Asset files exist (cover.png, track-01.wav, track-02.wav)');
{
  const missing = [coverPath, track01Path, track02Path].filter(p => !fs.existsSync(p));
  missing.length === 0
    ? pass('all 3 asset files found')
    : fail('missing assets: ' + missing.map(p => path.basename(p)).join(', '));
}

// ── Check 4: module import ────────────────────────────────────────────────────
section(4, 'runPackage imports without error');
let runPackage;
try {
  ({ runPackage } = await import('../src/core/package-runner.mjs'));
  pass('runPackage imported successfully');
} catch (e) {
  fail('import failed', e.message);
  process.exit(1);
}

// ── Dry-run (5-8) ─────────────────────────────────────────────────────────────
console.log('\n── Running dry-run ──');
const dryResult = await runPackage({
  packagePath,
  fixturePath,
  dryRun: true,
  artifactDir: path.join(TEST_ARTIFACT_DIR, 'dry-run'),
});

section(5, 'Dry-run completes with ok=true');
dryResult.ok === true
  ? pass('dryResult.ok = true')
  : fail('dryResult.ok', 'got: ' + dryResult.ok);

section(6, 'Dry-run workflowId = "distrokid-album-upload"');
{
  const wid = dryResult.package?.workflowId;
  wid === 'distrokid-album-upload'
    ? pass('workflowId = "distrokid-album-upload"')
    : fail('workflowId', 'got: ' + wid);
}

section(7, 'Dry-run itemCount = 2');
dryResult.package?.itemCount === 2
  ? pass('itemCount = 2')
  : fail('itemCount', 'got: ' + dryResult.package?.itemCount);

section(8, 'Dry-run checkpoint reached');
dryResult.execution?.checkpointReached === true
  ? pass('checkpointReached = true')
  : fail('checkpointReached', 'got: ' + dryResult.execution?.checkpointReached);

// ── Execute mode (9-21) ───────────────────────────────────────────────────────
console.log('\n── Running execute mode (headless) ──');
const execResult = await runPackage({
  packagePath,
  fixturePath,
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

section(9, 'Execute mode completes with ok=true');
execResult.ok === true
  ? pass('execResult.ok = true')
  : fail('execResult.ok', 'error: ' + execution?.error);

section(10, 'Album global fields filled correctly');
{
  const gf = finalState?.globalFields || {};
  gf.releaseTitle === 'Sunrise Sessions'
    ? pass('releaseTitle = "Sunrise Sessions"')
    : fail('releaseTitle', 'got: ' + gf.releaseTitle);
  gf.artistName === 'Example Artist'
    ? pass('artistName = "Example Artist"')
    : fail('artistName', 'got: ' + gf.artistName);
}

section(11, 'Item section count = 2');
finalState?.itemSectionCount === 2
  ? pass('itemSectionCount = 2')
  : fail('itemSectionCount', 'got: ' + finalState?.itemSectionCount);

section(12, 'First track has trackTitle = "Morning Light"');
{
  const v = finalState?.itemSections?.[0]?.trackTitle;
  v === 'Morning Light'
    ? pass('itemSections[0].trackTitle = "Morning Light"')
    : fail('itemSections[0].trackTitle', 'got: ' + v);
}

section(13, 'First track has songwriter = "Example Artist" (from defaults)');
{
  const v = finalState?.itemSections?.[0]?.songwriter;
  v === 'Example Artist'
    ? pass('itemSections[0].songwriter = "Example Artist" (from defaults)')
    : fail('itemSections[0].songwriter', 'got: ' + v);
}

section(14, 'First track has language = "English" (from defaults)');
{
  const v = finalState?.itemSections?.[0]?.language;
  v === 'English'
    ? pass('itemSections[0].language = "English" (from defaults)')
    : fail('itemSections[0].language', 'got: ' + v);
}

section(15, 'Second track has trackTitle = "Evening Calm"');
{
  const v = finalState?.itemSections?.[1]?.trackTitle;
  v === 'Evening Calm'
    ? pass('itemSections[1].trackTitle = "Evening Calm"')
    : fail('itemSections[1].trackTitle', 'got: ' + v);
}

section(16, 'Second track has songwriter = "Jane Composer" (item override)');
{
  const v = finalState?.itemSections?.[1]?.songwriter;
  v === 'Jane Composer'
    ? pass('itemSections[1].songwriter = "Jane Composer" (item override)')
    : fail('itemSections[1].songwriter', 'got: ' + v);
}

section(17, 'Second track has language = "English" (from defaults, not overridden)');
{
  const v = finalState?.itemSections?.[1]?.language;
  v === 'English'
    ? pass('itemSections[1].language = "English" (from defaults)')
    : fail('itemSections[1].language', 'got: ' + v);
}

section(18, 'Cover art uploaded (upload_global step for coverArt)');
{
  const step = (executedSteps || []).find(s => s.type === 'upload_global' && s.source === 'coverArt');
  step
    ? pass('upload_global[coverArt] found (file: ' + path.basename(step.resolvedPath || '') + ')')
    : fail('upload_global[coverArt] not found', 'steps: ' + JSON.stringify(executedSteps?.map(s => s.type + '/' + s.source)));
}

section(19, 'Both track audio files uploaded (2 upload_item steps for audioFile)');
{
  const steps = (executedSteps || []).filter(s => s.type === 'upload_item' && s.fieldName === 'audioFile');
  steps.length === 2
    ? pass('found 2 upload_item[audioFile] steps')
    : fail('upload_item[audioFile] count', 'got: ' + steps.length);
}

section(20, 'Human checkpoint reached');
execution.checkpointReached === true
  ? pass('checkpointReached = true')
  : fail('checkpointReached', 'got: ' + execution.checkpointReached);

section(21, 'Final submit not clicked');
{
  const action = finalState?.finalActionClicked;
  action !== 'submit'
    ? pass('finalActionClicked = ' + JSON.stringify(action) + ' (not submit)')
    : fail('finalActionClicked', 'got: submit — automation should not click submit');
}

// ── Artifact checks (22-25) ───────────────────────────────────────────────────

section(22, 'JSON artifact written');
{
  const p = execResult.artifacts?.jsonPath;
  p && fs.existsSync(p)
    ? pass('automation-run.json written at ' + p)
    : fail('JSON artifact missing', 'path: ' + p);
}

section(23, 'Markdown report written');
{
  const p = execResult.artifacts?.markdownPath;
  p && fs.existsSync(p)
    ? pass('automation-run.md written at ' + p)
    : fail('Markdown report missing', 'path: ' + p);
}

const mdText = fs.existsSync(execResult.artifacts?.markdownPath)
  ? fs.readFileSync(execResult.artifacts.markdownPath, 'utf8')
  : '';

section(24, 'Markdown contains "## Repeated Item Groups Processed"');
mdText.includes('## Repeated Item Groups Processed')
  ? pass('found "## Repeated Item Groups Processed"')
  : fail('"## Repeated Item Groups Processed" not found in report');

section(25, 'Markdown contains "## Defaults Applied"');
mdText.includes('## Defaults Applied')
  ? pass('found "## Defaults Applied"')
  : fail('"## Defaults Applied" not found in report');

// ── Architecture enforcement (26-27) ─────────────────────────────────────────

section(26, 'Core modules (src/core/) do NOT contain "distrokid"');
{
  try {
    const result = execSync(
      'grep -ril "distrokid" src/core/',
      { cwd: REPO_ROOT, encoding: 'utf8' }
    ).trim();
    result
      ? fail('Found "distrokid" in core: ' + result)
      : pass('No "distrokid" found in src/core/');
  } catch (e) {
    // grep exits 1 when no matches found — that's the passing case
    if (e.status === 1) {
      pass('No "distrokid" found in src/core/');
    } else {
      fail('grep error', e.message);
    }
  }
}

section(27, 'Core modules (src/core/) do NOT contain "pancake"');
{
  try {
    const result = execSync(
      'grep -ril "pancake" src/core/',
      { cwd: REPO_ROOT, encoding: 'utf8' }
    ).trim();
    result
      ? fail('Found "pancake" in core: ' + result)
      : pass('No "pancake" found in src/core/');
  } catch (e) {
    if (e.status === 1) {
      pass('No "pancake" found in src/core/');
    } else {
      fail('grep error', e.message);
    }
  }
}

// ── Check 28: prior suites still pass ────────────────────────────────────────
section(28, 'Prior suites (run-plan, repeat-groups, automation-package) still pass');
{
  for (const script of [
    'acceptance-run-plan.mjs',
    'acceptance-repeat-groups.mjs',
    'acceptance-automation-package.mjs',
  ]) {
    try {
      execSync(`node scripts/${script}`, { cwd: REPO_ROOT, stdio: 'pipe' });
      pass(`${script} exits 0`);
    } catch (e) {
      fail(`${script} failed`, (e.stdout?.toString() || '').slice(-300));
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n══════════════════════════════════════`);
console.log(`DistroKid album example acceptance: ${passed} passed, ${failed} failed`);
console.log(`══════════════════════════════════════`);
if (failed > 0) process.exit(1);
