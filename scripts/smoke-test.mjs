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
  'fixtures/song-creator/index.html',
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
// 9. Arg-validator security (wizard exec allowlist)
// ---------------------------------------------------------------------------
section('Arg-validator security');

try {
  const { validateExecArgs } = await import('../wizard/arg-validator.mjs');

  // Unknown command rejected
  let r = validateExecArgs('rm', ['-rf', '/']);
  if (r.ok) fail('Security: unknown command "rm" must be rejected');
  else pass('Security: unknown command rejected');

  // --allow-final-action absent from run allowlist
  r = validateExecArgs('run', ['--workflow', 'my-wf', '--allow-final-action']);
  if (r.ok) fail('Security: --allow-final-action must be rejected for run');
  else pass('Security: --allow-final-action blocked from run command');

  // Path traversal in workflow ID blocked
  r = validateExecArgs('run', ['--workflow', '../../etc/passwd']);
  if (r.ok) fail('Security: path traversal in --workflow must be rejected');
  else pass('Security: path traversal in --workflow blocked');

  // file:// URL blocked
  r = validateExecArgs('discover', ['--workflow', 'my-wf', '--url', 'file:///etc/passwd']);
  if (r.ok) fail('Security: file:// URL must be rejected');
  else pass('Security: file:// URL blocked in --url');

  // Unknown flag blocked
  r = validateExecArgs('promote', ['--workflow', 'my-wf', '--inject', 'evil']);
  if (r.ok) fail('Security: unknown flag --inject must be rejected for promote');
  else pass('Security: unknown flag rejected for promote');

  // Null byte in arg value blocked
  r = validateExecArgs('feedback', ['--workflow', 'my\0wf', '--message', 'hi']);
  if (r.ok) fail('Security: null byte in --workflow value must be rejected');
  else pass('Security: null byte in arg value blocked');

  // Absolute path in --manifest blocked
  r = validateExecArgs('run', ['--workflow', 'my-wf', '--manifest', '/etc/passwd']);
  if (r.ok) fail('Security: absolute path in --manifest must be rejected');
  else pass('Security: absolute path in --manifest blocked');

  // auth requires valid subcommand
  r = validateExecArgs('auth', ['badcmd', '--workflow', 'my-wf', '--url', 'https://x.com']);
  if (r.ok) fail('Security: invalid auth subcommand must be rejected');
  else pass('Security: invalid auth subcommand rejected');

  // Valid calls pass through
  const valid = [
    ['validate-request', []],
    ['init', ['--id', 'my-workflow']],
    ['init', ['--from-request']],
    ['discover', ['--workflow', 'my-wf', '--url', 'https://example.com', '--candidates']],
    ['run', ['--workflow', 'my-wf', '--dry-run', '--no-pause']],
    ['review', ['--workflow', 'my-wf']],
    ['feedback', ['--workflow', 'my-wf', '--message', 'looks good']],
    ['promote', ['--workflow', 'my-wf']],
    ['auth', ['save', '--workflow', 'my-wf', '--url', 'https://example.com']],
    ['auth', ['check', '--workflow', 'my-wf', '--url', 'https://example.com']],
  ];
  for (const [cmd, args] of valid) {
    const res = validateExecArgs(cmd, args);
    if (!res.ok) fail(`Security: valid call rejected — ${cmd} ${args.join(' ')}: ${res.reason}`);
    else pass(`Security: valid call passes — ${cmd}`);
  }
} catch (err) {
  fail('Arg-validator threw: ' + err.message);
  if (process.env.BROWSY_DEBUG) console.error(err.stack);
}

// ---------------------------------------------------------------------------
// 10. CLI lifecycle artifact checks (non-browser)
// ---------------------------------------------------------------------------
section('CLI lifecycle artifacts (non-browser)');

const SMOKE_WF = 'browsy-smoke-lc';

