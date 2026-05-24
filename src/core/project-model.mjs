import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_READINESS_STATES = [
  'intake_draft','intake_validated','observation_needed','observation_captured',
  'discovery_ready','discovery_complete','field_map_candidate_ready','field_map_verified',
  'harness_scaffolded','dry_run_ready','dry_run_passed','live_run_ready','live_run_gated',
  'live_run_completed','output_capture_completed','promoted_to_reusable',
];

export const FIELD_SCOPES = ['global','item','captured','derived','external_link','output_only'];

export const DEFAULT_NEVER_CLICK_TEXT = [
  'Submit','Finalize','Pay','Purchase','Release','Checkout','Confirm order',
  'Upload to stores','Send to stores','Continue & submit','Continue and submit',
  'Save and submit','I agree','I certify','Delete','Remove','Publish',
];

export const DEFAULT_MANUAL_ONLY_CATEGORIES = [
  'final_submit','payment','legal_certification','paid_extras','destructive_action',
];

export function toWorkflowId(value = 'workflow') {
  return String(value || 'workflow').trim().toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workflow';
}

export function toCamel(value = '') {
  const cleaned = String(value || '')
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.split(/\s+/).map((part, index) => {
    const lower = part.toLowerCase();
    return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join('');
}

function unique(values) { return [...new Set(values.filter(Boolean))]; }
function has(filePath) { return !!filePath && fs.existsSync(filePath); }
function writeJson(filePath, value) { fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function writeText(filePath, value) { fs.writeFileSync(filePath, value, 'utf8'); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

export function normalizeAutomationPackage(input = {}) {
  const workflowId = toWorkflowId(input.workflowId || input.id || input.target?.name || 'workflow');
  const target = input.target || {};
  return {
    schemaVersion: input.schemaVersion || 'browsy.workflow-package.v1',
    ...input,
    workflowId,
    target: { name: target.name || workflowId, url: target.url || '', ...target },
    globals: input.globals || {},
    defaults: input.defaults || {},
    assets: input.assets || {},
    repeatGroups: Array.isArray(input.repeatGroups) ? input.repeatGroups : [],
    humanCheckpoints: Array.isArray(input.humanCheckpoints) && input.humanCheckpoints.length
      ? input.humanCheckpoints
      : [{ id: 'review-before-final-action', label: 'Review before final action' }],
  };
}

export function extractFieldBuckets(pkgInput = {}) {
  const pkg = normalizeAutomationPackage(pkgInput);
  return {
    globals: Object.keys(pkg.globals || {}),
    defaults: Object.keys(pkg.defaults || {}),
    assets: Object.keys(pkg.assets || {}),
    repeatGroups: (pkg.repeatGroups || []).map(group => ({
      id: group.id || toCamel(group.label || 'items'),
      itemLabel: group.itemLabel || 'item',
      itemFields: unique((group.items || []).flatMap(item => Object.keys(item.fields || {}))),
      itemAssets: unique((group.items || []).flatMap(item => Object.keys(item.assets || {}))),
      sourceType: group.sourceType || 'manifest',
      sourceRef: group.sourceRef || '',
      createAction: group.createAction || null,
    })),
  };
}

export function buildCapturedOutputs(pkgInput = {}) {
  const pkg = normalizeAutomationPackage(pkgInput);
  const fromPackage = Array.isArray(pkg.capturedOutputs) ? pkg.capturedOutputs : [];
  const fromRuntime = Array.isArray(pkg.runtimeVariables?.captured) ? pkg.runtimeVariables.captured : [];
  const fromExternalLinks = Array.isArray(pkg.externalLinks) ? pkg.externalLinks : [];
  const byId = new Map();

  for (const output of [
    ...fromPackage,
    ...fromRuntime.map(v => ({ ...v, id: v.id || v.name, label: v.label || v.name })),
    ...fromExternalLinks.map(v => ({ ...v, id: v.id || v.name || toCamel(v.label || 'external link'), scope: 'external_link' })),
  ]) {
    const id = toCamel(output.id || output.name || output.label);
    if (!id) continue;
    byId.set(id, {
      id,
      label: output.label || output.name || id,
      scope: output.scope || (/url|link|public|page/i.test(id) ? 'external_link' : 'captured'),
      source: output.source || 'captured_from_page',
      required: output.required !== false,
      selector: output.selector,
      regex: output.regex,
      captureAfter: output.captureAfter,
      verify: output.verify || null,
      storesTo: output.storesTo || `captured.${id}`,
    });
  }
  return [...byId.values()];
}

export function normalizeGates(gates = []) {
  return gates.map(gate => ({
    id: gate.id || toWorkflowId(gate.label || 'gate'),
    label: gate.label || gate.id || 'Gate',
    requires: Array.isArray(gate.requires) ? gate.requires : [],
    unlocks: Array.isArray(gate.unlocks) ? gate.unlocks : [],
    mode: gate.mode || 'all',
    description: gate.description || '',
  }));
}

export function buildDefaultGates(pkgInput = {}, capturedOutputs = buildCapturedOutputs(pkgInput)) {
  const pkg = normalizeAutomationPackage(pkgInput);
  const explicit = normalizeGates(pkg.gates || []);
  if (explicit.length) return explicit;
  const publicOutput = capturedOutputs.find(o => /public|url|link/i.test(`${o.id} ${o.label}`));
  if (!publicOutput) return [];
  return [{
    id: `${publicOutput.id}_verified`,
    label: `${publicOutput.label} verified`,
    requires: [`captured.${publicOutput.id}`, `checks.${publicOutput.id}.status == verified`],
    unlocks: ['post_publish_steps'],
    mode: 'all',
    description: 'Unlock downstream steps only after the captured output exists and has been verified.',
  }];
}

function schemaForValue(value) {
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'number') return { type: 'number' };
  if (Array.isArray(value)) return { type: 'array' };
  if (value && typeof value === 'object') return { type: 'object' };
  return { type: 'string' };
}

function objectSchemaFromValues(values = {}) {
  const properties = {};
  for (const [key, value] of Object.entries(values)) properties[key] = schemaForValue(value);
  return { type: 'object', additionalProperties: true, properties, required: Object.keys(values).sort() };
}

export function buildManifestSchema(pkgInput = {}) {
  const pkg = normalizeAutomationPackage(pkgInput);
  const capturedOutputs = buildCapturedOutputs(pkg);
  const gates = buildDefaultGates(pkg, capturedOutputs);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `browsy://${pkg.workflowId}/manifest.schema.json`,
    title: `${pkg.workflowId} run manifest`,
    type: 'object',
    additionalProperties: true,
    properties: {
      workflowId: { const: pkg.workflowId },
      dryRun: { type: 'boolean', default: true },
      globals: objectSchemaFromValues(pkg.globals || {}),
      defaults: objectSchemaFromValues(pkg.defaults || {}),
      assets: objectSchemaFromValues(pkg.assets || {}),
      repeatGroups: { type: 'array', items: { type: 'object', additionalProperties: true } },
      capturedOutputs: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id','scope','source'],
          additionalProperties: true,
          properties: { id: { type: 'string' }, scope: { enum: FIELD_SCOPES }, source: { type: 'string' }, required: { type: 'boolean' } },
        },
      },
      gates: {
        type: 'array',
        items: { type: 'object', required: ['id','requires','unlocks'], additionalProperties: true },
      },
    },
    required: ['workflowId','dryRun'],
    'x-browsy': {
      capturedOutputs: capturedOutputs.map(o => o.id),
      gates: gates.map(g => g.id),
      repeatGroups: (pkg.repeatGroups || []).map(g => g.id),
    },
  };
}

