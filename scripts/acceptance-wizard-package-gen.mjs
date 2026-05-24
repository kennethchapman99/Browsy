#!/usr/bin/env node
/**
 * Acceptance test: Wizard package generation
 *
 * Simulates a workflow expert using the Browsy wizard to define an album-upload
 * workflow with repeat groups. Verifies that generatePackage() produces a valid
 * generic automation package JSON.
 *
 * Checks:
 *   1  Wizard HTML loads without JS errors
 *   2  generatePackage() is callable from the page context
 *   3  Empty state produces a package with workflowId, repeatGroups, humanCheckpoints
 *   4  Setting workflowName → workflowId is derived correctly
 *   5  Global fields (scope=global) appear in package.globals
 *   6  Album-level fields (scope=album-level) also appear in package.globals
 *   7  File-typed global fields appear in package.assets, not package.globals
 *   8  Shared default fields (scope=shared default) appear in package.defaults
 *   9  Item-level fields (scope=item-level / repeated) appear in package.repeatGroups[0].items[0].fields
 *  10  Item-level file fields appear in package.repeatGroups[0].items[0].assets
 *  11  humanCheckpoints are generated from S.checkpoints
 *  12  Repeat group name maps to repeatGroups[0].id
 *  13  Repeat group itemName maps to repeatGroups[0].itemLabel
 *  14  repeatActionSelector maps to createAction.selector
 *  15  repeatActionSelector defaults to [data-browsy-action="add-{itemName}"] when missing
 *  16  Album-upload scenario: fill UI via wizard steps and call generatePackage()
 *  17  Album-upload scenario: package has globals.releaseTitle and globals.artistName
 *  18  Album-upload scenario: package has assets.coverArt
 *  19  Album-upload scenario: package.repeatGroups[0].id = 'tracks'
 *  20  Album-upload scenario: package.repeatGroups[0].items[0].fields.trackTitle exists
 *  21  Album-upload scenario: package.repeatGroups[0].items[0].assets.audioFile exists
 *  22  Album-upload scenario: package.humanCheckpoints[0] is set
 *  23  DistroKid-like scenario: defaults (songwriter, language) appear in package.defaults
 *  24  Package JSON preview element is present in step 10 HTML
 *  25  Package has no music-specific keys in top level (no 'tracks', 'songs', 'album' keys at top level)
 *
 * Usage:
 *   node scripts/acceptance-wizard-package-gen.mjs
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');
const WIZARD_PATH = path.join(REPO_ROOT, 'wizard', 'index.html');
const WIZARD_URL  = pathToFileURL(WIZARD_PATH).href;

let passed = 0, failed = 0;
function pass(label)  { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Collect console errors
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));

await page.goto(WIZARD_URL);
await page.waitForLoadState('domcontentloaded');

// ── Check 1: Loads without JS errors ─────────────────────────────────────────
section(1, 'Wizard HTML loads without JS errors');
// Give a short moment for any immediate errors
await page.waitForTimeout(200);
jsErrors.length === 0
  ? pass('No JS errors on load')
  : fail('JS errors on load', jsErrors.slice(0,3).join('; '));

// ── Check 2: generatePackage is callable ──────────────────────────────────────
section(2, 'generatePackage() is callable from page context');
let generatePackageExists;
try {
  generatePackageExists = await page.evaluate(() => typeof generatePackage === 'function');
  generatePackageExists
    ? pass('generatePackage is a function')
    : fail('generatePackage is not defined');
} catch(e) {
  fail('evaluate failed', e.message);
  generatePackageExists = false;
}

if (!generatePackageExists) {
  console.error('\nFATAL: generatePackage() not found — aborting remaining checks.');
  await browser.close();
  process.exit(1);
}

// ── Check 3: Empty state produces valid package structure ─────────────────────
section(3, 'Empty state produces package with workflowId, repeatGroups, humanCheckpoints');
{
  const pkg = await page.evaluate(() => generatePackage());
  const hasId = typeof pkg.workflowId === 'string' && pkg.workflowId.length > 0;
  const hasRG = Array.isArray(pkg.repeatGroups);
  const hasCP = Array.isArray(pkg.humanCheckpoints) && pkg.humanCheckpoints.length > 0;
  if (hasId) pass('package.workflowId is a non-empty string');
  else fail('package.workflowId missing or empty', JSON.stringify(pkg.workflowId));
  if (hasRG) pass('package.repeatGroups is an array');
  else fail('package.repeatGroups missing or not array');
  if (hasCP) pass('package.humanCheckpoints has at least 1 entry (default checkpoint)');
  else fail('package.humanCheckpoints empty', JSON.stringify(pkg.humanCheckpoints));
}

// ── Check 4: workflowName → workflowId ────────────────────────────────────────
section(4, 'Setting S.workflowName derives workflowId correctly');
{
  const pkg = await page.evaluate(() => {
    S.workflowName = 'Album Upload Workflow';
    return generatePackage();
  });
  pkg.workflowId === 'album-upload-workflow'
    ? pass(`workflowId = "${pkg.workflowId}"`)
    : fail('workflowId', `expected "album-upload-workflow", got "${pkg.workflowId}"`);
  // Reset
  await page.evaluate(() => { S.workflowName = ''; });
}

// ── Check 5: Global scope → package.globals ────────────────────────────────────
section(5, 'Global-scoped runInput appears in package.globals');
{
  const pkg = await page.evaluate(() => {
    S.runInputs = [{ name: 'project.title', inputType: 'text', exampleValue: 'My Project', scope: 'global', required: true, notes: '' }];
    return generatePackage();
  });
  pkg.globals?.title === 'My Project'
    ? pass('globals.title = "My Project"')
    : fail('globals.title', `got: ${JSON.stringify(pkg.globals)}`);
  await page.evaluate(() => { S.runInputs = []; });
}

// ── Check 6: Album-level scope → package.globals ──────────────────────────────
section(6, 'Album-level-scoped runInput also appears in package.globals');
{
  const pkg = await page.evaluate(() => {
    S.runInputs = [{ name: 'album.artistName', inputType: 'text', exampleValue: 'Example Artist', scope: 'album-level', required: true, notes: '' }];
    return generatePackage();
  });
  pkg.globals?.artistName === 'Example Artist'
    ? pass('globals.artistName = "Example Artist"')
    : fail('globals.artistName', `got: ${JSON.stringify(pkg.globals)}`);
  await page.evaluate(() => { S.runInputs = []; });
}

// ── Check 7: File-typed global → package.assets ────────────────────────────────
section(7, 'File-typed global runInput appears in package.assets (not globals)');
{
  const pkg = await page.evaluate(() => {
    S.runInputs = [{ name: 'album.coverArt', inputType: 'file path', exampleValue: './cover.png', scope: 'global', required: true, notes: '' }];
    return generatePackage();
  });
  const inAssets  = pkg.assets?.coverArt === './cover.png';
  const notGlobal = !pkg.globals?.coverArt;
  if (inAssets)  pass('assets.coverArt = "./cover.png"');
  else fail('assets.coverArt', `got assets: ${JSON.stringify(pkg.assets)}`);
  if (notGlobal) pass('coverArt NOT in globals');
  else fail('coverArt should not be in globals', JSON.stringify(pkg.globals));
  await page.evaluate(() => { S.runInputs = []; });
}

// ── Check 8: Shared default → package.defaults ────────────────────────────────
section(8, 'Shared-default-scoped runInput appears in package.defaults');
{
  const pkg = await page.evaluate(() => {
    S.runInputs = [{ name: 'track.language', inputType: 'text', exampleValue: 'English', scope: 'shared default', required: false, notes: '' }];
    return generatePackage();
  });
  pkg.defaults?.language === 'English'
    ? pass('defaults.language = "English"')
    : fail('defaults.language', `got: ${JSON.stringify(pkg.defaults)}`);
  await page.evaluate(() => { S.runInputs = []; });
}

// ── Check 9: Item-level field → repeatGroups[0].items[0].fields ──────────────────
section(9, 'Item-level-scoped runInput appears in repeatGroups[0].items[0].fields');
{
  const pkg = await page.evaluate(() => {
    S.runInputs = [{ name: 'track.trackTitle', inputType: 'text', exampleValue: 'Song One', scope: 'item-level / repeated', required: true, notes: '' }];
    S.hasRepeatGroups = false; // let it fall back to auto-group
    return generatePackage();
  });
  const rg0 = pkg.repeatGroups?.[0];
  rg0?.items?.[0]?.fields?.trackTitle === 'Song One'
    ? pass('repeatGroups[0].items[0].fields.trackTitle = "Song One"')
    : fail('trackTitle in items[0].fields', `got: ${JSON.stringify(rg0?.items?.[0])}`);
  await page.evaluate(() => { S.runInputs = []; S.hasRepeatGroups = false; });
}

// ── Check 10: Item-level file → items[0].assets ────────────────────────────────
section(10, 'Item-level file-typed runInput appears in items[0].assets');
{
  const pkg = await page.evaluate(() => {
    S.runInputs = [{ name: 'track.audioFile', inputType: 'file path', exampleValue: './track-01.wav', scope: 'item-level / repeated', required: true, notes: '' }];
    S.hasRepeatGroups = false;
    return generatePackage();
  });
  const rg0 = pkg.repeatGroups?.[0];
  rg0?.items?.[0]?.assets?.audioFile === './track-01.wav'
    ? pass('repeatGroups[0].items[0].assets.audioFile = "./track-01.wav"')
    : fail('audioFile in items[0].assets', `got: ${JSON.stringify(rg0?.items?.[0])}`);
  await page.evaluate(() => { S.runInputs = []; S.hasRepeatGroups = false; });
}

// ── Check 11: humanCheckpoints from S.checkpoints ────────────────────────────────
section(11, 'humanCheckpoints generated from S.checkpoints');
{
  const pkg = await page.evaluate(() => {
    S.checkpoints = ['Stop before final submit'];
    return generatePackage();
  });
  pkg.humanCheckpoints?.[0]?.label === 'Stop before final submit'
    ? pass(`humanCheckpoints[0].label = "Stop before final submit"`)
    : fail('humanCheckpoints', JSON.stringify(pkg.humanCheckpoints));
  // Reset to default
  await page.evaluate(() => { S.checkpoints = ['Stop before final release / payment / legal certification']; });
}

// ── Check 12: repeat group name → repeatGroups[0].id ─────────────────────────────
section(12, 'Repeat group name maps to repeatGroups[0].id');
{
  const pkg = await page.evaluate(() => {
    S.hasRepeatGroups = true;
    S.repeatGroups = [{ name: 'tracks', source: 'tracks[]', itemName: 'track', sectionDescription: 'Song section', repeatActionDescription: 'Add another song', repeatActionSelector: "[data-browsy-action='add-track']", globalFields: [], itemFields: [] }];
    return generatePackage();
  });
  pkg.repeatGroups?.[0]?.id === 'tracks'
    ? pass('repeatGroups[0].id = "tracks"')
    : fail('repeatGroups[0].id', `got: ${pkg.repeatGroups?.[0]?.id}`);
  await page.evaluate(() => { S.hasRepeatGroups = false; S.repeatGroups = []; });
}

// ── Check 13: itemName → repeatGroups[0].itemLabel ──────────────────────────────
section(13, 'itemName maps to repeatGroups[0].itemLabel');
{
  const pkg = await page.evaluate(() => {
    S.hasRepeatGroups = true;
    S.repeatGroups = [{ name: 'tracks', source: 'tracks[]', itemName: 'track', sectionDescription: '', repeatActionDescription: '', repeatActionSelector: '', globalFields: [], itemFields: [] }];
    return generatePackage();
  });
  pkg.repeatGroups?.[0]?.itemLabel === 'track'
    ? pass('repeatGroups[0].itemLabel = "track"')
    : fail('repeatGroups[0].itemLabel', `got: ${pkg.repeatGroups?.[0]?.itemLabel}`);
  await page.evaluate(() => { S.hasRepeatGroups = false; S.repeatGroups = []; });
}

// ── Check 14: repeatActionSelector → createAction.selector ───────────────────────
section(14, 'repeatActionSelector maps to createAction.selector');
{
  const pkg = await page.evaluate(() => {
    S.hasRepeatGroups = true;
    S.repeatGroups = [{ name: 'items', source: 'items[]', itemName: 'item', sectionDescription: '', repeatActionDescription: '', repeatActionSelector: "[data-browsy-action='add-item']", globalFields: [], itemFields: [] }];
    return generatePackage();
  });
  pkg.repeatGroups?.[0]?.createAction?.selector === "[data-browsy-action='add-item']"
    ? pass(`createAction.selector = "[data-browsy-action='add-item']"`)
    : fail('createAction.selector', `got: ${pkg.repeatGroups?.[0]?.createAction?.selector}`);
  await page.evaluate(() => { S.hasRepeatGroups = false; S.repeatGroups = []; });
}

// ── Check 15: default selector when repeatActionSelector empty ──────────────────
section(15, 'Default selector derived from itemName when repeatActionSelector is empty');
{
  const pkg = await page.evaluate(() => {
    S.hasRepeatGroups = true;
    S.repeatGroups = [{ name: 'tracks', source: 'tracks[]', itemName: 'track', sectionDescription: '', repeatActionDescription: '', repeatActionSelector: '', globalFields: [], itemFields: [] }];
    return generatePackage();
  });
  const sel = pkg.repeatGroups?.[0]?.createAction?.selector;
  sel === '[data-browsy-action="add-track"]'
    ? pass(`default selector = "[data-browsy-action='add-track']"`)
    : fail('default selector', `got: "${sel}"`);
  await page.evaluate(() => { S.hasRepeatGroups = false; S.repeatGroups = []; });
}

// ── Checks 16-22: Album-upload scenario via UI interaction ────────────────────
section(16, 'Album-upload scenario: set state via programmatic API and call generatePackage()');
{
  const pkg = await page.evaluate(() => {
    // Simulate what a user would enter across wizard steps
    S.workflowName = 'album-upload';
    S.startUrl = 'https://example-distro.com/upload';
    S.runInputs = [
      { name: 'album.releaseTitle', inputType: 'text', exampleValue: 'Sunrise Sessions', scope: 'album-level', required: true, notes: '' },
      { name: 'album.artistName',   inputType: 'text', exampleValue: 'Example Artist',   scope: 'album-level', required: true, notes: '' },
      { name: 'album.primaryGenre', inputType: 'text', exampleValue: 'Pop',               scope: 'album-level', required: true, notes: '' },
      { name: 'album.language',     inputType: 'text', exampleValue: 'English',           scope: 'album-level', required: true, notes: '' },
      { name: 'album.releaseDate',  inputType: 'date', exampleValue: '2026-09-01',        scope: 'album-level', required: true, notes: '' },
      { name: 'album.labelName',    inputType: 'text', exampleValue: 'Independent',       scope: 'album-level', required: true, notes: '' },
      { name: 'album.coverArt',     inputType: 'file path', exampleValue: './cover.png',  scope: 'album-level', required: true, notes: '' },
      { name: 'track.songwriter',   inputType: 'text', exampleValue: 'Example Artist',    scope: 'shared default', required: false, notes: '' },
      { name: 'track.language',     inputType: 'text', exampleValue: 'English',           scope: 'shared default', required: false, notes: '' },
      { name: 'track.trackTitle',   inputType: 'text', exampleValue: 'Morning Light',     scope: 'item-level / repeated', required: true, notes: '' },
      { name: 'track.trackNumber',  inputType: 'text', exampleValue: '1',                 scope: 'item-level / repeated', required: true, notes: '' },
      { name: 'track.audioFile',    inputType: 'file path', exampleValue: './track-01.wav', scope: 'item-level / repeated', required: true, notes: '' },
    ];
    S.hasRepeatGroups = true;
    S.repeatGroups = [{
      name: 'tracks', source: 'tracks[]', itemName: 'track',
      sectionDescription: 'Song/track entry section',
      repeatActionDescription: 'Add another track',
      repeatActionSelector: "[data-browsy-action='add-track']",
      globalFields: ['album.releaseTitle','album.artistName','album.coverArt'],
      itemFields: [
        { name: 'track.trackTitle', source: 'track.trackTitle', description: 'Track title' },
        { name: 'track.audioFile',  source: 'track.audioFile',  description: 'Audio file upload' },
      ],
    }];
    S.checkpoints = ['Review all tracks before final release'];
    return generatePackage();
  });
  pkg ? pass('generatePackage() returned a package object') : fail('generatePackage() returned null/undefined');
  // Store for subsequent checks
  await page.evaluate(() => { window._testPkg = generatePackage(); });
}

section(17, 'Album-upload scenario: package has globals.releaseTitle and globals.artistName');
{
  const pkg = await page.evaluate(() => window._testPkg);
  pkg.globals?.releaseTitle === 'Sunrise Sessions'
    ? pass('globals.releaseTitle = "Sunrise Sessions"')
    : fail('globals.releaseTitle', `got: ${JSON.stringify(pkg.globals?.releaseTitle)}`);
  pkg.globals?.artistName === 'Example Artist'
    ? pass('globals.artistName = "Example Artist"')
    : fail('globals.artistName', `got: ${JSON.stringify(pkg.globals?.artistName)}`);
}

section(18, 'Album-upload scenario: package has assets.coverArt');
{
  const pkg = await page.evaluate(() => window._testPkg);
  pkg.assets?.coverArt === './cover.png'
    ? pass('assets.coverArt = "./cover.png"')
    : fail('assets.coverArt', `got: ${JSON.stringify(pkg.assets)}`);
}

section(19, 'Album-upload scenario: repeatGroups[0].id = "tracks"');
{
  const pkg = await page.evaluate(() => window._testPkg);
  pkg.repeatGroups?.[0]?.id === 'tracks'
    ? pass('repeatGroups[0].id = "tracks"')
    : fail('repeatGroups[0].id', `got: ${pkg.repeatGroups?.[0]?.id}`);
}

section(20, 'Album-upload scenario: repeatGroups[0].items[0].fields.trackTitle exists');
{
  const pkg = await page.evaluate(() => window._testPkg);
  const trackTitle = pkg.repeatGroups?.[0]?.items?.[0]?.fields?.trackTitle;
  trackTitle
    ? pass(`items[0].fields.trackTitle = "${trackTitle}"`)
    : fail('items[0].fields.trackTitle missing', JSON.stringify(pkg.repeatGroups?.[0]?.items?.[0]));
}

section(21, 'Album-upload scenario: repeatGroups[0].items[0].assets.audioFile exists');
{
  const pkg = await page.evaluate(() => window._testPkg);
  const audioFile = pkg.repeatGroups?.[0]?.items?.[0]?.assets?.audioFile;
  audioFile
    ? pass(`items[0].assets.audioFile = "${audioFile}"`)
    : fail('items[0].assets.audioFile missing', JSON.stringify(pkg.repeatGroups?.[0]?.items?.[0]));
}

section(22, 'Album-upload scenario: humanCheckpoints[0] is set');
{
  const pkg = await page.evaluate(() => window._testPkg);
  const cp = pkg.humanCheckpoints?.[0];
  cp?.label === 'Review all tracks before final release'
    ? pass(`humanCheckpoints[0].label = "${cp.label}"`)
    : fail('humanCheckpoints[0]', JSON.stringify(cp));
}

// ── Check 23: DistroKid-like scenario with defaults ───────────────────────────
section(23, 'DistroKid-like scenario: shared defaults (songwriter, language) in package.defaults');
{
  const pkg = await page.evaluate(() => {
    S.runInputs = [
      { name: 'album.artistName', inputType: 'text', exampleValue: 'Example Artist', scope: 'album-level', required: true, notes: '' },
      { name: 'track.songwriter', inputType: 'text', exampleValue: 'Example Artist', scope: 'shared default', required: false, notes: '' },
      { name: 'track.language',   inputType: 'text', exampleValue: 'English',        scope: 'shared default', required: false, notes: '' },
    ];
    S.hasRepeatGroups = false;
    return generatePackage();
  });
  pkg.defaults?.songwriter === 'Example Artist'
    ? pass('defaults.songwriter = "Example Artist"')
    : fail('defaults.songwriter', JSON.stringify(pkg.defaults));
  pkg.defaults?.language === 'English'
    ? pass('defaults.language = "English"')
    : fail('defaults.language', JSON.stringify(pkg.defaults));
  await page.evaluate(() => { S.runInputs = []; S.hasRepeatGroups = false; });
}

// ── Check 24: Package preview element present in DOM ────────────────────────────
section(24, 'Package JSON preview element is present in step 10 HTML');
{
  const exists = await page.evaluate(() => !!document.getElementById('pkg-preview-box'));
  exists
    ? pass('pkg-preview-box element found in DOM')
    : fail('pkg-preview-box element NOT found — step 10 HTML not updated');
}

// ── Check 25: No music-specific top-level keys ────────────────────────────────────
section(25, 'Package has no music-specific top-level keys (tracks, songs, album, etc.)');
{
  const pkg = await page.evaluate(() => {
    S.workflowName = 'album-upload';
    S.runInputs = [
      { name: 'album.artistName', inputType: 'text', exampleValue: 'Artist', scope: 'album-level', required: true, notes: '' },
      { name: 'track.trackTitle', inputType: 'text', exampleValue: 'Song',   scope: 'item-level / repeated', required: true, notes: '' },
    ];
    S.hasRepeatGroups = false;
    return generatePackage();
  });
  const badKeys = ['tracks', 'songs', 'album', 'artists', 'track'];
  const found = badKeys.filter(k => k in pkg);
  found.length === 0
    ? pass('No music-specific top-level keys in package')
    : fail('Music-specific top-level keys found', found.join(', '));
}

await browser.close();

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n══════════════════════════════════════`);
console.log(`Wizard package generation acceptance: ${passed} passed, ${failed} failed`);
console.log(`══════════════════════════════════════`);
if (failed > 0) process.exit(1);