try {
  const { spawnSync } = await import('child_process');
  const { REPO_ROOT: RR, workflowDir: wfDir, workflowRunDir: runDirFn, ensureDir: ed, writeJson: wj, writeText: wt } = await import('../src/core/paths.mjs');

  // Clean up any prior smoke run
  const wfPath = join(RR, 'workflows', SMOKE_WF);
  if (fs.existsSync(wfPath)) fs.rmSync(wfPath, { recursive: true });

  // init
  const initRes = spawnSync(process.execPath, ['src/cli/index.mjs', 'init', '--id', SMOKE_WF], { cwd: RR, encoding: 'utf8' });
  if (initRes.status !== 0) { fail('Lifecycle: init failed: ' + initRes.stderr); throw new Error('stop'); }
  if (!fs.existsSync(join(wfPath, 'workflow.json'))) fail('Lifecycle: workflow.json not created by init');
  else pass('Lifecycle: init — workflow.json created');
  if (!fs.existsSync(join(wfPath, 'run.mjs'))) fail('Lifecycle: run.mjs not created by init');
  else pass('Lifecycle: init — run.mjs created');
  if (!fs.existsSync(join(wfPath, 'safety-policy.json'))) fail('Lifecycle: safety-policy.json not created by init');
  else pass('Lifecycle: init — safety-policy.json created');

  // Synthesise a fake run with all expected artifacts
  const fakeRunDir = join(RR, 'output', 'runs', SMOKE_WF, '2099-01-01T00-00-00-000Z');
  ed(fakeRunDir);
  const fakeFilled  = [{ timestamp: new Date().toISOString(), field: 'title', selector: '#title', value: 'Test', masked: false }];
  const fakeSkipped = [
    { timestamp: new Date().toISOString(), field: 'submit_btn', selector: '#btn-submit', reason: 'dangerous text' },
    { timestamp: new Date().toISOString(), field: 'delete_btn', selector: '#btn-delete', reason: 'manual-only: destructive action' },
  ];
  const fakeErrors  = [{ timestamp: new Date().toISOString(), field: 'broken_field', selector: '#missing', error: 'Element not found' }];
  wj(join(fakeRunDir, 'filled-fields.json'),  fakeFilled);
  wj(join(fakeRunDir, 'skipped-fields.json'), fakeSkipped);
  wj(join(fakeRunDir, 'errors.json'),         fakeErrors);
  wj(join(fakeRunDir, 'run-log.json'),        [{ level: 'info', message: 'smoke test run' }]);
  wt(join(fakeRunDir, 'page-text-snapshot.txt'), 'smoke test page text');
  wt(join(fakeRunDir, 'html-snapshot.html'), '<html><body>smoke</body></html>');
  // Note: no screenshot files — intentional to test "incomplete run still useful"
  pass('Lifecycle: fake run artifacts written');

  // review — should generate run-review.md from existing artifacts
  const revRes = spawnSync(process.execPath, ['src/cli/index.mjs', 'review', '--workflow', SMOKE_WF], { cwd: RR, encoding: 'utf8' });
  if (revRes.status !== 0) fail('Lifecycle: review failed: ' + revRes.stderr);
  else pass('Lifecycle: review command ran successfully');

  const reviewPath = join(fakeRunDir, 'run-review.md');
  if (!fs.existsSync(reviewPath)) fail('Lifecycle: run-review.md not created by review');
  else {
    const reviewText = fs.readFileSync(reviewPath, 'utf8');
    pass('Lifecycle: run-review.md created');
    if (!reviewText.includes('Run Review')) fail('Lifecycle: run-review.md missing header');
    else pass('Lifecycle: run-review.md has expected header');
    if (!reviewText.includes('What was skipped for safety')) fail('Lifecycle: run-review.md missing skipped section');
    else pass('Lifecycle: run-review.md has skipped section');
    if (!reviewText.includes('Artifacts')) fail('Lifecycle: run-review.md missing artifacts section');
    else pass('Lifecycle: run-review.md has artifacts section');
    // Verify artifact path is printed in review
    if (!reviewText.includes('output/runs')) fail('Lifecycle: run-review.md does not print artifact path');
    else pass('Lifecycle: run-review.md prints artifact path');
  }

  // Verify skipped-fields.json has blocked buttons
  const skippedJson = JSON.parse(fs.readFileSync(join(fakeRunDir, 'skipped-fields.json'), 'utf8'));
  const blockedBtns = skippedJson.filter(s => /submit|delete/i.test(s.field));
  if (!blockedBtns.length) fail('Lifecycle: skipped-fields.json missing blocked button entries');
  else pass('Lifecycle: skipped-fields.json has ' + blockedBtns.length + ' blocked button(s)');

  // Verify failed run still has useful artifacts (errors.json non-empty but review still generated)
  const errJson = JSON.parse(fs.readFileSync(join(fakeRunDir, 'errors.json'), 'utf8'));
  if (!errJson.length) fail('Lifecycle: errors.json should have entries for failed-run test');
  else pass('Lifecycle: failed run — errors.json is non-empty');
  if (!fs.existsSync(reviewPath)) fail('Lifecycle: failed run — run-review.md still missing');
  else pass('Lifecycle: failed run — run-review.md still generated despite errors');

  // feedback — creates files in workflows/<id>/feedback/
  const fbRes = spawnSync(
    process.execPath,
    ['src/cli/index.mjs', 'feedback', '--workflow', SMOKE_WF, '--message', 'Smoke test feedback note'],
    { cwd: RR, encoding: 'utf8' }
  );
  if (fbRes.status !== 0) fail('Lifecycle: feedback failed: ' + fbRes.stderr);
  else pass('Lifecycle: feedback command ran successfully');

  const feedbackDir = join(wfPath, 'feedback');
  if (!fs.existsSync(feedbackDir)) fail('Lifecycle: feedback/ directory not created');
  else {
    const fbFiles = fs.readdirSync(feedbackDir);
    if (fbFiles.length < 2) fail('Lifecycle: feedback/ should have at least 2 files (user-feedback + patch-summary)');
    else pass('Lifecycle: feedback/ has ' + fbFiles.length + ' file(s)');
    const userFb = fbFiles.find(f => f.includes('user-feedback'));
    const patchFb = fbFiles.find(f => f.includes('patch-summary'));
    if (!userFb) fail('Lifecycle: user-feedback file missing');
    else pass('Lifecycle: user-feedback file created');
    if (!patchFb) fail('Lifecycle: patch-summary file missing');
    else pass('Lifecycle: patch-summary file created');
  }

  // promote — marks workflow reusable/stable
  const promRes = spawnSync(
    process.execPath,
    ['src/cli/index.mjs', 'promote', '--workflow', SMOKE_WF],
    { cwd: RR, encoding: 'utf8' }
  );
  if (promRes.status !== 0) fail('Lifecycle: promote failed: ' + promRes.stderr);
  else pass('Lifecycle: promote command ran successfully');

  const promotedPath = join(wfPath, 'PROMOTED');
  if (!fs.existsSync(promotedPath)) fail('Lifecycle: PROMOTED file not created by promote');
  else {
    pass('Lifecycle: PROMOTED file created');
    const promotedText = fs.readFileSync(promotedPath, 'utf8');
    if (!promotedText.includes('PROMOTED')) fail('Lifecycle: PROMOTED file missing header');
    else pass('Lifecycle: PROMOTED file has expected content');
  }

  const wfConfig = JSON.parse(fs.readFileSync(join(wfPath, 'workflow.json'), 'utf8'));
  if (!wfConfig.promoted) fail('Lifecycle: workflow.json promoted flag not set');
  else pass('Lifecycle: workflow.json promoted=true');
  if (!wfConfig.promoted_at) fail('Lifecycle: workflow.json missing promoted_at timestamp');
  else pass('Lifecycle: workflow.json has promoted_at');

  // Cleanup
  fs.rmSync(wfPath, { recursive: true });
  fs.rmSync(join(RR, 'output', 'runs', SMOKE_WF), { recursive: true, force: true });
  pass('Lifecycle: temp workflow cleaned up');

} catch (err) {
  if (err.message !== 'stop') fail('Lifecycle: threw: ' + err.message);
  if (process.env.BROWSY_DEBUG) console.error(err.stack);
}