export function buildManifestExample(pkgInput = {}) {
  const pkg = normalizeAutomationPackage(pkgInput);
  const capturedOutputs = buildCapturedOutputs(pkg);
  return {
    workflowId: pkg.workflowId,
    dryRun: true,
    globals: pkg.globals || {},
    defaults: pkg.defaults || {},
    assets: pkg.assets || {},
    repeatGroups: (pkg.repeatGroups || []).map(group => ({ id: group.id, items: group.items || [] })),
    capturedOutputs,
    gates: buildDefaultGates(pkg, capturedOutputs),
  };
}

export function buildSafetyPolicy(pkgInput = {}) {
  const pkg = normalizeAutomationPackage(pkgInput);
  const safety = pkg.safety || {};
  const checkpointText = (pkg.humanCheckpoints || []).map(cp => cp.label || cp.id).filter(Boolean);
  return {
    schemaVersion: 'browsy.safety-policy.v1',
    workflowId: pkg.workflowId,
    previewMeans: safety.previewMeans || 'Fill safe fields, capture artifacts, and stop before externally visible actions.',
    liveMeans: safety.liveMeans || 'Run against the target with dangerous-action blocks and explicit human checkpoint before final action.',
    neverClickText: unique([...(safety.neverClickText || []), ...DEFAULT_NEVER_CLICK_TEXT]),
    neverClickSelectors: safety.neverClickSelectors || [],
    manualOnlyCategories: unique([...(safety.manualOnlyCategories || []), ...DEFAULT_MANUAL_ONLY_CATEGORIES]),
    manualOnlyActions: unique([...(safety.manualOnlyActions || []), ...checkpointText]),
    checkpoints: pkg.humanCheckpoints || [],
    dangerButtonText: unique([...(safety.dangerButtonText || []), ...DEFAULT_NEVER_CLICK_TEXT]),
    finalSubmitRequiresExplicitHuman: true,
    paidLegalDestructiveRemainBlocked: true,
  };
}

