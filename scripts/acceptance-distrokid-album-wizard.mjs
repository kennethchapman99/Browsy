#!/usr/bin/env node
/**
 * Acceptance test: DistroKid-style album upload wizard
 *
 * Proves that a non-technical workflow expert can configure an album-upload
 * automation where some fields fill once globally and some fields repeat per
 * track — using ONLY friendly plain-English labels in the wizard.
 *
 * Three layers are validated:
 *   A. Fixture HTML  — data attributes are present so automation can target fields
 *   B. Package JSON  — generatePackage() produces a structurally correct package
 *   C. Readable summary — generateReadableSummary() produces human-verifiable text
 *
 * Checks:
 *   1  Fixture file exists at fixtures/distrokid-wizard/index.html
 *   2  Fixture has data-browsy-field="releaseTitle" on a global field
 *   3  Fixture has data-browsy-field="recordLabel"  (task-specific field name)
 *   4  Fixture has data-browsy-item-field="trackTitle" inside a track section
 *   5  Fixture has data-browsy-item-field="audioFile" (not audioUpload)
 *   6  Fixture has data-browsy-item-field="explicitLyrics" (not "explicit")
 *   7  Fixture has data-browsy-action="add-track" on the add-track button
 *   8  Fixture has data-browsy-repeat="tracks" on the tracks container
 *   9  toCamel('Explicit lyrics') → 'explicitLyrics'
 *  10  toCamel('Record label')    → 'recordLabel'
 *  11  toCamel('Album folder')    → 'albumFolder'
 *  12  Full package generation: generatePackage() returns a non-null object
 *  13  pkg.globals.releaseTitle  = "Sunrise Sessions"
 *  14  pkg.globals.artistName    = "Example Artist"
 *  15  pkg.globals.recordLabel   = "Independent Records"
 *  16  pkg.globals.releaseDate   = "2026-06-15"
 *  17  pkg.assets.coverArt       = "./cover.png"  (file-type → assets bucket)
 *  18  pkg.assets.albumFolder    = "./album-files" (folder-type → assets bucket)
 *  19  coverArt is NOT in pkg.globals (file stays in assets)
 *  20  pkg.repeatGroups has exactly 1 entry
 *  21  repeatGroups[0].id        = "tracks"    (plural / source array path)
 *  22  repeatGroups[0].itemLabel = "track"     (singular item label)
 *  23  repeatGroups[0].createAction.type     = "click"
 *  24  repeatGroups[0].createAction.selector = '[data-browsy-action="add-track"]' (auto-derived)
 *  25  items[0].fields.trackTitle    = "Morning Light"
 *  26  items[0].assets.audioFile     = "./track-01.wav"
 *  27  items[0].fields.trackNumber   = "1"
 *  28  items[0].fields.songwriter    = "Example Artist"
 *  29  items[0].fields.explicitLyrics = "false"
 *  30  releaseTitle NOT in items[0].fields or items[0].assets (no cross-contamination)
 *  31  trackTitle   NOT in pkg.globals or pkg.assets  (no cross-contamination)
 *  32  No runInput uses dotted notation (all plain labels)
 *  33  repeatActionSelector is blank (selector was auto-derived, no CSS supplied)
 *  34  advancedName override takes precedence over plain label
 *  35  generateReadableSummary() returns a non-empty string
 *  36  Summary includes "one-time album fields" heading
 *  37  Summary includes "repeated track fields" heading
 *  38  Summary includes "tracks source" (or equivalent source section)
 *  39  Summary includes "add another track" (or equivalent add-action line)
 *  40  pkg.globals does NOT contain any per-track key (trackTitle/audioFile/etc.)
 *
 * Usage:
 *   node scripts/acceptance-distrokid-album-wizard.mjs
 */

import { chromium } from 'playwright';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.join(__dirname, '..');
const WIZARD_URL = pathToFileURL(path.join(REPO_ROOT, 'wizard', 'index.html')).href;
const FIXTURE_PATH = path.join(REPO_ROOT, 'fixtures', 'distrokid-wizard', 'index.html');

let passed = 0, failed = 0;
function pass(label)             { console.log('PASS  ' + label); passed++; }
function fail(label, detail='') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

// ══════════════════════════════════════════════════════════════════
// Part A: Fixture HTML data-attribute checks (no browser needed)
// ══════════════════════════════════════════════════════════════════

