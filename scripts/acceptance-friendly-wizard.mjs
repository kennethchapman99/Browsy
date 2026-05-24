#!/usr/bin/env node
/**
 * Acceptance test: Friendly-label wizard UX
 *
 * Verifies that a nontechnical workflow expert can define an album-upload
 * package using only plain English labels — no dotted field names, no CSS
 * selectors, no JSON-like syntax, no knowledge of source array paths.
 *
 * Checks:
 *   1  toCamel() is available and converts plain labels to camelCase
 *   2  getRunInputKey() derives key from plain label (no dot)
 *   3  getRunInputKey() still works with legacy dotted names
 *   4  Step 6 input placeholder says "Field label", not dotted-name syntax
 *   5  Step 7 asks "What is this repeated thing called?"
 *   6  Step 7 asks "Where does the list of" (source question)
 *   7  Step 7 source buttons exist (folder / manifest / manual)
 *   8  Step 7 "Advanced mapping" disclosure is present
 *   9  Plain-label runInput → correct camelCase key in package.globals
 *  10  Plain-label file runInput → goes to package.assets, not globals
 *  11  Plain-label shared-default runInput → goes to package.defaults
 *  12  Plain-label item-level runInput → goes to repeatGroups[0].items[0].fields
 *  13  Friendly repeat group: itemSingular derives repeatGroups[0].id (plural)
 *  14  Friendly repeat group: itemLabel = itemSingular
 *  15  Friendly repeat group: selector auto-derived from itemSingular, no manual CSS
 *  16  Friendly repeat group: friendlyItemFields drives items[0].fields
 *  17  Friendly repeat group: friendlyItemFields file entry drives items[0].assets
 *  18  Full album-upload scenario — all friendly labels, no dots, no CSS selector
 *  19  Album scenario: pkg.globals.releaseTitle = "Sunrise Sessions"
 *  20  Album scenario: pkg.globals.artistName = "Example Artist"
 *  21  Album scenario: pkg.assets.coverArt = "./cover.png"
 *  22  Album scenario: pkg.repeatGroups[0].id = "tracks"
 *  23  Album scenario: pkg.repeatGroups[0].itemLabel = "track"
 *  24  Album scenario: selector auto-derived ('[data-browsy-action="add-track"]')
 *  25  Album scenario: items[0].fields.trackTitle = "Morning Light"
 *  26  Album scenario: items[0].assets.audioFile = "./track-01.wav"
 *  27  No dotted names were needed for any of the above
 *  28  No CSS selector was supplied for any of the above
 *
 * Usage:
 *   node scripts/acceptance-friendly-wizard.mjs
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const WIZARD_URL = pathToFileURL(path.join(__dirname, '..', 'wizard', 'index.html')).href;

let passed = 0, failed = 0;
function pass(label)          { console.log('PASS  ' + label); passed++; }
function fail(label, detail='') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

const browser = await chromium.launch({ headless: true });
const ctx  = await browser.newContext();
const page = await ctx.newPage();
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));

await page.goto(WIZARD_URL);
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(200);

// ── Check 1: toCamel is available ────────────────────────────────────────────
section(1, 'toCamel() helper is available and converts plain labels');
{
  const results = await page.evaluate(() => ({
    releaseTitle: toCamel('Release title'),
    trackTitle:   toCamel('Track title'),
    audioFile:    toCamel('Audio file'),
    coverArt:     toCamel('Cover art'),
    artistName:   toCamel('Artist name'),
    passthru:     toCamel('trackTitle'),
  }));
  const ok = results.releaseTitle==='releaseTitle' && results.trackTitle==='trackTitle'
    && results.audioFile==='audioFile' && results.coverArt==='coverArt'
    && results.artistName==='artistName' && results.passthru==='trackTitle';
  ok ? pass(`toCamel: "Release title"→"${results.releaseTitle}", "Audio file"→"${results.audioFile}", passthru "trackTitle"→"${results.passthru}"`)
     : fail('toCamel output wrong', JSON.stringify(results));
}

// ── Check 2: getRunInputKey with plain label (no dot) ────────────────────────
section(2, 'getRunInputKey() derives key from plain label (no dot notation)');
{
  const key = await page.evaluate(() => getRunInputKey({ name: 'Release title' }));
  key === 'releaseTitle'
    ? pass(`getRunInputKey({name:"Release title"}) = "${key}"`)
    : fail('getRunInputKey plain label', `got "${key}"`);
}

// ── Check 3: getRunInputKey with legacy dotted name ──────────────────────────
section(3, 'getRunInputKey() still works with legacy dotted names');
{
  const key = await page.evaluate(() => getRunInputKey({ name: 'album.releaseTitle' }));
  key === 'releaseTitle'
    ? pass(`getRunInputKey({name:"album.releaseTitle"}) = "${key}"`)
    : fail('getRunInputKey dotted name', `got "${key}"`);
}

// ── Check 4: Step 6 placeholder says "Field label" ───────────────────────────
section(4, 'Step 6: field input placeholder says "Field label", not dotted-name syntax');
{
  // Trigger rendering by adding a run input
  await page.evaluate(() => { addRunInput(); });
  await page.waitForTimeout(100);
  const placeholder = await page.evaluate(() => {
    const inp = document.querySelector('#run-inputs-list input[type="text"]');
    return inp ? inp.placeholder : null;
  });
  placeholder && placeholder.toLowerCase().includes('field label')
    ? pass(`placeholder = "${placeholder}"`)
    : fail('placeholder does not say "Field label"', `got: "${placeholder}"`);
  // Clean up
  await page.evaluate(() => { S.runInputs = []; renderRunInputs(); });
}

// ── Check 5: Step 7 asks "What is this repeated thing called?" ───────────────
section(5, 'Step 7: friendly question "What is this repeated thing called?"');
{
  await page.evaluate(() => {
    S.hasRepeatGroups = true;
    addRepeatGroup();
  });
  await page.waitForTimeout(100);
  const text = await page.evaluate(() => document.getElementById('repeat-groups-list')?.innerText || '');
  text.toLowerCase().includes('what is this repeated thing called')
    ? pass('Step 7 contains "What is this repeated thing called?"')
    : fail('"What is this repeated thing called?" not found in Step 7', text.slice(0,200));
  await page.evaluate(() => { S.repeatGroups = []; S.hasRepeatGroups = false; renderRepeatGroups(); });
}

// ── Check 6: Step 7 asks "Where does the list" ───────────────────────────────
section(6, 'Step 7: friendly question "Where does the list … come from?"');
{
  await page.evaluate(() => {
    S.hasRepeatGroups = true;
    addRepeatGroup({ itemSingular: 'track', itemPlural: 'tracks' });
  });
  await page.waitForTimeout(100);
  const text = await page.evaluate(() => document.getElementById('repeat-groups-list')?.innerText || '');
  text.toLowerCase().includes('where does the list')
    ? pass('Step 7 contains "Where does the list … come from?"')
    : fail('"Where does the list" not found in Step 7', text.slice(0,200));
}

// ── Check 7: Step 7 has source buttons ───────────────────────────────────────
section(7, 'Step 7: source buttons (folder / manifest / manual) are present');
{
  const text = await page.evaluate(() => document.getElementById('repeat-groups-list')?.innerText || '');
  const hasFolder   = text.includes('folder') || text.includes('Folder');
  const hasManifest = text.includes('manifest') || text.includes('Manifest');
  const hasManual   = text.includes('list them') || text.includes("I'll");
  hasFolder && hasManifest && hasManual
    ? pass('All three source options present (folder, manifest, manual list)')
    : fail('Source options missing', `folder:${hasFolder} manifest:${hasManifest} manual:${hasManual}`);
  await page.evaluate(() => { S.repeatGroups = []; S.hasRepeatGroups = false; renderRepeatGroups(); });
}

// ── Check 8: Advanced mapping disclosure is present ──────────────────────────
section(8, 'Step 7: "Advanced mapping" disclosure toggle is present');
{
  await page.evaluate(() => {
    S.hasRepeatGroups = true;
    addRepeatGroup({ itemSingular: 'track' });
  });
  await page.waitForTimeout(100);
  const text = await page.evaluate(() => document.getElementById('repeat-groups-list')?.innerText || '');
  text.toLowerCase().includes('advanced mapping')
    ? pass('"Advanced mapping" disclosure found')
    : fail('"Advanced mapping" not found in Step 7', text.slice(0,300));
  await page.evaluate(() => { S.repeatGroups = []; S.hasRepeatGroups = false; renderRepeatGroups(); });
}

// ── Check 9: Plain-label text runInput → package.globals ─────────────────────
section(9, 'Plain-label text runInput → package.globals.releaseTitle');
{
  const pkg = await page.evaluate(() => {
    S.runInputs = [{ name: 'Release title', inputType: 'text', exampleValue: 'Sunrise Sessions', scope: 'album-level', required: true, notes: '' }];
    return generatePackage();
  });
  pkg.globals?.releaseTitle === 'Sunrise Sessions'
    ? pass('globals.releaseTitle = "Sunrise Sessions" from plain label "Release title"')
    : fail('globals.releaseTitle missing', JSON.stringify(pkg.globals));
  await page.evaluate(() => { S.runInputs = []; });
}

// ── Check 10: Plain-label file runInput → package.assets ─────────────────────
section(10, 'Plain-label file runInput → package.assets (not globals)');
{
  const pkg = await page.evaluate(() => {
    S.runInputs = [{ name: 'Cover art', inputType: 'file path', exampleValue: './cover.png', scope: 'album-level', required: true, notes: '' }];
    return generatePackage();
  });
  const inAssets  = pkg.assets?.coverArt === './cover.png';
  const notGlobal = !pkg.globals?.coverArt;
  inAssets  ? pass('assets.coverArt = "./cover.png"')             : fail('assets.coverArt missing',     JSON.stringify(pkg.assets));
  notGlobal ? pass('coverArt correctly absent from pkg.globals')  : fail('coverArt leaked into globals', JSON.stringify(pkg.globals));
  await page.evaluate(() => { S.runInputs = []; });
}

// ── Check 11: Plain-label shared-default → package.defaults ──────────────────
section(11, 'Plain-label shared-default runInput → package.defaults');
{
  const pkg = await page.evaluate(() => {
    S.runInputs = [{ name: 'Songwriter', inputType: 'text', exampleValue: 'Example Artist', scope: 'shared default', required: false, notes: '' }];
    return generatePackage();
  });
  pkg.defaults?.songwriter === 'Example Artist'
    ? pass('defaults.songwriter = "Example Artist" from plain label "Songwriter"')
    : fail('defaults.songwriter missing', JSON.stringify(pkg.defaults));
  await page.evaluate(() => { S.runInputs = []; });
}

// ── Check 12: Plain-label item-level → repeatGroups items ────────────────────
section(12, 'Plain-label item-level runInput → repeatGroups[0].items[0].fields');
{
  const pkg = await page.evaluate(() => {
    S.runInputs = [{ name: 'Track title', inputType: 'text', exampleValue: 'Morning Light', scope: 'item-level / repeated', required: true, notes: '' }];
    S.hasRepeatGroups = false;
    return generatePackage();
  });
  const fields = pkg.repeatGroups?.[0]?.items?.[0]?.fields;
  fields?.trackTitle === 'Morning Light'
    ? pass('repeatGroups[0].items[0].fields.trackTitle = "Morning Light"')
    : fail('trackTitle missing in items[0].fields', JSON.stringify(fields));
  await page.evaluate(() => { S.runInputs = []; S.hasRepeatGroups = false; });
}

// ── Check 13: Friendly repeat group id derives from itemPlural ───────────────
section(13, 'Friendly repeat group: id derived from itemSingular (plural)');
{
  const pkg = await page.evaluate(() => {
    S.hasRepeatGroups = true;
    S.repeatGroups = [{ itemSingular:'track', itemPlural:'tracks', name:'', itemName:'track', source:'', repeatActionSelector:'', globalFields:[], itemFields:[], friendlyGlobalFields:[], friendlyItemFields:[] }];
    return generatePackage();
  });
  pkg.repeatGroups?.[0]?.id === 'tracks'
    ? pass('repeatGroups[0].id = "tracks" (derived from itemSingular "track")')
    : fail('repeatGroups[0].id', `got: "${pkg.repeatGroups?.[0]?.id}"`);
  await page.evaluate(() => { S.hasRepeatGroups = false; S.repeatGroups = []; });
}

// ── Check 14: itemLabel = itemSingular ────────────────────────────────────────
section(14, 'Friendly repeat group: itemLabel = itemSingular');
{
  const pkg = await page.evaluate(() => {
    S.hasRepeatGroups = true;
    S.repeatGroups = [{ itemSingular:'track', itemPlural:'tracks', name:'', itemName:'track', source:'', repeatActionSelector:'', globalFields:[], itemFields:[], friendlyGlobalFields:[], friendlyItemFields:[] }];
    return generatePackage();
  });
  pkg.repeatGroups?.[0]?.itemLabel === 'track'
    ? pass('repeatGroups[0].itemLabel = "track"')
    : fail('repeatGroups[0].itemLabel', `got: "${pkg.repeatGroups?.[0]?.itemLabel}"`);
  await page.evaluate(() => { S.hasRepeatGroups = false; S.repeatGroups = []; });
}

// ── Check 15: selector auto-derived, no manual CSS ───────────────────────────
section(15, 'Friendly repeat group: selector auto-derived from itemSingular, no CSS supplied');
{
  const pkg = await page.evaluate(() => {
    S.hasRepeatGroups = true;
    // repeatActionSelector deliberately left blank
    S.repeatGroups = [{ itemSingular:'track', itemPlural:'tracks', name:'', itemName:'track', source:'', repeatActionSelector:'', globalFields:[], itemFields:[], friendlyGlobalFields:[], friendlyItemFields:[] }];
    return generatePackage();
  });
  const sel = pkg.repeatGroups?.[0]?.createAction?.selector;
  sel === '[data-browsy-action="add-track"]'
    ? pass(`selector auto-derived = "${sel}"`)
    : fail('selector derivation wrong', `got: "${sel}"`);
  await page.evaluate(() => { S.hasRepeatGroups = false; S.repeatGroups = []; });
}

// ── Check 16: friendlyItemFields drives items fields ─────────────────────────
section(16, 'Friendly repeat group: friendlyItemFields drives items[0].fields');
{
  const pkg = await page.evaluate(() => {
    S.runInputs = [
      { name: 'Track title', inputType: 'text',      exampleValue: 'Morning Light',   scope: 'item-level / repeated', required: true, notes: '' },
      { name: 'Track number',inputType: 'text',      exampleValue: '1',               scope: 'item-level / repeated', required: true, notes: '' },
    ];
    S.hasRepeatGroups = true;
    S.repeatGroups = [{
      itemSingular:'track', itemPlural:'tracks', name:'', itemName:'track', source:'',
      repeatActionSelector:'', globalFields:[], itemFields:[],
      friendlyGlobalFields:[], friendlyItemFields:['Track title','Track number'],
    }];
    return generatePackage();
  });
  const f = pkg.repeatGroups?.[0]?.items?.[0]?.fields;
  f?.trackTitle === 'Morning Light' && f?.trackNumber === '1'
    ? pass(`items[0].fields.trackTitle="${f.trackTitle}", trackNumber="${f.trackNumber}"`)
    : fail('friendlyItemFields → fields', JSON.stringify(f));
  await page.evaluate(() => { S.runInputs = []; S.hasRepeatGroups = false; S.repeatGroups = []; });
}

// ── Check 17: friendlyItemFields file entry drives items[0].assets ───────────
section(17, 'Friendly repeat group: file entry in friendlyItemFields → items[0].assets');
{
  const pkg = await page.evaluate(() => {
    S.runInputs = [
      { name: 'Audio file', inputType: 'file path', exampleValue: './track-01.wav', scope: 'item-level / repeated', required: true, notes: '' },
    ];
    S.hasRepeatGroups = true;
    S.repeatGroups = [{
      itemSingular:'track', itemPlural:'tracks', name:'', itemName:'track', source:'',
      repeatActionSelector:'', globalFields:[], itemFields:[],
      friendlyGlobalFields:[], friendlyItemFields:['Audio file'],
    }];
    return generatePackage();
  });
  const a = pkg.repeatGroups?.[0]?.items?.[0]?.assets;
  a?.audioFile === './track-01.wav'
    ? pass(`items[0].assets.audioFile = "${a.audioFile}"`)
    : fail('friendlyItemFields file → assets', JSON.stringify(a));
  await page.evaluate(() => { S.runInputs = []; S.hasRepeatGroups = false; S.repeatGroups = []; });
}

// ── Checks 18-28: Full album-upload scenario (all friendly, no dots, no CSS) ─
section(18, 'Full album-upload: all friendly labels, no dotted names, no CSS selectors');
{
  const pkg = await page.evaluate(() => {
    S.workflowName = 'album upload';
    S.runInputs = [
      // Album-level: plain labels, scope "album-level"
      { name: 'Release title',  inputType: 'text',      exampleValue: 'Sunrise Sessions',  scope: 'album-level',          required: true,  notes: '' },
      { name: 'Artist name',    inputType: 'text',      exampleValue: 'Example Artist',    scope: 'album-level',          required: true,  notes: '' },
      { name: 'Primary genre',  inputType: 'text',      exampleValue: 'Pop',               scope: 'album-level',          required: true,  notes: '' },
      { name: 'Language',       inputType: 'text',      exampleValue: 'English',           scope: 'album-level',          required: true,  notes: '' },
      { name: 'Release date',   inputType: 'date',      exampleValue: '2026-09-01',        scope: 'album-level',          required: true,  notes: '' },
      { name: 'Label name',     inputType: 'text',      exampleValue: 'Independent',       scope: 'album-level',          required: true,  notes: '' },
      { name: 'Cover art',      inputType: 'file path', exampleValue: './cover.png',       scope: 'album-level',          required: true,  notes: '' },
      // Shared defaults
      { name: 'Songwriter',     inputType: 'text',      exampleValue: 'Example Artist',    scope: 'shared default',       required: false, notes: '' },
      // Per-track (item-level)
      { name: 'Track title',    inputType: 'text',      exampleValue: 'Morning Light',     scope: 'item-level / repeated',required: true,  notes: '' },
      { name: 'Track number',   inputType: 'text',      exampleValue: '1',                 scope: 'item-level / repeated',required: true,  notes: '' },
      { name: 'Audio file',     inputType: 'file path', exampleValue: './track-01.wav',    scope: 'item-level / repeated',required: true,  notes: '' },
    ];
    S.hasRepeatGroups = true;
    S.repeatGroups = [{
      // Only friendly fields — no dotted names, no CSS selector
      itemSingular: 'track',
      itemPlural:   'tracks',
      sourceFriendly: 'folder',
      addButtonText: 'Add another track',
      friendlyGlobalFields: ['Release title', 'Artist name', 'Cover art'],
      friendlyItemFields:   ['Track title', 'Track number', 'Audio file'],
      // Advanced left blank
      name: '', source: '', itemName: 'track', sectionDescription: '',
      repeatActionDescription: '', repeatActionSelector: '',
      globalFields: [], itemFields: [],
    }];
    S.checkpoints = ['Review all tracks before final release'];
    window._friendlyPkg = generatePackage();
    return window._friendlyPkg;
  });
  pkg
    ? pass('generatePackage() produced a package using only friendly labels')
    : fail('generatePackage() returned null/undefined');
}

section(19, 'Album scenario: pkg.globals.releaseTitle = "Sunrise Sessions"');
{
  const pkg = await page.evaluate(() => window._friendlyPkg);
  pkg.globals?.releaseTitle === 'Sunrise Sessions'
    ? pass(`globals.releaseTitle = "${pkg.globals.releaseTitle}"`)
    : fail('globals.releaseTitle', JSON.stringify(pkg.globals));
}

section(20, 'Album scenario: pkg.globals.artistName = "Example Artist"');
{
  const pkg = await page.evaluate(() => window._friendlyPkg);
  pkg.globals?.artistName === 'Example Artist'
    ? pass(`globals.artistName = "${pkg.globals.artistName}"`)
    : fail('globals.artistName', JSON.stringify(pkg.globals));
}

section(21, 'Album scenario: pkg.assets.coverArt = "./cover.png"');
{
  const pkg = await page.evaluate(() => window._friendlyPkg);
  pkg.assets?.coverArt === './cover.png'
    ? pass(`assets.coverArt = "${pkg.assets.coverArt}"`)
    : fail('assets.coverArt', JSON.stringify(pkg.assets));
}

section(22, 'Album scenario: pkg.repeatGroups[0].id = "tracks"');
{
  const pkg = await page.evaluate(() => window._friendlyPkg);
  pkg.repeatGroups?.[0]?.id === 'tracks'
    ? pass(`repeatGroups[0].id = "${pkg.repeatGroups[0].id}"`)
    : fail('repeatGroups[0].id', `got: "${pkg.repeatGroups?.[0]?.id}"`);
}

section(23, 'Album scenario: pkg.repeatGroups[0].itemLabel = "track"');
{
  const pkg = await page.evaluate(() => window._friendlyPkg);
  pkg.repeatGroups?.[0]?.itemLabel === 'track'
    ? pass(`repeatGroups[0].itemLabel = "${pkg.repeatGroups[0].itemLabel}"`)
    : fail('repeatGroups[0].itemLabel', `got: "${pkg.repeatGroups?.[0]?.itemLabel}"`);
}

section(24, 'Album scenario: selector auto-derived, no CSS manually supplied');
{
  const pkg = await page.evaluate(() => window._friendlyPkg);
  const sel = pkg.repeatGroups?.[0]?.createAction?.selector;
  sel === '[data-browsy-action="add-track"]'
    ? pass(`selector = "${sel}" (auto-derived, no CSS supplied)`)
    : fail('selector not auto-derived', `got: "${sel}"`);
}

section(25, 'Album scenario: items[0].fields.trackTitle = "Morning Light"');
{
  const pkg = await page.evaluate(() => window._friendlyPkg);
  const f = pkg.repeatGroups?.[0]?.items?.[0]?.fields;
  f?.trackTitle === 'Morning Light'
    ? pass(`items[0].fields.trackTitle = "${f.trackTitle}"`)
    : fail('items[0].fields.trackTitle', JSON.stringify(f));
}

section(26, 'Album scenario: items[0].assets.audioFile = "./track-01.wav"');
{
  const pkg = await page.evaluate(() => window._friendlyPkg);
  const a = pkg.repeatGroups?.[0]?.items?.[0]?.assets;
  a?.audioFile === './track-01.wav'
    ? pass(`items[0].assets.audioFile = "${a.audioFile}"`)
    : fail('items[0].assets.audioFile', JSON.stringify(a));
}

section(27, 'No dotted names were used (all runInput names are plain labels)');
{
  const allPlain = await page.evaluate(() =>
    S.runInputs.every(r => !r.name.includes('.') && !(r.advancedName||'').includes('.'))
  );
  allPlain
    ? pass('All runInput.name values are plain labels — no dot notation used')
    : fail('Some runInputs still use dotted names');
}

section(28, 'No CSS selector was supplied (repeatActionSelector left blank)');
{
  const noSelector = await page.evaluate(() =>
    S.repeatGroups.every(rg => !rg.repeatActionSelector)
  );
  noSelector
    ? pass('repeatActionSelector is empty for all groups — selector was auto-derived')
    : fail('repeatActionSelector was manually set');
}

await browser.close();

console.log(`\n══════════════════════════════════════`);
console.log(`Friendly-label wizard acceptance: ${passed} passed, ${failed} failed`);
console.log(`══════════════════════════════════════`);
if (failed > 0) process.exit(1);