export function buildFieldMapExample(pkgInput = {}) {
  const pkg = normalizeAutomationPackage(pkgInput);
  const buckets = extractFieldBuckets(pkg);
  return {
    schemaVersion: 'browsy.field-map.v1',
    workflowId: pkg.workflowId,
    status: 'candidate_only',
    note: 'Generated from intake. Replace with verified selectors after Atlas observation and Playwright discovery.',
    fields: {
      globals: buckets.globals.map(name => ({ name, selector: `(discover selector for ${name})`, scope: 'global' })),
      assets: buckets.assets.map(name => ({ name, selector: `(discover upload selector for ${name})`, scope: 'global_asset' })),
      repeatGroups: buckets.repeatGroups.map(group => ({
        id: group.id,
        itemLabel: group.itemLabel,
        createAction: group.createAction || { type: 'click', selector: '(discover add-item selector)' },
        itemFields: group.itemFields.map(name => ({ name, selector: `(discover item selector for ${name})`, scope: 'item' })),
        itemAssets: group.itemAssets.map(name => ({ name, selector: `(discover item upload selector for ${name})`, scope: 'item_asset' })),
      })),
    },
    capturedOutputs: buildCapturedOutputs(pkg).map(output => ({ id: output.id, selector: output.selector || `(discover capture selector for ${output.id})`, source: output.source, verify: output.verify })),
  };
}

export function buildWorkflowConfig(pkgInput = {}) {
  const pkg = normalizeAutomationPackage(pkgInput);
  const capturedOutputs = buildCapturedOutputs(pkg);
  return {
    schemaVersion: 'browsy.workflow.v1',
    id: pkg.workflowId,
    goal: pkg.goal || pkg.target?.name || pkg.workflowId,
    target: pkg.target,
    sourceOfTruth: 'project.json + AUTOMATION_REQUEST.md',
    runPackage: 'workflow-package.example.json',
    manifestSchema: 'manifest.schema.json',
    safetyPolicy: 'safety-policy.json',
    fieldMap: 'field-map.local.json',
    observationArtifacts: 'observations/',
    repeatGroups: pkg.repeatGroups || [],
    capturedOutputs,
    gates: buildDefaultGates(pkg, capturedOutputs),
  };
}

function yamlString(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) return value.length ? value.map(item => `${pad}- ${typeof item === 'object' && item ? `\n${yamlString(item, indent + 2)}` : JSON.stringify(item)}`).join('\n') : '[]';
  if (value && typeof value === 'object') return Object.entries(value).map(([key, val]) => val && typeof val === 'object' ? `${pad}${key}:\n${yamlString(val, indent + 2)}` : `${pad}${key}: ${JSON.stringify(val)}`).join('\n') || '{}';
  return JSON.stringify(value);
}

export function buildWorkflowYaml(pkgInput = {}) { return yamlString(buildWorkflowConfig(pkgInput)) + '\n'; }

