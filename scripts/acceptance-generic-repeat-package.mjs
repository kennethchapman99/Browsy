#!/usr/bin/env node
/**
 * Acceptance test: generic repeat-group package runner
 *
 * Checks:
 *   1  Package file exists at fixtures/generic-repeat-group/package.json
 *   2  Fixture HTML exists at fixtures/generic-repeat-group/index.html
 *   3  runPackage imports without error
 *   4  Dry-run completes with ok=true
 *   5  Dry-run reports executedStepCount === 0
 *   6  Dry-run package summary has correct workflowId
 *   7  Dry-run reports itemCount === 2
 *   8  Dry-run reports runPlan.stepCount > 0
 *   9  Dry-run reports globalStepCount > 0 (globals + projectBrief asset)
 *  10  Dry-run reports itemStepCount > 0
 *  11  Dry-run checkpoint reached
 *  12  Dry-run blockedActions non-empty
 *  13  Execute mode completes with ok=true
 *  14  Execute mode launches browser (executedStepCount > 0)
 *  15  Global field "projectName" filled as "Acme Redesign 2026"
 *  16  Global field "clientName" filled as "Acme Corp"
 *  17  Global field "department" filled as "Design"
 *  18  Item section count is 2
 *  19  First item section has itemName = "UX Research"
 *  20  First item section has category = "Labor" (from defaults)
 *  21  Second item section has itemName = "UI Design"
 *  22  Second item section has category = "Design" (item-level override beats default)
 *  23  projectBrief asset uploaded (upload_global step found)
 *  24  Both item attachments uploaded (2 upload_item steps for itemAttachment)
 *  25  Human checkpoint reached
 *  26  Final submit not clicked (finalActionClicked !== 'submit')
 *  27  JSON artifact written to disk
 *  28  Markdown report written to disk
 *  29  Markdown report contains "## Repeated Item Groups Processed"
 *  30  Markdown report contains "## Defaults Applied"
 *  31  Markdown report does NOT contain music-specific language
 *  32  Missing package path throws with path in message
 *  33  Missing fixture path throws with path in message
 *
 * Usage:
 *   node scripts/acceptance-generic-repeat-package.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures', 'generic-repeat-group');
const TEST_ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts', 'test-runs', 'acceptance-generic-repeat-package');

let passed = 0, failed = 0;
function pass(label)  { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

const packagePath = path.join(FIXTURE_DIR, 'package.json');
const fixturePath = path.join(FIXTURE_DIR, 'index.html');

// ── Check 1: package file exists ─────────────────────────────────────────────
section(1, 'Package file exists');
fs.existsSync(packagePath)
  ? pass('package.json found at ' + packagePath)
  : fail('package.json not found', packagePath);

// ── Check 2: fixture HTML exists ─────────────────────────────────────────────
section(2, 'Fixture HTML exists');
fs.existsSync(fixturePath)
  ? pass('index.html found at ' + fixturePath)
  : fail('index.html not found', fixturePath);

// ── Check 3: module imports ───────────────────────────────────────────────────
section(3, 'runPackage imports without error');
let runPackage;
try {
  ({ runPackage } = await import('../src/core/package-runner.mjs'));
  pass('runPackage imported successfully');
} catch (e) {
  fail('import failed', e.message);
  process.exit(1);
}

// ── Dry-run (4-12) ────────────────────────────────────────────────────────────
console.log('\n── Running dry-run ──');
const dryResult = await runPackage({
  packagePath,
  fixturePath,
  dryRun: true,
  artifactDir: path.join(TEST_ARTIFACT_DIR, 'dry-run'),
});

section(4, 'Dry-run completes with ok=true');
dryResult.ok === true
  ? pass('dryResult.ok = true')
  : fail('dryResult.ok', 'got: ' + dryResult.ok);

section(5, 'Dry-run reports executedStepCount === 0');
dryResult.execution?.executedStepCount === 0
  ? pass('executedStepCount = 0')
  : fail('executedStepCount', 'got: ' + dryResult.execution?.executedStepCount);

section(6, 'Dry-run package summary has correct workflowId');
{
  const wid = dryResult.package?.workflowId;
  wid === 'project-budget-submission'
    ? pass('workflowId = "project-budget-submission"')
    : fail('workflowId', 'got: ' + wid);
}

section(7, 'Dry-run reports itemCount === 2');
dryResult.package?.itemCount === 2
  ? pass('itemCount = 2')
  : fail('itemCount', 'got: ' + dryResult.package?.itemCount);

section(8, 'Dry-run reports runPlan.stepCount > 0');
dryResult.runPlan?.stepCount > 0
  ? pass('runPlan.stepCount = ' + dryResult.runPlan.stepCount)
  : fail('runPlan.stepCount', 'got: ' + dryResult.runPlan?.stepCount);

section(9, 'Dry-run reports globalStepCount > 0');
dryResult.runPlan?.globalStepCount > 0
  ? pass('globalStepCount = ' + dryResult.runPlan.globalStepCount)
  : fail('globalStepCount', 'got: ' + dryResult.runPlan?.globalStepCount);

section(10, 'Dry-run reports itemStepCount > 0');
dryResult.runPlan?.itemStepCount > 0
  ? pass('itemStepCount = ' + dryResult.runPlan.itemStepCount)
  : fail('itemStepCount', 'got: ' + dryResult.runPlan?.itemStepCount);

section(11, 'Dry-run checkpoint reached');
dryResult.execution?.checkpointReached === true
  ? pass('checkpointReached = true')
  : fail('checkpointReached', 'got: ' + dryResult.execution?.checkpointReached);

section(12, 'Dry-run blockedActions non-empty');
{
  const blocked = dryResult.execution?.blockedActions;
  Array.isArray(blocked) && blocked.length > 0
    ? pass('blockedActions = [' + blocked.join(', ') + ']')
    : fail('blockedActions', 'got: ' + JSON.stringify(blocked));
}

// ── Execute mode (13-26) ──────────────────────────────────────────────────────
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

section(13, 'Execute mode completes with ok=true');
execResult.ok === true
  ? pass('execResult.ok = true')
  : fail('execResult.ok', 'error: ' + execution?.error);

section(14, 'Execute mode launches browser (executedStepCount > 0)');
execution.executedStepCount > 0
  ? pass('executedStepCount = ' + execution.executedStepCount)
  : fail('executedStepCount', 'got: ' + execution.executedStepCount);

section(15, 'Global field "projectName" filled as "Acme Redesign 2026"');
{
  const v = finalState?.globalFields?.projectName;
  v === 'Acme Redesign 2026'
    ? pass('projectName = "Acme Redesign 2026"')
    : fail('projectName', 'got: ' + v);
}

section(16, 'Global field "clientName" filled as "Acme Corp"');
{
  const v = finalState?.globalFields?.clientName;
  v === 'Acme Corp'
    ? pass('clientName = "Acme Corp"')
    : fail('clientName', 'got: ' + v);
}

section(17, 'Global field "department" filled as "Design"');
{
  const v = finalState?.globalFields?.department;
  v === 'Design'
    ? pass('department = "Design"')
    : fail('department', 'got: ' + v);
}

section(18, 'Item section count is 2');
finalState?.itemSectionCount === 2
  ? pass('itemSectionCount = 2')
  : fail('itemSectionCount', 'got: ' + finalState?.itemSectionCount);

section(19, 'First item section has itemName = "UX Research"');
{
  const v = finalState?.itemSections?.[0]?.itemName;
  v === 'UX Research'
    ? pass('itemSections[0].itemName = "UX Research"')
    : fail('itemSections[0].itemName', 'got: ' + v);
}

section(20, 'First item section has category = "Labor" (from defaults)');
{
  const v = finalState?.itemSections?.[0]?.category;
  v === 'Labor'
    ? pass('itemSections[0].category = "Labor" (from defaults)')
    : fail('itemSections[0].category', 'got: ' + v);
}

section(21, 'Second item section has itemName = "UI Design"');
{
  const v = finalState?.itemSections?.[1]?.itemName;
  v === 'UI Design'
    ? pass('itemSections[1].itemName = "UI Design"')
    : fail('itemSections[1].itemName', 'got: ' + v);
}

section(22, 'Second item section has category = "Design" (item override beats default)');
{
  const v = finalState?.itemSections?.[1]?.category;
  v === 'Design'
    ? pass('itemSections[1].category = "Design" (item override)')
    : fail('itemSections[1].category', 'got: ' + v);
}

section(23, 'projectBrief asset uploaded (upload_global step found)');
{
  const step = executedSteps?.find(s => s.type === 'upload_global' && s.source === 'projectBrief');
  step
    ? pass('upload_global for projectBrief found (file: ' + path.basename(step.resolvedPath || '') + ')')
    : fail('upload_global[projectBrief] not found', 'steps: ' + JSON.stringify(executedSteps?.map(s => s.type + '/' + s.source)));
}

section(24, 'Both item attachments uploaded (2 upload_item steps for itemAttachment)');
{
  const steps = (executedSteps || []).filter(s => s.type === 'upload_item' && s.fieldName === 'itemAttachment');
  steps.length === 2
    ? pass('found 2 upload_item[itemAttachment] steps')
    : fail('upload_item[itemAttachment] count', 'got: ' + steps.length);
}

section(25, 'Human checkpoint reached');
execution.checkpointReached === true
  ? pass('checkpointReached = true')
  : fail('checkpointReached', 'got: ' + execution.checkpointReached);

section(26, 'Final submit not clicked');
{
  const action = finalState?.finalActionClicked;
  action !== 'submit'
    ? pass('finalActionClicked = ' + JSON.stringify(action) + ' (not submit)')
    : fail('finalActionClicked', 'got: submit — automation should not click submit');
}

// ── Artifact checks (27-30) ───────────────────────────────────────────────────

section(27, 'JSON artifact written to disk');
{
  const p = execResult.artifacts?.jsonPath;
  p && fs.existsSync(p)
    ? pass('automation-run.json written at ' + p)
    : fail('JSON artifact missing', 'path: ' + p);
}

section(28, 'Markdown report written to disk');
{
  const p = execResult.artifacts?.markdownPath;
  p && fs.existsSync(p)
    ? pass('automation-run.md written at ' + p)
    : fail('Markdown report missing', 'path: ' + p);
}

const mdText = fs.existsSync(execResult.artifacts?.markdownPath)
  ? fs.readFileSync(execResult.artifacts.markdownPath, 'utf8')
  : '';

section(29, 'Markdown report contains "## Repeated Item Groups Processed"');
mdText.includes('## Repeated Item Groups Processed')
  ? pass('found "## Repeated Item Groups Processed"')
  : fail('"## Repeated Item Groups Processed" not found in report');

section(30, 'Markdown report contains "## Defaults Applied"');
mdText.includes('## Defaults Applied')
  ? pass('found "## Defaults Applied"')
  : fail('"## Defaults Applied" not found in report');

section(31, 'Markdown report does NOT contain music-specific language');
{
  const lower = mdText.toLowerCase();
  const musicTerms = ['track section', 'album.', 'song flow'];
  const found = musicTerms.filter(t => lower.includes(t));
  found.length === 0
    ? pass('No music-specific language found in report')
    : fail('Music-specific language found: ' + found.join(', '));
}

// ── Error path checks (32-33) ─────────────────────────────────────────────────

section(32, 'Missing package path throws with path in message');
{
  const badPath = '/nonexistent/path/package.json';
  try {
    await runPackage({ packagePath: badPath, fixturePath, dryRun: true });
    fail('expected throw for missing package — no error thrown');
  } catch (e) {
    e.message.includes(badPath)
      ? pass('threw with path in message: ' + e.message.slice(0, 80))
      : fail('error message does not name the path', e.message);
  }
}

section(33, 'Missing fixture path throws with path in message');
{
  const badFixture = '/nonexistent/path/index.html';
  try {
    await runPackage({ packagePath, fixturePath: badFixture, dryRun: false });
    fail('expected throw for missing fixture — no error thrown');
  } catch (e) {
    e.message.includes(badFixture)
      ? pass('threw with path in message: ' + e.message.slice(0, 80))
      : fail('error message does not name the path', e.message);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n══════════════════════════════════════`);
console.log(`Generic repeat package acceptance: ${passed} passed, ${failed} failed`);
console.log(`══════════════════════════════════════`);
if (failed > 0) process.exit(1);
