#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseRequest } from '../src/core/request-parser.mjs';
import {
  PROJECT_READINESS_STATES,
  buildAutomationProjectDraft,
  buildManifestSchema,
  buildSafetyPolicy,
  evaluateGates,
  evaluateProjectReadiness,
  writeAutomationProjectDraft,
} from '../src/core/project-model.mjs';

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`✓ ${name}`);
}

const pkg = {
  workflowId: 'generic-release-flow',
  goal: 'Create a generic listing with repeated items and capture a public link after review.',
  target: { name: 'Generic listing form', url: 'https://example.test/listing/new', requiresLogin: true },
  globals: { title: 'Example Launch', category: 'Education' },
  assets: { heroImage: './assets/hero.png' },
  repeatGroups: [{
    id: 'items',
    label: 'Listing items',
    itemLabel: 'item',
    sourceType: 'manifest',
    createAction: { type: 'click', selector: '[data-browsy-action="add-item"]' },
    items: [{ fields: { itemName: 'Widget', itemOrder: 1 }, assets: { itemFile: './items/widget.pdf' } }],
  }],
  capturedOutputs: [{ id: 'publicUrl', label: 'Public URL', scope: 'external_link', source: 'captured_from_success_page', required: true, verify: { type: 'http_status', expected: 200 } }],
  gates: [{ id: 'public_link_verified', requires: ['captured.publicUrl', 'checks.publicUrl.status == verified'], unlocks: ['outreach', 'post_publish_steps'] }],
  humanCheckpoints: [{ id: 'review-before-submit', label: 'Review before final submit' }],
  safety: { neverClickText: ['Submit', 'Pay'], manualOnlyCategories: ['final_submit', 'payment'] },
};

check('project readiness states include full lifecycle', () => {
  for (const state of ['intake_draft','observation_captured','field_map_verified','live_run_gated','output_capture_completed','promoted_to_reusable']) {
    assert.ok(PROJECT_READINESS_STATES.includes(state), `${state} missing`);
  }
});

check('draft project captures canonical workflow model', () => {
  const draft = buildAutomationProjectDraft({ automationPackage: pkg });
  assert.equal(draft.project.workflowId, 'generic-release-flow');
  assert.equal(draft.project.readiness.status, 'intake_draft');
  assert.equal(draft.project.readiness.states.observation_needed, true);
  assert.equal(draft.project.repeatGroups[0].id, 'items');
  assert.equal(draft.project.capturedOutputs[0].scope, 'external_link');
  assert.equal(draft.project.gates[0].id, 'public_link_verified');
});

check('workflow package keeps globals, assets, repeat item fields, captured outputs, and gates separate', () => {
  const draft = buildAutomationProjectDraft({ automationPackage: pkg });
  assert.equal(draft.workflowPackageExample.globals.title, 'Example Launch');
  assert.equal(draft.workflowPackageExample.assets.heroImage, './assets/hero.png');
  assert.equal(draft.workflowPackageExample.repeatGroups[0].items[0].fields.itemName, 'Widget');
  assert.equal(draft.workflowPackageExample.repeatGroups[0].items[0].assets.itemFile, './items/widget.pdf');
  assert.equal(draft.workflowPackageExample.capturedOutputs[0].id, 'publicUrl');
  assert.equal(draft.workflowPackageExample.gates[0].unlocks.includes('outreach'), true);
});

check('manifest schema supports captured outputs and gates', () => {
  const schema = buildManifestSchema(pkg);
  assert.equal(schema.properties.capturedOutputs.type, 'array');
  assert.equal(schema.properties.gates.type, 'array');
  assert.equal(schema.properties.repeatGroups.type, 'array');
  assert.equal(schema['x-browsy'].capturedOutputs[0], 'publicUrl');
});

check('safety policy preserves final submit, payment, legal, and destructive gates', () => {
  const safety = buildSafetyPolicy(pkg);
  assert.equal(safety.finalSubmitRequiresExplicitHuman, true);
  assert.equal(safety.paidLegalDestructiveRemainBlocked, true);
  assert.ok(safety.neverClickText.includes('Submit'));
  assert.ok(safety.manualOnlyCategories.includes('legal_certification'));
  assert.ok(safety.manualOnlyActions.includes('Review before final submit'));
});

check('downstream gate blocks until captured output is verified', () => {
  const blocked = evaluateGates(pkg.gates, { captured: {}, checks: {} });
  assert.equal(blocked.allPassed, false);
  assert.deepEqual(blocked.blocked[0].missing, ['captured.publicUrl', 'checks.publicUrl.status == verified']);
  const unlocked = evaluateGates(pkg.gates, { captured: { publicUrl: 'https://example.test/public' }, checks: { publicUrl: { status: 'verified' } } });
  assert.equal(unlocked.allPassed, true);
  assert.ok(unlocked.unlocked.includes('post_publish_steps'));
});

