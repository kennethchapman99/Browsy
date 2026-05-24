#!/usr/bin/env node
/**
 * Acceptance test: Repeat-group run plan builder and execution readiness
 *
 * Checks:
 *   1  buildRunPlan with 2-track manifest produces correct step sequence
 *   2  Global fill/upload steps precede all repeat_iterations
 *   3  album.albumArtPath step is upload_global (file path detected)
 *   4  Exactly 2 repeat_iterations produced for 2-track manifest
 *   5  Each iteration starts with ensure_section
 *   6  track.audioPath step within each iteration is upload_item
 *   7  Final step is human_checkpoint
 *   8  validateRunPlan finds no errors on a well-formed 2-track plan
 *   9  validateRunPlan errors when human_checkpoint is absent
 *  10  validateRunPlan warns when iteration[>0] ensure_section has no repeatAction
 *  11  buildRunPlan with 0-track manifest: only global steps + checkpoint, no iterations
 *  12  countStepsByType gives correct tallies for 2-track plan
 *  13  Validator warns when repeat group has no repeatAction
 *  14  Validator warns when globalField starts with itemName (cross-contamination)
 *  15  Fixture manifest parses correctly (2 tracks, Pancake Robot)
 *  16  Fixture AUTOMATION_REQUEST.md parses with 0 validation errors
 *  17  Run plan from fixture manifest has 7 global steps (6 fills + 1 artwork upload)
 *  18  Run plan from fixture preserves correct values from manifest
 *  19  ensure_section for index 0 has note, not repeatAction
 *  20  ensure_section for index 1 has repeatAction propagated from group config
 *
 * Usage:
 *   node scripts/acceptance-run-plan.mjs
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') { console.error('FAIL  ' + label + (detail ? '\n      ' + detail : '')); failed++; }
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

import { buildRunPlan, validateRunPlan, countStepsByType } from '../src/core/run-plan.mjs';
import { parseRequest } from '../src/core/request-parser.mjs';

// ── Canonical repeat group for album upload ────────────────────────────────────
const REPEAT_ACTION = {
  type: 'click',
  selector: "[data-testid='add-track']",
  description: "Click '+ Add another song' to add a new track section",
  discover: false,
};

const ALBUM_REPEAT_GROUP = {
  name: 'tracks',
  source: 'tracks[]',
  itemName: 'track',
  sectionDescription: 'Per-track song entry section',
  repeatAction: REPEAT_ACTION,
  stopCondition: 'index >= tracks.length',
  globalFields: [
    'album.artistName',
    'album.releaseTitle',
    'album.primaryGenre',
    'album.language',
    'album.releaseDate',
    'album.labelName',
    'album.albumArtPath',
  ],
  itemFields: [
    { name: 'trackTitle',  source: 'track.trackTitle',  description: 'Track title text field' },
    { name: 'audioUpload', source: 'track.audioPath',   description: 'WAV or MP3 audio file upload' },
    { name: 'trackNumber', source: 'track.trackNumber', description: 'Track number / order field' },
    { name: 'songwriter',  source: 'track.songwriter',  description: 'Songwriter credit field' },
    { name: 'explicit',    source: 'track.explicit',    description: 'Explicit lyrics checkbox' },
  ],
};

const TWO_TRACK_MANIFEST = {
  id: 'ALBUM_001',
  album: {
    artistName: 'Pancake Robot',
    releaseTitle: 'Breakfast Beats',
    primaryGenre: "Children's Music",
    language: 'English',
    releaseDate: '2026-06-26',
    labelName: 'Figment Factory',
    albumArtPath: './album-cover.png',
    explicit: false,
  },
  tracks: [
    { trackNumber: 1, trackTitle: 'Tiny Robot Parade', audioPath: './01-tiny-robot-parade.wav', songwriter: 'Figment Factory', performer: 'Pancake Robot', explicit: false, instrumental: false },
    { trackNumber: 2, trackTitle: 'Waffle Moon',       audioPath: './02-waffle-moon.wav',       songwriter: 'Figment Factory', performer: 'Pancake Robot', explicit: false, instrumental: false },
  ],
  dryRun: true,
};

const ZERO_TRACK_MANIFEST = { ...TWO_TRACK_MANIFEST, tracks: [] };

// ── Check 1: step sequence ─────────────────────────────────────────────────────
section(1, 'buildRunPlan produces correct top-level step sequence');
{
  const plan = buildRunPlan(ALBUM_REPEAT_GROUP, TWO_TRACK_MANIFEST);
  const types = plan.steps.map(s => s.type);
  // Expected: [fill_global × 6, upload_global × 1, repeat_iteration × 2, human_checkpoint × 1]
  const allGlobalBeforeIter = types.indexOf('repeat_iteration') > types.lastIndexOf('upload_global');
  if (types.includes('fill_global'))        pass('plan contains fill_global steps');
  else fail('plan missing fill_global steps', JSON.stringify(types));

  if (types.includes('upload_global'))      pass('plan contains upload_global steps');
  else fail('plan missing upload_global steps', JSON.stringify(types));

  if (types.includes('repeat_iteration'))   pass('plan contains repeat_iteration steps');
  else fail('plan missing repeat_iteration steps', JSON.stringify(types));

  if (types.includes('human_checkpoint'))   pass('plan contains human_checkpoint step');
  else fail('plan missing human_checkpoint step', JSON.stringify(types));
}

// ── Check 2: global steps precede iterations ───────────────────────────────────
section(2, 'Global fill/upload steps all precede repeat_iterations');
{
  const plan = buildRunPlan(ALBUM_REPEAT_GROUP, TWO_TRACK_MANIFEST);
  const types = plan.steps.map(s => s.type);
  const firstIterIdx = types.indexOf('repeat_iteration');
  const lastGlobalIdx = types.reduce((max, t, i) =>
    (t === 'fill_global' || t === 'upload_global') ? i : max, -1);
  if (firstIterIdx > lastGlobalIdx) pass('all global steps precede iterations');
  else fail('global step after iteration', `lastGlobalIdx=${lastGlobalIdx}, firstIterIdx=${firstIterIdx}`);
}

// ── Check 3: albumArtPath is upload_global ────────────────────────────────────
section(3, 'album.albumArtPath resolves to upload_global (not fill_global)');
{
  const plan = buildRunPlan(ALBUM_REPEAT_GROUP, TWO_TRACK_MANIFEST);
  const artStep = plan.steps.find(s => s.source === 'album.albumArtPath');
  if (!artStep) {
    fail('album.albumArtPath step not found');
  } else if (artStep.type === 'upload_global') {
    pass('album.albumArtPath step type = upload_global');
  } else {
    fail('album.albumArtPath step type', 'got: ' + artStep.type);
  }
}

// ── Check 4: 2 iterations for 2-track manifest ───────────────────────────────
section(4, 'Exactly 2 repeat_iterations for 2-track manifest');
{
  const plan = buildRunPlan(ALBUM_REPEAT_GROUP, TWO_TRACK_MANIFEST);
  const iters = plan.steps.filter(s => s.type === 'repeat_iteration');
  if (iters.length === 2) pass('2 repeat_iterations found');
  else fail('wrong iteration count', 'got: ' + iters.length);
}

// ── Check 5: each iteration starts with ensure_section ───────────────────────
section(5, 'Each iteration starts with ensure_section');
{
  const plan = buildRunPlan(ALBUM_REPEAT_GROUP, TWO_TRACK_MANIFEST);
  const iters = plan.steps.filter(s => s.type === 'repeat_iteration');
  let ok = true;
  for (const iter of iters) {
    if (!iter.steps?.length || iter.steps[0].type !== 'ensure_section') {
      fail(`iteration[${iter.itemIndex}] does not start with ensure_section`, JSON.stringify(iter.steps?.[0]));
      ok = false;
    }
  }
  if (ok) pass('all iterations start with ensure_section');
}

// ── Check 6: audioPath step in each iteration is upload_item ─────────────────
section(6, 'track.audioPath resolves to upload_item in each iteration');
{
  const plan = buildRunPlan(ALBUM_REPEAT_GROUP, TWO_TRACK_MANIFEST);
  const iters = plan.steps.filter(s => s.type === 'repeat_iteration');
  let allOk = true;
  for (const iter of iters) {
    const audioStep = iter.steps.find(s => s.source === 'track.audioPath');
    if (!audioStep) {
      fail(`iteration[${iter.itemIndex}] missing track.audioPath step`);
      allOk = false;
    } else if (audioStep.type !== 'upload_item') {
      fail(`iteration[${iter.itemIndex}] track.audioPath type`, 'got: ' + audioStep.type);
      allOk = false;
    }
  }
  if (allOk) pass('upload_item for track.audioPath in every iteration');
}

// ── Check 7: final step is human_checkpoint ───────────────────────────────────
section(7, 'Final step is human_checkpoint');
{
  const plan = buildRunPlan(ALBUM_REPEAT_GROUP, TWO_TRACK_MANIFEST);
  const last = plan.steps[plan.steps.length - 1];
  if (last?.type === 'human_checkpoint') pass('last step = human_checkpoint');
  else fail('last step type', 'got: ' + last?.type);

  if (Array.isArray(last?.blocked) && last.blocked.includes('Submit')) {
    pass('human_checkpoint.blocked includes "Submit"');
  } else {
    fail('human_checkpoint.blocked missing "Submit"', JSON.stringify(last?.blocked));
  }
}

// ── Check 8: validateRunPlan clean on well-formed plan ────────────────────────
section(8, 'validateRunPlan has no errors on well-formed 2-track plan');
{
  const plan = buildRunPlan(ALBUM_REPEAT_GROUP, TWO_TRACK_MANIFEST);
  const issues = validateRunPlan(plan, ALBUM_REPEAT_GROUP);
  const errors = issues.filter(i => i.level === 'error');
  if (errors.length === 0) pass('0 errors from validateRunPlan');
  else fail('unexpected errors', errors.map(e => e.message).join('; '));
}

// ── Check 9: validateRunPlan errors when checkpoint absent ────────────────────
section(9, 'validateRunPlan errors when human_checkpoint is missing');
{
  const plan = buildRunPlan(ALBUM_REPEAT_GROUP, TWO_TRACK_MANIFEST);
  // Surgically remove the checkpoint
  const stripped = { ...plan, steps: plan.steps.filter(s => s.type !== 'human_checkpoint') };
  const issues = validateRunPlan(stripped, ALBUM_REPEAT_GROUP);
  const err = issues.find(i => i.level === 'error' && i.message.includes('human_checkpoint'));
  if (err) pass('error when human_checkpoint removed');
  else fail('no error for missing human_checkpoint', JSON.stringify(issues));
}

// ── Check 10: validateRunPlan warns when iter[>0] ensure_section has no repeatAction
section(10, 'validateRunPlan warns when iteration[>0] ensure_section has no repeatAction');
{
  const plan = buildRunPlan(ALBUM_REPEAT_GROUP, TWO_TRACK_MANIFEST);
  // Remove repeatAction from the second iteration's ensure_section
  const mutated = JSON.parse(JSON.stringify(plan));
  const iter1 = mutated.steps.find(s => s.type === 'repeat_iteration' && s.itemIndex === 1);
  if (iter1?.steps?.[0]) delete iter1.steps[0].repeatAction;
  const issues = validateRunPlan(mutated, ALBUM_REPEAT_GROUP);
  const w = issues.find(i => i.level === 'warning' && i.message.includes('repeatAction'));
  if (w) pass('warns when iter[1] ensure_section lacks repeatAction');
  else fail('no warning for missing repeatAction on iter[1]', JSON.stringify(issues));
}

// ── Check 11: 0-track manifest → global steps + checkpoint, no iterations ────
section(11, 'buildRunPlan with 0-track manifest has no iterations');
{
  const plan = buildRunPlan(ALBUM_REPEAT_GROUP, ZERO_TRACK_MANIFEST);
  const iters = plan.steps.filter(s => s.type === 'repeat_iteration');
  const globals = plan.steps.filter(s => s.type === 'fill_global' || s.type === 'upload_global');
  const last = plan.steps[plan.steps.length - 1];
  if (iters.length === 0) pass('0 repeat_iterations for empty manifest');
  else fail('unexpected iterations', 'got: ' + iters.length);
  if (globals.length === 7) pass('global steps present (7) even with 0 tracks');
  else fail('wrong global step count with 0 tracks', 'got: ' + globals.length);
  if (last?.type === 'human_checkpoint') pass('human_checkpoint still last step with 0 tracks');
  else fail('last step type with 0 tracks', 'got: ' + last?.type);
}

// ── Check 12: countStepsByType tallies ────────────────────────────────────────
section(12, 'countStepsByType returns correct tallies');
{
  const plan = buildRunPlan(ALBUM_REPEAT_GROUP, TWO_TRACK_MANIFEST);
  const counts = countStepsByType(plan);
  // Top-level: 6 fill_global + 1 upload_global + 2 repeat_iteration + 1 human_checkpoint
  // Sub-steps (each iteration has 1 ensure_section + 4 fill_item + 1 upload_item = 6):
  //   2 × ensure_section = 2, 2 × 4 fill_item = 8, 2 × 1 upload_item = 2
  if (counts.fill_global === 6)      pass('countStepsByType: fill_global = 6');
  else fail('countStepsByType fill_global', 'got: ' + counts.fill_global);

  if (counts.upload_global === 1)    pass('countStepsByType: upload_global = 1');
  else fail('countStepsByType upload_global', 'got: ' + counts.upload_global);

  if (counts.repeat_iteration === 2) pass('countStepsByType: repeat_iteration = 2');
  else fail('countStepsByType repeat_iteration', 'got: ' + counts.repeat_iteration);

  if (counts.ensure_section === 2)   pass('countStepsByType: ensure_section = 2');
  else fail('countStepsByType ensure_section', 'got: ' + counts.ensure_section);

  if (counts.fill_item === 8)        pass('countStepsByType: fill_item = 8 (4 per track × 2 tracks)');
  else fail('countStepsByType fill_item', 'got: ' + counts.fill_item);

  if (counts.upload_item === 2)      pass('countStepsByType: upload_item = 2 (1 per track)');
  else fail('countStepsByType upload_item', 'got: ' + counts.upload_item);

  if (counts.human_checkpoint === 1) pass('countStepsByType: human_checkpoint = 1');
  else fail('countStepsByType human_checkpoint', 'got: ' + counts.human_checkpoint);
}

// ── Check 13: validator warns when repeatAction missing ───────────────────────
section(13, 'Validator warns when repeat group has no repeatAction');
{
  const rgNoAction = { ...ALBUM_REPEAT_GROUP };
  delete rgNoAction.repeatAction;

  // Build a minimal valid AUTOMATION_REQUEST that uses this group
  const md = buildSampleRequest({ repeatGroups: [rgNoAction] });
  const parsed = parseRequest(md);
  const w = parsed.validationIssues.find(i =>
    i.field === 'repeat_groups' && i.message.includes('no "repeatAction"')
  );
  if (w) pass('warns when repeatAction missing');
  else fail('no warning for missing repeatAction', JSON.stringify(parsed.validationIssues.filter(i => i.field === 'repeat_groups')));
}

// ── Check 14: validator warns when globalField starts with itemName ───────────
section(14, 'Validator warns when globalField starts with itemName (cross-contamination)');
{
  const rgBadGlobal = {
    ...ALBUM_REPEAT_GROUP,
    globalFields: [...ALBUM_REPEAT_GROUP.globalFields, 'track.trackTitle'],
  };
  const md = buildSampleRequest({ repeatGroups: [rgBadGlobal] });
  const parsed = parseRequest(md);
  const w = parsed.validationIssues.find(i =>
    i.field === 'repeat_groups' && i.message.includes('global field') && i.message.includes('track.trackTitle')
  );
  if (w) pass('warns when globalField "track.trackTitle" starts with itemName');
  else fail('no warning for cross-contaminated globalField', JSON.stringify(parsed.validationIssues.filter(i => i.field === 'repeat_groups')));
}

// ── Check 15: fixture manifest loads correctly ────────────────────────────────
section(15, 'Fixture manifest.json has 2 tracks and correct artist');
{
  const manifestPath = path.join(REPO_ROOT, 'fixtures', 'album-upload', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fail('fixtures/album-upload/manifest.json exists');
  } else {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (m.album?.artistName === 'Pancake Robot') pass('manifest artistName = "Pancake Robot"');
    else fail('manifest artistName', 'got: ' + m.album?.artistName);
    if (Array.isArray(m.tracks) && m.tracks.length === 2) pass('manifest has 2 tracks');
    else fail('manifest track count', 'got: ' + m.tracks?.length);
    if (m.tracks?.[0]?.trackTitle === 'Tiny Robot Parade') pass('tracks[0].trackTitle = "Tiny Robot Parade"');
    else fail('tracks[0].trackTitle', 'got: ' + m.tracks?.[0]?.trackTitle);
    if (m.tracks?.[1]?.trackTitle === 'Waffle Moon') pass('tracks[1].trackTitle = "Waffle Moon"');
    else fail('tracks[1].trackTitle', 'got: ' + m.tracks?.[1]?.trackTitle);
  }
}

// ── Check 16: fixture AUTOMATION_REQUEST.md parses with 0 errors ───────────────
section(16, 'Fixture AUTOMATION_REQUEST.md parses with 0 validation errors');
{
  const reqPath = path.join(REPO_ROOT, 'fixtures', 'album-upload', 'AUTOMATION_REQUEST.md');
  if (!fs.existsSync(reqPath)) {
    fail('fixtures/album-upload/AUTOMATION_REQUEST.md exists');
  } else {
    const md = fs.readFileSync(reqPath, 'utf8');
    const parsed = parseRequest(md);
    const errors = parsed.validationIssues.filter(i => i.level === 'error');
    if (errors.length === 0) pass('0 errors from fixture AUTOMATION_REQUEST.md');
    else fail('fixture has validation errors', errors.map(e => e.message).join('; '));
    // Spot-check key fields parsed correctly
    if (parsed.workflowId === 'album-upload') pass('workflowId = "album-upload"');
    else fail('workflowId', 'got: ' + parsed.workflowId);
    if (Array.isArray(parsed.repeatGroups) && parsed.repeatGroups.length === 1) {
      pass('fixture has 1 repeat group');
    } else {
      fail('fixture repeat groups', 'got: ' + JSON.stringify(parsed.repeatGroups?.length));
    }
  }
}

// ── Check 17: run plan from fixture manifest has 7 global steps ───────────────
section(17, 'Run plan from fixture manifest has 7 global steps (6 fills + 1 artwork upload)');
{
  const manifestPath = path.join(REPO_ROOT, 'fixtures', 'album-upload', 'manifest.json');
  const reqPath      = path.join(REPO_ROOT, 'fixtures', 'album-upload', 'AUTOMATION_REQUEST.md');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(reqPath)) {
    fail('fixture files exist for check 17');
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const parsed   = parseRequest(fs.readFileSync(reqPath, 'utf8'));
    const rg       = parsed.repeatGroups[0];
    const plan     = buildRunPlan(rg, manifest);
    const globals  = plan.steps.filter(s => s.type === 'fill_global' || s.type === 'upload_global');
    if (globals.length === 7) pass('7 global steps in fixture-based plan');
    else fail('global step count', 'got: ' + globals.length);
    const artStep = plan.steps.find(s => s.source === 'album.albumArtPath');
    if (artStep?.type === 'upload_global') pass('artwork step is upload_global in fixture plan');
    else fail('artwork step type in fixture plan', 'got: ' + artStep?.type);
  }
}

// ── Check 18: run plan values match manifest ──────────────────────────────────
section(18, 'Run plan resolves correct values from manifest');
{
  const plan = buildRunPlan(ALBUM_REPEAT_GROUP, TWO_TRACK_MANIFEST);

  const artistStep = plan.steps.find(s => s.source === 'album.artistName');
  if (artistStep?.value === 'Pancake Robot') pass('album.artistName value = "Pancake Robot"');
  else fail('album.artistName value', 'got: ' + artistStep?.value);

  const iter0 = plan.steps.find(s => s.type === 'repeat_iteration' && s.itemIndex === 0);
  const title0 = iter0?.steps.find(s => s.source === 'track.trackTitle');
  if (title0?.value === 'Tiny Robot Parade') pass('iter[0] trackTitle = "Tiny Robot Parade"');
  else fail('iter[0] trackTitle', 'got: ' + title0?.value);

  const iter1 = plan.steps.find(s => s.type === 'repeat_iteration' && s.itemIndex === 1);
  const audio1 = iter1?.steps.find(s => s.source === 'track.audioPath');
  if (audio1?.value === './02-waffle-moon.wav') pass('iter[1] audioPath = "./02-waffle-moon.wav"');
  else fail('iter[1] audioPath', 'got: ' + audio1?.value);
}

// ── Check 19: first iteration ensure_section has note (not repeatAction) ───────
section(19, 'ensure_section for index 0 has note (first section already in DOM)');
{
  const plan = buildRunPlan(ALBUM_REPEAT_GROUP, TWO_TRACK_MANIFEST);
  const iter0 = plan.steps.find(s => s.type === 'repeat_iteration' && s.itemIndex === 0);
  const sec0  = iter0?.steps[0];
  if (sec0?.note && !sec0.repeatAction) pass('iter[0] ensure_section has note, no repeatAction');
  else fail('iter[0] ensure_section structure', JSON.stringify(sec0));
}

// ── Check 20: second iteration ensure_section has repeatAction ────────────────
section(20, 'ensure_section for index 1 has repeatAction propagated');
{
  const plan = buildRunPlan(ALBUM_REPEAT_GROUP, TWO_TRACK_MANIFEST);
  const iter1 = plan.steps.find(s => s.type === 'repeat_iteration' && s.itemIndex === 1);
  const sec1  = iter1?.steps[0];
  if (sec1?.repeatAction?.type === 'click') pass('iter[1] ensure_section has repeatAction.type = "click"');
  else fail('iter[1] ensure_section repeatAction', JSON.stringify(sec1));
}

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n══════════════════════════════════════`);
console.log(`Run-plan acceptance: ${passed} passed, ${failed} failed`);
console.log(`══════════════════════════════════════`);
if (failed > 0) process.exit(1);

// ── Helpers ────────────────────────────────────────────────────────────────────

// Build a minimal but valid AUTOMATION_REQUEST.md string for parser tests,
// overriding the repeatGroups section with the supplied groups.
function buildSampleRequest({ repeatGroups = [ALBUM_REPEAT_GROUP] } = {}) {
  return `# Browsy Automation Request

## 1. Workflow name

\`album-upload\`

## 2. Goal

Upload an album to a music distribution service with repeat-group track filling.

## 3. Target websites / pages

| Purpose | URL | Requires login? | Notes |
| --- | --- | --- | --- |
| Upload page | https://example-distro.com/upload | yes | |

## 4. Existing APIs, files, or local systems

\`\`\`json
[
  { "name": "Local album folder", "type": "local_folder", "examplePath": "./fixtures/album-upload", "contains": "album data", "required": true, "usage": "source of truth" }
]
\`\`\`

## 5. Input data contract

\`\`\`json
{
  "id": "ALBUM_001",
  "album": { "artistName": "Pancake Robot", "albumArtPath": "./cover.png" },
  "tracks": [
    { "trackNumber": 1, "trackTitle": "Tiny Robot Parade", "audioPath": "./01.wav", "songwriter": "Figment Factory", "explicit": false }
  ],
  "dryRun": true
}
\`\`\`

## 5a. Runtime variables

\`\`\`json
{ "input": [], "captured": [], "derived": [] }
\`\`\`

## 5b. Repeat groups

\`\`\`json
${JSON.stringify({ repeatGroups }, null, 2)}
\`\`\`

## 6. Desired workflow steps

1. Fill album fields.
2. For each track, add section and fill fields.
3. Stop before submit.

## 7. Fields to fill or upload

| Field / action | Source in input | Website field/page | Scope / rule |
| --- | --- | --- | --- |
| Artist name | \`album.artistName\` | Artist name input | global / fill once |
| Track title | \`track.trackTitle\` | Track title input | item-level / repeat per track |

## 8. Actions that must stay manual

- Final submit
- Legal certification

## 9. Human checkpoints

- Stop before final release.

## 10. Authentication plan

- manual-save-state

## 11. Discovery needs

- (none)

## 12. Safety policy

\`\`\`json
{
  "dry_run_default": true,
  "pause_at_end_default": true,
  "never_click_text": ["Submit", "Upload to stores"],
  "never_click_selectors": ["[data-testid='final-submit']"],
  "manual_only_categories": ["final submission", "legal certification"]
}
\`\`\`

## 13. Output artifacts expected

- run-log.json

## 14. Test commands expected

\`\`\`
node scripts/acceptance-run-plan.mjs
\`\`\`

## 15. Acceptance criteria

- Album fields filled once before any track iteration.
- Audio uploaded per track.
- Human checkpoint is last step.

## 16. Narrated walkthrough

Fill album fields, upload cover art, then loop through each track filling title and audio.
`;
}
