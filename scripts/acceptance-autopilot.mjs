#!/usr/bin/env node
/**
 * Acceptance test: autopilot orchestration (src/core/autopilot.mjs)
 *
 * Proves the one-command autopilot loop end-to-end against the LOCAL
 * fixtures/local-form fixture, with NO browser and NO API key (the per-page
 * discovery and the LLM caller are both injected):
 *
 *   A  Happy path: discover → map → dry-run → report
 *      - report JSON + markdown are written to output/runs/<id>/<ts>/
 *      - safe fields map to selectors that exist verbatim in the fixture HTML
 *        and are a subset of the generated candidate selectors (no fabrication)
 *      - dangerous controls (Submit/Delete) are flagged as dangerous_action
 *      - legal/paid fields land in unmapped[] (never auto-mapped)
 *      - a low-confidence mapping is flagged
 *      - dry-run reaches dry_run_passed; readiness shows field_map_verified
 *      - overall = completed_with_followups, exit code 3
 *   B  Auth gate: a workflow requiring an unsaved site → blocked (exit 4)
 *      with a blocked_auth_required touchpoint, before any discovery
 *   C  Hallucination guard: an LLM that invents selectors → all unmapped,
 *      no invented selector reaches field-map.local.json
 *   D  recordingPageUrls harvests distinct non-auth page URLs from events.json
 *
 * Usage:
 *   node scripts/acceptance-autopilot.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  runAutopilot,
  recordingPageUrls,
  LOW_CONFIDENCE_THRESHOLD,
} from '../src/core/autopilot.mjs';
import { generateCandidates } from '../src/core/field-map-candidates.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOWS = path.join(REPO_ROOT, 'workflows');
const RUNS = path.join(REPO_ROOT, 'output', 'runs');
const FIXTURE = path.join(REPO_ROOT, 'fixtures', 'local-form', 'index.html');

let passed = 0, failed = 0;
const failures = [];
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
  failures.push(label);
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

const fixtureHtml = fs.readFileSync(FIXTURE, 'utf8');

// ---------------------------------------------------------------------------
// Discovery object reflecting fixtures/local-form (real ids/names/text).
// ---------------------------------------------------------------------------
function fixtureDiscovery(url) {
  return {
    url,
    captured_at: new Date().toISOString(),
    inputs: [
      { index: 0, tag: 'input', type: 'text', id: 'title', name: 'title', placeholder: 'Enter release title', ariaLabel: '', labels: 'Release Title', visible: true, accept: '' },
      { index: 1, tag: 'input', type: 'text', id: 'artist', name: 'artist', placeholder: 'Enter artist name', ariaLabel: '', labels: 'Artist Name', visible: true, accept: '' },
      { index: 2, tag: 'input', type: 'checkbox', id: 'notify-email', name: 'notify_email', placeholder: '', ariaLabel: '', labels: '', visible: true, accept: '' },
      { index: 3, tag: 'input', type: 'checkbox', id: 'paid-mastering', name: 'paid_mastering', placeholder: '', ariaLabel: '', labels: 'Add professional mastering', visible: true, accept: '' },
      { index: 4, tag: 'input', type: 'checkbox', id: 'legal-cert', name: 'legal_certification', placeholder: '', ariaLabel: 'I certify that I own all rights to this content', labels: '', visible: true, accept: '' },
    ],
    textareas: [
      { index: 0, tag: 'textarea', type: '', id: 'description', name: 'description', placeholder: 'Enter a short description', ariaLabel: '', labels: 'Description', visible: true, accept: '' },
    ],
    selects: [
      { index: 0, tag: 'select', type: '', id: 'category', name: 'category', placeholder: '', ariaLabel: '', labels: 'Category', visible: true, accept: '' },
    ],
    fileInputs: [
      { index: 0, tag: 'input', type: 'file', id: 'audio-file', name: 'audio_file', placeholder: '', ariaLabel: '', labels: 'Audio File', visible: true, accept: '.mp3,.wav,.flac,.aiff' },
    ],
    buttons: [
      { index: 0, text: 'Next →', id: 'btn-next', name: '', ariaLabel: '', visible: true },
      { index: 1, text: 'Export Data', id: 'btn-export', name: '', ariaLabel: '', visible: true },
      { index: 2, text: 'Submit Release', id: 'btn-submit', name: '', ariaLabel: '', visible: true },
      { index: 3, text: 'Delete Release', id: 'btn-delete', name: '', ariaLabel: '', visible: true },
    ],
  };
}

// Injected per-page discovery: writes discovered-fields.json into runDir (so the
// field-map step finds it) and returns the discovery object. No browser.
function makeFakeDiscover() {
  return async ({ url, runDir }) => {
    const discovery = fixtureDiscovery(url);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'discovered-fields.json'), JSON.stringify(discovery, null, 2));
    return discovery;
  };
}

// Injected LLM: maps safe fields to their real #id selectors, nulls the rest.
// category gets a deliberately low confidence to exercise the flag.
const SAFE_SEL = {
  title: '#title',
  artist: '#artist',
  description: '#description',
  category: '#category',
  audio_file: '#audio-file',
};
function fakeLLM(messages) {
  const payload = JSON.parse(messages[0].content);
  const mappings = (payload.packageFields || []).map(f => {
    const sel = SAFE_SEL[f.fieldName] || null;
    return {
      fieldName: f.fieldName,
      selector: sel,
      confidence: sel ? (f.fieldName === 'category' ? 0.5 : 0.9) : 0,
      reasoning: 'deterministic test mapping',
    };
  });
  return JSON.stringify({ mappings });
}

// Injected LLM that invents selectors for every field (hallucination guard test).
function hallucinatingLLM(messages) {
  const payload = JSON.parse(messages[0].content);
  return JSON.stringify({
    mappings: (payload.packageFields || []).map(f => ({
      fieldName: f.fieldName,
      selector: `#fabricated-${f.fieldName}`,
      confidence: 0.99,
      reasoning: 'invented',
    })),
  });
}

// ---------------------------------------------------------------------------
// Workflow scaffolding helpers
// ---------------------------------------------------------------------------
const created = [];
function scaffoldWorkflow(id, { auth = { mode: 'none' }, withPackage = true } = {}) {
  const dir = path.join(WORKFLOWS, id);
  fs.mkdirSync(dir, { recursive: true });
  created.push(dir, path.join(RUNS, id));
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    workflow_id: id,
    auth,
    discovery_urls: ['http://fixture.local/local-form'],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'field-mapping-instruction.md'),
    '# Intent\nMap title, artist, description, category, audio_file. Never touch legal/paid/submit.\n');
  if (withPackage) {
    fs.writeFileSync(path.join(dir, 'workflow-package.example.json'), JSON.stringify({
      workflow_id: id,
      source_system: 'test',
      entity_type: 'release',
      entity_id: 'ENT_TEST',
      mode: 'dry_run',
      canonical_payload: {
        globals: {
          title: 'Test Release', artist: 'Test Artist',
          description: 'A short description', category: 'music',
          legal_certification: 'true', paid_mastering: 'false',
        },
        assets: { audio_file: './fixtures/local-form/upload-target/dummy.mp3' },
      },
    }, null, 2));
  }
  return dir;
}

const rand = Date.now().toString(36);

// ===========================================================================
section('A', 'happy path: discover → map → dry-run → report');
const idA = `autopilot-accept-a-${rand}`;
scaffoldWorkflow(idA);
let outA;
{
  outA = await runAutopilot({
    workflowId: idA,
    callLLM: fakeLLM,
    discoverPageFn: makeFakeDiscover(),
    headed: false,
  });
  const r = outA.report;

  outA.exitCode === 3 ? pass('exit code 3 (completed_with_followups)') : fail('expected exit 3', `got ${outA.exitCode}`);
  r.overall === 'completed_with_followups' ? pass(`overall = ${r.overall}`) : fail('overall not completed_with_followups', r.overall);

  // Report files written
  fs.existsSync(outA.jsonPath) ? pass('autopilot-report.json written') : fail('report json missing', outA.jsonPath);
  fs.existsSync(outA.mdPath) ? pass('autopilot-report.md written') : fail('report md missing', outA.mdPath);

  // Intent surfaced
  r.intent.fieldMappingInstructionPresent ? pass('intent doc detected') : fail('intent doc not detected');

  // Discovery counts
  const d = r.discovery[0];
  d && d.inputs === 5 ? pass('discovery counted 5 inputs') : fail('wrong input count', JSON.stringify(d));
  d && d.buttons === 4 ? pass('discovery counted 4 buttons') : fail('wrong button count', JSON.stringify(d));
  d && d.fileInputs === 1 ? pass('discovery counted 1 file input') : fail('wrong file-input count', JSON.stringify(d));

  // Field map: safe fields mapped, legal/paid unmapped
  const fm = r.fieldMap;
  fm && fm.mapped === 5 ? pass('5 fields mapped') : fail('expected 5 mapped', JSON.stringify(fm && { mapped: fm.mapped, total: fm.total }));
  fm && ['legal_certification', 'paid_mastering'].every(k => fm.unmapped.includes(k))
    ? pass('legal_certification + paid_mastering are unmapped (never auto-mapped)')
    : fail('legal/paid should be unmapped', JSON.stringify(fm && fm.unmapped));

  // No fabrication: every mapped selector exists in the fixture AND is a real candidate
  const candSelectors = new Set();
  for (const c of generateCandidates(fixtureDiscovery('x')).candidates) {
    for (const sc of c.selectorCandidates) candSelectors.add(sc.selector);
  }
  let fabricated = 0, missingInFixture = 0;
  for (const [name, f] of Object.entries(fm.fields)) {
    if (!candSelectors.has(f.selector)) fabricated++;
    const m = f.selector.match(/^#(.+)$/);
    if (m && !fixtureHtml.includes(`id="${m[1]}"`)) missingInFixture++;
  }
  fabricated === 0 ? pass('every mapped selector is a real discovery candidate (no fabrication)') : fail(`${fabricated} fabricated selectors`);
  missingInFixture === 0 ? pass('every mapped selector exists verbatim in the fixture HTML') : fail(`${missingInFixture} selectors not in fixture`);

  // Low-confidence flag (category @ 0.5)
  const low = r.humanTouchpoints.find(t => t.type === 'low_confidence_selector' && t.field === 'category');
  low && low.confidence < LOW_CONFIDENCE_THRESHOLD ? pass('category flagged low_confidence_selector') : fail('no low-confidence flag for category');

  // Dangerous controls flagged (Submit Release / Delete Release), non-blocking
  const danger = r.humanTouchpoints.filter(t => t.type === 'dangerous_action');
  danger.length >= 2 ? pass(`dangerous controls flagged (${danger.length})`) : fail('expected >=2 dangerous_action', JSON.stringify(danger));
  danger.every(t => t.blocking === false) ? pass('dangerous_action flags are non-blocking heads-ups') : fail('dangerous_action should be non-blocking');

  // Dry-run passed
  r.dryRun && r.dryRun.status === 'dry_run_passed' ? pass('dry-run reached dry_run_passed') : fail('dry-run not passed', JSON.stringify(r.dryRun));
  r.dryRun && r.dryRun.filledFields === 0 ? pass('no fields filled in dry-run (no browser, dangerous fields untouched)') : fail('unexpected filled fields', JSON.stringify(r.dryRun));

  // field-map.local.json on disk
  const fmPath = path.join(WORKFLOWS, idA, 'field-map.local.json');
  fs.existsSync(fmPath) ? pass('field-map.local.json written to workflow dir') : fail('field-map.local.json missing');

  // Readiness verdict
  r.readiness && r.readiness.states.field_map_verified ? pass('readiness: field_map_verified') : fail('readiness not field_map_verified', JSON.stringify(r.readiness && r.readiness.states));
}

// ===========================================================================
section('B', 'auth gate blocks before discovery');
const idB = `autopilot-accept-b-${rand}`;
scaffoldWorkflow(idB, { auth: { site_id: `unsaved-site-${rand}`, mode: 'required', base_url: 'http://needs-login.local' } });
{
  let discoverCalled = false;
  const out = await runAutopilot({
    workflowId: idB,
    callLLM: fakeLLM,
    discoverPageFn: async (a) => { discoverCalled = true; return fixtureDiscovery(a.url); },
    headed: false,
  });
  out.exitCode === 4 ? pass('exit code 4 (blocked)') : fail('expected exit 4', `got ${out.exitCode}`);
  out.report.overall === 'blocked' ? pass('overall = blocked') : fail('overall not blocked', out.report.overall);
  const authTp = out.report.humanTouchpoints.find(t => t.type === 'blocked_auth_required');
  authTp && authTp.blocking ? pass('blocked_auth_required touchpoint emitted (blocking)') : fail('no blocked_auth_required');
  authTp && authTp.command && authTp.command.includes('auth save') ? pass('touchpoint includes auth save command') : fail('no auth save command');
  out.report.nextRequiredAction === 'refresh_auth_profile' ? pass('next action = refresh_auth_profile') : fail('wrong next action', out.report.nextRequiredAction);
  !discoverCalled ? pass('discovery never ran (auth gated first)') : fail('discovery ran despite missing auth');
}

// ===========================================================================
section('C', 'hallucination guard: invented selectors never reach field-map');
const idC = `autopilot-accept-c-${rand}`;
scaffoldWorkflow(idC);
{
  // First a normal discovery pass so a discovered-fields.json exists,
  // then re-map with a hallucinating LLM via skip-discovery.
  await runAutopilot({ workflowId: idC, callLLM: fakeLLM, discoverPageFn: makeFakeDiscover(), headed: false });
  const out = await runAutopilot({ workflowId: idC, callLLM: hallucinatingLLM, skipDiscovery: true, headed: false });

  const fmPath = path.join(WORKFLOWS, idC, 'field-map.local.json');
  const fm = JSON.parse(fs.readFileSync(fmPath, 'utf8'));
  Object.keys(fm.fields).length === 0 ? pass('no fields mapped from hallucinated selectors') : fail('hallucinated selectors leaked into field map', JSON.stringify(fm.fields));
  !JSON.stringify(fm).includes('#fabricated-') ? pass('no #fabricated- selector anywhere in field-map.local.json') : fail('fabricated selector present in field map');
  fm.unmapped.includes('title') && fm.unmapped.includes('artist') ? pass('safe fields fell through to unmapped[] under hallucination guard') : fail('expected safe fields unmapped', JSON.stringify(fm.unmapped));
}

// ===========================================================================
section('D', 'recordingPageUrls harvests distinct non-auth page URLs');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-rec-'));
  const eventsPath = path.join(tmp, 'events.json');
  fs.writeFileSync(eventsPath, JSON.stringify([
    { type: 'page_seen', pageUrl: 'https://app.example.com/step-1', pageTitle: 'Step 1' },
    { type: 'page_seen', pageUrl: 'https://app.example.com/step-2', pageTitle: 'Step 2' },
    { type: 'page_seen', pageUrl: 'https://app.example.com/step-1', pageTitle: 'Step 1 again' },
    { type: 'page_seen', pageUrl: 'https://accounts.google.com/signin', pageTitle: 'Login' },
  ], null, 2));
  try {
    const urls = recordingPageUrls(eventsPath);
    urls.length === 2 ? pass('harvested 2 distinct pages') : fail('expected 2 urls', JSON.stringify(urls));
    urls.includes('https://app.example.com/step-1') && urls.includes('https://app.example.com/step-2')
      ? pass('harvested both business pages') : fail('missing business pages', JSON.stringify(urls));
    !urls.some(u => /accounts\.google\.com/.test(u)) ? pass('dropped the SSO/login page') : fail('login page not dropped');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`Summary: ${passed} passed, ${failed} failed`);

// Cleanup temp workflows + run output
for (const dir of created) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

if (failed > 0) {
  console.error('Failures:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('All checks passed.');
