#!/usr/bin/env node
/**
 * Acceptance test: field-map-llm core module
 *
 * Checks:
 *   1  extractPackageFields — extracts global text fields
 *   2  extractPackageFields — extracts global asset (file) fields
 *   3  extractPackageFields — extracts default fields (deduped from globals)
 *   4  extractPackageFields — extracts repeat-group item fields
 *   5  extractPackageFields — extracts repeat-group item assets
 *   6  extractPackageFields — extracts capturedOutputs as captured scope
 *   7  extractPackageFields — sourcePath is set on all fields
 *   8  mapFieldsWithLLM — maps valid selectors from fake LLM response
 *   9  mapFieldsWithLLM — hallucination guard: invented selector → unmapped[]
 *  10  mapFieldsWithLLM — LLM null selector → unmapped[]
 *  11  mapFieldsWithLLM — unmapped field not present in fieldMap
 *  12  mapFieldsWithLLM — confidence values in [0, 1]
 *  13  mapFieldsWithLLM — fields unmentioned by LLM → unmapped[]
 *  14  mapFieldsWithLLM — repeat-group item field maps under correct groupId scope
 *  15  mapFieldsWithLLM — empty packageFields returns empty result
 *  16  mapFieldsWithLLM — invalid LLM JSON throws useful error
 *  17  mapFieldsWithLLM — accepts markdown-fenced JSON from LLM (defensive strip)
 *  18  CLI-ish integration: create temp workflow, write workflow-package.example.json,
 *      write fake discovered-fields.json, call core functions, verify field-map shape
 *
 * No real API calls. Uses a deterministic fake callLLM.
 *
 * Usage:
 *   node scripts/acceptance-field-map-llm.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');

import {
  extractPackageFields,
  mapFieldsWithLLM,
} from '../src/core/field-map-llm.mjs';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Sample package
// ---------------------------------------------------------------------------

const SAMPLE_PKG = {
  workflowId: 'test-workflow',
  globals: {
    title: 'My Release',
    category: 'Music',
  },
  assets: {
    heroImage: './assets/hero.png',
  },
  defaults: {
    language: 'en',
    // 'title' is already in globals — should NOT be duplicated
    title: 'Default Title',
  },
  repeatGroups: [
    {
      id: 'tracks',
      label: 'Tracks',
      items: [
        {
          fields: { trackTitle: 'Track One', trackNumber: 1 },
          assets: { audioFile: './tracks/01.mp3' },
        },
      ],
    },
  ],
  capturedOutputs: [
    { id: 'publicUrl', label: 'Public URL', scope: 'external_link' },
  ],
};

// ---------------------------------------------------------------------------
// Sample discovery candidates
// ---------------------------------------------------------------------------

const CANDIDATES = [
  {
    humanLabel: 'Title input',
    likelySemantic: 'title',
    type: 'text',
    visible: true,
    isDangerous: false,
    recommendedSelector: "[data-browsy-field='title']",
    selectorCandidates: [
      { selector: "[data-browsy-field='title']", stability: 90, method: 'data-attr' },
    ],
  },
  {
    humanLabel: 'Category select',
    likelySemantic: 'category',
    type: 'select',
    visible: true,
    isDangerous: false,
    recommendedSelector: "[data-browsy-field='category']",
    selectorCandidates: [
      { selector: "[data-browsy-field='category']", stability: 85, method: 'data-attr' },
    ],
  },
  {
    humanLabel: 'Hero image upload',
    likelySemantic: 'heroImage',
    type: 'file',
    visible: true,
    isDangerous: false,
    recommendedSelector: "[data-browsy-field='heroImage']",
    selectorCandidates: [
      { selector: "[data-browsy-field='heroImage']", stability: 80, method: 'data-attr' },
    ],
  },
  {
    humanLabel: 'Track title input',
    likelySemantic: 'trackTitle',
    type: 'text',
    visible: true,
    isDangerous: false,
    recommendedSelector: "[data-browsy-item-field='trackTitle']",
    selectorCandidates: [
      { selector: "[data-browsy-item-field='trackTitle']", stability: 88, method: 'data-attr' },
    ],
  },
  {
    humanLabel: 'Track audio upload',
    likelySemantic: 'audioFile',
    type: 'file',
    visible: true,
    isDangerous: false,
    recommendedSelector: "[data-browsy-item-field='audioFile']",
    selectorCandidates: [
      { selector: "[data-browsy-item-field='audioFile']", stability: 82, method: 'data-attr' },
    ],
  },
  {
    humanLabel: 'Submit button',
    likelySemantic: 'submit',
    type: 'button',
    visible: true,
    isDangerous: true,
    recommendedSelector: 'button[type=submit]',
    selectorCandidates: [
      { selector: 'button[type=submit]', stability: 60, method: 'tag' },
    ],
  },
];

// Fake LLM that returns a valid mapping
function makeFakeLLM(fields) {
  const selMap = {
    title:      "[data-browsy-field='title']",
    category:   "[data-browsy-field='category']",
    heroImage:  "[data-browsy-field='heroImage']",
    trackTitle: "[data-browsy-item-field='trackTitle']",
    trackNumber: null,
    audioFile:  "[data-browsy-item-field='audioFile']",
    language:   null,
    publicUrl:  null,
  };
  const mappings = fields.map(f => ({
    fieldName: f.fieldName,
    selector: selMap[f.fieldName] ?? null,
    confidence: selMap[f.fieldName] ? 0.9 : 0,
    reasoning: 'deterministic test mapping',
  }));
  return async (_msgs, _sys) => JSON.stringify({ mappings });
}

// Fake LLM that invents a selector not present in candidates
function makeHallucinatorLLM(fields) {
  return async (_msgs, _sys) => JSON.stringify({
    mappings: fields.map(f => ({
      fieldName: f.fieldName,
      selector: `#hallucinated-${f.fieldName}`,
      confidence: 0.99,
      reasoning: 'invented',
    })),
  });
}

// Fake LLM that returns JSON with markdown fences
function makeMarkdownFencerLLM() {
  return async (_msgs, _sys) => '```json\n' + JSON.stringify({ mappings: [] }) + '\n```';
}

// Fake LLM that returns garbage
function makeBrokenLLM() {
  return async (_msgs, _sys) => 'this is not json at all!!!';
}

// ---------------------------------------------------------------------------
// Tests: extractPackageFields
// ---------------------------------------------------------------------------

console.log('\nextractPackageFields');

const fields = extractPackageFields(SAMPLE_PKG);

check('1  extracts global text fields', () => {
  const globals = fields.filter(f => f.scope === 'global');
  assert.ok(globals.some(f => f.fieldName === 'title'), 'title missing');
  assert.ok(globals.some(f => f.fieldName === 'category'), 'category missing');
});

check('2  extracts global asset fields', () => {
  const assets = fields.filter(f => f.scope === 'asset');
  assert.ok(assets.some(f => f.fieldName === 'heroImage'), 'heroImage missing');
  assert.equal(assets.find(f => f.fieldName === 'heroImage')?.inputType, 'file');
});

check('3  defaults deduplicated against globals', () => {
  // 'language' from defaults should appear; 'title' from defaults should NOT be duplicated
  const titleFields = fields.filter(f => f.fieldName === 'title');
  assert.equal(titleFields.length, 1, 'title should appear exactly once');
  const langFields = fields.filter(f => f.fieldName === 'language');
  assert.equal(langFields.length, 1, 'language should appear (from defaults)');
});

check('4  extracts repeat-group item fields', () => {
  const items = fields.filter(f => f.scope === 'item');
  assert.ok(items.some(f => f.fieldName === 'trackTitle' && f.groupId === 'tracks'), 'trackTitle missing');
  assert.ok(items.some(f => f.fieldName === 'trackNumber' && f.groupId === 'tracks'), 'trackNumber missing');
});

check('5  extracts repeat-group item assets', () => {
  const itemAssets = fields.filter(f => f.scope === 'item_asset');
  assert.ok(itemAssets.some(f => f.fieldName === 'audioFile' && f.groupId === 'tracks'), 'audioFile missing');
  assert.equal(itemAssets.find(f => f.fieldName === 'audioFile')?.inputType, 'file');
});

check('6  extracts capturedOutputs as captured scope', () => {
  const captured = fields.filter(f => f.scope === 'external_link' || f.scope === 'captured');
  assert.ok(captured.some(f => f.fieldName === 'publicUrl'), 'publicUrl missing');
  assert.equal(captured.find(f => f.fieldName === 'publicUrl')?.inputType, 'captured');
});

check('7  sourcePath set on all fields', () => {
  for (const f of fields) {
    assert.ok(f.sourcePath, `sourcePath missing on ${f.fieldName}`);
    assert.ok(f.sourcePath.includes(f.fieldName) || f.sourcePath.includes('.'), `sourcePath malformed for ${f.fieldName}: ${f.sourcePath}`);
  }
});

// ---------------------------------------------------------------------------
// Tests: mapFieldsWithLLM
// ---------------------------------------------------------------------------

console.log('\nmapFieldsWithLLM');

const packageFields = extractPackageFields(SAMPLE_PKG);

await checkAsync('8  maps valid selectors from fake LLM', async () => {
  const { fieldMap } = await mapFieldsWithLLM({ packageFields, candidates: CANDIDATES, callLLM: makeFakeLLM(packageFields) });
  assert.ok(fieldMap.title?.selector === "[data-browsy-field='title']", 'title not mapped');
  assert.ok(fieldMap.category?.selector === "[data-browsy-field='category']", 'category not mapped');
});

await checkAsync('9  hallucination guard: invented selector → unmapped[]', async () => {
  const { fieldMap, unmapped } = await mapFieldsWithLLM({ packageFields, candidates: CANDIDATES, callLLM: makeHallucinatorLLM(packageFields) });
  // All invented selectors must go to unmapped, none in fieldMap
  for (const fieldName of Object.keys(fieldMap)) {
    const sel = fieldMap[fieldName]?.selector;
    assert.ok(!sel?.includes('#hallucinated-'), `Hallucinated selector made it into fieldMap for ${fieldName}`);
  }
  assert.ok(unmapped.length > 0, 'No fields were unmapped despite hallucinated selectors');
});

await checkAsync('10  LLM null selector → unmapped[]', async () => {
  const { unmapped } = await mapFieldsWithLLM({
    packageFields,
    candidates: CANDIDATES,
    callLLM: makeFakeLLM(packageFields),
  });
  // trackNumber and language have null selectors in fake LLM
  assert.ok(unmapped.includes('trackNumber'), 'trackNumber should be unmapped (null selector)');
  assert.ok(unmapped.includes('language'), 'language should be unmapped (null selector)');
});

await checkAsync('11  unmapped field not present in fieldMap', async () => {
  const { fieldMap, unmapped } = await mapFieldsWithLLM({
    packageFields,
    candidates: CANDIDATES,
    callLLM: makeFakeLLM(packageFields),
  });
  for (const name of unmapped) {
    assert.equal(fieldMap[name], undefined, `${name} is in unmapped but also in fieldMap`);
  }
});

await checkAsync('12  confidence values in [0, 1]', async () => {
  const { confidence } = await mapFieldsWithLLM({
    packageFields,
    candidates: CANDIDATES,
    callLLM: makeFakeLLM(packageFields),
  });
  for (const [name, val] of Object.entries(confidence)) {
    assert.ok(val >= 0 && val <= 1, `confidence[${name}]=${val} out of range`);
  }
});

await checkAsync('13  fields unmentioned by LLM → unmapped[]', async () => {
  // LLM only mentions one field
  const singleMappingLLM = async () => JSON.stringify({
    mappings: [{ fieldName: 'title', selector: "[data-browsy-field='title']", confidence: 0.9, reasoning: 'test' }],
  });
  const { unmapped } = await mapFieldsWithLLM({ packageFields, candidates: CANDIDATES, callLLM: singleMappingLLM });
  // Everything except title should be unmapped
  const nonTitle = packageFields.filter(f => f.fieldName !== 'title').map(f => f.fieldName);
  for (const name of nonTitle) {
    assert.ok(unmapped.includes(name), `${name} should be unmapped (LLM didn't mention it)`);
  }
});

await checkAsync('14  repeat-group item field maps under correct groupId scope', async () => {
  const { fieldMap } = await mapFieldsWithLLM({
    packageFields,
    candidates: CANDIDATES,
    callLLM: makeFakeLLM(packageFields),
  });
  assert.ok(fieldMap.trackTitle, 'trackTitle not in fieldMap');
  assert.equal(fieldMap.trackTitle.selector, "[data-browsy-item-field='trackTitle']");
  // source should indicate it came from LLM
  assert.equal(fieldMap.trackTitle.source, 'llm');
});

await checkAsync('15  empty packageFields returns empty result', async () => {
  const result = await mapFieldsWithLLM({ packageFields: [], candidates: CANDIDATES, callLLM: async () => '{}' });
  assert.deepEqual(result.fieldMap, {});
  assert.deepEqual(result.unmapped, []);
});

await checkAsync('16  invalid LLM JSON throws useful error', async () => {
  await assert.rejects(
    () => mapFieldsWithLLM({ packageFields, candidates: CANDIDATES, callLLM: makeBrokenLLM() }),
    err => {
      assert.ok(err.message.includes('invalid JSON') || err.message.includes('LLM returned'), `Unexpected error: ${err.message}`);
      return true;
    }
  );
});

await checkAsync('17  accepts markdown-fenced JSON from LLM', async () => {
  // Should not throw — strips fences and returns empty mappings
  const result = await mapFieldsWithLLM({ packageFields, candidates: CANDIDATES, callLLM: makeMarkdownFencerLLM() });
  assert.ok(Array.isArray(result.unmapped), 'unmapped should be array');
  // All fields unmapped since LLM returned empty mappings
  assert.equal(result.unmapped.length, packageFields.length);
});

// ---------------------------------------------------------------------------
// Test 18: CLI-ish integration — temp workflow folder round-trip
// ---------------------------------------------------------------------------

console.log('\nCLI-ish integration');

await checkAsync('18  temp workflow with workflow-package.example.json round-trips field-map shape', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browsy-test-'));
  try {
    // Write workflow-package.example.json
    const examplePkg = {
      workflowId: 'temp-test-workflow',
      globals: { itemTitle: 'Test Item', status: 'draft' },
      assets: { coverImage: './assets/cover.jpg' },
      repeatGroups: [{
        id: 'entries',
        items: [{ fields: { entryName: 'Entry One' }, assets: { entryFile: './entries/01.pdf' } }],
      }],
      capturedOutputs: [{ id: 'listingUrl', label: 'Listing URL', scope: 'external_link' }],
    };
    fs.writeFileSync(path.join(tmpDir, 'workflow-package.example.json'), JSON.stringify(examplePkg, null, 2));

    // Write fake discovered-fields.json
    const discoveredFields = {
      inputs: [
        { type: 'text', id: 'item-title', name: 'itemTitle', 'data-browsy-field': 'itemTitle', visible: true },
        { type: 'text', id: 'status', name: 'status', 'data-browsy-field': 'status', visible: true },
        { type: 'file', id: 'cover-image', name: 'coverImage', visible: true },
      ],
      buttons: [],
      links: [],
    };
    fs.writeFileSync(path.join(tmpDir, 'discovered-fields.json'), JSON.stringify(discoveredFields, null, 2));

    // Read back and call core functions
    const pkgRaw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'workflow-package.example.json'), 'utf8'));
    const pkgFields = extractPackageFields(pkgRaw);

    assert.ok(pkgFields.some(f => f.fieldName === 'itemTitle'), 'itemTitle not extracted');
    assert.ok(pkgFields.some(f => f.fieldName === 'coverImage'), 'coverImage not extracted');
    assert.ok(pkgFields.some(f => f.fieldName === 'entryName' && f.scope === 'item'), 'entryName item not extracted');
    assert.ok(pkgFields.some(f => f.fieldName === 'listingUrl' && f.inputType === 'captured'), 'listingUrl not extracted');

    // Fake candidates matching this package
    const fakeCandidates = [
      {
        humanLabel: 'Item title',
        likelySemantic: 'itemTitle',
        type: 'text',
        visible: true,
        isDangerous: false,
        recommendedSelector: "[data-browsy-field='itemTitle']",
        selectorCandidates: [{ selector: "[data-browsy-field='itemTitle']", stability: 90, method: 'data-attr' }],
      },
    ];

    const fakeLLMForTemp = async () => JSON.stringify({
      mappings: pkgFields.map(f => ({
        fieldName: f.fieldName,
        selector: f.fieldName === 'itemTitle' ? "[data-browsy-field='itemTitle']" : null,
        confidence: f.fieldName === 'itemTitle' ? 0.95 : 0,
        reasoning: 'test',
      })),
    });

    const { fieldMap, unmapped } = await mapFieldsWithLLM({
      packageFields: pkgFields,
      candidates: fakeCandidates,
      callLLM: fakeLLMForTemp,
    });

    // Verify shape
    assert.ok(fieldMap.itemTitle?.selector, 'itemTitle not in fieldMap');
    assert.ok(unmapped.length > 0, 'unmapped should not be empty');
    // Verify hallucination guard still holds for null selectors
    for (const name of unmapped) {
      assert.equal(fieldMap[name], undefined, `${name} in both fieldMap and unmapped`);
    }

    // Write output file to verify shape
    const output = {
      schemaVersion: 'browsy.field-map.v1',
      workflowId: pkgRaw.workflowId,
      status: 'llm_candidate',
      generatedBy: 'discover:map',
      fields: fieldMap,
      unmapped,
    };
    const outPath = path.join(tmpDir, 'field-map.local.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(written.schemaVersion, 'browsy.field-map.v1');
    assert.ok(written.fields.itemTitle, 'itemTitle not in written fieldMap');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
if (failed === 0) {
  console.log(`PASS: acceptance-field-map-llm — ${passed} checks passed.`);
} else {
  console.error(`FAIL: ${failed} check(s) failed (${passed} passed).`);
  process.exit(1);
}