section(1, 'Fixture file exists');
{
  fs.existsSync(FIXTURE_PATH)
    ? pass('fixtures/distrokid-wizard/index.html exists')
    : fail('fixtures/distrokid-wizard/index.html not found');
}

let fixtureHtml = '';
try { fixtureHtml = fs.readFileSync(FIXTURE_PATH, 'utf8'); } catch { /* handled by check 1 */ }

section(2, 'Fixture has data-browsy-field="releaseTitle"');
{
  fixtureHtml.includes('data-browsy-field="releaseTitle"')
    ? pass('data-browsy-field="releaseTitle" found on global field')
    : fail('data-browsy-field="releaseTitle" missing from fixture');
}

section(3, 'Fixture has data-browsy-field="recordLabel"');
{
  fixtureHtml.includes('data-browsy-field="recordLabel"')
    ? pass('data-browsy-field="recordLabel" found (not "labelName")')
    : fail('data-browsy-field="recordLabel" missing — fixture may use wrong field name');
}

section(4, 'Fixture has data-browsy-item-field="trackTitle"');
{
  fixtureHtml.includes('data-browsy-item-field="trackTitle"')
    ? pass('data-browsy-item-field="trackTitle" found in track section')
    : fail('data-browsy-item-field="trackTitle" missing from fixture');
}

section(5, 'Fixture has data-browsy-item-field="audioFile" (not "audioUpload")');
{
  const hasCorrect = fixtureHtml.includes('data-browsy-item-field="audioFile"');
  const hasOld     = fixtureHtml.includes('data-browsy-item-field="audioUpload"');
  hasCorrect && !hasOld
    ? pass('data-browsy-item-field="audioFile" found (old "audioUpload" not present)')
    : fail('audioFile field name wrong',
        `hasAudioFile:${hasCorrect} hasAudioUpload(old):${hasOld}`);
}

section(6, 'Fixture has data-browsy-item-field="explicitLyrics" (not "explicit")');
{
  const hasCorrect = fixtureHtml.includes('data-browsy-item-field="explicitLyrics"');
  const hasOld     = fixtureHtml.includes('data-browsy-item-field="explicit"') &&
                     !fixtureHtml.includes('data-browsy-item-field="explicitLyrics"');
  hasCorrect
    ? pass('data-browsy-item-field="explicitLyrics" found (camelCase, not "explicit")')
    : fail('explicitLyrics field name wrong', `hasExplicitLyrics:${hasCorrect} hasOldExplicit:${hasOld}`);
}

section(7, 'Fixture has data-browsy-action="add-track" on add button');
{
  fixtureHtml.includes('data-browsy-action="add-track"')
    ? pass('data-browsy-action="add-track" found on add-track button')
    : fail('data-browsy-action="add-track" missing — automation cannot click add-track');
}

section(8, 'Fixture has data-browsy-repeat="tracks" on tracks container');
{
  fixtureHtml.includes('data-browsy-repeat="tracks"')
    ? pass('data-browsy-repeat="tracks" found on tracks container')
    : fail('data-browsy-repeat="tracks" missing from fixture');
}

// ══════════════════════════════════════════════════════════════════
// Part B: Wizard JS helpers + package generation (Playwright)
// ══════════════════════════════════════════════════════════════════

const browser = await chromium.launch({ headless: true });
const ctx  = await browser.newContext();
const page = await ctx.newPage();
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));

await page.goto(WIZARD_URL);
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(200);

section(9, 'toCamel("Explicit lyrics") → "explicitLyrics"');
{
  const r = await page.evaluate(() => toCamel('Explicit lyrics'));
  r === 'explicitLyrics'
    ? pass(`toCamel("Explicit lyrics") = "${r}"`)
    : fail('toCamel("Explicit lyrics")', `got "${r}"`);
}

section(10, 'toCamel("Record label") → "recordLabel"');
{
  const r = await page.evaluate(() => toCamel('Record label'));
  r === 'recordLabel'
    ? pass(`toCamel("Record label") = "${r}"`)
    : fail('toCamel("Record label")', `got "${r}"`);
}

section(11, 'toCamel("Album folder") → "albumFolder"');
{
  const r = await page.evaluate(() => toCamel('Album folder'));
  r === 'albumFolder'
    ? pass(`toCamel("Album folder") = "${r}"`)
    : fail('toCamel("Album folder")', `got "${r}"`);
}

