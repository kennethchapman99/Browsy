#!/usr/bin/env node
/**
 * Browsy v0.2 smoke test suite.
 *
 * Non-browser checks run always (fast, < 1 second).
 * Browser checks run when --browser flag is passed (requires Playwright + Chromium).
 *
 * Usage:
 *   npm run smoke              # non-browser only
 *   npm run smoke:browser      # includes browser-based fixture tests
 */
import fs from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const withBrowser = process.argv.includes('--browser');

let passed = 0;
let failed = 0;
let warned = 0;

function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') { console.error('FAIL  ' + label + (detail ? '\n      ' + detail : '')); failed++; }
function warn(label) { console.log('WARN  ' + label); warned++; }
function section(title) { console.log('\n── ' + title + ' ──'); }

// ---------------------------------------------------------------------------
// 1. Required file existence
// ---------------------------------------------------------------------------
section('Required files');

const requiredFiles = [
  'README.md',
  'AGENTS.md',
  'AUTOMATION_REQUEST.md',
  'package.json',
  'src/cli/index.mjs',
  'src/core/args.mjs',
  'src/core/paths.mjs',
  'src/core/safety.mjs',
  'src/core/discovery.mjs',
  'src/core/request-parser.mjs',
  'src/core/workflow-runtime.mjs',
  'src/core/field-map-candidates.mjs',
  'src/adapters/playwright-adapter.mjs',
  'src/adapters/api-adapter.mjs',
  'src/adapters/browser-agent-adapter.mjs',
  'docs/architecture.md',
  'docs/agent-build-runbook.md',
  'docs/product-positioning.md',
  'templates/workflow/workflow.yaml',
  'templates/workflow/safety-policy.json',
  'examples/distrokid-upload/README.md',
  'fixtures/local-form/index.html',
  'fixtures/local-form/sample-manifest.json',
  'fixtures/local-form/field-map.json',
  'wizard/server.mjs',
  'wizard/index.html'
];

for (const file of requiredFiles) {
  const path = join(REPO_ROOT, file);
  if (!fs.existsSync(path)) fail('missing: ' + file);
  else pass('exists: ' + file);
}

// ---------------------------------------------------------------------------
// 2. package.json scripts
// ---------------------------------------------------------------------------
section('package.json scripts');