export function buildAtlasObservationTemplate() {
  return `# Atlas observation — <workflow-id>\n\n## Metadata\n\n- Workflow id:\n- Date observed:\n- Observer:\n- Site/page:\n- URL pattern:\n- Login/auth state:\n- Page purpose:\n\n## Visible page model\n\n### Visible labels\n\n-\n\n### Global fields\n\n| Friendly field | Visible label | Required? | Notes |\n| --- | --- | --- | --- |\n| | | | |\n\n### Repeated item fields\n\n| Group | Item field | Visible label | Required? | Notes |\n| --- | --- | --- | --- | --- |\n| | | | | |\n\n### Add/remove item behavior\n\n- Add action label:\n- Remove action label:\n- First item pre-exists?:\n- Ordering behavior:\n- Stop condition:\n\n### File upload behavior\n\n- Global file uploads:\n- Item file uploads:\n- Accepted file types:\n- Upload progress/success indicators:\n\n## Buttons and actions\n\n| Action | Visible text | Safe to automate? | Reason |\n| --- | --- | --- | --- |\n| | | | |\n\n## Dangerous actions\n\n- Final submit buttons:\n- Payment/legal/destructive controls:\n- Confirmation dialogs:\n- Required human checkpoint:\n\n## Validation and success states\n\n- Blank form:\n- Invalid field:\n- Missing repeated item:\n- Success text:\n- Confirmation number / assigned ID:\n- Public URL / generated page:\n\n## Captured output candidates\n\n| Output id | Where it appears | Verification method | Downstream gate |\n| --- | --- | --- | --- |\n| | | | |\n\n## Selector candidates\n\n| Intent | Candidate selector | Why stable? | Needs Playwright verification? |\n| --- | --- | --- | --- |\n| | | | |\n\n## Artifact paths\n\n- Screenshots:\n- Page text snapshots:\n- HTML snapshots:\n\n## Unclear / gotcha notes\n\n-\n\n## Recommended automation strategy\n\n- [ ] API\n- [ ] Playwright\n- [ ] Browser-agent adapter\n- [ ] Human checkpoint\n\nRationale:\n`;
}

export function buildObservationChecklist(pkgInput = {}) {
  const pkg = normalizeAutomationPackage(pkgInput);
  const groups = pkg.repeatGroups || [];
  const outputs = buildCapturedOutputs(pkg);
  return `# Observation checklist — ${pkg.workflowId}\n\nUse ChatGPT Atlas Attach plus Codex to observe the real browser workflow before locking selectors.\n\n## Target\n\n- Workflow: ${pkg.workflowId}\n- Page: ${pkg.target?.url || '(target URL)'}\n- Requires login: ${pkg.target?.requiresLogin === false ? 'no' : 'yes / verify'}\n\n## Capture these page states\n\n- [ ] Blank form / initial dashboard state\n- [ ] Partially filled form\n- [ ] Validation error state\n- [ ] Repeated item added\n- [ ] Review / confirmation page\n- [ ] Success page\n- [ ] Post-submit dashboard or listing\n\n## Capture these artifacts\n\n- [ ] Screenshot path(s)\n- [ ] Page text snapshot path(s)\n- [ ] HTML snapshot path(s)\n- [ ] Visible labels and field groups\n- [ ] Button/action labels\n- [ ] Dangerous actions and final-submit controls\n- [ ] Validation messages\n- [ ] Success indicators\n- [ ] Selector candidates worth testing in Playwright\n\n## Repeat groups to verify\n\n${groups.length ? groups.map(group => `- ${group.id}: ${group.itemLabel || 'item'} items, add action ${group.createAction?.selector || '(observe button)'}`).join('\n') : '- None declared yet'}\n\n## Captured outputs to verify\n\n${outputs.length ? outputs.map(output => `- ${output.id}: ${output.label} (${output.scope})`).join('\n') : '- None declared yet'}\n`;
}