check('request parser extracts captured outputs, external links, gates, and observation requirements', () => {
  const request = `# Browsy Automation Request\n\n## 1. Workflow name\n\n\`generic-release-flow\`\n\n## 2. Goal\n\nCreate a generic listing.\n\n## 3. Target websites / pages\n\n| Purpose | URL | Requires login? | Notes |\n| --- | --- | --- | --- |\n| Form | https://example.test/listing/new | yes | |\n\n## 5. Input data contract\n\n\`\`\`json\n{ "id": "RUN_1", "items": [], "captured": { "publicUrl": "" } }\n\`\`\`\n\n## 5c. Captured outputs\n\n\`\`\`json\n{ "capturedOutputs": [{ "id": "publicUrl", "scope": "external_link", "source": "success_page", "required": true }] }\n\`\`\`\n\n## 5d. Downstream gates\n\n\`\`\`json\n[{ "id": "public_link_verified", "requires": ["captured.publicUrl", "checks.publicUrl.status == verified"], "unlocks": ["post_publish_steps"] }]\n\`\`\`\n\n## 5e. Observation requirements\n\n\`\`\`json\n{ "atlasObservationNeeded": true, "requiredStates": ["blank form", "success page"], "artifacts": ["screenshot", "html"] }\n\`\`\`\n\n## 7. Fields to fill or upload\n\n| Field / action | Source in input | Website field/page | Scope / rule |\n| --- | --- | --- | --- |\n| Public URL | captured.publicUrl | success page | external link / captured output |\n\n## 8. Actions that must stay manual\n\n- Final submit\n\n## 12. Safety policy\n\n\`\`\`json\n{ "never_click_text": ["Submit"] }\n\`\`\`\n\n## 15. Acceptance criteria\n\n- Gates block downstream stages.\n\n## 16. Narrated walkthrough\n\nFill the safe form and stop before final submit.\n`;
  const parsed = parseRequest(request);
  assert.equal(parsed.capturedOutputs[0].id, 'publicUrl');
  assert.equal(parsed.externalLinks[0].scope, 'external_link');
  assert.equal(parsed.gates[0].id, 'public_link_verified');
  assert.equal(parsed.observationRequirements.atlasObservationNeeded, true);
});

check('project draft writer creates full file-based workflow package', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browsy-project-'));
  const result = writeAutomationProjectDraft({ repoRoot, automationPackage: pkg });
  const wfDir = path.join(repoRoot, 'workflows', 'generic-release-flow');
  for (const rel of ['project.json','workflow.json','workflow.yaml','manifest.schema.json','manifest.example.json','workflow-package.example.json','safety-policy.json','field-map.example.json','field-map.local.json.example','observations/atlas-observation-template.md','observations/observation-checklist.md','fixtures/observed-form.html','fixtures/observed-review.html','fixtures/observed-success.html','README.md','run.mjs','smoke-test.mjs']) {
    assert.equal(fs.existsSync(path.join(wfDir, rel)), true, rel);
  }
  assert.equal(result.packagePath, 'workflows/generic-release-flow/workflow-package.example.json');
});

check('readiness changes after observation document exists', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browsy-project-ready-'));
  writeAutomationProjectDraft({ repoRoot, automationPackage: pkg });
  const wfDir = path.join(repoRoot, 'workflows', 'generic-release-flow');
  const runsDir = path.join(repoRoot, 'output', 'runs', 'generic-release-flow');
  const outputObsDir = path.join(repoRoot, 'output', 'observations', 'generic-release-flow');
  const before = evaluateProjectReadiness({ workflowDir: wfDir, runsDir, outputObservationDir: outputObsDir });
  assert.equal(before.states.observation_needed, true);
  assert.equal(before.states.observation_captured, false);
  fs.writeFileSync(path.join(wfDir, 'observations', 'observation-2026-05-24.md'), '# Observation\n', 'utf8');
  const after = evaluateProjectReadiness({ workflowDir: wfDir, runsDir, outputObservationDir: outputObsDir });
  assert.equal(after.states.observation_needed, false);
  assert.equal(after.states.observation_captured, true);
  assert.equal(after.states.discovery_ready, true);
});

check('observation docs and reusable pattern docs exist', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  for (const rel of ['docs/atlas-codex-observation.md','templates/observation/atlas-observation-template.md','docs/patterns/global-repeat-captured-outputs.md']) {
    assert.equal(fs.existsSync(path.join(repoRoot, rel)), true, rel);
  }
});

console.log(`\nacceptance-project-lifecycle: ${checks} checks passed`);
