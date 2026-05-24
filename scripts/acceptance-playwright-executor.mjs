#!/usr/bin/env node
/**
 * Acceptance test: Playwright executor drives the album-upload fixture
 *
 * Checks:
 *   1  Fixture page loads (title contains "Album Upload")
 *   2  Parsed AUTOMATION_REQUEST.md has 0 validation errors
 *   3  Manifest loads with 2 tracks (Pancake Robot)
 *   4  Run plan builds successfully (steps array is non-empty)
 *   5  Executor fills global album title (releaseTitle)
 *   6  Executor fills global artist name and label name correctly
 *   7  Executor records an upload_global step for album artwork
 *   8  Executor uses the existing first track section (verified-exists, no click)
 *   9  Executor fills first track title ("Tiny Robot Parade")
 *  10  Executor records an upload_item step for first track audio
 *  11  Executor creates second track section by clicking repeatAction
 *  12  Executor fills second track title ("Waffle Moon")
 *  13  Executor records an upload_item step for second track audio
 *  14  No item field (track.*) was written into a global-level DOM input
 *  15  No global field source appears inside any per-track fill_item step
 *  16  album.artistName is classified fill_global (not upload) — "Art" word in "artistName" is not a false positive
 *  17  Step execution order matches the run plan (global before iterations)
 *  18  Final human_checkpoint is reached and stored in result
 *  19  Blocked actions list is non-empty
 *  20  No final submit button was clicked (finalState.submitClicked === false)
 *
 * Usage:
 *   node scripts/acceptance-playwright-executor.mjs
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures', 'album-upload');

let passed = 0, failed = 0;
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

import { buildRunPlan }    from '../src/core/run-plan.mjs';
import { parseRequest }    from '../src/core/request-parser.mjs';
import { executeRunPlanWithPlaywright } from '../src/core/playwright-executor.mjs';

// ── Load fixture artifacts ──────────────────────────────────────────────────────

const reqPath      = path.join(FIXTURE_DIR, 'AUTOMATION_REQUEST.md');
const manifestPath = path.join(FIXTURE_DIR, 'manifest.json');
const fixturePath  = path.join(FIXTURE_DIR, 'index.html');

const parsed   = parseRequest(fs.readFileSync(reqPath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const rg       = parsed.repeatGroups[0];
const runPlan  = buildRunPlan(rg, manifest);

// ── Static checks (no browser needed) ──────────────────────────────────────────

section(2, 'Parsed AUTOMATION_REQUEST.md has 0 validation errors');
{
  const errors = parsed.validationIssues.filter(i => i.level === 'error');
  if (errors.length === 0) pass('0 errors from fixture AUTOMATION_REQUEST.md');
  else fail('fixture has validation errors', errors.map(e => e.message).join('; '));
}

section(3, 'Manifest loads with 2 tracks and correct artist');
{
  if (Array.isArray(manifest.tracks) && manifest.tracks.length === 2)
    pass('manifest has 2 tracks');
  else
    fail('manifest track count', 'got: ' + manifest.tracks?.length);
  if (manifest.album?.artistName === 'Pancake Robot')
    pass('manifest artistName = "Pancake Robot"');
  else
    fail('manifest artistName', 'got: ' + manifest.album?.artistName);
}

section(4, 'Run plan builds successfully');
{
  if (Array.isArray(runPlan.steps) && runPlan.steps.length > 0)
    pass('runPlan.steps is non-empty (' + runPlan.steps.length + ' top-level steps)');
  else
    fail('runPlan.steps is empty or missing');
  if (runPlan.warnings.length === 0)
    pass('run plan has 0 warnings');
  else
    fail('run plan has warnings', runPlan.warnings.join('; '));
}

section(16, 'album.artistName classified as fill_global (not upload_global)');
{
  const artistStep = runPlan.steps.find(s => s.source === 'album.artistName');
  if (artistStep?.type === 'fill_global')
    pass('album.artistName → fill_global (no false positive from "Art" in "artistName")');
  else
    fail('album.artistName step type', 'got: ' + artistStep?.type);
}

section(17, 'Step execution order: all globals before first repeat_iteration');
{
  const types = runPlan.steps.map(s => s.type);
  const firstIterIdx = types.indexOf('repeat_iteration');
  const lastGlobalIdx = types.reduce(
    (max, t, i) => (t === 'fill_global' || t === 'upload_global') ? i : max, -1
  );
  if (firstIterIdx > lastGlobalIdx)
    pass('all global steps precede repeat_iterations in run plan');
  else
    fail('global step order violation', `lastGlobal=${lastGlobalIdx}, firstIter=${firstIterIdx}`);
}

section(14, 'No item field source appears in the globalFields list');
{
  const itemPrefix = rg.itemName + '.';
  const contaminated = (rg.globalFields || []).filter(f => f.startsWith(itemPrefix));
  if (contaminated.length === 0)
    pass('no global field starts with item alias "' + rg.itemName + '"');
  else
    fail('cross-contaminated global fields', contaminated.join(', '));
}

section(15, 'No global field source appears inside any fill_item step');
{
  const globalSources = new Set((rg.globalFields || []));
  const iters = runPlan.steps.filter(s => s.type === 'repeat_iteration');
  let ok = true;
  for (const iter of iters) {
    for (const sub of iter.steps) {
      if ((sub.type === 'fill_item' || sub.type === 'upload_item') && globalSources.has(sub.source)) {
        fail(`iter[${iter.itemIndex}] fill_item uses global source "${sub.source}"`);
        ok = false;
      }
    }
  }
  if (ok) pass('no global field source found in any fill_item/upload_item step');
}

// ── Browser execution ───────────────────────────────────────────────────────────

console.log('\n── Running Playwright executor (headless) ──');
const result = await executeRunPlanWithPlaywright({
  runPlan,
  fixturePath,
  manifestBaseDir: FIXTURE_DIR,
  headless: true,
});

if (!result.ok) {
  console.error('\nFATAL: executor returned ok=false — ' + result.error);
  console.error('Executed steps before failure: ' + result.executedSteps.length);
  process.exit(1);
}

const { executedSteps, checkpoint, finalState } = result;

// ── Browser-dependent checks ────────────────────────────────────────────────────

section(1, 'Fixture page loads (page title contains "Album Upload")');
{
  if (finalState?.pageTitle?.includes('Album Upload'))
    pass('page title = "' + finalState.pageTitle + '"');
  else
    fail('page title', 'got: ' + finalState?.pageTitle);
}

section(5, 'Executor fills global album title (releaseTitle)');
{
  const v = finalState?.globalFields?.['releaseTitle'];
  if (v === 'Breakfast Beats')
    pass('releaseTitle = "Breakfast Beats"');
  else
    fail('album.releaseTitle', 'got: ' + v);
}

section(6, 'Executor fills global artist name and label name');
{
  const artist = finalState?.globalFields?.['artistName'];
  const label  = finalState?.globalFields?.['labelName'];
  if (artist === 'Pancake Robot')
    pass('artistName = "Pancake Robot"');
  else
    fail('album.artistName in DOM', 'got: ' + artist);
  if (label === 'Figment Factory')
    pass('labelName = "Figment Factory"');
  else
    fail('album.labelName in DOM', 'got: ' + label);
}

section(7, 'Executor records an upload_global step for album artwork');
{
  const artStep = executedSteps.find(
    s => s.type === 'upload_global' && s.source === 'album.albumArtPath'
  );
  if (artStep)
    pass('upload_global step found for album.albumArtPath (resolvedPath: ' + path.basename(artStep.resolvedPath) + ')');
  else
    fail('no upload_global step for album.albumArtPath', 'executed: ' + JSON.stringify(executedSteps.map(s => s.type + '/' + s.source)));
}

section(8, 'Executor uses the existing first track section (no add-track click)');
{
  const sec0 = executedSteps.find(s => s.type === 'ensure_section' && s.itemIndex === 0);
  if (sec0?.action === 'verified-exists')
    pass('ensure_section[0] action = "verified-exists" (no button click)');
  else
    fail('ensure_section[0] action', 'got: ' + JSON.stringify(sec0));
}

section(9, 'Executor fills first track title ("Tiny Robot Parade")');
{
  const title0 = finalState?.itemSections?.[0]?.trackTitle;
  if (title0 === 'Tiny Robot Parade')
    pass('itemSections[0].trackTitle = "Tiny Robot Parade"');
  else
    fail('tracks[0].trackTitle', 'got: ' + title0);
}

section(10, 'Executor records an upload_item step for first track audio');
{
  const audioStep = executedSteps.find(
    s => s.type === 'upload_item' && s.itemIndex === 0 && s.fieldName === 'audioUpload'
  );
  if (audioStep)
    pass('upload_item[0].audioUpload found (file: ' + path.basename(audioStep.resolvedPath) + ')');
  else
    fail('no upload_item[0].audioUpload step', JSON.stringify(executedSteps.filter(s => s.type === 'upload_item')));
}

section(11, 'Executor creates second track section by clicking repeatAction');
{
  const sec1 = executedSteps.find(s => s.type === 'ensure_section' && s.itemIndex === 1);
  if (sec1?.action === 'clicked-add')
    pass('ensure_section[1] action = "clicked-add" (selector: ' + sec1.selector + ')');
  else
    fail('ensure_section[1] action', 'got: ' + JSON.stringify(sec1));
  if (finalState?.itemSectionCount === 2)
    pass('DOM has exactly 2 item sections after execution');
  else
    fail('DOM track section count', 'got: ' + finalState?.itemSectionCount);
}

section(12, 'Executor fills second track title ("Waffle Moon")');
{
  const title1 = finalState?.itemSections?.[1]?.trackTitle;
  if (title1 === 'Waffle Moon')
    pass('itemSections[1].trackTitle = "Waffle Moon"');
  else
    fail('tracks[1].trackTitle', 'got: ' + title1);
}

section(13, 'Executor records an upload_item step for second track audio');
{
  const audioStep = executedSteps.find(
    s => s.type === 'upload_item' && s.itemIndex === 1 && s.fieldName === 'audioUpload'
  );
  if (audioStep)
    pass('upload_item[1].audioUpload found (file: ' + path.basename(audioStep.resolvedPath) + ')');
  else
    fail('no upload_item[1].audioUpload step', JSON.stringify(executedSteps.filter(s => s.type === 'upload_item')));
}

section(18, 'Final human_checkpoint is reached');
{
  if (checkpoint?.type === 'human_checkpoint')
    pass('result.checkpoint.type = "human_checkpoint"');
  else
    fail('checkpoint', 'got: ' + JSON.stringify(checkpoint));
}

section(19, 'Blocked actions list is non-empty');
{
  if (Array.isArray(checkpoint?.blocked) && checkpoint.blocked.length > 0)
    pass('checkpoint.blocked = [' + checkpoint.blocked.join(', ') + ']');
  else
    fail('checkpoint.blocked', 'got: ' + JSON.stringify(checkpoint?.blocked));
}

section(20, 'No final submit button was clicked');
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

// ── Summary ─────────────────────────────────────────────────────────────────────
console.log(`\n══════════════════════════════════════`);
console.log(`Playwright executor acceptance: ${passed} passed, ${failed} failed`);
console.log(`══════════════════════════════════════`);
if (failed > 0) process.exit(1);
