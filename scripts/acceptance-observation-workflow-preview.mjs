#!/usr/bin/env node
/**
 * Acceptance — observation → automation handoff hardening.
 *
 * Locks down the Sprint-3 hardening slice:
 *   1  Event dedupe collapses input/change pairs and redundant initial-scan
 *      candidates without losing meaningful changes.
 *   2  Tightened heuristics drop the known false positives:
 *        - "Next: add tracks →" must NOT become a repeat group.
 *        - "Review release →" must NOT become a dangerous action.
 *      While the real signals survive:
 *        - "+ Add another track" is a repeat group.
 *        - "Submit & Publish Release" is a dangerous action.
 *   3  Repeat-group instances are modeled — the realistic fixture should
 *      surface a `tracks` group with two structured instances, each carrying
 *      its child fields and assets.
 *   4  Suggested assertions cover manual-only actions and required fields.
 *   5  Pages carry evidence metadata (screenshots either present or marked
 *      explicitly unavailable).
 *   6  The markdown preview is written to docs/fixtures and contains every
 *      major section a human reviewer needs.
 *   7  Pure heuristic unit tests (isHardDangerous, isLikelyAddInstanceAction).
 *   8  Conversion is still deterministic and shape-compatible (the
 *      observation-real-world acceptance test still passes its 12 checks).
 *
 * Usage:
 *   npm run acceptance:observation-workflow-preview
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildObservationFromEvents,
  normalizeAndDedupeEvents,
  isHardDangerous,
  isLikelyAddInstanceAction,
  inferRepeatGroupInstances,
} from '../src/core/observation-from-events.mjs';
import { renderObservationPreview } from '../src/core/observation-preview.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'docs', 'fixtures', 'observation-realistic-upload-events.json');
const PREVIEW_OUT_PATH = path.join(REPO_ROOT, 'docs', 'fixtures', 'observation-realistic-upload-preview.md');

let passed = 0, failed = 0;
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') { console.error('FAIL  ' + label + (detail ? '\n      ' + detail : '')); failed++; }
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

// ── Load the golden ──────────────────────────────────────────────────────────
let events;
try {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  events = golden.events || [];
  if (events.length === 0) throw new Error('events array empty');
} catch (e) {
  console.error('FATAL: cannot load golden — ' + e.message);
  process.exit(1);
}

const obs = buildObservationFromEvents({
  events,
  workflowId: 'observation-realistic-upload',
  sourceUrl: '/fixtures/observation-realistic-upload/release.html',
  capturedAt: '2026-05-25T00:00:00.000Z',
  captureSource: 'playwrightRecorder',
});

// ── Check 1: dedupe collapses noise ──────────────────────────────────────────
section(1, 'Event dedupe drops redundant field/candidate pairs');
{
  const deduped = normalizeAndDedupeEvents(events);
  const rawFieldCount = events.filter(e => e.type === 'field_detected').length;
  const dedupedFieldCount = deduped.filter(e => e.type === 'field_detected').length;
  const rawRepeatCount = events.filter(e => e.type === 'repeat_group_candidate_detected').length;
  const dedupedRepeatCount = deduped.filter(e => e.type === 'repeat_group_candidate_detected').length;
  const rawDangerousCount = events.filter(e => e.type === 'dangerous_action_candidate_detected').length;
  const dedupedDangerousCount = deduped.filter(e => e.type === 'dangerous_action_candidate_detected').length;

  // Field dedupe — every typed text field has a duplicate input+change pair
  // in the golden; we expect at least some collapse.
  if (dedupedFieldCount >= rawFieldCount) {
    fail('field_detected dedupe did not reduce count', `raw=${rawFieldCount} deduped=${dedupedFieldCount}`);
  } else {
    pass(`field_detected: ${rawFieldCount} → ${dedupedFieldCount} (dropped ${rawFieldCount - dedupedFieldCount})`);
  }
  if (dedupedRepeatCount > rawRepeatCount) fail('repeat dedupe inflated count');
  else pass(`repeat_group_candidate_detected: ${rawRepeatCount} → ${dedupedRepeatCount}`);
  if (dedupedDangerousCount > rawDangerousCount) fail('dangerous dedupe inflated count');
  else pass(`dangerous_action_candidate_detected: ${rawDangerousCount} → ${dedupedDangerousCount}`);

  // Meaningful changes survive — synthesize a 3-event sequence where the
  // user genuinely changes the value between events. Dedupe must keep all
  // three when values differ.
  const synth = [
    { id: 'a', sessionId: 's', timestamp: '+0', source: 'playwrightRecorder', type: 'field_detected', selector: '#title', rawEvidence: { name: 'title', id: 'title', inputType: 'text', value: 'Tin', required: true } },
    { id: 'b', sessionId: 's', timestamp: '+1', source: 'playwrightRecorder', type: 'field_detected', selector: '#title', rawEvidence: { name: 'title', id: 'title', inputType: 'text', value: 'Tin', required: true } },
    { id: 'c', sessionId: 's', timestamp: '+2', source: 'playwrightRecorder', type: 'field_detected', selector: '#title', rawEvidence: { name: 'title', id: 'title', inputType: 'text', value: 'Tiny Robot', required: true } },
  ];
  const synthDeduped = normalizeAndDedupeEvents(synth);
  if (synthDeduped.length === 2 && synthDeduped[0].rawEvidence.value === 'Tin' && synthDeduped[1].rawEvidence.value === 'Tiny Robot') {
    pass('value change between events is preserved (3 raw → 2 deduped, distinct values)');
  } else {
    fail('value change not preserved', JSON.stringify(synthDeduped.map(e => e.rawEvidence.value)));
  }
}

// ── Check 2: heuristics drop false positives ─────────────────────────────────
section(2, 'Tightened heuristics drop "Next: add tracks →" + "Review release →"');
{
  const repeatLabels = (obs.repeatGroups || []).map(g => g.label);
  const dangerousLabels = (obs.manualOnlyActions || []).map(a => a.label);

  const hasAddAnother = repeatLabels.some(l => /add another track/i.test(l));
  const hasNextAddTracks = repeatLabels.some(l => /next:?\s*add tracks/i.test(l));
  hasAddAnother && !hasNextAddTracks
    ? pass(`repeat groups: ${repeatLabels.join(' | ')} (no nav false positive)`)
    : fail('repeat-group heuristic wrong', `hasAddAnother=${hasAddAnother} hasNextAddTracks=${hasNextAddTracks} labels=${JSON.stringify(repeatLabels)}`);

  const hasPublishRelease = dangerousLabels.some(l => /submit\s*&?\s*publish/i.test(l));
  const hasReviewRelease = dangerousLabels.some(l => /^review release/i.test(l));
  hasPublishRelease && !hasReviewRelease
    ? pass(`dangerous: ${dangerousLabels.join(' | ')} (no nav false positive)`)
    : fail('dangerous heuristic wrong', `hasPublishRelease=${hasPublishRelease} hasReviewRelease=${hasReviewRelease} labels=${JSON.stringify(dangerousLabels)}`);
}

// ── Check 3: repeat-group instance modeling ──────────────────────────────────
section(3, 'Repeat-group instances are modeled from `track_*_<n>` naming');
{
  const tracks = (obs.repeatGroups || []).find(g => /track/i.test(g.label || '') || g.itemLabel === 'track');
  if (!tracks) {
    fail('no tracks repeat group found', JSON.stringify((obs.repeatGroups || []).map(g => g.label)));
  } else {
    const instanceOk = Array.isArray(tracks.instances) && tracks.instances.length === 2;
    const inst1 = tracks.instances && tracks.instances.find(i => i.index === 1);
    const inst2 = tracks.instances && tracks.instances.find(i => i.index === 2);
    const inst1HasFields = inst1 && inst1.fields.includes('track_title_1') && inst1.fields.includes('track_isrc_1');
    const inst1HasAsset = inst1 && inst1.assets.includes('track_audio_1');
    const inst2HasFields = inst2 && inst2.fields.includes('track_title_2') && inst2.fields.includes('track_isrc_2');
    const inst2HasAsset = inst2 && inst2.assets.includes('track_audio_2');
    const stemsOk = tracks.fieldStems && tracks.fieldStems.length >= 3;
    if (instanceOk && inst1HasFields && inst1HasAsset && inst2HasFields && inst2HasAsset && stemsOk) {
      pass(`tracks group has ${tracks.instances.length} instances; instance 1 fields=${inst1.fields.join(',')} asset=${inst1.assets.join(',')}; instance 2 fields=${inst2.fields.join(',')} asset=${inst2.assets.join(',')}`);
    } else {
      fail('instance modeling incomplete', JSON.stringify({
        instanceCount: tracks.instances?.length,
        inst1, inst2, fieldStems: tracks.fieldStems,
      }));
    }
  }

  // Standalone unit on inferRepeatGroupInstances.
  const synthGroups = inferRepeatGroupInstances({
    globalFields: [{ id: 'speaker_name_1', scope: 'global' }, { id: 'speaker_name_2', scope: 'global' }, { id: 'speaker_bio_1', scope: 'global' }, { id: 'speaker_bio_2', scope: 'global' }],
    globalAssets: [{ id: 'speaker_photo_1', scope: 'asset' }, { id: 'speaker_photo_2', scope: 'asset' }],
  });
  const sg = synthGroups.find(g => g.stem === 'speaker');
  sg && sg.instances.length === 2 && sg.instances[0].assets.includes('speaker_photo_1')
    ? pass('inferRepeatGroupInstances clusters generic <stem>_<n> fields correctly')
    : fail('inferRepeatGroupInstances generic clustering failed', JSON.stringify(synthGroups));

  // Negative — a single _1 field is NOT a repeat group.
  const singleton = inferRepeatGroupInstances({
    globalFields: [{ id: 'thing_1', scope: 'global' }],
    globalAssets: [],
  });
  singleton.length === 0
    ? pass('inferRepeatGroupInstances ignores singletons (no _2 sibling)')
    : fail('inferRepeatGroupInstances treated singleton as group', JSON.stringify(singleton));
}

// ── Check 4: suggested assertions ────────────────────────────────────────────
section(4, 'Suggested assertions cover manual actions, required fields, and pages');
{
  const assertions = obs.suggestedAssertions || [];
  const byKind = assertions.reduce((m, a) => { (m[a.kind] = m[a.kind] || []).push(a); return m; }, {});
  const hasManualPresence = (byKind['manual-action-presence'] || []).some(a => /Submit\s*&?\s*Publish/i.test(a.label));
  const hasRequiredField = (byKind['required-field-value'] || []).some(a => /release_title|release title/i.test(a.label) || a.id === 'required_field_release_title');
  const hasPageMatch = (byKind['page-title-match'] || []).length >= 1;
  hasManualPresence && hasRequiredField && hasPageMatch
    ? pass(`assertions: manual-action-presence=${byKind['manual-action-presence']?.length || 0}, required-field-value=${byKind['required-field-value']?.length || 0}, page-title-match=${byKind['page-title-match']?.length || 0}, total=${assertions.length}`)
    : fail('assertion coverage missing', JSON.stringify({ hasManualPresence, hasRequiredField, hasPageMatch, kinds: Object.keys(byKind) }));

  // output_candidate_detected events (when present) become output-candidate assertions.
  const synth = buildObservationFromEvents({
    events: [
      { id: 'a', sessionId: 's', timestamp: '+0', source: 'playwrightRecorder', type: 'page_seen', pageUrl: '/x', pageTitle: 'X' },
      { id: 'b', sessionId: 's', timestamp: '+1', source: 'playwrightRecorder', type: 'output_candidate_detected', selector: '.upc', rawEvidence: { label: 'UPC', text: '012345678901', pattern: '^[0-9]{12}$', selectorCandidates: [{ selector: '.upc', kind: 'class', confidence: 'medium' }], selectorConfidence: 'medium' } },
    ],
    workflowId: 'synthetic',
    captureSource: 'playwrightRecorder',
  });
  const synthOutputs = (synth.suggestedAssertions || []).filter(a => a.kind === 'output-candidate');
  synthOutputs.length === 1 && /UPC/i.test(synthOutputs[0].label)
    ? pass('output_candidate_detected event becomes an output-candidate assertion')
    : fail('output candidate assertion not produced', JSON.stringify(synthOutputs));
}

// ── Check 5: evidence metadata ───────────────────────────────────────────────
section(5, 'Pages carry evidence metadata (screenshots either present or explicitly unavailable)');
{
  const allHaveEvidence = (obs.pages || []).every(p => p.evidence && typeof p.evidence.screenshotsAvailable === 'boolean');
  const allMarkedUnavailable = (obs.pages || []).every(p => p.evidence && p.evidence.screenshotsAvailable === false);
  allHaveEvidence && allMarkedUnavailable
    ? pass(`all ${obs.pages.length} page(s) have evidence metadata; screenshots marked unavailable with a reason`)
    : fail('evidence metadata wrong', JSON.stringify(obs.pages?.map(p => p.evidence)));

  // When the capture pipeline emits a page_snapshot_captured event with a
  // screenshotPath, evidence flips to available.
  const synth = buildObservationFromEvents({
    events: [
      { id: 'a', sessionId: 's', timestamp: '+0', source: 'playwrightRecorder', type: 'page_seen', pageUrl: '/x', pageTitle: 'X' },
      { id: 'b', sessionId: 's', timestamp: '+1', source: 'playwrightRecorder', type: 'page_snapshot_captured', pageUrl: '/x', rawEvidence: { screenshotPath: 'shots/x.png', kind: 'page' } },
    ],
    workflowId: 'synth',
    captureSource: 'playwrightRecorder',
  });
  const sp = synth.pages.find(p => p.url === '/x');
  sp && sp.evidence.screenshotsAvailable === true && sp.evidence.screenshots[0].screenshotPath === 'shots/x.png'
    ? pass('page_snapshot_captured with screenshotPath surfaces as available evidence')
    : fail('evidence not surfaced from page_snapshot_captured', JSON.stringify(sp));
}

// ── Check 6: preview markdown ────────────────────────────────────────────────
section(6, 'Captured workflow preview is written and contains every major section');
{
  const md = renderObservationPreview(obs);
  fs.mkdirSync(path.dirname(PREVIEW_OUT_PATH), { recursive: true });
  fs.writeFileSync(PREVIEW_OUT_PATH, md + '\n', 'utf8');

  const required = [
    '# Captured Workflow Preview',
    '## Pages / states observed',
    '## Fields detected',
    '### Global fields',
    '### Global assets',
    '## Repeat groups',
    '## Manual-only / dangerous actions',
    '## Suggested assertions / checkpoints',
    '## Selector confidence warnings',
    '## Event noise reduction',
  ];
  const missing = required.filter(s => !md.includes(s));
  const mentionsTracks = /\btracks?\b/i.test(md);
  const mentionsPublish = /Submit\s*&\s*Publish Release/i.test(md);
  if (missing.length === 0 && mentionsTracks && mentionsPublish) {
    pass(`preview has all ${required.length} required sections; wrote ${path.relative(REPO_ROOT, PREVIEW_OUT_PATH)} (${md.length} chars)`);
  } else {
    fail('preview missing sections or content', `missing=${JSON.stringify(missing)} tracks=${mentionsTracks} publish=${mentionsPublish}`);
  }
}

// ── Check 7: pure heuristic unit tests ───────────────────────────────────────
section(7, 'Heuristic classifiers handle the realistic + synthetic edge cases');
{
  // Dangerous
  const dangerCases = [
    ['Submit & Publish Release', true],
    ['Publish now', true],
    ['Delete account', true],
    ['Pay $19.99', true],
    ['Finalize order', true],
    ['Submit and confirm', true],
    ['Review release →', false],
    ['Next: add tracks →', false],
    ['Back to metadata', false],
    ['Cancel', false],
    ['Continue', false],
  ];
  let dangerFails = 0;
  for (const [label, expected] of dangerCases) {
    const got = isHardDangerous(label);
    if (got !== expected) { console.error(`        isHardDangerous("${label}") returned ${got}, expected ${expected}`); dangerFails++; }
  }
  dangerFails === 0
    ? pass(`isHardDangerous: ${dangerCases.length} cases (incl. 5 navigation false-positive guards)`)
    : fail(`isHardDangerous failed ${dangerFails}/${dangerCases.length} cases`);

  // Repeat-group add
  const repeatCases = [
    ['+ Add another track', true],
    ['+ Add another speaker', true],
    ['Add another item', true],
    ['Append another row', true],
    ['Next: add tracks →', false],
    ['Add', false],
    ['Add to cart', false],
    ['Back', false],
    ['Submit', false],
    ['Review', false],
  ];
  let repeatFails = 0;
  for (const [label, expected] of repeatCases) {
    const got = isLikelyAddInstanceAction(label);
    if (got !== expected) { console.error(`        isLikelyAddInstanceAction("${label}") returned ${got}, expected ${expected}`); repeatFails++; }
  }
  repeatFails === 0
    ? pass(`isLikelyAddInstanceAction: ${repeatCases.length} cases (incl. nav-prefix + bare-add guards)`)
    : fail(`isLikelyAddInstanceAction failed ${repeatFails}/${repeatCases.length} cases`);
}

// ── Check 8: shape compatibility + noiseReduction metadata ───────────────────
section(8, 'Shape stays compatible + noiseReduction counters reported');
{
  const requiredKeys = [
    'workflowId', 'captureSource', 'sourceUrl', 'mode',
    'pages', 'globalFields', 'globalAssets',
    'repeatGroups', 'manualOnlyActions',
    'sessionStats', 'sessionEvents',
    // new in this slice:
    'suggestedAssertions', 'selectorWarnings', 'noiseReduction', 'dedupedSessionEvents',
  ];
  const missing = requiredKeys.filter(k => !(k in obs));
  if (missing.length !== 0) fail('shape missing keys', JSON.stringify(missing));
  else pass(`shape has all ${requiredKeys.length} required keys (incl. new: suggestedAssertions, selectorWarnings, noiseReduction, dedupedSessionEvents)`);

  const nr = obs.noiseReduction || {};
  if (typeof nr.eventsBeforeDedupe === 'number' && typeof nr.eventsAfterDedupe === 'number' && nr.eventsAfterDedupe < nr.eventsBeforeDedupe) {
    pass(`noiseReduction reports ${nr.eventsBeforeDedupe} → ${nr.eventsAfterDedupe} (dropped ${nr.dropped})`);
  } else {
    fail('noiseReduction did not reflect a drop', JSON.stringify(nr));
  }

  // Deterministic re-run
  const a = buildObservationFromEvents({ events, workflowId: 'x', sourceUrl: 'u', capturedAt: 't', captureSource: 'playwrightRecorder' });
  const b = buildObservationFromEvents({ events, workflowId: 'x', sourceUrl: 'u', capturedAt: 't', captureSource: 'playwrightRecorder' });
  JSON.stringify(a) === JSON.stringify(b)
    ? pass('two passes still produce byte-identical observations')
    : fail('non-deterministic after slice');
}

console.log('\n══════════════════════════════════════');
console.log(`Observation workflow preview: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════');
if (failed > 0) process.exit(1);
