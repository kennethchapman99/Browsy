#!/usr/bin/env node
/**
 * Acceptance — DistroKid post-submit chain (fake fixture, headless, no live site)
 *
 * Exercises the NEW end-to-end automation against the local distrokid-wizard
 * fixture: final submit (Continue) → mixea "Use my originals" + Continue → done
 * page → capture the HyperFollow link. Proves the executor's postSubmitSteps
 * interpreter + auto-submit opt-in work without touching a real DistroKid account.
 *
 * Run: node scripts/acceptance-distrokid-postsubmit.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

import { executeRunPlanWithPlaywright } from '../src/core/playwright-executor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIELD_MAP_PATH = path.join(REPO_ROOT, 'workflows', 'distrokid-album-submit', 'field-map.local.json');
const FIXTURE_INDEX = path.join(REPO_ROOT, 'fixtures', 'distrokid-wizard', 'index.html');

const fieldMap = JSON.parse(fs.readFileSync(FIELD_MAP_PATH, 'utf8'));
assert.ok(Array.isArray(fieldMap.postSubmitSteps) && fieldMap.postSubmitSteps.length,
  'field-map must declare postSubmitSteps');
assert.ok(fixtureSelectorsPresent(fieldMap.postSubmitSteps),
  'every postSubmitSteps action must carry a fixtureSelector (except waitForUrl)');

// A minimal run plan: the fill phase is covered by the structural acceptance test
// and the live dry run. Here we jump straight to the checkpoint that triggers the
// post-submit chain.
const runPlan = { steps: [{ type: 'human_checkpoint' }] };

const result = await executeRunPlanWithPlaywright({
  runPlan,
  targetUrl: pathToFileURL(FIXTURE_INDEX).href,
  fieldMap,
  headless: true,
  autoSubmit: true,
  confirmBeforeSubmit: false, // fake site → no human gate needed
  isFixture: true,
});

assert.ok(result.ok, `executor failed: ${result.error}`);
assert.equal(result.postSubmitCompleted, true, 'post-submit chain did not complete');
assert.equal(result.browserLeftOpen, false, 'fixture run must not leave a browser open');

const clicks = result.executedSteps.filter(s => s.type === 'post_submit_click').length;
const checks = result.executedSteps.filter(s => s.type === 'post_submit_check').length;
const waits = result.executedSteps.filter(s => s.type === 'post_submit_waitForUrl').map(s => s.match);
assert.ok(clicks >= 2, `expected >=2 post-submit clicks (submit + mixea continue), got ${clicks}`);
assert.equal(checks, 1, `expected exactly 1 check (Use my originals), got ${checks}`);
assert.deepEqual(waits, ['mixea', 'done'], `expected mixea then done URL waits, got ${JSON.stringify(waits)}`);

const captured = result.capturedOutputs?.hyperfollow_url;
assert.ok(captured && captured.value, 'hyperfollow_url was not captured');
assert.match(captured.value, /^https:\/\/distrokid\.com\/hyperfollow\//,
  `captured HyperFollow URL looks wrong: ${captured.value}`);

console.log('✓ post-submit chain completed on the fake fixture');
console.log('  clicks:', clicks, ' checks:', checks, ' url waits:', waits.join(' → '));
console.log('  captured hyperfollow_url:', captured.value);
console.log('PASS');

function fixtureSelectorsPresent(steps) {
  return steps.every(s => s.type === 'waitForUrl' || typeof s.fixtureSelector === 'string');
}