// ---------------------------------------------------------------------------
// 11. test-form workflow scaffold check
// ---------------------------------------------------------------------------
section('test-form workflow scaffold');

try {
  const tfDir = join(REPO_ROOT, 'workflows', 'test-form');
  const required = ['workflow.json', 'field-map.local.json', 'manifest.example.json', 'safety-policy.json', 'run.mjs'];
  for (const f of required) {
    if (!fs.existsSync(join(tfDir, f))) fail('test-form: missing ' + f);
    else pass('test-form: ' + f + ' exists');
  }

  const wf = JSON.parse(fs.readFileSync(join(tfDir, 'workflow.json'), 'utf8'));
  if (!wf.targets?.start_url?.includes('httpbin')) warn('test-form: start_url does not point at httpbin');
  else pass('test-form: start_url points at httpbin form');

  const fm = JSON.parse(fs.readFileSync(join(tfDir, 'field-map.local.json'), 'utf8'));
  const blocked = Object.values(fm.fields || {}).filter(f => f.safety_category === 'final submission');
  if (!blocked.length) fail('test-form: no final-submission blocked field in field-map');
  else pass('test-form: submit field has safety_category=final submission');

  const sp = JSON.parse(fs.readFileSync(join(tfDir, 'safety-policy.json'), 'utf8'));
  if (!(sp.manual_only_categories || []).includes('final submission'))
    fail('test-form: safety-policy missing final submission in manual_only_categories');
  else pass('test-form: safety-policy blocks final submission');

} catch (err) {
  fail('test-form scaffold check threw: ' + err.message);
}