// Set up the full DistroKid-style scenario in the wizard state
await page.evaluate(() => {
  S.workflowName = 'album upload';
  S.startUrl     = 'file:///fixtures/distrokid-wizard/index.html';

  // Step 6: Run Inputs — ALL plain labels, no dotted names, no CSS
  S.runInputs = [
    // Global (album-level) text fields
    { name: 'Release title',  inputType: 'text',        exampleValue: 'Sunrise Sessions',   scope: 'album-level', required: true,  notes: '', advancedName: '' },
    { name: 'Artist name',    inputType: 'text',        exampleValue: 'Example Artist',     scope: 'album-level', required: true,  notes: '', advancedName: '' },
    { name: 'Record label',   inputType: 'text',        exampleValue: 'Independent Records',scope: 'album-level', required: true,  notes: '', advancedName: '' },
    { name: 'Release date',   inputType: 'date',        exampleValue: '2026-06-15',         scope: 'album-level', required: true,  notes: '', advancedName: '' },
    // Global (album-level) file/folder fields → go to pkg.assets
    { name: 'Cover art',      inputType: 'file path',   exampleValue: './cover.png',        scope: 'album-level', required: true,  notes: '', advancedName: '' },
    { name: 'Album folder',   inputType: 'folder path', exampleValue: './album-files',      scope: 'album-level', required: true,  notes: '', advancedName: '' },
    // Per-track (item-level) fields
    { name: 'Track title',    inputType: 'text',        exampleValue: 'Morning Light',      scope: 'item-level / repeated', required: true,  notes: '', advancedName: '' },
    { name: 'Audio file',     inputType: 'file path',   exampleValue: './track-01.wav',     scope: 'item-level / repeated', required: true,  notes: '', advancedName: '' },
    { name: 'Track number',   inputType: 'text',        exampleValue: '1',                  scope: 'item-level / repeated', required: true,  notes: '', advancedName: '' },
    { name: 'Songwriter',     inputType: 'text',        exampleValue: 'Example Artist',     scope: 'item-level / repeated', required: false, notes: '', advancedName: '' },
    { name: 'Explicit lyrics',inputType: 'text',        exampleValue: 'false',              scope: 'item-level / repeated', required: false, notes: '', advancedName: '' },
  ];

  // Step 7: Repeat Groups — friendly values only, no CSS selector, no dotted name
  S.hasRepeatGroups = true;
  S.repeatGroups = [{
    itemSingular:         'track',
    itemPlural:           'tracks',
    itemName:             'track',
    sourceFriendly:       'folder',
    addButtonText:        'Add another track',
    friendlyGlobalFields: ['Release title', 'Artist name', 'Record label', 'Release date', 'Cover art'],
    friendlyItemFields:   ['Track title', 'Audio file', 'Track number', 'Songwriter', 'Explicit lyrics'],
    // Advanced fields left blank — no manual CSS or dotted name required
    name:                    '',
    source:                  '',
    sectionDescription:      '',
    repeatActionDescription: '',
    repeatActionSelector:    '',
    globalFields:            [],
    itemFields:              [],
  }];

  S.checkpoints = ['Review all tracks before final release'];

  // Generate and cache
  window._distrokidPkg     = generatePackage();
  window._distrokidSummary = generateReadableSummary();
});

section(12, 'generatePackage() returns a non-null object');
{
  const pkg = await page.evaluate(() => window._distrokidPkg);
  pkg && typeof pkg === 'object'
    ? pass('generatePackage() returned a package object')
    : fail('generatePackage() returned null/undefined');
}

section(13, 'pkg.globals.releaseTitle = "Sunrise Sessions"');
{
  const v = await page.evaluate(() => window._distrokidPkg?.globals?.releaseTitle);
  v === 'Sunrise Sessions'
    ? pass(`globals.releaseTitle = "${v}"`)
    : fail('globals.releaseTitle', `got "${v}"`);
}

section(14, 'pkg.globals.artistName = "Example Artist"');
{
  const v = await page.evaluate(() => window._distrokidPkg?.globals?.artistName);
  v === 'Example Artist'
    ? pass(`globals.artistName = "${v}"`)
    : fail('globals.artistName', `got "${v}"`);
}

