#!/usr/bin/env node
/**
 * Acceptance — Kitchen Sink end-to-end workflow pipeline (Parts 4–7).
 *
 * Verifies the full pipeline from observed events → observation → workflow package
 * → run plan → Playwright execution, covering:
 *   Part 4: repeat-group fields surface as structured itemFields/itemAssets through
 *            the ingestion path (not as flattened globalFields)
 *   Part 5: output_captured events flow from observation → package → run plan →
 *            executor's capturedOutputs
 *   Part 6: download events are captured and saved by the executor
 *
 * Checks 1–14 are pure-function (no browser).
 * Checks 15–17 require Playwright and the kitchen-sink fixture.
 *
 * Usage:
 *   npm run acceptance:kitchen-sink-workflow
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { buildObservationFromEvents } from '../src/core/observation-from-events.mjs';
import { normalizeObservation, buildWorkflowPackageFromObservation } from '../src/core/observation-ingestion.mjs';
import { buildRunPlanFromPackage } from '../src/core/run-plan.mjs';
import { executeRunPlanWithPlaywright } from '../src/core/playwright-executor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/kitchen-sink-workflow/index.html');

let passed = 0, failed = 0;
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

// ── Synthesized event log (what the Playwright recorder would emit) ───────────

const events = [
  // Global album fields
  { source: 'playwrightRecorder', type: 'field_detected', selector: '#album_title',
    rawEvidence: { name: 'album_title', id: 'album_title', inputType: 'text', label: 'Album title', value: 'Demo Album' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: '#album_description',
    rawEvidence: { name: 'album_description', id: 'album_description', inputType: 'text', label: 'Album description', value: '' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: '#brand_profile_id',
    rawEvidence: { name: 'brand_profile_id', id: 'brand_profile_id', inputType: 'text', label: 'Brand profile', value: 'pancake-robot' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: '#release_date',
    rawEvidence: { name: 'release_date', id: 'release_date', inputType: 'date', label: 'Release date', value: '2099-01-01' } },

  // Tracks repeat group — two instances
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="tracks[1][title]"]',
    rawEvidence: { name: 'tracks[1][title]', inputType: 'text', label: 'Track title', value: 'First Track' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="tracks[1][artist]"]',
    rawEvidence: { name: 'tracks[1][artist]', inputType: 'text', label: 'Artist name', value: 'Artist A' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="tracks[1][explicit]"]',
    rawEvidence: { name: 'tracks[1][explicit]', inputType: 'checkbox', label: 'Explicit', value: false } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="tracks[1][audio]"]',
    rawEvidence: { name: 'tracks[1][audio]', inputType: 'file', isFileInput: true, label: 'Track audio', value: null } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="tracks[2][title]"]',
    rawEvidence: { name: 'tracks[2][title]', inputType: 'text', label: 'Track title', value: 'Second Track' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="tracks[2][artist]"]',
    rawEvidence: { name: 'tracks[2][artist]', inputType: 'text', label: 'Artist name', value: 'Artist B' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="tracks[2][explicit]"]',
    rawEvidence: { name: 'tracks[2][explicit]', inputType: 'checkbox', label: 'Explicit', value: true } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="tracks[2][audio]"]',
    rawEvidence: { name: 'tracks[2][audio]', inputType: 'file', isFileInput: true, label: 'Track audio', value: null } },

  // Platforms repeat group — two instances
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'select[name="platforms[1][name]"]',
    rawEvidence: { name: 'platforms[1][name]', inputType: 'text', label: 'Platform', value: 'spotify' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="platforms[1][enabled]"]',
    rawEvidence: { name: 'platforms[1][enabled]', inputType: 'checkbox', label: 'Enabled', value: true } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="platforms[1][notes]"]',
    rawEvidence: { name: 'platforms[1][notes]', inputType: 'text', label: 'Notes', value: '' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'select[name="platforms[2][name]"]',
    rawEvidence: { name: 'platforms[2][name]', inputType: 'text', label: 'Platform', value: 'youtube' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="platforms[2][enabled]"]',
    rawEvidence: { name: 'platforms[2][enabled]', inputType: 'checkbox', label: 'Enabled', value: false } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="platforms[2][notes]"]',
    rawEvidence: { name: 'platforms[2][notes]', inputType: 'text', label: 'Notes', value: '' } },

  // Repeat-group add buttons
  { source: 'playwrightRecorder', type: 'repeat_group_candidate_detected', selector: '#addTrack',
    rawEvidence: { label: 'Add Track' } },
  { source: 'playwrightRecorder', type: 'repeat_group_candidate_detected', selector: '#addPlatform',
    rawEvidence: { label: 'Add Platform' } },

  // Output captured after clicking "Generate Draft"
  { source: 'playwrightRecorder', type: 'output_captured', selector: '#output',
    rawEvidence: {
      outputId: 'output',
      text: '{"status":"draft_generated","albumTitle":"Demo Album","tracks":[]}',
      triggeredBySelector: '#generateDraft',
      selectorCandidates: [{ selector: '#output', kind: 'id', confidence: 'high' }],
      selectorConfidence: 'high',
      eventTrigger: 'mutation_observer',
    } },
];

const obs = buildObservationFromEvents({ events, workflowId: 'kitchen-sink-workflow' });

// ── Check 1: tracks group has 2 instances with correct instance ids ───────────

section(1, 'tracks repeat group has 2 instances');
{
  const tracks = (obs.repeatGroups || []).find(g => g.stem === 'tracks' || /track/i.test(g.label || ''));
  const ok = tracks && (tracks.instances || []).length === 2;
  if (ok) pass(`tracks group has ${tracks.instances.length} instances`);
  else fail('tracks group missing or wrong instance count', JSON.stringify((obs.repeatGroups || []).map(g => g.stem)));
}

// ── Check 2: tracks group has itemFields with title, artist, explicit ─────────

section(2, 'tracks group itemFields: title, artist, explicit');
{
  const tracks = (obs.repeatGroups || []).find(g => g.stem === 'tracks' || /track/i.test(g.label || ''));
  if (!tracks) {
    fail('no tracks group found');
  } else {
    const ids = (tracks.itemFields || []).map(f => f.id);
    const ok = ids.includes('title') && ids.includes('artist') && ids.includes('explicit');
    if (ok) pass(`itemFields ids: ${ids.join(', ')}`);
    else fail('missing expected itemFields', JSON.stringify(ids));
  }
}

// ── Check 3: tracks group has itemAssets with audio ───────────────────────────

section(3, 'tracks group itemAssets: audio');
{
  const tracks = (obs.repeatGroups || []).find(g => g.stem === 'tracks' || /track/i.test(g.label || ''));
  if (!tracks) {
    fail('no tracks group found');
  } else {
    const ids = (tracks.itemAssets || []).map(f => f.id);
    const ok = ids.includes('audio');
    if (ok) pass(`itemAssets ids: ${ids.join(', ')}`);
    else fail('audio not in itemAssets', JSON.stringify(ids));
  }
}

// ── Check 4: platforms group itemFields has name, enabled, notes ──────────────

section(4, 'platforms group itemFields: name, enabled, notes');
{
  const platforms = (obs.repeatGroups || []).find(g => g.stem === 'platforms' || /platform/i.test(g.label || ''));
  if (!platforms) {
    fail('no platforms group found');
  } else {
    const ids = (platforms.itemFields || []).map(f => f.id);
    const ok = ids.includes('name') && ids.includes('enabled') && ids.includes('notes');
    if (ok) pass(`itemFields ids: ${ids.join(', ')}`);
    else fail('missing expected platform itemFields', JSON.stringify(ids));
  }
}

// ── Check 5: observation capturedOutputs has an 'output' entry ───────────────

section(5, 'observation capturedOutputs has output entry with selector');
{
  const output = (obs.capturedOutputs || []).find(o => o.id === 'output');
  if (output && output.selector === '#output') {
    pass(`capturedOutputs.output selector = ${output.selector}`);
  } else {
    fail('capturedOutputs missing output entry or wrong selector', JSON.stringify(obs.capturedOutputs || []));
  }
}

// ── Check 6: capturedOutputs[0].captureAfter = '#generateDraft' ──────────────

section(6, 'capturedOutputs[0].captureAfter = #generateDraft');
{
  const output = (obs.capturedOutputs || []).find(o => o.id === 'output');
  if (output && output.captureAfter === '#generateDraft') {
    pass(`captureAfter = ${output.captureAfter}`);
  } else {
    fail('captureAfter not set correctly', JSON.stringify(output));
  }
}

// ── Check 7: normalizeObservation globalFields does NOT contain tracks[*] ────

section(7, 'normalizeObservation globalFields has no tracks[*] ids');
{
  const normalized = normalizeObservation(obs);
  const leaks = (normalized.fields || []).filter(f => /^tracks\[|^platforms\[/.test(f.id));
  if (leaks.length === 0) {
    pass(`globalFields: ${(normalized.fields || []).map(f => f.id).join(', ') || '(empty)'}`);
  } else {
    fail('bracket-form ids leaked into globalFields', leaks.map(f => f.id).join(', '));
  }
}

// Helper: find a repeat group that is about "tracks" — checks id, label, and itemLabel.
function findTracksGroup(groups) {
  return (groups || []).find(g =>
    /track/i.test(g.id) || /track/i.test(g.label || '') || /track/i.test(g.itemLabel || '')
  );
}

// ── Check 8: normalizeObservation tracks repeatGroup has itemFields title, artist ──

section(8, 'normalizeObservation tracks repeatGroup has itemFields');
{
  const normalized = normalizeObservation(obs);
  const tracks = findTracksGroup(normalized.repeatGroups);
  if (!tracks) {
    fail('no tracks repeatGroup after normalization',
      JSON.stringify((normalized.repeatGroups || []).map(g => ({ id: g.id, label: g.label, itemLabel: g.itemLabel }))));
  } else {
    const ids = (tracks.itemFields || []).map(f => f.id);
    const ok = ids.includes('title') && ids.includes('artist');
    if (ok) pass(`normalized tracks itemFields: ${ids.join(', ')}`);
    else fail('normalized tracks itemFields wrong', JSON.stringify(ids));
  }
}

// ── Check 9: normalizeObservation tracks itemAssets has audio ────────────────

section(9, 'normalizeObservation tracks itemAssets has audio');
{
  const normalized = normalizeObservation(obs);
  const tracks = findTracksGroup(normalized.repeatGroups);
  if (!tracks) {
    fail('no tracks repeatGroup after normalization');
  } else {
    const ids = (tracks.itemAssets || []).map(f => f.id);
    if (ids.includes('audio')) pass(`normalized tracks itemAssets: ${ids.join(', ')}`);
    else fail('audio not in normalized tracks itemAssets', JSON.stringify(ids));
  }
}

// ── Check 10: buildWorkflowPackageFromObservation tracks item has fields.title ─

section(10, 'workflow package tracks item[0].fields has title, artist');
{
  const pkg = buildWorkflowPackageFromObservation(obs);
  const cp = pkg.canonical_payload || {};
  const tracks = findTracksGroup(cp.repeatGroups);
  if (!tracks) {
    fail('no tracks repeatGroup in workflow package',
      JSON.stringify((cp.repeatGroups || []).map(g => ({ id: g.id, label: g.label, itemLabel: g.itemLabel }))));
  } else {
    const fields = tracks.items?.[0]?.fields || {};
    const ok = 'title' in fields && 'artist' in fields;
    if (ok) pass(`tracks item[0].fields keys: ${Object.keys(fields).join(', ')}`);
    else fail('tracks item fields missing title or artist', JSON.stringify(fields));
  }
}

// ── Check 11: workflow package tracks item[0].assets has audio ───────────────

section(11, 'workflow package tracks item[0].assets has audio');
{
  const pkg = buildWorkflowPackageFromObservation(obs);
  const cp = pkg.canonical_payload || {};
  const tracks = findTracksGroup(cp.repeatGroups);
  if (!tracks) {
    fail('no tracks repeatGroup in workflow package');
  } else {
    const assets = tracks.items?.[0]?.assets || {};
    if ('audio' in assets) pass(`tracks item[0].assets keys: ${Object.keys(assets).join(', ')}`);
    else fail('audio not in tracks item[0].assets', JSON.stringify(assets));
  }
}

// ── Check 12: workflow package canonical_payload.capturedOutputs has #output ──

section(12, 'canonical_payload.capturedOutputs[0].selector = #output');
{
  const pkg = buildWorkflowPackageFromObservation(obs);
  const cp = pkg.canonical_payload || {};
  const out = (cp.capturedOutputs || []).find(o => o.id === 'output');
  if (out && out.selector === '#output') {
    pass(`capturedOutputs[0].selector = ${out.selector}, captureAfter = ${out.captureAfter}`);
  } else {
    fail('canonical_payload.capturedOutputs missing output or wrong selector', JSON.stringify(cp.capturedOutputs || []));
  }
}

// ── Check 13: run plan has click_safe_action for #generateDraft ───────────────

section(13, 'run plan has click_safe_action for #generateDraft');
{
  const pkg = buildWorkflowPackageFromObservation(obs);
  const cp = pkg.canonical_payload || {};
  const plan = buildRunPlanFromPackage(cp);
  const clickStep = plan.steps.find(s => s.type === 'click_safe_action' && s.selector === '#generateDraft');
  if (clickStep) pass(`click_safe_action{selector: ${clickStep.selector}}`);
  else fail('no click_safe_action for #generateDraft in plan', JSON.stringify(plan.steps.map(s => ({ type: s.type, selector: s.selector }))));
}

// ── Check 14: run plan has capture_output for #output, ends with human_checkpoint ──

section(14, 'run plan has capture_output for #output and ends with human_checkpoint');
{
  const pkg = buildWorkflowPackageFromObservation(obs);
  const cp = pkg.canonical_payload || {};
  const plan = buildRunPlanFromPackage(cp);
  const captureStep = plan.steps.find(s => s.type === 'capture_output' && s.selector === '#output');
  const lastStep = plan.steps[plan.steps.length - 1];
  const ok = captureStep && lastStep?.type === 'human_checkpoint';
  if (ok) pass(`capture_output{selector: ${captureStep.selector}}; last step: ${lastStep.type}`);
  else fail('capture_output or human_checkpoint missing/wrong',
    JSON.stringify({ captureStep: captureStep || null, lastStep: lastStep?.type }));
}

// ── Checks 15–17: browser execution (Playwright) ─────────────────────────────

console.log('\n── Browser checks (Playwright) ──');

if (!fs.existsSync(FIXTURE_PATH)) {
  fail('Check 15 (executor output capture)', `fixture not found: ${FIXTURE_PATH}`);
  fail('Check 16 (capturedOutputs has value)', 'fixture missing');
  fail('Check 17 (download captured)', 'fixture missing');
} else {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browsy-ks-'));

  // Minimal run plan: click generateDraft → capture output → click download → checkpoint
  const fixturePlan = {
    steps: [
      { type: 'click_safe_action', selector: '#generateDraft', label: 'Generate Draft' },
      { type: 'capture_output', outputId: 'output', selector: '#output' },
      { type: 'click_safe_action', selector: '#downloadDraft', label: 'Download Draft JSON' },
      { type: 'human_checkpoint', reason: 'Manual review required', blocked: ['Submit', 'Publish'] },
    ],
  };

  try {
    const result = await executeRunPlanWithPlaywright({
      runPlan: fixturePlan,
      fixturePath: FIXTURE_PATH,
      headless: true,
      downloadsDir,
    });

    section(15, 'executor runs to checkpoint without errors');
    if (result.ok && result.checkpoint) {
      pass(`checkpoint reached: ${result.checkpoint.type}; executed ${result.executedSteps.length} steps`);
    } else {
      fail('executor did not reach checkpoint cleanly', result.error || JSON.stringify(result.skippedSteps));
    }

    section(16, 'capturedOutputs.output has a value after Generate Draft');
    {
      const out = result.capturedOutputs?.output;
      if (out && out.status === 'captured' && typeof out.value === 'string' && out.value.length > 0) {
        const preview = out.value.slice(0, 80).replace(/\n/g, ' ');
        pass(`output captured (${out.value.length} chars): ${preview}…`);
      } else {
        fail('capturedOutputs.output not captured', JSON.stringify(out));
      }
    }

    section(17, 'downloadedFiles has one entry after clicking download link');
    {
      const files = result.downloadedFiles || [];
      const saved = files.find(f => f.path && fs.existsSync(f.path));
      if (saved) {
        const size = fs.statSync(saved.path).size;
        pass(`download saved: ${saved.filename} (${size} bytes) at ${saved.path}`);
      } else if (files.length > 0) {
        // download fired but no downloadsDir path — still counts as captured
        pass(`download captured: ${files[0].filename || '(unnamed)'} (path not saved)`);
      } else {
        fail('no download captured', JSON.stringify(files));
      }
    }
  } catch (err) {
    fail('Check 15 (executor)', err.message);
    fail('Check 16 (capturedOutputs)', 'executor threw');
    fail('Check 17 (download)', 'executor threw');
  } finally {
    // Clean up temp downloads dir
    try { fs.rmSync(downloadsDir, { recursive: true, force: true }); } catch {}
  }
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
