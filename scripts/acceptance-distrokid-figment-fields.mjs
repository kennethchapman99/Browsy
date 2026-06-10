#!/usr/bin/env node
/**
 * Acceptance — Figment Factory → DistroKid required fields
 *
 * Loads the REAL workflows/distrokid-album-submit/field-map.local.json and the
 * payload shape Pancake's buildBrowsyRunVariables() produces, then builds the run
 * plan the same way run-plan-executor-adapter.mjs does. Asserts the run plan
 * actually drives the fields the "Distrokid fields" test plan requires:
 *
 *   - Record Label global (labelName) is present.
 *   - All five mandatory agreement checkboxes are filled as globals
 *     (tandc, otherArtist, promoServices, recorded, youtube).
 *   - Per-track AI disclosure + title + audio + credits scale to N tracks.
 *   - The plan always ends at a human_checkpoint (never auto-submits).
 *
 * This guards the cross-repo contract between Pancake's payload and Browsy's
 * field-map without touching real DistroKid.
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { buildRunPlan } from '../src/core/run-plan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIELD_MAP_PATH = path.join(REPO_ROOT, 'workflows', 'distrokid-album-submit', 'field-map.local.json');

const fieldMap = JSON.parse(fs.readFileSync(FIELD_MAP_PATH, 'utf8'));

// Mirror run-plan-executor-adapter.mjs: globals are non-item field sources; item
// fields come from the repeat group.
const rgConfig = fieldMap.repeatGroups?.[0];
assert.ok(rgConfig, 'field-map must declare a repeatGroups entry');

const globalFields = Object.values(fieldMap.fields || {})
  .filter(f => f.source && !f.item)
  .map(f => f.source);

const itemFields = Object.entries(rgConfig.itemFields || {}).map(([name, def]) => ({
  name,
  source: def.source,
}));

const repeatGroup = {
  name: rgConfig.id,
  source: `${rgConfig.id}[]`,
  itemName: rgConfig.itemName || rgConfig.id.replace(/s$/, ''),
  globalFields,
  itemFields,
  repeatAction: rgConfig.createAction || null,
};

// A representative payload shaped like Pancake's buildBrowsyRunVariables() output,
// for an N-track album. N is intentionally > the 3 tracks that were recorded, to
// prove the repeat group scales to any track count.
function buildPayload(trackCount) {
  const tracks = Array.from({ length: trackCount }, (_, i) => ({
    songId: `SONG_${i + 1}`,
    title: `Track ${i + 1}`,
    trackNumber: i + 1,
    audioPath: `/tmp/songs/SONG_${i + 1}/audio/${i + 1} - Track ${i + 1}.mp3`,
    songwriterFirst: 'Kenneth',
    songwriterLast: 'Chapman',
    performerName: 'Figment Factory',
    performerRole: 'Performer',
    producerName: 'Kenneth Chapman',
    producerRole: 'Executive Producer',
    aiGate: '1',
    aiRecordingScope: 'full',
  }));
  return {
    howmanysongs: trackCount,
    artworkPath: '/tmp/release-packages/ALBUM_FF/cover-art.png',
    inputs: { albumtitle: 'Figment Factory' },
    album: {
      releaseDate: '2026-09-01',
      primaryGenre: 'Alternative',
      labelName: 'Figment Factory',
    },
    agreements: {
      tandc: true,
      otherArtist: true,
      promoServices: true,
      recorded: true,
      youtube: true,
    },
    tracks,
  };
}

function fillGlobalFor(plan, lastSegment) {
  return plan.steps.find(s => s.type === 'fill_global' && String(s.source).split('.').pop() === lastSegment);
}

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

console.log('Figment Factory → DistroKid required-fields acceptance');

for (const trackCount of [1, 3, 12]) {
  console.log(`\nAlbum with ${trackCount} track(s):`);
  const { steps, warnings } = buildRunPlan(repeatGroup, buildPayload(trackCount));
  const plan = { steps, warnings };

  check('Record Label (labelName) filled as a global = "Figment Factory"', () => {
    const step = fillGlobalFor(plan, 'labelName');
    assert.ok(step, 'expected a fill_global for labelName');
    assert.equal(step.value, 'Figment Factory');
  });

  check('Primary genre global = "Alternative"', () => {
    const step = fillGlobalFor(plan, 'primaryGenre');
    assert.ok(step, 'expected a fill_global for primaryGenre');
    assert.equal(step.value, 'Alternative');
  });

  check('All five agreement checkboxes filled as globals (value true)', () => {
    for (const seg of ['tandc', 'otherArtist', 'promoServices', 'recorded', 'youtube']) {
      const step = fillGlobalFor(plan, seg);
      assert.ok(step, `expected a fill_global for agreement "${seg}"`);
      assert.equal(step.value, true, `agreement "${seg}" must be checked`);
    }
  });

  check(`one repeat_iteration per track (×${trackCount}) with AI disclosure + title + audio`, () => {
    const iterations = steps.filter(s => s.type === 'repeat_iteration');
    assert.equal(iterations.length, trackCount);
    for (const iter of iterations) {
      const subTypes = iter.steps.map(s => `${s.type}:${s.fieldName || ''}`);
      assert.ok(iter.steps.some(s => s.fieldName === 'aiDisclosure' && s.value === '1'), 'AI gate forced to all-audio per track');
      assert.ok(iter.steps.some(s => s.fieldName === 'trackTitle'), 'track title filled');
      assert.ok(iter.steps.some(s => s.fieldName === 'trackAudio' && s.type === 'upload_item'), 'track audio uploaded');
      assert.ok(subTypes.length > 3);
    }
  });

  check('plan ends at a human_checkpoint (never auto-submits)', () => {
    const last = steps[steps.length - 1];
    assert.equal(last.type, 'human_checkpoint');
  });

  check('all fill/upload globals precede the first repeat_iteration', () => {
    const firstIter = steps.findIndex(s => s.type === 'repeat_iteration');
    const lastGlobal = steps.reduce((max, s, i) => (s.type === 'fill_global' || s.type === 'upload_global') ? i : max, -1);
    assert.ok(firstIter === -1 || lastGlobal < firstIter, 'globals must precede iterations');
  });
}

console.log(`\nAll ${passed} checks passed.`);
