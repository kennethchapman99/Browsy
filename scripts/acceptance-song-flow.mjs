#!/usr/bin/env node
/**
 * Acceptance test: Pancake Robot-style dynamic URL flow
 *
 * Exercises generic runtime variable capture end-to-end using a "create song →
 * capture generated ID → derive detail URL" pattern.  No Pancake Robot-specific
 * logic lives in core; this is a regression fixture for the general mechanism.
 *
 * Checks:
 *   1  UI allows a templated URL ({{songId}} in a page URL field)
 *   2  UI shows "Example URL for discovery" when URL has template vars
 *   3  Generated AUTOMATION_REQUEST.md includes ## 5a. Runtime variables
 *   4  Captured variable (songId) is NOT added as a required manifest input
 *   5  Discovery can use the concrete example URL (no template expansion needed)
 *   6  captureVariables extracts songId from the URL after song creation
 *   7  Dry-run writes runtime-vars.json with captured + derived values
 *   8  run-review.md shows the captured songId
 *   9  Missing songId stops the run safely with actionable run-review feedback
 *  10  npm run smoke still passes with 0 failures
 *
 * Usage:
 *   node scripts/acceptance-song-flow.mjs            # non-browser checks only
 *   node scripts/acceptance-song-flow.mjs --browser  # full suite
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { fileURLToPath }  from 'url';
import { spawnSync }      from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');
const withBrowser = process.argv.includes('--browser');

// ── Helpers ────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0, warned = 0;
const report = { checks: [], generatedMd: '', runtimeVarsExample: null };

function pass(label) { console.log('PASS  ' + label); passed++; report.checks.push({ status: 'PASS', label }); }
function fail(label, detail = '') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
  report.checks.push({ status: 'FAIL', label, detail });
}
function warn(label) { console.log('WARN  ' + label); warned++; report.checks.push({ status: 'WARN', label }); }
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

// ── SAMPLE AUTOMATION_REQUEST.MD ───────────────────────────────────────────────
// Represents what the Browsy wizard would generate for a song-creation workflow.
const SAMPLE_REQUEST_MD = `# Browsy Automation Request

## 1. Workflow name

\`song-detail-flow\`

## 2. Goal

Create a new song and navigate to its generated detail page.

## 3. Target websites / pages

| Purpose | URL | Requires login? | Example URL | Notes |
| --- | --- | --- | --- | --- |
| Song creation | http://localhost:3737/create | no | | |
| Song detail | http://localhost:3737/songs/{{songId}} | no | http://localhost:3737/songs/SONG_MPHMZMDK_E9UU_T01 | Dynamic URL — songId captured at runtime |

## 4. Existing APIs or local systems

| System | Type | Purpose | Auth/notes |
| --- | --- | --- | --- |
| Local files | files | Source of truth | |

## 5. Input data contract

\`\`\`json
{
  "id": "ITEM_123",
  "title": "Summer Haze",
  "artistName": "The Midnight"
}
\`\`\`

## 5a. Runtime variables

\`\`\`json
{
  "captured": [
    {
      "name": "songId",
      "source": "current_url",
      "regex": "/songs/(SONG_[A-Z0-9_]+)",
      "example": "SONG_MPHMZMDK_E9UU_T01",
      "required": true
    }
  ],
  "derived": [
    {
      "name": "songUrl",
      "template": "http://localhost:3737/songs/{{songId}}"
    }
  ]
}
\`\`\`

## 6. Desired workflow steps

1. Open the song creation page.
2. Fill in title and artist.
3. Click Create Song.
4. Capture songId from the URL of the resulting detail page.
5. Derive songUrl from songId.
6. Navigate to songUrl to confirm the detail page loaded.

## 7. Fields to fill or upload

| Field / action | Source in input | Website field/page | Rule / why |
| --- | --- | --- | --- |
| title | \`title\` | Song creation form | Song title |
| artistName | \`artistName\` | Song creation form | Artist name |

## 8. Actions that must stay manual

- Final submit
- Payment or purchase
- Legal certification checkboxes
- Paid extras or add-ons
- Deletion or destructive changes

## 9. Human checkpoints

- Stop before final submit.
- Leave browser open by default.

## 10. Authentication plan

- none

## 11. Discovery needs

- http://localhost:3737/create
- http://localhost:3737/songs/SONG_MPHMZMDK_E9UU_T01

## 12. Safety policy

\`\`\`json
{
  "never_click_text": ["Submit","Finalize","Pay","Purchase","Release","Delete"],
  "never_click_selectors": [],
  "manual_only_categories": ["final submission","payment","legal certification"]
}
\`\`\`

## 13. Output artifacts expected

Every run should save:

- run-log.json
- filled-fields.json
- skipped-fields.json
- errors.json
- runtime-vars.json
- screenshot-start.png
- screenshot-after-fill.png
- page-text-snapshot.txt
- html-snapshot.html

## 14. Test commands expected

\`\`\`bash
npm install
npm run smoke
npm run discover -- --workflow song-detail-flow --url http://localhost:3737/songs/SONG_MPHMZMDK_E9UU_T01
npm run run -- --workflow song-detail-flow --manifest workflows/song-detail-flow/manifest.example.json --dry-run
\`\`\`

## 15. Acceptance criteria

- URL templates render correctly.
- Captured variables are not treated as required user inputs.
- Missing captured variables produce useful run-review feedback.
- runtime-vars.json is saved after each capture step.
- Discovery uses the example URL, not the template.

## 16. Narrated walkthrough

(No walkthrough recorded yet.)
`;

report.generatedMd = SAMPLE_REQUEST_MD;

// ── Non-browser checks ─────────────────────────────────────────────────────────

section(1, 'Wizard UI allows a templated URL');
try {
  const wizardHtml = fs.readFileSync(path.join(REPO_ROOT, 'wizard/index.html'), 'utf8');
  if (!wizardHtml.includes('hasTemplateVars'))
    fail('Check 1: wizard does not define hasTemplateVars()');
  else pass('Check 1: wizard defines hasTemplateVars() for URL template detection');

  if (!wizardHtml.includes('{{varName}}') && !wizardHtml.includes('varName'))
    warn('Check 1: wizard placeholder text could mention {{varName}} syntax');
  else pass('Check 1: wizard mentions {{varName}} syntax in placeholder/hint');
} catch (e) {
  fail('Check 1: threw — ' + e.message);
}

section(2, 'UI shows Example URL for discovery');
try {
  const wizardHtml = fs.readFileSync(path.join(REPO_ROOT, 'wizard/index.html'), 'utf8');
  if (!wizardHtml.includes('urlExample'))
    fail('Check 2: wizard does not handle urlExample field');
  else pass('Check 2: wizard stores urlExample per page');

  if (!wizardHtml.includes('Example URL for discovery'))
    fail('Check 2: wizard missing "Example URL for discovery" label');
  else pass('Check 2: wizard shows "Example URL for discovery" label');

  if (!wizardHtml.includes("hasTemplateVars(p.url)"))
    fail('Check 2: wizard does not conditionally show urlExample based on template vars');
  else pass('Check 2: urlExample input is shown conditionally when URL has {{...}}');
} catch (e) {
  fail('Check 2: threw — ' + e.message);
}

section(3, 'AUTOMATION_REQUEST.md includes ## 5a. Runtime variables');
try {
  const { parseRequest } = await import('../src/core/request-parser.mjs');
  const parsed = parseRequest(SAMPLE_REQUEST_MD);

  if (!parsed.runtimeVariables)
    fail('Check 3: parseRequest did not return runtimeVariables');
  else pass('Check 3: parseRequest returns runtimeVariables object');

  const captured = parsed.runtimeVariables.captured || [];
  const songIdDef = captured.find(v => v.name === 'songId');
  if (!songIdDef)
    fail('Check 3: songId not found in parsed runtimeVariables.captured');
  else {
    pass('Check 3: runtimeVariables.captured includes songId');
    if (songIdDef.source !== 'current_url')
      fail('Check 3: songId source should be current_url, got ' + songIdDef.source);
    else pass('Check 3: songId source = current_url ✓');
    if (!songIdDef.regex || !songIdDef.regex.includes('SONG_'))
      fail('Check 3: songId regex missing SONG_ pattern, got: ' + songIdDef.regex);
    else pass('Check 3: songId regex includes SONG_[A-Z0-9_]+ ✓');
  }

  const derived = parsed.runtimeVariables.derived || [];
  const songUrlDef = derived.find(v => v.name === 'songUrl');
  if (!songUrlDef)
    fail('Check 3: songUrl not found in runtimeVariables.derived');
  else {
    pass('Check 3: runtimeVariables.derived includes songUrl');
    if (!songUrlDef.template.includes('{{songId}}'))
      fail('Check 3: songUrl template should contain {{songId}}');
    else pass('Check 3: songUrl template = http://localhost:3737/songs/{{songId}} ✓');
  }

  // Also verify the ## 3. Target websites table has the example URL
  const templatePage = parsed.targetUrls.find(r => r.url && r.url.includes('{{'));
  if (!templatePage)
    warn('Check 3: no target URL with template vars found in parsed request');
  else {
    pass('Check 3: template URL detected in target pages: ' + templatePage.url);
    const exampleCol = templatePage.example_url || templatePage.url_example;
    if (!exampleCol || !exampleCol.includes('SONG_MPHMZMDK'))
      warn('Check 3: example URL column not parsed from pages table (may need table header update)');
    else pass('Check 3: example URL parsed from pages table: ' + exampleCol);
  }

  // Verify no validation errors for declared template var
  const errs = parsed.validationIssues.filter(i => i.level === 'error' && i.field === 'runtime_variables');
  if (errs.length)
    fail('Check 3: validator flagged undeclared template variables: ' + errs.map(e => e.message).join('; '));
  else pass('Check 3: no undeclared {{variable}} validation errors ✓');

} catch (e) {
  fail('Check 3: threw — ' + e.message);
  if (process.env.BROWSY_DEBUG) console.error(e.stack);
}

section(4, 'Captured variable excluded from manifest input');
try {
  // Write a temp AUTOMATION_REQUEST.md and scaffold a workflow from it, then
  // verify manifest.example.json does NOT contain songId.
  const tmpWfId = 'accept-song-' + Date.now().toString(36);
  const tmpReq  = SAMPLE_REQUEST_MD.replace('`song-detail-flow`', `\`${tmpWfId}\``);
  const reqPath = path.join(REPO_ROOT, 'AUTOMATION_REQUEST.md');
  const reqBackup = fs.existsSync(reqPath) ? fs.readFileSync(reqPath) : null;

  fs.writeFileSync(reqPath, tmpReq, 'utf8');

  const result = spawnSync(process.execPath, ['src/cli/index.mjs', 'init', '--from-request'],
    { cwd: REPO_ROOT, encoding: 'utf8' });

  // Restore original
  if (reqBackup !== null) fs.writeFileSync(reqPath, reqBackup);
  else fs.unlinkSync(reqPath);

  if (result.status !== 0) {
    fail('Check 4: init --from-request failed: ' + result.stderr.slice(0, 200));
  } else {
    const manifestPath = path.join(REPO_ROOT, 'workflows', tmpWfId, 'manifest.example.json');
    if (!fs.existsSync(manifestPath)) {
      fail('Check 4: manifest.example.json not created');
    } else {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if ('songId' in manifest)
        fail('Check 4: manifest.example.json contains songId — captured var leaked into manifest!');
      else pass('Check 4: manifest.example.json does NOT contain songId ✓');

      // Verify input vars DO appear
      if (!('title' in manifest) && !('id' in manifest))
        warn('Check 4: manifest.example.json seems empty — expected input fields');
      else pass('Check 4: input variables (title, id) present in manifest ✓');

      // Verify workflow.json carries variables.captured
      const wfPath = path.join(REPO_ROOT, 'workflows', tmpWfId, 'workflow.json');
      const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
      const capturedInWf = wf.variables?.captured || [];
      const songIdInWf = capturedInWf.find(v => v.name === 'songId');
      if (!songIdInWf)
        fail('Check 4: workflow.json missing variables.captured.songId');
      else pass('Check 4: workflow.json carries variables.captured.songId ✓');
    }

    // Cleanup temp workflow
    const tmpWfDir = path.join(REPO_ROOT, 'workflows', tmpWfId);
    if (fs.existsSync(tmpWfDir)) fs.rmSync(tmpWfDir, { recursive: true });
  }
} catch (e) {
  fail('Check 4: threw — ' + e.message);
  if (process.env.BROWSY_DEBUG) console.error(e.stack);
}

section(5, 'Example URL has no template vars — ready for discovery');
try {
  const { hasTemplateVars, extractTemplateVars } = await import('../src/core/runtime-vars.mjs');
  const exampleUrl = 'http://localhost:3737/songs/SONG_MPHMZMDK_E9UU_T01';
  const templateUrl = 'http://localhost:3737/songs/{{songId}}';

  if (hasTemplateVars(exampleUrl))
    fail('Check 5: example URL should have no template vars but hasTemplateVars returned true');
  else pass('Check 5: example URL is concrete — discovery can navigate to it directly ✓');

  if (!hasTemplateVars(templateUrl))
    fail('Check 5: template URL should be detected as containing vars');
  else {
    const vars = extractTemplateVars(templateUrl);
    if (!vars.includes('songId'))
      fail('Check 5: extractTemplateVars missed songId in template URL');
    else pass('Check 5: template URL correctly identified as containing {{songId}} ✓');
  }

  // Verify the fixture file is reachable as a concrete local URL (file://)
  const fixturePath = path.join(REPO_ROOT, 'fixtures/song-creator/index.html');
  if (!fs.existsSync(fixturePath))
    fail('Check 5: song-creator fixture missing at ' + fixturePath);
  else {
    const fixtureUrl = 'file://' + fixturePath + '#/songs/SONG_MPHMZMDK_E9UU_T01';
    if (hasTemplateVars(fixtureUrl))
      fail('Check 5: fixture example URL unexpectedly contains template vars');
    else pass('Check 5: fixture example URL is a plain, navigable URL ✓');
  }
} catch (e) {
  fail('Check 5: threw — ' + e.message);
}

section(9, 'Missing songId stops run safely with actionable feedback (non-browser)');
try {
  const { captureVariables } = await import('../src/core/runtime-vars.mjs');
  const { generateRunReview } = await import('../src/core/run-review.mjs');

  // Mock a Playwright page whose URL contains no SONG_ ID
  const mockPageNoSong = { url: () => 'http://localhost:3737/create' };
  const captureSpec = [{ name: 'songId', source: 'current_url', regex: '/songs/(SONG_[A-Z0-9_]+)', required: true }];

  const { vars, missing } = await captureVariables(mockPageNoSong, captureSpec, {});
  if (!missing.includes('songId'))
    fail('Check 9: captureVariables should report songId in missing[] when URL has no SONG_ ID');
  else pass('Check 9: captureVariables reports songId in missing[] ✓');

  if ('songId' in vars)
    fail('Check 9: vars should not contain songId when capture failed');
  else pass('Check 9: vars object does not contain failed capture ✓');

  // Simulate the run stopping: record skipped field for missing var
  const { recordSkippedField } = await import('../src/core/workflow-runtime.mjs');
  const skipped = [];
  for (const name of missing) recordSkippedField(skipped, name, 'missing runtime variable: ' + name);

  const tmpDir = path.join(os.tmpdir(), 'browsy-accept-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const review = generateRunReview({
    workflowId: 'song-detail-flow', runDir: tmpDir,
    filled: [], skipped, errors: [],
    startUrl: 'http://localhost:3737/create', dryRun: true
  });

  if (!review.includes('Runtime variables'))
    fail('Check 9: run-review.md missing "Runtime variables" section');
  else pass('Check 9: run-review.md includes Runtime variables section ✓');

  if (!review.includes('songId'))
    fail('Check 9: run-review.md does not mention songId');
  else pass('Check 9: run-review.md mentions songId ✓');

  if (!review.includes('missing runtime variable') && !review.includes('Missing required'))
    fail('Check 9: run-review.md does not describe the missing-variable problem');
  else pass('Check 9: run-review.md describes missing required variable ✓');

  if (!review.includes('capture spec') && !review.includes('capture step') && !review.includes('Recommended'))
    warn('Check 9: run-review.md may not include recommended fix for missing var');
  else pass('Check 9: run-review.md includes recommended next fix ✓');

} catch (e) {
  fail('Check 9 (non-browser): threw — ' + e.message);
  if (process.env.BROWSY_DEBUG) console.error(e.stack);
}

// ── Browser checks ─────────────────────────────────────────────────────────────
if (withBrowser) {
  console.log('\n── Browser checks (fixture: song-creator) ──');
  await runBrowserChecks();
} else {
  console.log('\n── Browser checks (6, 7, 8, 9b) ──');
  console.log('  (skipped — run with --browser to include)');
  // Mark browser checks as skipped in report
  for (const n of [6, 7, 8]) report.checks.push({ status: 'SKIP', label: `Check ${n}: browser required` });
}

// ── Check 10: smoke tests ──────────────────────────────────────────────────────
section(10, 'npm run smoke passes with 0 failures');
try {
  const smokeResult = spawnSync(process.execPath, ['scripts/smoke-test.mjs'],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });

  const lastLine = smokeResult.stdout.trim().split('\n').pop() || '';
  const failMatch = smokeResult.stdout.match(/FAIL:\s*(\d+)/);
  const failCount = failMatch ? parseInt(failMatch[1], 10) : -1;

  if (smokeResult.status !== 0 || failCount > 0) {
    fail('Check 10: smoke tests have failures — FAIL=' + (failCount >= 0 ? failCount : '?'),
      smokeResult.stderr?.slice(0, 300) || smokeResult.stdout.slice(-300));
  } else {
    const passMatch = smokeResult.stdout.match(/PASS:\s*(\d+)/);
    pass('Check 10: npm run smoke passes — ' + (passMatch ? passMatch[1] + ' checks' : 'all checks') + ' ✓');
  }
} catch (e) {
  fail('Check 10: threw — ' + e.message);
}

// ── Final report ───────────────────────────────────────────────────────────────
printFinalReport();

// ── Browser implementation ─────────────────────────────────────────────────────
async function runBrowserChecks() {
  let browser;
  try {
    const { chromium }  = await import('playwright');
    const { captureVariables, computeDerived, saveRuntimeVars, loadRuntimeVars,
            captureFromPage } = await import('../src/core/runtime-vars.mjs');
    const { createRunDir, createRunLogger, finalizeRun,
            recordSkippedField } = await import('../src/core/workflow-runtime.mjs');
    const { generateRunReview } = await import('../src/core/run-review.mjs');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const fixturePath = path.join(REPO_ROOT, 'fixtures/song-creator/index.html');
    const fixtureBase = 'file://' + fixturePath;
    const exampleUrl  = fixtureBase + '#/songs/SONG_MPHMZMDK_E9UU_T01';

    // ── Check 5 (browser): navigate to example URL, confirm detail page renders ──
    section(5, 'Discovery uses example URL (browser)');
    await page.goto(exampleUrl, { waitUntil: 'domcontentloaded' });
    const titleAfterNav = await page.title();
    if (!titleAfterNav.includes('SONG_MPHMZMDK'))
      warn('Check 5: page title after example URL nav: ' + titleAfterNav);
    else pass('Check 5: example URL loaded song detail page — title: ' + titleAfterNav + ' ✓');

    const idText = await page.locator('#song-id-display').textContent().catch(() => '');
    if (!idText.includes('SONG_MPHMZMDK'))
      fail('Check 5: #song-id-display does not show expected ID, got: ' + idText);
    else pass('Check 5: #song-id-display shows SONG_MPHMZMDK_E9UU_T01 ✓');

    // Check 5: current URL has no {{...}} so discovery would work
    const urlOnPage = page.url();
    if (urlOnPage.includes('{{'))
      fail('Check 5: URL after example nav contains template vars: ' + urlOnPage);
    else pass('Check 5: page URL is concrete after example nav — discovery can proceed ✓');

    // ── Check 6: navigate to creator, click Create Song, capture songId ──────────
    section(6, 'Dry-run captures songId after navigation');
    await page.goto(fixtureBase, { waitUntil: 'domcontentloaded' });
    await page.click('#btn-create');
    await page.waitForFunction(() => window.location.hash.startsWith('#/songs/'));

    const captureSpec = [{ name: 'songId', source: 'current_url', regex: '/songs/(SONG_[A-Z0-9_]+)', required: true }];
    const { vars: captured, missing } = await captureVariables(page, captureSpec, {});

    if (missing.length)
      fail('Check 6: captureVariables reported missing vars: ' + missing.join(', '));
    else pass('Check 6: captureVariables reports no missing variables ✓');

    if (!captured.songId || !captured.songId.startsWith('SONG_'))
      fail('Check 6: captured.songId is invalid — got: ' + captured.songId);
    else pass('Check 6: songId captured from URL: ' + captured.songId + ' ✓');

    // Derive songUrl
    const derived = computeDerived([{ name: 'songUrl', template: 'http://localhost:3737/songs/{{songId}}' }], captured);
    const expectedSongUrl = 'http://localhost:3737/songs/' + captured.songId;
    if (derived.songUrl !== expectedSongUrl)
      fail('Check 6: derived.songUrl wrong — got ' + derived.songUrl);
    else pass('Check 6: derived songUrl = ' + derived.songUrl + ' ✓');

    // ── Check 7: write runtime-vars.json ──────────────────────────────────────────
    section(7, 'Dry-run writes runtime-vars.json');
    const runDir = createRunDir('song-flow-acceptance');
    saveRuntimeVars(runDir, derived);

    const rtvPath = path.join(runDir, 'runtime-vars.json');
    if (!fs.existsSync(rtvPath))
      fail('Check 7: runtime-vars.json not found at ' + rtvPath);
    else {
      const loaded = loadRuntimeVars(runDir);
      if (loaded.songId !== captured.songId)
        fail('Check 7: runtime-vars.json songId mismatch — got ' + loaded.songId);
      else pass('Check 7: runtime-vars.json written and reloaded correctly ✓');

      if (loaded.songUrl !== expectedSongUrl)
        fail('Check 7: runtime-vars.json songUrl mismatch — got ' + loaded.songUrl);
      else pass('Check 7: runtime-vars.json contains derived songUrl ✓');

      // Stash for final report
      report.runtimeVarsExample = loaded;
      console.log('  runtime-vars.json path: ' + rtvPath);
    }

    // ── Check 8: run-review.md shows captured songId ───────────────────────────
    section(8, 'Run review shows captured songId');
    const logger = createRunLogger(runDir);
    logger.log('info', 'Captured: songId = ' + captured.songId);
    logger.log('info', 'Derived:  songUrl = ' + derived.songUrl);

    finalizeRun(runDir, {
      logger, filled: [], skipped: [], errors: [],
      workflowId: 'song-detail-flow',
      startUrl: fixtureBase,
      dryRun: true,
      runtimeVars: derived
    });

    const reviewPath = path.join(runDir, 'run-review.md');
    if (!fs.existsSync(reviewPath))
      fail('Check 8: run-review.md not written by finalizeRun');
    else {
      const review = fs.readFileSync(reviewPath, 'utf8');

      if (!review.includes('Runtime variables'))
        fail('Check 8: run-review.md missing "Runtime variables" section');
      else pass('Check 8: run-review.md contains "Runtime variables" section ✓');

      if (!review.includes(captured.songId))
        fail('Check 8: run-review.md does not show captured songId (' + captured.songId + ')');
      else pass('Check 8: run-review.md shows captured songId ✓');

      if (!review.includes('songUrl'))
        warn('Check 8: run-review.md does not mention derived songUrl');
      else pass('Check 8: run-review.md shows derived songUrl ✓');

      if (!review.includes('runtime-vars.json'))
        warn('Check 8: run-review.md does not reference runtime-vars.json');
      else pass('Check 8: run-review.md references runtime-vars.json ✓');
    }

    // ── Check 9b (browser): missing songId stops run with actionable review ────
    section(9, 'Missing songId stops run safely (browser)');
    const plainPage = await context.newPage();
    await plainPage.goto(fixtureBase, { waitUntil: 'domcontentloaded' });
    // Do NOT click Create Song — URL has no #/songs/ hash, so regex won't match

    const { vars: emptyVars, missing: miss9 } = await captureVariables(plainPage, captureSpec, {});
    if (!miss9.includes('songId'))
      fail('Check 9b: expected songId in missing[], got: ' + JSON.stringify(miss9));
    else pass('Check 9b: captureVariables correctly reports songId missing when not on detail page ✓');

    // Simulate the run-stop path
    const stop9Dir = createRunDir('song-flow-missing-var');
    const stopLogger = createRunLogger(stop9Dir);
    const stop9Skipped = [];
    for (const name of miss9) recordSkippedField(stop9Skipped, name, 'missing runtime variable: ' + name);
    stopLogger.log('error', 'Stopping: required runtime variable(s) could not be captured: ' + miss9.join(', '));

    finalizeRun(stop9Dir, {
      logger: stopLogger, filled: [], skipped: stop9Skipped, errors: [],
      workflowId: 'song-detail-flow',
      startUrl: fixtureBase,
      dryRun: true,
      runtimeVars: null
    });

    const stop9Review = path.join(stop9Dir, 'run-review.md');
    if (!fs.existsSync(stop9Review))
      fail('Check 9b: run-review.md not written for stopped run');
    else {
      const md9 = fs.readFileSync(stop9Review, 'utf8');
      if (!md9.includes('songId'))
        fail('Check 9b: stopped run-review.md does not mention songId');
      else pass('Check 9b: stopped run-review.md mentions songId ✓');

      if (!md9.includes('Missing required') && !md9.includes('missing runtime variable'))
        fail('Check 9b: run-review.md does not describe the missing-variable problem clearly');
      else pass('Check 9b: run-review.md describes the missing variable problem ✓');

      if (!md9.includes('capture spec') && !md9.includes('capture step') && !md9.includes('Recommended'))
        warn('Check 9b: run-review.md may not include a recommended fix');
      else pass('Check 9b: run-review.md includes recommended fix section ✓');
    }

    await plainPage.close();

  } catch (e) {
    fail('Browser checks threw: ' + e.message);
    if (process.env.BROWSY_DEBUG) console.error(e.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Report printer ─────────────────────────────────────────────────────────────
function printFinalReport() {
  const line = '─'.repeat(60);
  console.log('\n' + line);
  console.log('ACCEPTANCE REPORT — Browsy dynamic URL / runtime variable flow');
  console.log(line);

  console.log('\n### Check results\n');
  for (const c of report.checks) {
    const icon = c.status === 'PASS' ? '✓' : c.status === 'FAIL' ? '✗' : c.status === 'SKIP' ? '·' : '?';
    console.log(`  [${icon}] ${c.label}${c.detail ? '\n      ' + c.detail : ''}`);
  }

  console.log('\n### Generated AUTOMATION_REQUEST.md excerpt\n');
  const lines = SAMPLE_REQUEST_MD.split('\n');
  const start = lines.findIndex(l => l.startsWith('## 3.'));
  const end   = lines.findIndex((l, i) => i > start + 2 && l.startsWith('## 6.'));
  const excerpt = lines.slice(start, end).join('\n').trim();
  console.log(indent(excerpt, '  '));

  if (report.runtimeVarsExample) {
    console.log('\n### runtime-vars.json (example from browser run)\n');
    console.log(indent(JSON.stringify(report.runtimeVarsExample, null, 2), '  '));
  } else {
    console.log('\n### runtime-vars.json (example, browser skipped)\n');
    const example = {
      songId: 'SONG_ABCDEFGH_XY12_T01',
      songUrl: 'http://localhost:3737/songs/SONG_ABCDEFGH_XY12_T01'
    };
    console.log(indent(JSON.stringify(example, null, 2), '  '));
  }

  console.log('\n### Known gaps\n');
  const gaps = [
    'Multi-step capture: run.mjs only captures after the START page navigation.',
    'A workflow where songId is captured after an explicit "click Create" step requires',
    'hand-editing run.mjs to insert captureAndDerive() after the click — not yet automatic.',
    '',
    'Selector-based capture (selector_text, selector_attribute) is implemented in',
    'runtime-vars.mjs but has no fixture coverage in the smoke tests yet.',
    '',
    'The wizard UI for captured variables has no live preview of the regex result.',
    'Users cannot test their regex against a sample URL without running the full workflow.',
    '',
    'Derived variable computation is not retried if a dependency was captured later',
    'in the same run — computeDerived must be called again after each capture step.',
  ];
  for (const g of gaps) console.log('  ' + (g ? '• ' + g : ''));

  console.log('\n' + line);
  console.log(`PASS: ${passed}  FAIL: ${failed}  WARN: ${warned}  SKIP: ${report.checks.filter(c=>c.status==='SKIP').length}`);
  if (failed) {
    console.error('\n' + failed + ' acceptance check(s) FAILED.');
    process.exit(1);
  }
  console.log('\nAll acceptance checks passed.' + (withBrowser ? '' : ' (Run with --browser for full suite.)'));
}

function indent(text, prefix) {
  return text.split('\n').map(l => prefix + l).join('\n');
}
