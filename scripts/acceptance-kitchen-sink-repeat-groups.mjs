#!/usr/bin/env node
/**
 * Acceptance — Kitchen Sink repeat-group materialisation.
 *
 * Locks down the fix for the regression diagnosed during the Workflow Library
 * sprint: when the Kitchen Sink fixture is observed, fields named
 *   tracks[1][title], tracks[2][title], platforms[1][name], ...
 * must materialise as proper repeat-group instances — not as flattened global
 * fields like `tracks1Title` / `platforms2Name`.
 *
 * Checks:
 *  1   `tracks[N][title]` bracket ids cluster into a single `tracks` group
 *      with two instances (1 and 2), preserving every per-instance field +
 *      asset.
 *  2   `platforms[N][name]` clusters into a `platforms` group with at least
 *      two instances.
 *  3   Camel-case collapsed ids (`tracks1Title`) also cluster into the same
 *      `tracks` stem (lossy normalizer pass-through).
 *  4   No clustered field id remains in `globalFields` / `globalAssets`
 *      after building the observation — they belong inside their instance,
 *      not double-counted in globals.
 *  5   "Add Track" / "Add Platform" (capitalised noun, no "another"/"more")
 *      register as repeat-group buttons via the relaxed heuristic.
 *  6   Singletons (one `_1` with no `_2` sibling) are still NOT promoted.
 *
 * Usage:
 *   npm run acceptance:kitchen-sink-repeat-groups
 */

import {
  buildObservationFromEvents,
  inferRepeatGroupInstances,
  isLikelyAddInstanceAction,
} from '../src/core/observation-from-events.mjs';

let passed = 0, failed = 0;
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