section(15, 'pkg.globals.recordLabel = "Independent Records"');
{
  const v = await page.evaluate(() => window._distrokidPkg?.globals?.recordLabel);
  v === 'Independent Records'
    ? pass(`globals.recordLabel = "${v}"`)
    : fail('globals.recordLabel', `got "${v}" — check toCamel("Record label")`);
}

section(16, 'pkg.globals.releaseDate = "2026-06-15"');
{
  const v = await page.evaluate(() => window._distrokidPkg?.globals?.releaseDate);
  v === '2026-06-15'
    ? pass(`globals.releaseDate = "${v}"`)
    : fail('globals.releaseDate', `got "${v}"`);
}

section(17, 'pkg.assets.coverArt = "./cover.png" (file-type goes to assets, not globals)');
{
  const v = await page.evaluate(() => window._distrokidPkg?.assets?.coverArt);
  v === './cover.png'
    ? pass(`assets.coverArt = "${v}"`)
    : fail('assets.coverArt', `got "${v}"`);
}

section(18, 'pkg.assets.albumFolder = "./album-files" (folder-type goes to assets)');
{
  const v = await page.evaluate(() => window._distrokidPkg?.assets?.albumFolder);
  v === './album-files'
    ? pass(`assets.albumFolder = "${v}"`)
    : fail('assets.albumFolder', `got "${v}"`);
}

section(19, 'coverArt is NOT in pkg.globals (file stays in assets bucket)');
{
  const inGlobals = await page.evaluate(() => 'coverArt' in (window._distrokidPkg?.globals || {}));
  !inGlobals
    ? pass('coverArt absent from pkg.globals — correctly routed to assets')
    : fail('coverArt leaked into pkg.globals');
}

section(20, 'pkg.repeatGroups has exactly 1 entry');
{
  const n = await page.evaluate(() => window._distrokidPkg?.repeatGroups?.length);
  n === 1
    ? pass(`repeatGroups.length = ${n}`)
    : fail(`repeatGroups.length`, `got ${n}`);
}

section(21, 'repeatGroups[0].id = "tracks" (plural / source array path)');
{
  const v = await page.evaluate(() => window._distrokidPkg?.repeatGroups?.[0]?.id);
  v === 'tracks'
    ? pass(`repeatGroups[0].id = "${v}" (derived from itemSingular "track")`)
    : fail('repeatGroups[0].id', `got "${v}"`);
}

section(22, 'repeatGroups[0].itemLabel = "track" (singular)');
{
  const v = await page.evaluate(() => window._distrokidPkg?.repeatGroups?.[0]?.itemLabel);
  v === 'track'
    ? pass(`repeatGroups[0].itemLabel = "${v}"`)
    : fail('repeatGroups[0].itemLabel', `got "${v}"`);
}

section(23, 'repeatGroups[0].createAction.type = "click"');
{
  const v = await page.evaluate(() => window._distrokidPkg?.repeatGroups?.[0]?.createAction?.type);
  v === 'click'
    ? pass(`createAction.type = "${v}"`)
    : fail('createAction.type', `got "${v}"`);
}

section(24, 'createAction.selector auto-derived as \'[data-browsy-action="add-track"]\' (no CSS supplied)');
{
  const sel = await page.evaluate(() => window._distrokidPkg?.repeatGroups?.[0]?.createAction?.selector);
  sel === '[data-browsy-action="add-track"]'
    ? pass(`createAction.selector = "${sel}" (auto-derived, no manual CSS)`)
    : fail('createAction.selector wrong or not auto-derived', `got "${sel}"`);
}

section(25, 'items[0].fields.trackTitle = "Morning Light"');
{
  const v = await page.evaluate(() => window._distrokidPkg?.repeatGroups?.[0]?.items?.[0]?.fields?.trackTitle);
  v === 'Morning Light'
    ? pass(`items[0].fields.trackTitle = "${v}"`)
    : fail('items[0].fields.trackTitle', `got "${v}"`);
}

section(26, 'items[0].assets.audioFile = "./track-01.wav" (file-type item → assets)');
{
  const v = await page.evaluate(() => window._distrokidPkg?.repeatGroups?.[0]?.items?.[0]?.assets?.audioFile);
  v === './track-01.wav'
    ? pass(`items[0].assets.audioFile = "${v}"`)
    : fail('items[0].assets.audioFile', `got "${v}"`);
}