// ---------------------------------------------------------------------------
// 12. Runtime variable engine (no browser)
// ---------------------------------------------------------------------------
section('Runtime variable engine (no browser)');

try {
  const {
    resolveTemplate, tryResolveTemplate, extractTemplateVars, hasTemplateVars,
    validateTemplateVars, computeDerived, saveRuntimeVars, loadRuntimeVars
  } = await import('../src/core/runtime-vars.mjs');
  const { join: pjoin } = await import('path');
  const { ensureDir, writeJson } = await import('../src/core/paths.mjs');
  const os = await import('os');

  // resolveTemplate
  const vars = { songId: 'SONG_ABC123', host: 'localhost:3737' };
  const resolved = resolveTemplate('http://{{host}}/songs/{{songId}}', vars);
  if (resolved !== 'http://localhost:3737/songs/SONG_ABC123')
    fail('resolveTemplate: expected correct substitution, got ' + resolved);
  else pass('resolveTemplate: substitutes correctly');

  // resolveTemplate throws on missing variable
  try {
    resolveTemplate('http://example.com/{{missing}}', {});
    fail('resolveTemplate: should throw on missing variable');
  } catch (e) {
    if (e.message.includes('missing')) pass('resolveTemplate: throws on unresolved variable');
    else fail('resolveTemplate: wrong error message — ' + e.message);
  }

  // tryResolveTemplate returns null instead of throwing
  const nullResult = tryResolveTemplate('http://example.com/{{noSuchVar}}', {});
  if (nullResult !== null) fail('tryResolveTemplate: should return null for missing var, got ' + nullResult);
  else pass('tryResolveTemplate: returns null for missing variable');

  // extractTemplateVars
  const extracted = extractTemplateVars('http://{{host}}/songs/{{songId}}/details');
  if (extracted.length !== 2 || !extracted.includes('host') || !extracted.includes('songId'))
    fail('extractTemplateVars: expected [host, songId], got ' + JSON.stringify(extracted));
  else pass('extractTemplateVars: extracts two variables');

  // extractTemplateVars with no vars
  const noVars = extractTemplateVars('https://example.com/static');
  if (noVars.length !== 0) fail('extractTemplateVars: should return [] for plain URL');
  else pass('extractTemplateVars: returns [] for URL with no templates');

  // hasTemplateVars
  if (!hasTemplateVars('http://example.com/{{id}}')) fail('hasTemplateVars: should return true');
  else pass('hasTemplateVars: returns true for templated string');
  if (hasTemplateVars('https://example.com/plain')) fail('hasTemplateVars: should return false for plain URL');
  else pass('hasTemplateVars: returns false for plain URL');

  // validateTemplateVars — all declared
  const defs = { input: [{ name: 'albumId' }], captured: [{ name: 'songId' }], derived: [{ name: 'songUrl' }] };
  const noIssues = validateTemplateVars(['http://x.com/{{albumId}}/songs/{{songId}}', '{{songUrl}}'], defs);
  if (noIssues.length !== 0) fail('validateTemplateVars: should find no issues when all vars declared');
  else pass('validateTemplateVars: no issues when all vars declared');

  // validateTemplateVars — undeclared variable
  const issues = validateTemplateVars(['http://x.com/{{undeclared}}'], defs);
  if (!issues.length || issues[0].variable !== 'undeclared')
    fail('validateTemplateVars: should flag undeclared variable');
  else pass('validateTemplateVars: flags undeclared {{undeclared}}');

  // computeDerived
  const baseVars = { songId: 'SONG_XYZ' };
  const derived = [{ name: 'songUrl', template: 'http://localhost:3737/songs/{{songId}}' }];
  const withDerived = computeDerived(derived, baseVars);
  if (withDerived.songUrl !== 'http://localhost:3737/songs/SONG_XYZ')
    fail('computeDerived: expected correct URL, got ' + withDerived.songUrl);
  else pass('computeDerived: builds derived URL correctly');

  // computeDerived skips when dependency missing (no throw)
  const partialDerived = computeDerived([{ name: 'url', template: '{{missingVar}}/path' }], {});
  if ('url' in partialDerived) fail('computeDerived: should skip if dependency is missing');
  else pass('computeDerived: skips derived var when dependency not yet captured');

  // saveRuntimeVars / loadRuntimeVars round-trip
  const tmpDir = pjoin(os.default.tmpdir(), 'browsy-smoke-' + Date.now());
  ensureDir(tmpDir);
  const testVars = { songId: 'SONG_TEST', songUrl: 'http://localhost:3737/songs/SONG_TEST' };
  saveRuntimeVars(tmpDir, testVars);
  const loaded = loadRuntimeVars(tmpDir);
  if (loaded.songId !== 'SONG_TEST' || loaded.songUrl !== 'http://localhost:3737/songs/SONG_TEST')
    fail('saveRuntimeVars/loadRuntimeVars: round-trip failed — ' + JSON.stringify(loaded));
  else pass('saveRuntimeVars/loadRuntimeVars: round-trip works');

  // loadRuntimeVars returns {} when file missing
  const emptyDir = pjoin(os.default.tmpdir(), 'browsy-smoke-empty-' + Date.now());
  ensureDir(emptyDir);
  const empty = loadRuntimeVars(emptyDir);
  if (typeof empty !== 'object' || Object.keys(empty).length !== 0)
    fail('loadRuntimeVars: should return {} when file missing');
  else pass('loadRuntimeVars: returns {} when runtime-vars.json absent');

  // id-gen-fixture file exists
  const fixturePath = join(REPO_ROOT, 'fixtures/id-gen-fixture/index.html');
  if (!fs.existsSync(fixturePath)) fail('id-gen-fixture: index.html missing');
  else {
    const html = fs.readFileSync(fixturePath, 'utf8');
    if (!html.includes('createItem')) fail('id-gen-fixture: missing createItem function');
    else pass('id-gen-fixture: index.html exists and contains createItem()');
    if (!html.includes('ITEM_')) fail('id-gen-fixture: missing ITEM_ prefix in ID generation');
    else pass('id-gen-fixture: generates ITEM_-prefixed IDs');
  }

} catch (err) {
  fail('Runtime variable engine threw: ' + err.message);
  if (process.env.BROWSY_DEBUG) console.error(err.stack);
}