export function buildProjectJson(pkgInput = {}) {
  const pkg = normalizeAutomationPackage(pkgInput);
  const capturedOutputs = buildCapturedOutputs(pkg);
  const gates = buildDefaultGates(pkg, capturedOutputs);
  const states = Object.fromEntries(PROJECT_READINESS_STATES.map(state => [state, false]));
  states.intake_draft = true;
  states.observation_needed = true;
  return {
    schemaVersion: 'browsy.project.v1',
    workflowId: pkg.workflowId,
    goal: pkg.goal || pkg.target?.name || '',
    targetOutcome: pkg.targetOutcome || '',
    ownerContextNotes: pkg.ownerContextNotes || '',
    targetSites: [{ id: 'primary', purpose: pkg.target?.name || 'Target page', url: pkg.target?.url || '', requiresLogin: pkg.target?.requiresLogin !== false, expectedPageState: pkg.target?.expectedPageState || 'Ready for Atlas observation and Playwright discovery', atlasObservationNeeded: true }],
    dataSources: pkg.dataSources || [],
    runtimeVariables: pkg.runtimeVariables || { input: [], captured: capturedOutputs, derived: [] },
    runManifestSchema: 'manifest.schema.json',
    repeatGroups: pkg.repeatGroups || [],
    observationArtifacts: { required: true, directory: 'observations', template: 'observations/atlas-observation-template.md', documents: [] },
    discoveredFields: { status: 'not_started', directory: `output/runs/${pkg.workflowId}` },
    selectorCandidates: { status: 'not_started' },
    verifiedFieldMap: { status: 'not_verified', path: 'field-map.local.json' },
    safetyPolicy: 'safety-policy.json',
    runPackage: 'workflow-package.example.json',
    dryRunArtifacts: { status: 'not_started', directory: `output/runs/${pkg.workflowId}` },
    liveRunArtifacts: { status: 'not_started', directory: `output/runs/${pkg.workflowId}` },
    promotionStatus: 'not_promoted',
    capturedOutputs,
    gates,
    readiness: { status: 'intake_draft', states, updatedAt: new Date().toISOString() },
  };
}

export function buildWorkflowPackageExample(pkgInput = {}) {
  const pkg = normalizeAutomationPackage(pkgInput);
  const capturedOutputs = buildCapturedOutputs(pkg);
  return { schemaVersion: 'browsy.workflow-package.v1', ...pkg, capturedOutputs, gates: buildDefaultGates(pkg, capturedOutputs), safety: { ...(pkg.safety || {}), humanGated: true, finalSubmitRequiresExplicitHuman: true } };
}

function buildProjectReadme(pkgInput = {}) {
  const pkg = normalizeAutomationPackage(pkgInput);
  return `# ${pkg.workflowId}\n\nAutomation project draft generated by Browsy.\n\n## Source of truth\n\n- ../../AUTOMATION_REQUEST.md\n- project.json\n- workflow-package.example.json\n- manifest.schema.json\n- safety-policy.json\n- observations/\n\n## Lifecycle\n\nIntake → Atlas observation → Discovery → Field map → Package → Dry run → Human checkpoint → Live run → Output capture → Reusable workflow\n\n## Required next step\n\nCapture at least one real-page observation in observations/observation-YYYY-MM-DD.md, then run Playwright discovery. Do not guess selectors.\n`;
}

function buildWalkthrough(pkgInput = {}) {
  const pkg = normalizeAutomationPackage(pkgInput);
  return `# Walkthrough — ${pkg.workflowId}\n\nThis file should contain the workflow expert's plain-English walkthrough and Atlas observation notes.\n\n## Intake summary\n\n- Workflow id: ${pkg.workflowId}\n- Goal: ${pkg.goal || pkg.target?.name || ''}\n- Target URL: ${pkg.target?.url || ''}\n`;
}

function buildObservedFixture(kind, pkgInput) {
  const pkg = normalizeAutomationPackage(pkgInput);
  const success = kind === 'success' ? '<p data-browsy-captured="publicUrl">https://example.test/public/generated-page</p>' : '';
  const finalButton = kind === 'review' ? '<button data-browsy-action="final-submit">Submit</button>' : '';
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${pkg.workflowId} observed ${kind}</title></head><body><main data-browsy-observed-state="${kind}"><section data-browsy-section="globals"></section><section data-browsy-repeat="items"></section>${finalButton}${success}</main></body></html>\n`;
}

function buildRunMjs(pkgInput) {
  const pkg = normalizeAutomationPackage(pkgInput);
  return `#!/usr/bin/env node\nconsole.log('Browsy workflow draft: ${pkg.workflowId}');\nconsole.log('Next: capture observations, run discovery, verify field-map.local.json, then implement deterministic run logic.');\n`;
}

function buildSmokeTestMjs(pkgInput) {
  const pkg = normalizeAutomationPackage(pkgInput);
  return `#!/usr/bin/env node\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst root = path.dirname(new URL(import.meta.url).pathname);\nfor (const file of ['project.json','workflow-package.example.json','manifest.schema.json','safety-policy.json']) assert.equal(fs.existsSync(path.join(root, file)), true, file + ' exists');\nconsole.log('[${pkg.workflowId}] smoke-test: draft project files exist');\n`;
}