const pkg = JSON.parse(fs.readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const requiredScripts = ['wizard','smoke','smoke:browser','validate:request','plan','init:workflow','auth:save','auth:check','discover','generate:prompt','run','discover:all','review','feedback','promote'];
for (const script of requiredScripts) {
  if (!pkg.scripts?.[script]) fail('missing script: ' + script);
  else pass('script: ' + script);
}

// ---------------------------------------------------------------------------
// 3. AGENTS.md phrase checks
// ---------------------------------------------------------------------------
section('AGENTS.md content');

const agentsMd = fs.readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
const agentsPhrases = [
  'dry-run', 'Playwright', 'APIs', 'human checkpoints',
  'safety', 'smoke', 'never claim success', 'manual-only'
];
for (const phrase of agentsPhrases) {
  if (!agentsMd.includes(phrase)) fail('AGENTS.md missing phrase: ' + phrase);
  else pass('AGENTS.md has: ' + phrase);
}

// ---------------------------------------------------------------------------
// 4. Request parsing
// ---------------------------------------------------------------------------
section('Request parsing');

try {
  const { parseRequest, formatValidationIssues } = await import('../src/core/request-parser.mjs');
  const text = fs.readFileSync(join(REPO_ROOT, 'AUTOMATION_REQUEST.md'), 'utf8');
  const req = parseRequest(text);

  if (!req.workflowId) fail('Request parser: workflowId is empty');
  else pass('Request parser: workflowId = ' + req.workflowId);

  if (!req.goal) fail('Request parser: goal is empty');
  else pass('Request parser: goal extracted');

  if (!req.targetUrls.length) fail('Request parser: no target URLs');
  else pass('Request parser: ' + req.targetUrls.length + ' target URL(s)');

  if (!req.safetyPolicy) fail('Request parser: safety policy JSON not found');
  else pass('Request parser: safety policy parsed');

  if (!req.manualOnlyActions.length) fail('Request parser: no manual-only actions');
  else pass('Request parser: ' + req.manualOnlyActions.length + ' manual-only action(s)');

  const errors = req.validationIssues.filter(i => i.level === 'error');
  const warnings = req.validationIssues.filter(i => i.level === 'warning');
  if (errors.length) warn('Request has ' + errors.length + ' validation error(s): ' + errors.map(e => e.field).join(', '));
  else pass('Request parser: no validation errors');
  if (warnings.length) warn('Request has ' + warnings.length + ' warning(s): ' + warnings.map(w => w.field).join(', '));

} catch (err) {
  fail('Request parsing threw: ' + err.message);
}

// ---------------------------------------------------------------------------
// 5. Safety logic
// ---------------------------------------------------------------------------
section('Safety logic');

try {
  const { isDangerousText, isSelectorBlocked, isLegalAttestation, isPaymentAction,
          isDestructiveAction, isManualOnly, defaultSafetyPolicy } = await import('../src/core/safety.mjs');
  const policy = defaultSafetyPolicy();

  // Dangerous text detection
  const dangerousCases = [
    ['Submit', true], ['submit', true], ['SUBMIT', true],
    ['Pay now', true], ['Purchase', true], ['Release', true],
    ['Delete', true], ['Next', false], ['Save draft', false], ['Continue', false]
  ];
  for (const [text, expected] of dangerousCases) {
    const result = isDangerousText(text, policy);
    if (result !== expected) fail(`isDangerousText("${text}") = ${result}, expected ${expected}`);
    else pass(`isDangerousText("${text}") = ${expected}`);
  }

  // Legal attestation detection
  const legalCases = [
    ['I certify that I own all rights', true],
    ['I agree to the Terms of Service', true],
    ['Add to cart', false],
    ['Next step', false]
  ];
  for (const [text, expected] of legalCases) {
    const result = isLegalAttestation(text);
    if (result !== expected) fail(`isLegalAttestation("${text}") = ${result}, expected ${expected}`);
    else pass(`isLegalAttestation("${text}") = ${expected}`);
  }

  // Payment detection
  const paymentCases = [
    ['Pay $9.99', true], ['Checkout', true], ['Add paid mastering', true],
    ['Save description', false]
  ];
  for (const [text, expected] of paymentCases) {
    const result = isPaymentAction(text);
    if (result !== expected) fail(`isPaymentAction("${text}") = ${result}, expected ${expected}`);
    else pass(`isPaymentAction("${text}") = ${expected}`);
  }

  // Selector blocking
  const selectorCases = [
    ['#submit-btn', { never_click_selectors: ['#submit-btn'] }, true],
    ['#next-btn', { never_click_selectors: ['#submit-btn'] }, false],
    ['#ok', {}, false]
  ];
  for (const [sel, pol, expected] of selectorCases) {
    const result = isSelectorBlocked(sel, pol);
    if (result !== expected) fail(`isSelectorBlocked("${sel}") = ${result}, expected ${expected}`);
    else pass(`isSelectorBlocked("${sel}") = ${expected}`);
  }

  // Manual-only category
  const manualCases = [
    ['legal certification', policy, true],
    ['payment', policy, true],
    ['title text', policy, false]
  ];
  for (const [cat, pol, expected] of manualCases) {
    const result = isManualOnly(cat, pol);
    if (result !== expected) fail(`isManualOnly("${cat}") = ${result}, expected ${expected}`);
    else pass(`isManualOnly("${cat}") = ${expected}`);
  }

} catch (err) {
  fail('Safety logic threw: ' + err.message);
}

// ---------------------------------------------------------------------------
// 6. Field map candidates (no browser — uses fixture discovery JSON)
// ---------------------------------------------------------------------------
section('Field map candidates (no browser)');

try {
  const { generateCandidates, candidatesMarkdown } = await import('../src/core/field-map-candidates.mjs');

  const mockDiscovery = {
    url: 'file:///fixtures/local-form/index.html',
    captured_at: new Date().toISOString(),
    inputs: [
      { index: 0, tag: 'input', type: 'text', id: 'title', name: 'title', placeholder: 'Enter release title', ariaLabel: '', labels: 'Release Title', visible: true, accept: '', dataTestid: 'title-input' },
      { index: 1, tag: 'input', type: 'checkbox', id: 'legal-cert', name: 'legal_certification', placeholder: '', ariaLabel: 'I certify that I own all rights to this content', labels: 'I certify', visible: true, accept: '' },
      { index: 2, tag: 'input', type: 'submit', id: 'btn-submit', name: '', placeholder: '', ariaLabel: '', labels: '', visible: true, accept: '' }
    ],
    textareas: [
      { index: 0, tag: 'textarea', id: 'description', name: 'description', placeholder: 'Enter a short description', ariaLabel: '', labels: 'Description', visible: true }
    ],
    selects: [
      { index: 0, tag: 'select', id: 'category', name: 'category', ariaLabel: '', labels: 'Category', visible: true }
    ],
    buttons: [
      { index: 0, text: 'Next →', id: 'btn-next', name: '', ariaLabel: '', visible: true, tag: 'button' },
      { index: 1, text: 'Submit Release', id: 'btn-submit', name: '', ariaLabel: '', visible: true, tag: 'button' }
    ],
    fileInputs: [
      { index: 0, tag: 'input', type: 'file', id: 'audio-file', name: 'audio_file', placeholder: '', ariaLabel: '', labels: 'Audio File', visible: true, accept: '.mp3,.wav,.flac,.aiff' }
    ]
  };

  const result = generateCandidates(mockDiscovery, []);
  if (!result.candidates || !result.candidates.length) fail('generateCandidates: no candidates returned');
  else pass('generateCandidates: ' + result.candidates.length + ' candidate(s)');

  const dangerousCount = result.candidates.filter(c => c.isDangerous).length;
  if (dangerousCount < 2) fail('generateCandidates: expected dangerous fields (submit, legal), got ' + dangerousCount);
  else pass('generateCandidates: ' + dangerousCount + ' dangerous field(s) flagged');

  const titleCandidate = result.candidates.find(c => c.raw.id === 'title');
  if (!titleCandidate) fail('generateCandidates: title field not found in candidates');
  else if (!titleCandidate.selectorCandidates.length) fail('generateCandidates: title has no selector candidates');
  else pass('generateCandidates: title field has ' + titleCandidate.selectorCandidates.length + ' selector candidate(s)');

  const md = candidatesMarkdown(result);
  if (!md.includes('## ') || !md.includes('Selector candidates')) fail('candidatesMarkdown: markdown output missing expected sections');
  else pass('candidatesMarkdown: markdown output looks valid');

} catch (err) {
  fail('Field map candidates threw: ' + err.message);
  if (process.env.BROWSY_DEBUG) console.error(err.stack);
}

// ---------------------------------------------------------------------------
// 7. Workflow runtime unit checks (no browser)
// ---------------------------------------------------------------------------
section('Workflow runtime (no browser)');

try {
  const { recordFilledField, recordSkippedField, recordError, getManifestValue } = await import('../src/core/workflow-runtime.mjs');

  const filled = [];
  recordFilledField(filled, 'title', '#title', 'Test Title', false);
  if (filled.length !== 1 || filled[0].value !== 'Test Title') fail('recordFilledField: unexpected result');
  else pass('recordFilledField: works');

  const skipped = [];
  recordSkippedField(skipped, 'legal', 'manual-only: legal certification', '#legal');
  if (skipped.length !== 1 || skipped[0].reason !== 'manual-only: legal certification') fail('recordSkippedField: unexpected result');
  else pass('recordSkippedField: works');

  const errors = [];
  recordError(errors, 'submit', new Error('Blocked'), '#submit');
  if (errors.length !== 1 || errors[0].error !== 'Blocked') fail('recordError: unexpected result');
  else pass('recordError: works');

  const manifest = { release: { title: 'Hello', year: 2025 }, artist: 'Test' };
  if (getManifestValue(manifest, 'release.title') !== 'Hello') fail('getManifestValue: nested path failed');
  else pass('getManifestValue: nested path works');
  if (getManifestValue(manifest, 'artist') !== 'Test') fail('getManifestValue: flat path failed');
  else pass('getManifestValue: flat path works');
  if (getManifestValue(manifest, 'missing.key') !== undefined) fail('getManifestValue: missing path should return undefined');
  else pass('getManifestValue: missing path returns undefined');

} catch (err) {
  fail('Workflow runtime threw: ' + err.message);
}

// ---------------------------------------------------------------------------
// 8. Fixture field-map.json structure
// ---------------------------------------------------------------------------
section('Fixture field-map.json');

try {
  const fieldMap = JSON.parse(fs.readFileSync(join(REPO_ROOT, 'fixtures/local-form/field-map.json'), 'utf8'));
  const fields = Object.keys(fieldMap.fields || {});
  if (!fields.length) fail('field-map.json: no fields');
  else pass('field-map.json: ' + fields.length + ' field(s)');

  const safeCats = ['title','artist','description','category','audio_file'];
  for (const f of safeCats) {
    if (!fieldMap.fields[f]) fail('field-map.json: missing safe field: ' + f);
    else if (fieldMap.fields[f].safety_category) fail('field-map.json: ' + f + ' should have null safety_category');
    else pass('field-map.json: safe field ok: ' + f);
  }

  const dangerFields = ['paid_mastering','legal_certification'];
  for (const f of dangerFields) {
    if (!fieldMap.fields[f]) fail('field-map.json: missing dangerous field: ' + f);
    else if (!fieldMap.fields[f].safety_category) fail('field-map.json: ' + f + ' must have a safety_category');
    else pass('field-map.json: dangerous field has safety_category: ' + f);
  }

} catch (err) {
  fail('Fixture field-map.json: ' + err.message);
}

// ---------------------------------------------------------------------------
// 9. Browser tests (opt-in)
// ---------------------------------------------------------------------------

if (withBrowser) {
  section('Browser tests (fixture page)');
  await runBrowserTests();
} else {
  section('Browser tests');
  console.log('  (skipped — run with npm run smoke:browser to include)');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + '─'.repeat(48));
console.log(`PASS: ${passed}  FAIL: ${failed}  WARN: ${warned}`);
if (failed) {
  console.error('\n' + failed + ' smoke check(s) failed.');
  process.exit(1);
}
console.log('\nBrowsy smoke checks passed.');

// ---------------------------------------------------------------------------
// Browser test implementation
// ---------------------------------------------------------------------------

async function runBrowserTests() {
  let browser;
  try {
    const { chromium } = await import('playwright');
    const { generateCandidates } = await import('../src/core/field-map-candidates.mjs');
    const { discoverPage } = await import('../src/core/discovery.mjs');
    const { isDangerousText, isManualOnly, defaultSafetyPolicy } = await import('../src/core/safety.mjs');
    const { recordFilledField, recordSkippedField, recordError, getManifestValue,
            createRunDir, createRunLogger, writeRunArtifact, saveScreenshot, finalizeRun } = await import('../src/core/workflow-runtime.mjs');
    const { writeJson, writeText } = await import('../src/core/paths.mjs');

    const fixturePath = join(REPO_ROOT, 'fixtures/local-form/index.html');
    const fixtureUrl = 'file://' + fixturePath;
    const fieldMapPath = join(REPO_ROOT, 'fixtures/local-form/field-map.json');
    const manifestPath = join(REPO_ROOT, 'fixtures/local-form/sample-manifest.json');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to fixture
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    pass('Browser: navigated to fixture page');

    // Discovery
    const discovery = await discoverPage(page);
    if (!discovery.inputs.length) fail('Browser: discovery found no inputs');
    else pass('Browser: discovery found ' + discovery.inputs.length + ' input(s)');

    if (!discovery.buttons.length) fail('Browser: discovery found no buttons');
    else pass('Browser: discovery found ' + discovery.buttons.length + ' button(s)');

    // Save discovery artifacts
    const runDir = createRunDir('local-form-demo-smoke');
    const logger = createRunLogger(runDir);
    writeJson(join(runDir, 'discovered-fields.json'), discovery);

    // Field map candidates
    const candidates = generateCandidates(discovery, []);
    writeJson(join(runDir, 'field-map.candidates.json'), candidates);
    writeText(join(runDir, 'field-map.candidates.md'), (await import('../src/core/field-map-candidates.mjs')).candidatesMarkdown(candidates));

    const dangerous = candidates.candidates.filter(c => c.isDangerous);
    if (!dangerous.length) fail('Browser: no dangerous candidates flagged');
    else pass('Browser: ' + dangerous.length + ' dangerous candidate(s) flagged');

    const submitBtn = candidates.candidates.find(c => /submit/i.test(c.humanLabel) || c.raw.id === 'btn-submit');
    if (!submitBtn?.isDangerous) fail('Browser: submit button not flagged as dangerous');
    else pass('Browser: submit button correctly flagged as dangerous');

    // Dry-run fill
    const fieldMap = JSON.parse(fs.readFileSync(fieldMapPath, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const policy = defaultSafetyPolicy();
    const filled = [], skipped = [], errors = [];

    for (const [fieldName, fieldConfig] of Object.entries(fieldMap.fields || {})) {
      const { selector, type, source, safety_category, redact } = fieldConfig;

      if (safety_category && isManualOnly(safety_category, policy)) {
        recordSkippedField(skipped, fieldName, 'manual-only: ' + safety_category, selector);
        continue;
      }

      if ((type === 'button' || type === 'submit') && isDangerousText(fieldName, policy)) {
        recordSkippedField(skipped, fieldName, 'dangerous text', selector);
        continue;
      }

      const value = getManifestValue(manifest, source);
      if (value === undefined || value === null) {
        recordSkippedField(skipped, fieldName, 'no manifest value', selector);
        continue;
      }

      try {
        if (type === 'text' || type === 'textarea') {
          await page.fill(selector, String(value));
        } else if (type === 'select') {
          await page.selectOption(selector, value);
        } else if (type === 'checkbox') {
          if (value) await page.check(selector);
          else await page.uncheck(selector);
        } else if (type === 'file') {
          // Skip file upload in smoke test (no real file)
          recordSkippedField(skipped, fieldName, 'file upload skipped in smoke test', selector);
          continue;
        }
        recordFilledField(filled, fieldName, selector, value, !!redact);
        logger.log('info', 'Filled: ' + fieldName);
      } catch (err) {
        logger.log('error', 'Failed: ' + fieldName + ': ' + err.message);
        recordError(errors, fieldName, err, selector);
      }
    }

    // Verify safe fields were filled
    const filledNames = filled.map(f => f.field);
    const safeCats = ['title', 'artist', 'description', 'category', 'notify_email'];
    for (const name of safeCats) {
      if (!filledNames.includes(name)) warn('Browser dry-run: safe field not filled: ' + name);
      else pass('Browser dry-run: filled safe field: ' + name);
    }

    // Verify dangerous fields were skipped
    const skippedNames = skipped.map(s => s.field);
    const dangerFields = ['paid_mastering', 'legal_certification'];
    for (const name of dangerFields) {
      if (!skippedNames.includes(name)) fail('Browser dry-run: dangerous field not skipped: ' + name);
      else pass('Browser dry-run: skipped dangerous field: ' + name);
    }

    // Verify submit was never clicked
    const submitClicked = await page.evaluate(() => {
      return (window._browsy?.events || []).some(e => e.type === 'click' && e.id === 'btn-submit');
    });
    if (submitClicked) fail('Browser: SUBMIT WAS CLICKED — safety failure');
    else pass('Browser: Submit was never clicked');

    // Save screenshot
    await saveScreenshot(page, runDir, 'screenshot-after-fill.png');
    pass('Browser: screenshot saved');

    // Write artifacts
    finalizeRun(runDir, { logger, filled, skipped, errors });

    // Verify artifacts exist
    const artifactFiles = ['run-log.json', 'filled-fields.json', 'skipped-fields.json', 'errors.json'];
    for (const f of artifactFiles) {
      const path = join(runDir, f);
      if (!fs.existsSync(path)) fail('Browser artifacts: missing ' + f);
      else pass('Browser artifacts: ' + f + ' written');
    }

    // Verify filled-fields has content
    const filledJson = JSON.parse(fs.readFileSync(join(runDir, 'filled-fields.json'), 'utf8'));
    if (!filledJson.length) fail('Browser: filled-fields.json is empty');
    else pass('Browser: filled-fields.json has ' + filledJson.length + ' entry/entries');

    // Verify errors.json is empty (clean run)
    const errorsJson = JSON.parse(fs.readFileSync(join(runDir, 'errors.json'), 'utf8'));
    if (errorsJson.length) warn('Browser: ' + errorsJson.length + ' error(s) in run: ' + errorsJson.map(e => e.field).join(', '));
    else pass('Browser: no errors in dry-run');

  } catch (err) {
    fail('Browser test suite threw: ' + err.message);
    if (process.env.BROWSY_DEBUG) console.error(err.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
