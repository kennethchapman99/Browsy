#!/usr/bin/env node
/**
 * Acceptance — observation real-world readiness.
 *
 * Loads the sanitized golden event log captured from the realistic-upload
 * fixture and asserts that the canonical event-to-observation conversion
 * produces enough structure to drive a durable automation package.
 *
 * Golden file:
 *   docs/fixtures/observation-realistic-upload-events.json
 *
 * Refresh the golden by running:
 *   node scripts/capture-observation-realistic-upload.mjs
 *
 * Checks (numbered for traceability):
 *   1  Golden file exists and parses
 *   2  Conversion produces an observation object with the expected top-level keys
 *   3  Pages are detected (≥ 1 page_seen → ≥ 1 pages[] entry)
 *   4  Fields are detected (≥ 5 unique globalFields — title, artist, date,
 *      genre, email, plus checkboxes)
 *   5  Repeat groups are detected (≥ 1 "+ Add another track" — by label)
 *   6  Dangerous / manual-only actions are detected (≥ 1 matches the
 *      "Submit & Publish Release" button)
 *   7  File inputs are represented as file-input intent — NOT as local paths.
 *      a) Each file field has inputType === 'file' and scope === 'asset'.
 *      b) If an exampleValue is present it matches /^<file: [^>]+>$/ and never
 *         starts with a directory marker ('/', '~/', 'C:\\', 'file://').
 *      c) No event in the log carries an absolute filesystem path.
 *   8  Conversion is deterministic — running it twice on the same golden
 *      produces identical observations.
 *   9  All events declare source='playwrightRecorder' (no leaked mock/random).
 *  10  Stats derived from the events satisfy the minimum bar for a DistroKid-
 *      style automation (pages ≥ 1, fields ≥ 5, repeatGroups ≥ 1, dangerous ≥ 1).
 *  11  Observation downstream-friendly: globalAssets is non-empty (cover art +
 *      track audio), globalFields is non-empty, manualOnlyActions is non-empty.
 *  12  Selector candidates exist for every detected field/action and are
 *      ranked by confidence (high / medium / low). At least one field has a
 *      high-confidence candidate.
 *
 * Usage:
 *   npm run acceptance:observation-real-world
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildObservationFromEvents } from '../src/core/observation-from-events.mjs';
import { deriveStatsFromEvents } from '../src/core/observation-events.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'docs', 'fixtures', 'observation-realistic-upload-events.json');

let passed = 0, failed = 0;
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') { console.error('FAIL  ' + label + (detail ? '\n      ' + detail : '')); failed++; }
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

// ── Path-leak detector — applied to every string value in every event ───────
const PATH_RX = /^(\/Users\/|\/home\/|\/private\/|\/var\/|\/tmp\/|~\/|[A-Z]:\\|file:\/\/)/;
function findPathLeaks(node, trail = '') {
  const leaks = [];
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const at = trail ? `${trail}.${k}` : k;
      if (typeof v === 'string' && PATH_RX.test(v)) leaks.push({ at, value: v });
      else if (v && typeof v === 'object') leaks.push(...findPathLeaks(v, at));
    }
  }
  return leaks;
}

// ── Check 1 ─────────────────────────────────────────────────────────────────
section(1, 'Golden event log exists and parses');
let golden, events;
try {
  const raw = fs.readFileSync(GOLDEN_PATH, 'utf8');
  golden = JSON.parse(raw);
  events = golden.events || [];
  if (!Array.isArray(events) || events.length === 0) throw new Error('events array empty');
  pass(`${path.relative(REPO_ROOT, GOLDEN_PATH)} parses, ${events.length} events`);
} catch (e) {
  fail('cannot load golden', e.message);
  console.log('\n══════════════════════════════════════');
  console.log(`Observation real-world acceptance: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════');
  process.exit(1);
}

// ── Check 2 ─────────────────────────────────────────────────────────────────
section(2, 'buildObservationFromEvents() produces the expected shape');
const obs = buildObservationFromEvents({
  events,
  workflowId: 'observation-realistic-upload',
  sourceUrl: '/fixtures/observation-realistic-upload/release.html',
  capturedAt: '2026-05-25T00:00:00.000Z',
  captureSource: 'playwrightRecorder',
});
{
  const requiredKeys = [
    'workflowId', 'captureSource', 'sourceUrl', 'mode',
    'pages', 'globalFields', 'globalAssets',
    'repeatGroups', 'manualOnlyActions',
    'sessionStats', 'sessionEvents',
  ];
  const missing = requiredKeys.filter(k => !(k in obs));
  missing.length === 0
    ? pass(`shape has all ${requiredKeys.length} required keys`)
    : fail('missing keys', JSON.stringify(missing));
}

// ── Check 3 ─────────────────────────────────────────────────────────────────
section(3, 'Pages are detected');
{
  const ok = Array.isArray(obs.pages) && obs.pages.length >= 1 && obs.pages.every(p => p.url);
  ok ? pass(`${obs.pages.length} page(s): ${obs.pages.map(p => p.url).join(', ')}`)
     : fail('no pages detected', JSON.stringify(obs.pages));
}

// ── Check 4 ─────────────────────────────────────────────────────────────────
section(4, 'Fields are detected (≥ 5 unique global text/select/email/checkbox)');
{
  const names = obs.globalFields.map(f => f.id);
  const enough = obs.globalFields.length >= 5;
  // Spot-check that all key metadata fields showed up
  const expected = ['release_title', 'primary_artist', 'release_date', 'genre', 'label_email'];
  const found = expected.filter(n => names.includes(n));
  enough && found.length === expected.length
    ? pass(`${obs.globalFields.length} global fields; expected metadata found: ${found.join(', ')}`)
    : fail('missing global fields', `total=${obs.globalFields.length}, missing=${expected.filter(n => !names.includes(n)).join(', ') || '(none)'}, names=${names.join(', ')}`);
}

// ── Check 5 ─────────────────────────────────────────────────────────────────
section(5, 'Repeat groups are detected');
{
  const labels = obs.repeatGroups.map(g => g.label);
  const addAnother = labels.find(l => /add another track/i.test(l));
  addAnother
    ? pass(`repeat groups: ${labels.join(' | ')}`)
    : fail('no "Add another track" repeat group', JSON.stringify(labels));
}

// ── Check 6 ─────────────────────────────────────────────────────────────────
section(6, 'Dangerous / manual-only actions are detected');
{
  const labels = obs.manualOnlyActions.map(a => a.label);
  const publish = labels.find(l => /submit\s*&?\s*publish\s*release/i.test(l));
  publish
    ? pass(`manual-only actions: ${labels.join(' | ')}`)
    : fail('Submit & Publish Release not flagged as dangerous', JSON.stringify(labels));
}

// ── Check 7 ─────────────────────────────────────────────────────────────────
section(7, 'File inputs are represented as file-input intent — never as local paths');
{
  // 7a — every globalAsset is a file input
  const allAssetsAreFile = obs.globalAssets.length > 0
    && obs.globalAssets.every(a => a.inputType === 'file' && a.scope === 'asset');
  if (!allAssetsAreFile) {
    fail('globalAssets are not all file-input typed',
      JSON.stringify(obs.globalAssets.map(a => ({ id: a.id, inputType: a.inputType, scope: a.scope }))));
  } else {
    pass(`${obs.globalAssets.length} file fields — all inputType=file, scope=asset`);
  }

  // 7b — exampleValue, when present, must match the file placeholder format
  const fileExamples = obs.globalAssets.map(a => a.exampleValue).filter(Boolean);
  const placeholderRx = /^<file: [^>]+>$/;
  const bad = fileExamples.filter(v => !placeholderRx.test(v));
  bad.length === 0
    ? pass(`file exampleValues use placeholder format: ${fileExamples.join(', ') || '(none)'}`)
    : fail('file fields leaked non-placeholder values', JSON.stringify(bad));

  // 7c — no event in the log carries an absolute path
  const leaks = findPathLeaks(events);
  leaks.length === 0
    ? pass('no absolute filesystem paths in any event')
    : fail(`${leaks.length} path-like string(s) leaked`, JSON.stringify(leaks.slice(0, 3)));
}

// ── Check 8 ─────────────────────────────────────────────────────────────────
section(8, 'Conversion is deterministic — two runs produce identical output');
{
  const a = buildObservationFromEvents({ events, workflowId: 'x', sourceUrl: 'u', capturedAt: 't', captureSource: 'playwrightRecorder' });
  const b = buildObservationFromEvents({ events, workflowId: 'x', sourceUrl: 'u', capturedAt: 't', captureSource: 'playwrightRecorder' });
  JSON.stringify(a) === JSON.stringify(b)
    ? pass('two passes produce byte-identical observations')
    : fail('non-deterministic conversion');
}

// ── Check 9 ─────────────────────────────────────────────────────────────────
section(9, 'All events carry source=playwrightRecorder');
{
  const bad = events.filter(e => e.source !== 'playwrightRecorder');
  bad.length === 0
    ? pass(`all ${events.length} events carry source=playwrightRecorder`)
    : fail(`${bad.length} events use a different source`, JSON.stringify(bad.slice(0, 3)));
}

// ── Check 10 ────────────────────────────────────────────────────────────────
section(10, 'Stats meet the bar for a DistroKid-style flow');
{
  const stats = deriveStatsFromEvents(events);
  const meets = stats.pages >= 1 && stats.fields >= 5 && stats.repeatGroups >= 1 && stats.dangerous >= 1;
  meets
    ? pass(`stats meet bar: ${JSON.stringify(stats)}`)
    : fail('stats below threshold', JSON.stringify(stats));
}

// ── Check 11 ────────────────────────────────────────────────────────────────
section(11, 'Observation is downstream-friendly — assets, fields, and manual actions all non-empty');
{
  const ok = obs.globalAssets.length > 0 && obs.globalFields.length > 0 && obs.manualOnlyActions.length > 0;
  ok
    ? pass(`globalAssets=${obs.globalAssets.length}, globalFields=${obs.globalFields.length}, manualOnlyActions=${obs.manualOnlyActions.length}`)
    : fail('one of (assets|fields|manualOnlyActions) was empty', JSON.stringify({ a: obs.globalAssets.length, f: obs.globalFields.length, m: obs.manualOnlyActions.length }));
}

// ── Check 12 ────────────────────────────────────────────────────────────────
section(12, 'Selector candidates with confidence scoring are present on fields/actions');
{
  const CONFIDENCE_VALUES = new Set(['high', 'medium', 'low']);
  const targets = [
    ...obs.globalFields.map(f => ({ kind: 'field', label: f.id, c: f.selectorCandidates, conf: f.selectorConfidence })),
    ...obs.globalAssets.map(f => ({ kind: 'asset', label: f.id, c: f.selectorCandidates, conf: f.selectorConfidence })),
    ...obs.manualOnlyActions.map(a => ({ kind: 'manualAction', label: a.label, c: a.selectorCandidates, conf: a.selectorConfidence })),
    ...obs.repeatGroups.map(g => ({ kind: 'repeatGroup', label: g.label, c: g.selectorCandidates, conf: g.selectorConfidence })),
  ];
  const bad = targets.filter(t => !Array.isArray(t.c) || t.c.length === 0 || !CONFIDENCE_VALUES.has(t.conf));
  const wellShaped = targets.every(t =>
    Array.isArray(t.c) &&
    t.c.every(cand => typeof cand.selector === 'string' && typeof cand.kind === 'string' && CONFIDENCE_VALUES.has(cand.confidence))
  );
  const anyHigh = targets.some(t => t.conf === 'high');

  if (bad.length === 0 && wellShaped && anyHigh) {
    pass(`${targets.length} target(s) have ranked selectorCandidates; ${targets.filter(t => t.conf === 'high').length} high-confidence`);
  } else {
    fail('selector candidates missing or malformed',
      `bad=${bad.length} wellShaped=${wellShaped} anyHigh=${anyHigh} (first bad: ${JSON.stringify(bad[0] || null)})`);
  }
}

console.log('\n══════════════════════════════════════');
console.log(`Observation real-world acceptance: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════');
if (failed > 0) process.exit(1);