// ---------------------------------------------------------------------------
// 13. Browser tests (opt-in)
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

    // New fixture elements: Delete, Export, modal
    const deleteBtn = candidates.candidates.find(c => c.raw.id === 'btn-delete');
    if (!deleteBtn) warn('Browser: delete button not found in candidates');
    else if (!deleteBtn.isDangerous) fail('Browser: delete button not flagged as dangerous');
    else pass('Browser: delete button correctly flagged as dangerous');

    const exportBtn = candidates.candidates.find(c => c.raw.id === 'btn-export');
    if (!exportBtn) warn('Browser: export button not found in candidates');
    else if (exportBtn.isDangerous) fail('Browser: export button should NOT be flagged as dangerous');
    else pass('Browser: export button correctly not flagged as dangerous');

    const modalConfirm = candidates.candidates.find(c => c.raw.id === 'modal-confirm');
    if (!modalConfirm) warn('Browser: modal-confirm button not found in candidates');
    else if (!modalConfirm.isDangerous) fail('Browser: modal-confirm should be flagged as dangerous');
    else pass('Browser: modal-confirm button flagged as dangerous');

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
    const dangerFields = ['paid_mastering', 'legal_certification', 'delete_button', 'modal_confirm_button'];
    for (const name of dangerFields) {
      if (!skippedNames.includes(name)) fail('Browser dry-run: dangerous field not skipped: ' + name);
      else pass('Browser dry-run: skipped dangerous field: ' + name);
    }

    // Verify submit and delete were never clicked
    const dangerClicks = await page.evaluate(() => {
      return (window._browsy?.events || []).filter(e =>
        e.type === 'click' && ['btn-submit', 'btn-delete', 'modal-confirm'].includes(e.id)
      );
    });
    if (dangerClicks.length) fail('Browser: DANGEROUS BUTTON CLICKED — ' + JSON.stringify(dangerClicks));
    else pass('Browser: no dangerous buttons clicked (Submit, Delete, modal-confirm)');

    // Save screenshot
    await saveScreenshot(page, runDir, 'screenshot-after-fill.png');
    pass('Browser: screenshot saved');

    // Write artifacts — includes run-review.md
    finalizeRun(runDir, { logger, filled, skipped, errors, workflowId: 'local-form-demo-smoke', dryRun: true });

    // Verify all expected artifacts exist
    const artifactFiles = ['run-log.json', 'filled-fields.json', 'skipped-fields.json', 'errors.json', 'run-review.md'];
    for (const f of artifactFiles) {
      const p = join(runDir, f);
      if (!fs.existsSync(p)) fail('Browser artifacts: missing ' + f);
      else pass('Browser artifacts: ' + f + ' written');
    }

    // Verify run-review.md content
    const reviewMd = fs.readFileSync(join(runDir, 'run-review.md'), 'utf8');
    if (!reviewMd.includes('Run Review')) fail('Browser: run-review.md missing header');
    else pass('Browser: run-review.md has expected header');
    if (!reviewMd.includes('Artifacts')) fail('Browser: run-review.md missing Artifacts section');
    else pass('Browser: run-review.md Artifacts section present');
    if (!reviewMd.includes('output/runs')) fail('Browser: run-review.md does not print artifact path');
    else pass('Browser: run-review.md prints artifact path');

    // Verify discovered-fields.json exists (written earlier in this test)
    if (!fs.existsSync(join(runDir, 'discovered-fields.json'))) fail('Browser: discovered-fields.json missing');
    else pass('Browser: discovered-fields.json present');

    // Verify skipped-fields.json has blocked buttons logged
    const skippedJson = JSON.parse(fs.readFileSync(join(runDir, 'skipped-fields.json'), 'utf8'));
    const blockedInSkipped = skippedJson.filter(s => s.reason?.includes('manual-only') || s.reason?.includes('dangerous'));
    if (!blockedInSkipped.length) fail('Browser: skipped-fields.json has no blocked-button entries');
    else pass('Browser: skipped-fields.json has ' + blockedInSkipped.length + ' blocked-button entry/entries');

    // Verify filled-fields has content
    const filledJson = JSON.parse(fs.readFileSync(join(runDir, 'filled-fields.json'), 'utf8'));
    if (!filledJson.length) fail('Browser: filled-fields.json is empty');
    else pass('Browser: filled-fields.json has ' + filledJson.length + ' entry/entries');

    // Verify errors.json is empty (clean run)
    const errorsJson = JSON.parse(fs.readFileSync(join(runDir, 'errors.json'), 'utf8'));
    if (errorsJson.length) warn('Browser: ' + errorsJson.length + ' error(s) in run: ' + errorsJson.map(e => e.field).join(', '));
    else pass('Browser: no errors in dry-run');

    // ── id-gen fixture: variable capture from current URL ──
    const { captureFromPage, captureVariables, computeDerived, saveRuntimeVars, loadRuntimeVars, resolveTemplate } = await import('../src/core/runtime-vars.mjs');

    const idFixturePath = join(REPO_ROOT, 'fixtures/id-gen-fixture/index.html');
    const idFixtureUrl = 'file://' + idFixturePath;

    const idPage = await context.newPage();
    await idPage.goto(idFixtureUrl, { waitUntil: 'domcontentloaded' });
    pass('Browser id-gen: navigated to fixture');

    // Click "Create Item" to generate an ID and update the hash
    await idPage.click('#btn-create');
    await idPage.waitForFunction(() => window.location.hash.startsWith('#/items/'));
    pass('Browser id-gen: Create Item clicked, hash updated');

    // Capture itemId from current URL hash
    const capturedUrl = idPage.url();
    const captureSpec = { source: 'current_url', regex: '#/items/(ITEM_[A-Z0-9_]+)' };
    const capturedId = await captureFromPage(idPage, captureSpec);
    if (!capturedId || !capturedId.startsWith('ITEM_'))
      fail('Browser id-gen: captureFromPage failed to extract ITEM_ ID from URL — got: ' + capturedId);
    else pass('Browser id-gen: captureFromPage extracted itemId: ' + capturedId);

    // captureVariables using a capture spec array
    const captureSpecArray = [{ name: 'itemId', source: 'current_url', regex: '#/items/(ITEM_[A-Z0-9_]+)', required: true }];
    const { vars: captured, missing } = await captureVariables(idPage, captureSpecArray, {});
    if (missing.length) fail('Browser id-gen: captureVariables reported missing vars: ' + missing.join(', '));
    else pass('Browser id-gen: captureVariables captured itemId: ' + captured.itemId);

    // computeDerived builds URL from captured var
    const derivedDefs = [{ name: 'itemUrl', template: 'http://localhost:3737/items/{{itemId}}' }];
    const withDerived = computeDerived(derivedDefs, captured);
    const expectedUrl = 'http://localhost:3737/items/' + captured.itemId;
    if (withDerived.itemUrl !== expectedUrl)
      fail('Browser id-gen: computeDerived got ' + withDerived.itemUrl + ', expected ' + expectedUrl);
    else pass('Browser id-gen: computeDerived built correct itemUrl');

    // save and reload runtime-vars.json
    const idRunDir = createRunDir('id-gen-fixture-smoke');
    saveRuntimeVars(idRunDir, withDerived);
    const reloaded = loadRuntimeVars(idRunDir);
    if (reloaded.itemId !== captured.itemId)
      fail('Browser id-gen: runtime-vars.json round-trip failed');
    else pass('Browser id-gen: runtime-vars.json saved and reloaded correctly');

    if (!fs.existsSync(join(idRunDir, 'runtime-vars.json')))
      fail('Browser id-gen: runtime-vars.json file not written to run dir');
    else pass('Browser id-gen: runtime-vars.json exists in run dir');

    await idPage.close();

  } catch (err) {
    fail('Browser test suite threw: ' + err.message);
    if (process.env.BROWSY_DEBUG) console.error(err.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