export function buildAutomationProjectDraft({ automationPackage = {}, workflowId } = {}) {
  const pkg = normalizeAutomationPackage({ ...automationPackage, workflowId: workflowId || automationPackage.workflowId });
  return {
    workflowId: pkg.workflowId,
    project: buildProjectJson(pkg),
    workflow: buildWorkflowConfig(pkg),
    workflowYaml: yamlString(buildWorkflowConfig(pkg)) + '\n',
    manifestSchema: buildManifestSchema(pkg),
    manifestExample: buildManifestExample(pkg),
    workflowPackageExample: buildWorkflowPackageExample(pkg),
    safetyPolicy: buildSafetyPolicy(pkg),
    fieldMapExample: buildFieldMapExample(pkg),
    fieldMapLocalExample: buildFieldMapExample(pkg),
    observationChecklist: buildObservationChecklist(pkg),
    atlasObservationTemplate: buildAtlasObservationTemplate(),
    readme: buildProjectReadme(pkg),
    walkthrough: buildWalkthrough(pkg),
    fixtureObservedForm: buildObservedFixture('form', pkg),
    fixtureObservedReview: buildObservedFixture('review', pkg),
    fixtureObservedSuccess: buildObservedFixture('success', pkg),
    runMjs: buildRunMjs(pkg),
    smokeTestMjs: buildSmokeTestMjs(pkg),
  };
}

export function writeAutomationProjectDraft({ repoRoot, workflowId, automationPackage = {} } = {}) {
  if (!repoRoot) throw new Error('repoRoot required');
  const draft = buildAutomationProjectDraft({ automationPackage, workflowId });
  const wfDir = path.join(repoRoot, 'workflows', draft.workflowId);
  ensureDir(path.join(wfDir, 'observations'));
  ensureDir(path.join(wfDir, 'fixtures'));
  const files = [
    ['project.json', draft.project, 'json'], ['workflow.json', draft.workflow, 'json'], ['workflow.yaml', draft.workflowYaml, 'text'],
    ['manifest.schema.json', draft.manifestSchema, 'json'], ['manifest.example.json', draft.manifestExample, 'json'],
    ['workflow-package.example.json', draft.workflowPackageExample, 'json'], ['safety-policy.json', draft.safetyPolicy, 'json'],
    ['field-map.example.json', draft.fieldMapExample, 'json'], ['field-map.local.json.example', draft.fieldMapLocalExample, 'json'],
    ['walkthrough.md', draft.walkthrough, 'text'], ['README.md', draft.readme, 'text'], ['run.mjs', draft.runMjs, 'text'], ['smoke-test.mjs', draft.smokeTestMjs, 'text'],
    ['observations/atlas-observation-template.md', draft.atlasObservationTemplate, 'text'], ['observations/observation-checklist.md', draft.observationChecklist, 'text'],
    ['fixtures/observed-form.html', draft.fixtureObservedForm, 'text'], ['fixtures/observed-review.html', draft.fixtureObservedReview, 'text'], ['fixtures/observed-success.html', draft.fixtureObservedSuccess, 'text'],
  ];
  for (const [rel, content, kind] of files) {
    const filePath = path.join(wfDir, rel);
    ensureDir(path.dirname(filePath));
    kind === 'json' ? writeJson(filePath, content) : writeText(filePath, content);
  }
  return { workflowId: draft.workflowId, workflowDir: wfDir, packagePath: `workflows/${draft.workflowId}/workflow-package.example.json`, relativeFiles: files.map(([rel]) => `workflows/${draft.workflowId}/${rel}`) };
}

function findLatestRunDir(runsDir) {
  if (!runsDir || !fs.existsSync(runsDir)) return null;
  const runs = fs.readdirSync(runsDir).filter(name => fs.statSync(path.join(runsDir, name)).isDirectory()).sort().reverse();
  return runs.length ? path.join(runsDir, runs[0]) : null;
}