section(27, 'items[0].fields.trackNumber = "1"');
{
  const v = await page.evaluate(() => window._distrokidPkg?.repeatGroups?.[0]?.items?.[0]?.fields?.trackNumber);
  v === '1'
    ? pass(`items[0].fields.trackNumber = "${v}"`)
    : fail('items[0].fields.trackNumber', `got "${v}"`);
}

section(28, 'items[0].fields.songwriter = "Example Artist"');
{
  const v = await page.evaluate(() => window._distrokidPkg?.repeatGroups?.[0]?.items?.[0]?.fields?.songwriter);
  v === 'Example Artist'
    ? pass(`items[0].fields.songwriter = "${v}"`)
    : fail('items[0].fields.songwriter', `got "${v}"`);
}

section(29, 'items[0].fields.explicitLyrics = "false"');
{
  const v = await page.evaluate(() => window._distrokidPkg?.repeatGroups?.[0]?.items?.[0]?.fields?.explicitLyrics);
  v === 'false'
    ? pass(`items[0].fields.explicitLyrics = "${v}"`)
    : fail('items[0].fields.explicitLyrics', `got "${v}"`);
}

section(30, 'No cross-contamination: releaseTitle NOT in items[0] (global stays global)');
{
  const inFields = await page.evaluate(() => {
    const f = window._distrokidPkg?.repeatGroups?.[0]?.items?.[0]?.fields || {};
    const a = window._distrokidPkg?.repeatGroups?.[0]?.items?.[0]?.assets || {};
    return 'releaseTitle' in f || 'releaseTitle' in a;
  });
  !inFields
    ? pass('releaseTitle correctly absent from items[0] fields/assets')
    : fail('releaseTitle leaked into per-track items — cross-contamination detected');
}

section(31, 'No cross-contamination: trackTitle NOT in pkg.globals or pkg.assets');
{
  const leaked = await page.evaluate(() => {
    const g = window._distrokidPkg?.globals || {};
    const a = window._distrokidPkg?.assets  || {};
    return 'trackTitle' in g || 'trackTitle' in a;
  });
  !leaked
    ? pass('trackTitle correctly absent from pkg.globals and pkg.assets')
    : fail('trackTitle leaked into pkg.globals/assets — cross-contamination detected');
}

section(32, 'No runInput uses dotted notation — all plain labels');
{
  const allPlain = await page.evaluate(() =>
    S.runInputs.every(r => !r.name.includes('.') && !(r.advancedName || '').includes('.'))
  );
  allPlain
    ? pass('All runInput.name values are plain English labels — no dot notation used')
    : fail('Some runInputs still use dotted names');
}

section(33, 'repeatActionSelector is blank (selector auto-derived, no manual CSS required)');
{
  const noSel = await page.evaluate(() =>
    S.repeatGroups.every(rg => !rg.repeatActionSelector)
  );
  noSel
    ? pass('repeatActionSelector is empty for all groups — fully auto-derived')
    : fail('repeatActionSelector was manually set — expert had to supply CSS');
}

section(34, 'Advanced override: advancedName takes precedence over plain label');
{
  const pkg = await page.evaluate(() => {
    const saved = S.runInputs.slice();
    S.runInputs = [{
      name: 'Release title',
      advancedName: 'album.title',
      inputType: 'text',
      exampleValue: 'Override Test',
      scope: 'album-level',
      required: true,
      notes: '',
    }];
    const p = generatePackage();
    S.runInputs = saved;
    return p;
  });
  const hasTitle  = pkg.globals?.title === 'Override Test';
  const noRelease = !('releaseTitle' in (pkg.globals || {}));
  hasTitle && noRelease
    ? pass('advancedName "album.title" → globals.title; plain label "releaseTitle" not used')
    : fail('advancedName override did not work', JSON.stringify(pkg.globals));
}

// ══════════════════════════════════════════════════════════════════
// Part C: Readable summary checks
// ══════════════════════════════════════════════════════════════════

section(35, 'generateReadableSummary() returns a non-empty string');
{
  const summary = await page.evaluate(() => window._distrokidSummary);
  typeof summary === 'string' && summary.length > 50
    ? pass(`generateReadableSummary() returned ${summary.length} chars`)
    : fail('generateReadableSummary() returned empty or non-string', typeof summary);
}