// Synthesize the events the Playwright recorder would emit while a user
// fills out the kitchen-sink form. Two tracks + two platforms + two add
// buttons + one global album field, no global pollution.
const events = [
  { source: 'playwrightRecorder', type: 'field_detected', selector: '#album_title', rawEvidence: { name: 'album_title', id: 'album_title', inputType: 'text', label: 'Album title', value: 'Demo' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="tracks[1][title]"]',  rawEvidence: { name: 'tracks[1][title]',  inputType: 'text',     label: 'Track title',  value: 'One' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="tracks[1][artist]"]', rawEvidence: { name: 'tracks[1][artist]', inputType: 'text',     label: 'Artist name',  value: 'A' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="tracks[1][audio]"]',  rawEvidence: { name: 'tracks[1][audio]',  inputType: 'file', isFileInput: true, label: 'Track audio',  value: null } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="tracks[2][title]"]',  rawEvidence: { name: 'tracks[2][title]',  inputType: 'text',     label: 'Track title',  value: 'Two' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="tracks[2][artist]"]', rawEvidence: { name: 'tracks[2][artist]', inputType: 'text',     label: 'Artist name',  value: 'B' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'input[name="tracks[2][audio]"]',  rawEvidence: { name: 'tracks[2][audio]',  inputType: 'file', isFileInput: true, label: 'Track audio',  value: null } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'select[name="platforms[1][name]"]',rawEvidence: { name: 'platforms[1][name]', inputType: 'text', label: 'Platform', value: 'spotify' } },
  { source: 'playwrightRecorder', type: 'field_detected', selector: 'select[name="platforms[2][name]"]',rawEvidence: { name: 'platforms[2][name]', inputType: 'text', label: 'Platform', value: 'youtube' } },
  { source: 'playwrightRecorder', type: 'repeat_group_candidate_detected', selector: '#addTrack',    rawEvidence: { label: 'Add Track' } },
  { source: 'playwrightRecorder', type: 'repeat_group_candidate_detected', selector: '#addPlatform', rawEvidence: { label: 'Add Platform' } },
];

const obs = buildObservationFromEvents({ events, workflowId: 'kitchen-sink-workflow' });

section(1, 'tracks[N][...] bracket ids cluster into a `tracks` group with 2 instances');
{
  const tracks = (obs.repeatGroups || []).find(g => g.stem === 'tracks' || /^Inferred repeat group: tracks$/.test(g.label) || /track/i.test(g.label));
  if (!tracks) {
    fail('no tracks repeat group found', JSON.stringify((obs.repeatGroups || []).map(g => ({ stem: g.stem, label: g.label }))));
  } else {
    const inst1 = (tracks.instances || []).find(i => i.index === 1);
    const inst2 = (tracks.instances || []).find(i => i.index === 2);
    const hasBothInstances = inst1 && inst2;
    const inst1Fields = inst1 ? inst1.fields.concat(inst1.assets) : [];
    const inst2Fields = inst2 ? inst2.fields.concat(inst2.assets) : [];
    const inst1Ok = inst1Fields.includes('tracks[1][title]')
      && inst1Fields.includes('tracks[1][artist]')
      && inst1Fields.includes('tracks[1][audio]');
    const inst2Ok = inst2Fields.includes('tracks[2][title]')
      && inst2Fields.includes('tracks[2][artist]')
      && inst2Fields.includes('tracks[2][audio]');
    if (hasBothInstances && inst1Ok && inst2Ok) {
      pass(`tracks group has 2 instances; inst1=[${inst1Fields.join(', ')}], inst2=[${inst2Fields.join(', ')}]`);
    } else {
      fail('tracks cluster shape wrong', JSON.stringify({ inst1, inst2 }));
    }
  }
}

section(2, 'platforms[N][...] bracket ids cluster into a `platforms` group with ≥2 instances');
{
  const platforms = (obs.repeatGroups || []).find(g => g.stem === 'platforms' || /platform/i.test(g.label || ''));
  if (!platforms) {
    fail('no platforms repeat group found', JSON.stringify((obs.repeatGroups || []).map(g => ({ stem: g.stem, label: g.label }))));
  } else if ((platforms.instances || []).length >= 2) {
    pass(`platforms group has ${platforms.instances.length} instance(s)`);
  } else {
    fail('platforms cluster missing instances', JSON.stringify(platforms));
  }
}

section(3, 'Camel-case collapsed ids (tracks1Title) also cluster into the `tracks` stem');
{
  const camelGroups = inferRepeatGroupInstances({
    globalFields: [
      { id: 'tracks1Title',  scope: 'global' },
      { id: 'tracks1Artist', scope: 'global' },
      { id: 'tracks2Title',  scope: 'global' },
      { id: 'tracks2Artist', scope: 'global' },
    ],
    globalAssets: [],
  });
  const tracks = camelGroups.find(g => g.stem === 'tracks');
  if (tracks && (tracks.instances || []).length === 2) {
    pass(`camelCase ids cluster into 2 instances under stem=tracks (bases: ${tracks.fieldStems.join(', ')})`);
  } else {
    fail('camelCase ids did not cluster', JSON.stringify(camelGroups));
  }
}

section(4, 'No clustered id remains in globalFields / globalAssets');
{
  const ids = [...obs.globalFields, ...obs.globalAssets].map(f => f.id);
  const leaks = ids.filter(id => /^tracks\[|^platforms\[|^tracks\d+[A-Z]|^platforms\d+[A-Z]/.test(id));
  if (leaks.length === 0) {
    pass(`globals contain ${ids.length} entry/ies, none from a repeat-group instance: ${ids.join(', ') || '(none)'}`);
  } else {
    fail('clustered ids leaked into globals', `leaks: ${leaks.join(', ')}`);
  }
}

section(5, '"Add Track" / "Add Platform" register as repeat-group buttons');
{
  const both = isLikelyAddInstanceAction('Add Track') && isLikelyAddInstanceAction('Add Platform');
  if (both) pass('isLikelyAddInstanceAction accepts bare capitalised nouns');
  else fail('isLikelyAddInstanceAction rejected Add Track or Add Platform', JSON.stringify({
    addTrack: isLikelyAddInstanceAction('Add Track'),
    addPlatform: isLikelyAddInstanceAction('Add Platform'),
  }));
  // Negative — navigation labels with "Add" must still be rejected.
  if (!isLikelyAddInstanceAction('Next: Add Track')) {
    pass('navigation prefix still blocks repeat-group classification');
  } else {
    fail('navigation prefix wrongly accepted');
  }
}

section(6, 'Singletons (no _2 sibling) are still NOT promoted to repeat groups');
{
  const singleton = inferRepeatGroupInstances({
    globalFields: [{ id: 'thing_1', scope: 'global' }, { id: 'widget[1][name]', scope: 'global' }],
    globalAssets: [],
  });
  if (singleton.length === 0) pass('singletons remain unclustered');
  else fail('singletons promoted to repeat groups', JSON.stringify(singleton));
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