export function listObservationDocuments(workflowDir, outputObservationDir) {
  const dirs = [path.join(workflowDir || '', 'observations'), outputObservationDir].filter(Boolean);
  const docs = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) if (file.endsWith('.md') && !/template|checklist/i.test(file)) docs.push(path.join(dir, file));
  }
  return unique(docs);
}

export function evaluateProjectReadiness({ workflowDir, runsDir, outputObservationDir } = {}) {
  const latestRun = findLatestRunDir(runsDir);
  const observationDocs = listObservationDocuments(workflowDir, outputObservationDir);
  let errors = [];
  if (latestRun && has(path.join(latestRun, 'errors.json'))) {
    try { errors = JSON.parse(fs.readFileSync(path.join(latestRun, 'errors.json'), 'utf8')); } catch { errors = ['unreadable errors.json']; }
  }
  const states = Object.fromEntries(PROJECT_READINESS_STATES.map(state => [state, false]));
  states.intake_draft = has(path.join(workflowDir || '', 'project.json')) || has(path.join(workflowDir || '', 'workflow-package.example.json'));
  states.intake_validated = states.intake_draft && has(path.join(workflowDir || '', 'manifest.schema.json')) && has(path.join(workflowDir || '', 'safety-policy.json'));
  states.observation_needed = states.intake_validated && observationDocs.length === 0;
  states.observation_captured = observationDocs.length > 0;
  states.discovery_ready = states.intake_validated && (states.observation_captured || !states.observation_needed);
  states.discovery_complete = !!latestRun && has(path.join(latestRun, 'discovered-fields.json'));
  states.field_map_candidate_ready = has(path.join(workflowDir || '', 'field-map.example.json')) || (!!latestRun && has(path.join(latestRun, 'field-map.candidates.md')));
  states.field_map_verified = has(path.join(workflowDir || '', 'field-map.local.json'));
  states.harness_scaffolded = has(path.join(workflowDir || '', 'run.mjs')) && has(path.join(workflowDir || '', 'workflow.json'));
  states.dry_run_ready = states.harness_scaffolded && has(path.join(workflowDir || '', 'workflow-package.example.json'));
  states.dry_run_passed = !!latestRun && has(path.join(latestRun, 'run-review.md')) && errors.length === 0;
  states.live_run_ready = states.dry_run_passed && states.field_map_verified;
  states.live_run_gated = states.live_run_ready && has(path.join(workflowDir || '', 'safety-policy.json'));
  states.live_run_completed = !!latestRun && has(path.join(latestRun, 'live-run-completed.json'));
  states.output_capture_completed = !!latestRun && (has(path.join(latestRun, 'captured-outputs.json')) || has(path.join(latestRun, 'runtime-vars.json')));
  states.promoted_to_reusable = has(path.join(workflowDir || '', 'PROMOTED'));
  const status = [...PROJECT_READINESS_STATES].reverse().find(state => states[state]) || 'intake_draft';
  return { status, states, observationDocuments: observationDocs, latestRun: latestRun ? path.basename(latestRun) : null };
}

function getPath(obj, dottedPath) { return String(dottedPath || '').split('.').filter(Boolean).reduce((cur, part) => cur?.[part], obj); }
function normalizeExpected(value) { const raw = String(value || '').trim(); if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1); if (raw === 'true') return true; if (raw === 'false') return false; if (!Number.isNaN(Number(raw)) && raw !== '') return Number(raw); return raw; }

export function evaluateGate(gate = {}, context = {}) {
  const missing = [];
  for (const requirement of Array.isArray(gate.requires) ? gate.requires : []) {
    const expr = String(requirement || '').trim();
    const equality = expr.match(/^(.+?)\s*==\s*(.+)$/);
    if (equality) {
      if (getPath(context, equality[1].trim()) !== normalizeExpected(equality[2])) missing.push(expr);
    } else if ([undefined, null, false, ''].includes(getPath(context, expr))) missing.push(expr);
  }
  return { id: gate.id || 'gate', passed: missing.length === 0, missing, unlocks: gate.unlocks || [] };
}

export function evaluateGates(gates = [], context = {}) {
  const results = normalizeGates(gates).map(gate => evaluateGate(gate, context));
  return { allPassed: results.every(result => result.passed), results, unlocked: unique(results.filter(result => result.passed).flatMap(result => result.unlocks)), blocked: results.filter(result => !result.passed).map(result => ({ id: result.id, missing: result.missing })) };
}