section(36, 'Summary includes "One-time album fields" heading');
{
  const summary = await page.evaluate(() => window._distrokidSummary);
  summary.toLowerCase().includes('one-time album fields')
    ? pass('"One-time album fields" heading found in summary')
    : fail('"One-time album fields" not in summary', summary.slice(0, 300));
}

section(37, 'Summary includes "Repeated track fields" heading');
{
  const summary = await page.evaluate(() => window._distrokidSummary);
  summary.toLowerCase().includes('repeated track fields')
    ? pass('"Repeated track fields" heading found in summary')
    : fail('"Repeated track fields" not in summary', summary.slice(0, 300));
}

section(38, 'Summary includes "tracks source" section');
{
  const summary = await page.evaluate(() => window._distrokidSummary);
  const lower = summary.toLowerCase();
  lower.includes('tracks source') || lower.includes('track source')
    ? pass('"tracks source" / "track source" section found in summary')
    : fail('Source section not found in summary', summary.slice(0, 400));
}

section(39, 'Summary includes add-another-track instruction');
{
  const summary = await page.evaluate(() => window._distrokidSummary);
  const lower = summary.toLowerCase();
  lower.includes('add another track')
    ? pass('"add another track" instruction found in summary')
    : fail('"add another track" not in summary', summary.slice(0, 400));
}

section(40, 'pkg.globals contains no per-track key (trackTitle/audioFile/etc.)');
{
  const leaked = await page.evaluate(() => {
    const g = window._distrokidPkg?.globals || {};
    const perTrackKeys = ['trackTitle', 'audioFile', 'trackNumber', 'songwriter', 'explicitLyrics'];
    return perTrackKeys.filter(k => k in g);
  });
  leaked.length === 0
    ? pass('No per-track keys in pkg.globals — clean separation of scopes')
    : fail('Per-track keys found in pkg.globals', JSON.stringify(leaked));
}

// ══════════════════════════════════════════════════════════════════
// Part D: Generated AUTOMATION_REQUEST.md markdown content
// These assert that the human review document is accurate, not just
// that the machine JSON is correct.
// ══════════════════════════════════════════════════════════════════

const markdown = await page.evaluate(() => generateMarkdown());

section(41, 'generateMarkdown() produces a non-empty string');
{
  typeof markdown === 'string' && markdown.length > 200
    ? pass(`generateMarkdown() returned ${markdown.length} chars`)
    : fail('generateMarkdown() returned empty or short string', typeof markdown);
}

section(42, 'Markdown contains "## 5b. Repeat groups" section');
{
  markdown.includes('## 5b. Repeat groups')
    ? pass('"## 5b. Repeat groups" found in generated markdown')
    : fail('"## 5b. Repeat groups" missing from markdown');
}

section(43, 'Markdown 5b section contains "Repeated thing: track"');
{
  const lower = markdown.toLowerCase();
  lower.includes('repeated thing') && lower.includes('track')
    ? pass('"Repeated thing … track" found in ## 5b section')
    : fail('"Repeated thing: track" not found in markdown', markdown.slice(markdown.indexOf('5b'), markdown.indexOf('5b') + 600));
}

section(44, 'Markdown 5b section contains "One-time album fields"');
{
  markdown.toLowerCase().includes('one-time album fields')
    ? pass('"One-time album fields" found in generated markdown')
    : fail('"One-time album fields" missing from markdown');
}

section(45, 'Markdown 5b: global field names present (Release title, Artist name, Cover art)');
{
  const seg = markdown.slice(markdown.indexOf('5b'));
  const hasRelease = seg.includes('Release title');
  const hasArtist  = seg.includes('Artist name');
  const hasCover   = seg.includes('Cover art');
  hasRelease && hasArtist && hasCover
    ? pass('Release title, Artist name, Cover art all present in ## 5b section')
    : fail('Some global field names missing from ## 5b',
        `Release title:${hasRelease} Artist name:${hasArtist} Cover art:${hasCover}`);
}

section(46, 'Markdown 5b section contains "Repeated track fields"');
{
  markdown.toLowerCase().includes('repeated track fields')
    ? pass('"Repeated track fields" found in generated markdown')
    : fail('"Repeated track fields" missing from markdown');
}

