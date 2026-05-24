#!/usr/bin/env node
/**
 * Acceptance test: runtime variables and dynamic URLs.
 *
 * Usage:
 *   node scripts/acceptance-runtime-vars.mjs
 *   node scripts/acceptance-runtime-vars.mjs --browser
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseRequest } from '../src/core/request-parser.mjs';
import {
  resolveTemplate,
  tryResolveTemplate,
  extractTemplateVars,
  hasTemplateVars,
  validateTemplateVars,
  captureFromPage,
  captureVariables,
  computeDerived,
  saveRuntimeVars,
  loadRuntimeVars,
  filterCapturedByTiming,
  isFatalCaptureTiming,
} from '../src/core/runtime-vars.mjs';
import { generateRunReview } from '../src/core/run-review.mjs';

const withBrowser = process.argv.includes('--browser');
let passed = 0;
let failed = 0;
let skipped = 0;

function pass(label) { passed++; console.log('PASS  ' + label); }
function fail(label, detail = '') { failed++; console.error('FAIL  ' + label + (detail ? '\n      ' + detail : '')); }
function skip(label) { skipped++; console.log('SKIP  ' + label); }
function section(title) { console.log('\n── ' + title + ' ──'); }
function check(label, fn) { try { fn(); pass(label); } catch (err) { fail(label, err.message); } }
async function checkAsync(label, fn) { try { await fn(); pass(label); } catch (err) { fail(label, err.message); } }

const REQUEST_MD = `# Runtime variable fixture

## 1. Workflow name

\`song-runtime-vars\`

## 2. Goal

Create a song, capture the generated song ID, derive the song detail URL, and stop for review.

## 3. Target websites / pages

| Purpose | URL | Requires login? | Example URL | Notes |
| --- | --- | --- | --- | --- |
| Song creation | http://localhost:3737/create | no | | |
| Song detail | http://localhost:3737/songs/{{songId}} | no | http://localhost:3737/songs/SONG_MPHMZMDK_E9UU_T01 | Dynamic URL |

## 4. Existing APIs or local systems

| System | Type | Purpose | Auth/notes |
| --- | --- | --- | --- |
| Local files | files | Source of truth | none |

## 5. Input data contract

\`\`\`json
{ "title": "Summer Haze", "artistName": "The Midnight" }
\`\`\`

## 5a. Runtime variables

\`\`\`json
{
  "input": [{ "name": "title" }],
  "captured": [
    { "name": "songId", "source": "current_url", "regex": "/songs/(SONG_[A-Z0-9_]+)", "required": true, "captureAfter": "create-song" },
    { "name": "statusText", "source": "selector_text", "selector": "[data-browsy-output='status']", "required": false },
    { "name": "publicLink", "source": "selector_attribute", "selector": "[data-browsy-output='public-link']", "attribute": "href", "required": false }
  ],
  "derived": [
    { "name": "songUrl", "template": "http://localhost:3737/songs/{{songId}}" }
  ]
}
\`\`\`

## 6. Desired workflow steps

- Open create page
- Capture songId
- Open derived songUrl
- Stop for review

## 7. Fields to fill or upload

| Field / action | Source in input | Type | Scope rule | Notes |
| --- | --- | --- | --- | --- |
| Song title | title | text | global | |
| Generated song ID | songId | captured | captured output | output only |

## 8. Actions that must stay manual

- Final submit
- Store upload

## 9. Human checkpoints

- Review captured songId and derived songUrl

## 10. Authentication plan

manual-save-state

## 11. Discovery needs

- http://localhost:3737/create

## 12. Safety policy

\`\`\`json
{ "never_click_text": ["Submit", "Upload to stores", "Release"], "manual_only_categories": ["final submission"] }
\`\`\`

## 13. Output artifacts expected

- runtime-vars.json
- run-review.md

## 14. Test commands expected

\`\`\`bash
npm run acceptance:runtime-vars
npm run acceptance:runtime-vars -- --browser
\`\`\`

## 15. Acceptance criteria

- Runtime variable capture is explicit
- Missing required captures produce a clear run-review fix

## 16. Narrated walkthrough

A workflow expert creates a song and uses the generated URL to reach the detail page.
`;

function mockPage({ url = 'http://localhost:3737/songs/SONG_ABCDEFGH_XY12_T01', text = {}, attrs = {} } = {}) {
  return {
    url: () => url,
    locator: selector => ({
      first() { return this; },
      async innerText() { return selector === 'body' ? (text.body || '') : (text[selector] || ''); },
      async getAttribute(attribute) { return attrs[`${selector}::${attribute}`] ?? null; },
    }),
  };
}

section('request parser');
const parsed = parseRequest(REQUEST_MD);

check('parseRequest extracts workflowId', () => assert.equal(parsed.workflowId, 'song-runtime-vars'));
check('parseRequest extracts dynamic target URL', () => assert.ok(parsed.targetUrls.some(r => r.url === 'http://localhost:3737/songs/{{songId}}')));
check('parseRequest preserves concrete example URL', () => {
  const row = parsed.targetUrls.find(r => r.url === 'http://localhost:3737/songs/{{songId}}');
  assert.equal(row.example_url, 'http://localhost:3737/songs/SONG_MPHMZMDK_E9UU_T01');
});
check('parseRequest extracts captured songId', () => {
  const spec = parsed.runtimeVariables.captured.find(v => v.name === 'songId');
  assert.equal(spec.source, 'current_url');
  assert.equal(spec.captureAfter, 'create-song');
});
check('parseRequest extracts derived songUrl', () => assert.equal(parsed.runtimeVariables.derived[0].template, 'http://localhost:3737/songs/{{songId}}'));
check('hasTemplateVars/extractTemplateVars detect songId', () => {
  assert.equal(hasTemplateVars('http://x/{{songId}}'), true);
  assert.deepEqual(extractTemplateVars('http://x/{{songId}}'), ['songId']);
});
check('validateTemplateVars has no undeclared variables in target URLs', () => {
  assert.deepEqual(validateTemplateVars(parsed.targetUrls.map(r => r.url), parsed.runtimeVariables), []);
});
check('validateTemplateVars catches undeclared variable', () => {
  const issues = validateTemplateVars(['http://x/{{missingId}}'], parsed.runtimeVariables);
  assert.equal(issues[0].variable, 'missingId');
});

section('runtime engine');
check('resolveTemplate substitutes songId', () => assert.equal(resolveTemplate('http://x/{{songId}}', { songId: 'SONG_1' }), 'http://x/SONG_1'));
check('tryResolveTemplate returns null for unresolved variable', () => assert.equal(tryResolveTemplate('http://x/{{songId}}', {}), null));
check('computeDerived builds songUrl', () => {
  const vars = computeDerived(parsed.runtimeVariables.derived, { songId: 'SONG_ABCDEFGH_XY12_T01' });
  assert.equal(vars.songUrl, 'http://localhost:3737/songs/SONG_ABCDEFGH_XY12_T01');
});
await checkAsync('captureFromPage captures from current_url', async () => {
  const value = await captureFromPage(mockPage(), { source: 'current_url', regex: '/songs/(SONG_[A-Z0-9_]+)' });
  assert.equal(value, 'SONG_ABCDEFGH_XY12_T01');
});
await checkAsync('captureFromPage captures selector_text', async () => {
  const value = await captureFromPage(mockPage({ text: { "[data-browsy-output='status']": 'Ready' } }), { source: 'selector_text', selector: "[data-browsy-output='status']" });
  assert.equal(value, 'Ready');
});
await checkAsync('captureFromPage captures selector_attribute', async () => {
  const value = await captureFromPage(mockPage({ attrs: { "[data-browsy-output='public-link']::href": 'https://example.test/release' } }), { source: 'selector_attribute', selector: "[data-browsy-output='public-link']", attribute: 'href' });
  assert.equal(value, 'https://example.test/release');
});
await checkAsync('captureVariables reports missing required capture', async () => {
  const result = await captureVariables(mockPage({ url: 'http://localhost:3737/create' }), [{ name: 'songId', source: 'current_url', regex: '/songs/(SONG_[A-Z0-9_]+)', required: true }], {});
  assert.deepEqual(result.vars, {});
  assert.deepEqual(result.missing, ['songId']);
});
check('saveRuntimeVars/loadRuntimeVars round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browsy-runtime-vars-'));
  try {
    const vars = { songId: 'SONG_1', songUrl: 'http://x/SONG_1' };
    saveRuntimeVars(dir, vars);
    assert.deepEqual(loadRuntimeVars(dir), vars);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
check('filterCapturedByTiming respects named stepId', () => {
  const defs = parsed.runtimeVariables.captured;
  assert.ok(filterCapturedByTiming(defs, { event: 'action', stepId: 'create-song' }).some(v => v.name === 'songId'));
  assert.ok(!filterCapturedByTiming(defs, { event: 'action', stepId: 'other-step' }).some(v => v.name === 'songId'));
});
check('isFatalCaptureTiming treats named step as fatal', () => {
  assert.equal(isFatalCaptureTiming('create-song'), true);
  assert.equal(isFatalCaptureTiming('each_step'), false);
});

section('run review');
check('missing runtime variable appears in run-review.md with next fix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browsy-runtime-review-'));
  try {
    const skippedFields = [{ field: 'songId', selector: '', reason: 'missing runtime variable: songId' }];
    const review = generateRunReview({ workflowId: parsed.workflowId, runDir: dir, skipped: skippedFields, runtimeVars: {}, dryRun: true });
    assert.ok(review.includes('## Runtime variables'));
    assert.ok(review.includes('songId'));
    assert.ok(review.includes('Missing required runtime variables'));
    assert.ok(review.includes('## Recommended next fix'));
    assert.ok(review.includes('Update the capture spec'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

section('browser checks');
if (!withBrowser) {
  skip('browser checks skipped — run with --browser');
} else {
  await runBrowserChecks();
}

console.log('\n' + '─'.repeat(60));
console.log(`PASS: ${passed}  FAIL: ${failed}  SKIP: ${skipped}`);
if (failed) process.exit(1);
console.log('\nAcceptance passed: runtime variable / dynamic URL flow.');

async function runBrowserChecks() {
  let browser;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browsy-runtime-browser-'));
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    const songId = 'SONG_ABCDEFGH_XY12_T01';
    const createPath = path.join(dir, 'create.html');
    const detailPath = path.join(dir, `song-${songId}.html`);

    fs.writeFileSync(createPath, `<!doctype html><title>Create</title><div data-browsy-output="status">Ready</div><a data-browsy-output="public-link" href="https://example.test/release">Public</a>`);
    fs.writeFileSync(detailPath, `<!doctype html><title>Detail</title><h1 data-browsy-output="detail">Song Detail ${songId}</h1>`);

    const createUrl = pathToFileURL(createPath).href + `#/songs/${songId}`;
    const detailTemplate = pathToFileURL(path.join(dir, 'song-__SONG_ID__.html')).href.replace('__SONG_ID__', '{{songId}}');

    await checkAsync('Browser loads fixture page with generated URL', async () => {
      await page.goto(createUrl, { waitUntil: 'domcontentloaded' });
      assert.equal(await page.title(), 'Create');
      assert.ok(page.url().includes(songId));
    });
    await checkAsync('Browser captures current_url songId', async () => {
      const value = await captureFromPage(page, { source: 'current_url', regex: '#/songs/(SONG_[A-Z0-9_]+)' });
      assert.equal(value, songId);
    });
    await checkAsync('Browser captures selector_text', async () => {
      const value = await captureFromPage(page, { source: 'selector_text', selector: "[data-browsy-output='status']" });
      assert.equal(value, 'Ready');
    });
    await checkAsync('Browser captures selector_attribute', async () => {
      const value = await captureFromPage(page, { source: 'selector_attribute', selector: "[data-browsy-output='public-link']", attribute: 'href' });
      assert.equal(value, 'https://example.test/release');
    });

    let vars = {};
    await checkAsync('Browser captureVariables captures all vars and derives next URL', async () => {
      const result = await captureVariables(page, [
        { name: 'songId', source: 'current_url', regex: '#/songs/(SONG_[A-Z0-9_]+)', required: true },
        { name: 'statusText', source: 'selector_text', selector: "[data-browsy-output='status']", required: true },
        { name: 'publicLink', source: 'selector_attribute', selector: "[data-browsy-output='public-link']", attribute: 'href', required: true },
      ], {});
      assert.deepEqual(result.missing, []);
      vars = computeDerived([
        { name: 'songUrl', template: 'http://localhost:3737/songs/{{songId}}' },
        { name: 'detailFileUrl', template: detailTemplate },
      ], result.vars);
      assert.equal(vars.songUrl, `http://localhost:3737/songs/${songId}`);
      assert.ok(vars.detailFileUrl.endsWith(`song-${songId}.html`));
    });
    await checkAsync('Browser derived URL can drive next navigation', async () => {
      await page.goto(vars.detailFileUrl, { waitUntil: 'domcontentloaded' });
      const detail = await captureFromPage(page, { source: 'selector_text', selector: "[data-browsy-output='detail']" });
      assert.equal(detail, `Song Detail ${songId}`);
    });
    await checkAsync('Browser saves captured runtime-vars.json', async () => {
      const runDir = path.join(dir, 'run');
      fs.mkdirSync(runDir, { recursive: true });
      saveRuntimeVars(runDir, vars);
      assert.equal(loadRuntimeVars(runDir).songId, songId);
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
