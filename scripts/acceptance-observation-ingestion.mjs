#!/usr/bin/env node
/**
 * Acceptance test: observation ingestion.
 *
 * Proves a generic browser/narrated observation can become Browsy artifacts
 * without vendor-specific core logic.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeObservation,
  inferRepeatGroups,
  inferRuntimeVariables,
  inferCapturedOutputs,
  buildWorkflowPackageFromObservation,
  buildWorkflowConfigFromObservation,
  buildRunPlanFromObservation,
} from '../src/core/observation-ingestion.mjs';
import {
  validateWorkflowPackage,
  RETURN_CONTRACT_VERSION,
} from '../src/core/workflow-contract.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const fixturePath = path.join(REPO_ROOT, 'fixtures', 'observed-album-workflow', 'observation.json');

let passed = 0;
let failed = 0;

function pass(label) { passed++; console.log('PASS  ' + label); }
function fail(label, detail = '') { failed++; console.error('FAIL  ' + label + (detail ? '\n      ' + detail : '')); }
function check(label, fn) { try { fn(); pass(label); } catch (err) { fail(label, err.message); } }
function section(title) { console.log('\n── ' + title + ' ──'); }

const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const obs = normalizeObservation(raw);
const repeatGroups = inferRepeatGroups(obs);
const runtime = inferRuntimeVariables(obs);
const outputs = inferCapturedOutputs(obs);
const pkg = buildWorkflowPackageFromObservation(obs);
const workflow = buildWorkflowConfigFromObservation(obs);
const runPlan = buildRunPlanFromObservation(obs);

section('normalized observation');

check('extracts workflowId', () => {
  assert.equal(obs.workflowId, 'observed-album-upload');
});

check('normalizes observed pages', () => {
  assert.equal(obs.pages.length, 2);
  assert.ok(obs.pages.some(page => page.id === 'albumCreate'));
  assert.ok(obs.pages.some(page => page.id === 'releaseDetail'));
});

check('extracts global fields', () => {
  const fieldIds = obs.fields.map(field => field.id);
  assert.ok(fieldIds.includes('albumTitle'));
  assert.ok(fieldIds.includes('artistName'));
  assert.ok(fieldIds.includes('releaseDate'));
  assert.ok(fieldIds.includes('primaryGenre'));
});

check('extracts global assets', () => {
  const cover = obs.fields.find(field => field.id === 'albumCover');
  assert.equal(cover.inputType, 'file');
  assert.equal(cover.scope, 'asset');
});

check('extracts shared defaults', () => {
  const songwriter = obs.fields.find(field => field.id === 'songwriter');
  assert.equal(songwriter.scope, 'default');
});

section('repeat groups');

check('detects repeat group', () => {
  assert.equal(repeatGroups.length, 1);
  assert.equal(repeatGroups[0].id, 'tracks');
  assert.equal(repeatGroups[0].itemLabel, 'track');
});

check('maps repeated item fields', () => {
  const names = repeatGroups[0].itemFields.map(field => field.id);
  assert.ok(names.includes('trackTitle'));
  assert.ok(names.includes('trackNumber'));
  assert.ok(names.includes('explicitLyrics'));
});

check('maps repeated item assets', () => {
  const assets = repeatGroups[0].itemAssets.map(asset => asset.id);
  assert.ok(assets.includes('audioFile'));
  assert.equal(repeatGroups[0].itemAssets.find(asset => asset.id === 'audioFile').inputType, 'file');
});

check('detects add-item action', () => {
  assert.equal(repeatGroups[0].addAction.id, 'addTrack');
  assert.equal(repeatGroups[0].addAction.targetRepeatGroup, 'tracks');
});

section('runtime variables and captured outputs');

check('detects captured output', () => {
  assert.ok(outputs.some(output => output.id === 'publicReleaseUrl'));
  assert.equal(outputs.find(output => output.id === 'publicReleaseUrl').scope, 'external_link');
});

check('turns generated URL / ID into runtime variable', () => {
  const releaseId = runtime.captured.find(v => v.name === 'releaseId');
  assert.ok(releaseId);
  assert.equal(releaseId.source, 'current_url');
  assert.equal(releaseId.captureAfter, 'create-release');
});

check('derives URL templates when possible', () => {
  const derived = runtime.derived.find(v => v.name === 'releaseDetailUrl');
  assert.ok(derived);
  assert.equal(derived.template, 'https://example.invalid/releases/{{releaseId}}');
});

check('captures selector_attribute outputs', () => {
  const publicLink = runtime.captured.find(v => v.name === 'publicReleaseUrl');
  assert.ok(publicLink);
  assert.equal(publicLink.source, 'selector_attribute');
  assert.equal(publicLink.attribute, 'href');
});

section('workflow package');

check('emits envelope conforming to workflow package contract', () => {
  assert.equal(pkg.workflow_id, 'observed-album-upload');
  assert.equal(pkg.source_system, 'external_client');
  assert.equal(pkg.entity_type, 'workflow');
  assert.equal(typeof pkg.entity_id, 'string');
  assert.ok(pkg.entity_id.length > 0);
  assert.equal(pkg.mode, 'dry_run');
  assert.equal(pkg.return_contract_version, RETURN_CONTRACT_VERSION);
  assert.equal(pkg.on_failure, 'stop_and_return_blocked_result');
  // Validate against the live runtime contract.
  const v = validateWorkflowPackage(pkg);
  assert.equal(v.ok, true, `validateWorkflowPackage rejected: ${JSON.stringify(v.errors)}`);
});

check('assets is an ARRAY (not an id→path object) per the contract', () => {
  assert.ok(Array.isArray(pkg.assets), 'assets must be an array');
  // Observed album fixture has a global cover asset + a per-track audio asset
  const cover = pkg.assets.find(a => a.role === 'albumCover');
  assert.ok(cover, `expected albumCover entry — got ${JSON.stringify(pkg.assets)}`);
  assert.equal(cover.path, './album-cover.png');
  const audio = pkg.assets.find(a => a.role === 'audioFile');
  assert.ok(audio, `expected audioFile entry — got ${JSON.stringify(pkg.assets)}`);
  assert.equal(audio.repeat_group, 'tracks');
});

check('capture_outputs is an array of names per the contract', () => {
  assert.ok(Array.isArray(pkg.capture_outputs));
  assert.ok(pkg.capture_outputs.includes('releaseId'));
  assert.ok(pkg.capture_outputs.includes('publicReleaseUrl'));
});

check('canonical_payload retains observation-derived structure', () => {
  const cp = pkg.canonical_payload;
  assert.ok(cp && typeof cp === 'object');
  assert.equal(cp.globals.albumTitle, 'Sunrise Sessions');
  assert.equal(cp.globals.artistName, 'Example Artist');
  assert.equal(cp.globals.releaseDate, '2099-06-01');
  assert.equal(cp.assets.albumCover, './album-cover.png');
  assert.equal(cp.defaults.songwriter, 'Example Artist');
  assert.ok(Array.isArray(cp.repeatGroups));
  const item = cp.repeatGroups[0].items[0];
  assert.equal(item.fields.trackTitle, 'Morning Light');
  assert.equal(item.fields.trackNumber, 1);
  assert.equal(item.assets.audioFile, './tracks/01-morning-light.wav');
  assert.ok(cp.capturedOutputs.some(output => output.id === 'releaseId'));
  assert.ok(cp.capturedOutputs.some(output => output.id === 'publicReleaseUrl'));
});

section('workflow config');

check('emits workflow.json-compatible runtime variable shape', () => {
  assert.equal(workflow.workflowId, 'observed-album-upload');
  assert.ok(workflow.runtimeVariables);
  assert.ok(Array.isArray(workflow.runtimeVariables.input));
  assert.ok(Array.isArray(workflow.runtimeVariables.captured));
  assert.ok(Array.isArray(workflow.runtimeVariables.derived));
});

check('preserves manual checkpoints', () => {
  assert.ok(workflow.humanCheckpoints.some(c => c.id === 'reviewBeforeFinalSubmit'));
  assert.ok(workflow.humanCheckpoints.some(c => c.id === 'reviewCapturedPublicLink'));
});

check('flags dangerous/final actions as manual-only', () => {
  assert.ok(workflow.manualOnlyActions.some(action => action.id === 'finalSubmit'));
  assert.ok(workflow.safetyPolicy.never_click_text.includes('Submit release to stores'));
});

section('run plan');

check('emits readable run-plan markdown', () => {
  assert.ok(runPlan.includes('# Run Plan: Observed album upload'));
  assert.ok(runPlan.includes('## Pages / states observed'));
  assert.ok(runPlan.includes('## Repeat groups'));
  assert.ok(runPlan.includes('## Runtime variables'));
  assert.ok(runPlan.includes('## Human checkpoints / manual-only actions'));
});

check('run plan includes core observed concepts', () => {
  assert.ok(runPlan.includes('albumTitle'));
  assert.ok(runPlan.includes('albumCover'));
  assert.ok(runPlan.includes('tracks'));
  assert.ok(runPlan.includes('releaseId'));
  assert.ok(runPlan.includes('publicReleaseUrl'));
});

section('vendor neutrality');

check('fixture proves no vendor-specific strings are required', () => {
  const serialized = JSON.stringify(raw).toLowerCase();
  assert.equal(serialized.includes('distrokid'), false);
  assert.equal(serialized.includes('pancake'), false);
  assert.equal(serialized.includes('pancakerobot'), false);
});

check('core outputs do not inject vendor-specific strings', () => {
  const serialized = JSON.stringify({ pkg, workflow, runPlan }).toLowerCase();
  assert.equal(serialized.includes('distrokid'), false);
  assert.equal(serialized.includes('pancake'), false);
  assert.equal(serialized.includes('pancakerobot'), false);
});

check('exports are callable independently', () => {
  const minimal = normalizeObservation({ title: 'Simple Upload', fields: [{ label: 'Title' }] });
  assert.equal(minimal.workflowId, 'simple-upload');
  const minimalPkg = buildWorkflowPackageFromObservation(minimal);
  assert.equal(minimalPkg.workflow_id, 'simple-upload');
  assert.equal(minimalPkg.canonical_payload.globals.title, 'Example Title');
  assert.ok(Array.isArray(minimalPkg.assets));
  // Even with no assets, validateWorkflowPackage must accept the package.
  const v = validateWorkflowPackage(minimalPkg);
  assert.equal(v.ok, true, `validateWorkflowPackage rejected minimal: ${JSON.stringify(v.errors)}`);
});

console.log('');
if (failed === 0) {
  console.log(`PASS: acceptance-observation-ingestion — ${passed} checks passed.`);
} else {
  console.error(`FAIL: ${failed} check(s) failed (${passed} passed).`);
  process.exit(1);
}