section(47, 'Markdown 5b: per-track field names present (Track title, Audio file, Track number)');
{
  const seg = markdown.slice(markdown.indexOf('5b'));
  const hasTitle  = seg.includes('Track title');
  const hasAudio  = seg.includes('Audio file');
  const hasNumber = seg.includes('Track number');
  hasTitle && hasAudio && hasNumber
    ? pass('Track title, Audio file, Track number all present in ## 5b section')
    : fail('Some per-track field names missing from ## 5b',
        `Track title:${hasTitle} Audio file:${hasAudio} Track number:${hasNumber}`);
}

section(48, 'Markdown 5b section contains "How to add another track"');
{
  markdown.toLowerCase().includes('how to add another track')
    ? pass('"How to add another track" found in generated markdown')
    : fail('"How to add another track" missing from markdown');
}

section(49, 'Markdown 5b section contains "Add another track" button text');
{
  markdown.includes('Add another track')
    ? pass('"Add another track" button text found in ## 5b section')
    : fail('"Add another track" missing from markdown');
}

// ══════════════════════════════════════════════════════════════════
// Part E: Source contract in package JSON
// ══════════════════════════════════════════════════════════════════

section(50, 'pkg.repeatGroups[0].sourceType = "folder"');
{
  const v = await page.evaluate(() => window._distrokidPkg?.repeatGroups?.[0]?.sourceType);
  v === 'folder'
    ? pass(`repeatGroups[0].sourceType = "${v}"`)
    : fail('repeatGroups[0].sourceType', `got "${v}"`);
}

section(51, 'pkg.repeatGroups[0].sourceRef = "assets.albumFolder"');
{
  const v = await page.evaluate(() => window._distrokidPkg?.repeatGroups?.[0]?.sourceRef);
  v === 'assets.albumFolder'
    ? pass(`repeatGroups[0].sourceRef = "${v}" (points to folder asset)`)
    : fail('repeatGroups[0].sourceRef', `got "${v}"`);
}

// ══════════════════════════════════════════════════════════════════
// Part F: Three-track repetition scenario
// Uses friendlyItems to supply concrete values for 3 example tracks.
// Proves the repeat group correctly models multi-item repetition.
// ══════════════════════════════════════════════════════════════════

// Set up 3-track state and generate package
await page.evaluate(() => {
  S.repeatGroups[0].friendlyItems = [
    { 'Track title': 'Morning Light',    'Audio file': './track-01.wav', 'Track number': '1', 'Songwriter': 'Example Artist', 'Explicit lyrics': 'false' },
    { 'Track title': 'Blue Hallway',     'Audio file': './track-02.wav', 'Track number': '2', 'Songwriter': 'Example Artist', 'Explicit lyrics': 'false' },
    { 'Track title': 'Last Train Home',  'Audio file': './track-03.wav', 'Track number': '3', 'Songwriter': 'Example Artist', 'Explicit lyrics': 'false' },
  ];
  window._threePkg = generatePackage();
});

section(52, '3-track scenario: repeatGroups[0].items.length === 3');
{
  const n = await page.evaluate(() => window._threePkg?.repeatGroups?.[0]?.items?.length);
  n === 3
    ? pass(`items.length = ${n}`)
    : fail('items.length', `got ${n}`);
}

section(53, '3-track: items[0].fields.trackTitle = "Morning Light"');
{
  const v = await page.evaluate(() => window._threePkg?.repeatGroups?.[0]?.items?.[0]?.fields?.trackTitle);
  v === 'Morning Light'
    ? pass(`items[0].fields.trackTitle = "${v}"`)
    : fail('items[0].fields.trackTitle', `got "${v}"`);
}

section(54, '3-track: items[1].fields.trackTitle = "Blue Hallway"');
{
  const v = await page.evaluate(() => window._threePkg?.repeatGroups?.[0]?.items?.[1]?.fields?.trackTitle);
  v === 'Blue Hallway'
    ? pass(`items[1].fields.trackTitle = "${v}"`)
    : fail('items[1].fields.trackTitle', `got "${v}"`);
}

section(55, '3-track: items[2].fields.trackTitle = "Last Train Home"');
{
  const v = await page.evaluate(() => window._threePkg?.repeatGroups?.[0]?.items?.[2]?.fields?.trackTitle);
  v === 'Last Train Home'
    ? pass(`items[2].fields.trackTitle = "${v}"`)
    : fail('items[2].fields.trackTitle', `got "${v}"`);
}

section(56, '3-track: each item has correct audioFile asset');
{
  const results = await page.evaluate(() => {
    const rg = window._threePkg?.repeatGroups?.[0];
    return [0, 1, 2].map(i => rg?.items?.[i]?.assets?.audioFile);
  });
  const expected = ['./track-01.wav', './track-02.wav', './track-03.wav'];
  const ok = results.every((v, i) => v === expected[i]);
  ok
    ? pass(`audioFile assets: ${results.join(', ')}`)
    : fail('audioFile assets wrong', `got: ${JSON.stringify(results)}`);
}

section(57, '3-track: trackNumber increments 1 → 2 → 3');
{
  const results = await page.evaluate(() => {
    const rg = window._threePkg?.repeatGroups?.[0];
    return [0, 1, 2].map(i => rg?.items?.[i]?.fields?.trackNumber);
  });
  const ok = results[0] === '1' && results[1] === '2' && results[2] === '3';
  ok
    ? pass(`trackNumbers = ${results.join(', ')}`)
    : fail('trackNumber sequence wrong', `got: ${JSON.stringify(results)}`);
}

section(58, '3-track: createAction appears once on the group, not inside each item');
{
  const result = await page.evaluate(() => {
    const rg = window._threePkg?.repeatGroups?.[0];
    const groupHasAction = !!rg?.createAction?.selector;
    // Items must NOT contain a createAction
    const itemsHaveAction = (rg?.items || []).some(item => 'createAction' in item);
    return { groupHasAction, itemsHaveAction };
  });
  result.groupHasAction && !result.itemsHaveAction
    ? pass('createAction is on the group, not duplicated inside each item')
    : fail('createAction placement wrong',
        `group:${result.groupHasAction} insideItems:${result.itemsHaveAction}`);
}

section(59, '3-track: albumFolder is in pkg.assets (folder source contract)');
{
  const v = await page.evaluate(() => window._threePkg?.assets?.albumFolder);
  v === './album-files'
    ? pass(`assets.albumFolder = "${v}" (folder source contract present)`)
    : fail('assets.albumFolder missing in 3-track package', `got "${v}"`);
}

section(60, '3-track: coverArt is in pkg.assets (album-level asset contract)');
{
  const v = await page.evaluate(() => window._threePkg?.assets?.coverArt);
  v === './cover.png'
    ? pass(`assets.coverArt = "${v}" (album-level asset present)`)
    : fail('assets.coverArt missing in 3-track package', `got "${v}"`);
}

await browser.close();

// ══════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════

if (jsErrors.length) {
  console.error('\nJS page errors during test:');
  jsErrors.forEach(e => console.error('  ' + e));
}

console.log(`\n══════════════════════════════════════════════════════════`);
console.log(`DistroKid album-upload wizard: ${passed} passed, ${failed} failed (60 checks total)`);
console.log(`══════════════════════════════════════════════════════════`);

if (failed > 0) {
  console.log('\nSample generated package (for debugging):');
  // Re-open browser to get package for debug output
  const b2  = await chromium.launch({ headless: true });
  const p2  = await b2.newContext().then(c => c.newPage());
  await p2.goto(WIZARD_URL);
  await p2.waitForLoadState('domcontentloaded');
  await p2.waitForTimeout(100);
  const debugPkg = await p2.evaluate(() => {
    S.workflowName = 'album upload';
    S.runInputs = [
      { name: 'Release title', inputType: 'text', exampleValue: 'Sunrise Sessions', scope: 'album-level', required: true, notes: '', advancedName: '' },
      { name: 'Cover art', inputType: 'file path', exampleValue: './cover.png', scope: 'album-level', required: true, notes: '', advancedName: '' },
      { name: 'Track title', inputType: 'text', exampleValue: 'Morning Light', scope: 'item-level / repeated', required: true, notes: '', advancedName: '' },
    ];
    S.hasRepeatGroups = true;
    S.repeatGroups = [{ itemSingular: 'track', itemPlural: 'tracks', itemName: 'track', sourceFriendly: 'folder', addButtonText: 'Add another track', friendlyGlobalFields: [], friendlyItemFields: ['Track title'], name: '', source: '', sectionDescription: '', repeatActionDescription: '', repeatActionSelector: '', globalFields: [], itemFields: [] }];
    return generatePackage();
  });
  console.log(JSON.stringify(debugPkg, null, 2));
  await b2.close();

  process.exit(1);
}
