// Convert a narrated/browser-observed workflow into generic Browsy artifacts.
// This module intentionally avoids vendor-specific assumptions.

import { join } from 'path';
import { RETURN_CONTRACT_VERSION } from './workflow-contract.mjs';
import { WORKFLOWS_DIR, writeJson } from './paths.mjs';

const FILE_INPUT_TYPES = new Set(['file', 'file path', 'upload', 'asset']);
const DANGEROUS_WORDS = /submit|release|publish|pay|purchase|checkout|delete|remove|confirm|certify|agree/i;
const FINAL_WORDS = /final|submit|release|publish|upload to stores|go live/i;
const FIELD_EVENTS = new Set(['field_detected', 'editor_input', 'rich_text_changed', 'paste_detected']);
const UPLOAD_EVENTS = new Set(['file_selected', 'file_dropped']);
const ACTION_EVENTS = new Set(['action_detected', 'dangerous_action_candidate_detected', 'user_marked_dangerous_action']);
const OUTPUT_EVENTS = new Set(['output_candidate_detected', 'output_captured']);
const DOWNLOAD_EVENTS = new Set(['download_started', 'download_saved', 'download_failed']);
const PAGE_EVENTS = new Set(['page_seen', 'page_opened', 'page_navigated', 'popup_opened', 'page_snapshot_captured']);

export function normalizeObservation(input = {}) {
  const raw = typeof input === 'string' ? JSON.parse(input) : (input || {});
  const workflowId = toWorkflowId(raw.workflowId || raw.id || raw.name || raw.title || 'observed-workflow');
  const actions = asArray(raw.actions).map(normalizeAction);
  const repeatGroups = normalizeRepeatGroups(raw.repeatGroups || raw.repeatables || raw.repeatedGroups || [], actions);

  // Merge the recorder's separate `globalAssets` array into the field list
  // so file-type album-level inputs (cover art, album folder, etc.) reach
  // canonical_payload.assets instead of being silently dropped.
  const fieldsInput = [
    ...asArray(raw.fields || raw.globalFields || []),
    ...asArray(raw.globalAssets || []),
  ];

  return {
    schemaVersion: raw.schemaVersion || 'browsy.observation.v1',
    workflowId,
    title: raw.title || raw.name || workflowId,
    goal: raw.goal || raw.description || '',
    pages: asArray(raw.pages || raw.targetPages || raw.targets).map(normalizePage),
    fields: normalizeFields(fieldsInput, { defaultScope: 'global' }),
    actions,
    repeatGroups,
    capturedOutputs: normalizeCapturedOutputList(raw.capturedOutputs || raw.outputs || raw.captures || []),
    humanCheckpoints: normalizeCheckpoints(raw.humanCheckpoints || raw.checkpoints || []),
    safetyPolicy: raw.safetyPolicy || null,
    notes: raw.notes || '',
    recordingSetup: raw.recordingSetup || null,
    sessionEvents: asArray(raw.sessionEvents || raw.events || []),
  };
}

export function inferRepeatGroups(observation) {
  return normalizeObservation(observation).repeatGroups;
}

export function inferCapturedOutputs(observation) {
  const obs = normalizeObservation(observation);
  const outputs = [...obs.capturedOutputs];

  for (const page of obs.pages) {
    const url = page.urlTemplate || page.url || '';
    for (const varName of extractTemplateVars(url)) {
      if (!outputs.some(o => o.id === varName)) {
        outputs.push({
          id: varName,
          label: humanize(varName),
          scope: inferOutputScope(varName),
          source: 'current_url',
          regex: page.captureRegex || regexForUrlTemplate(url, varName),
          required: true,
          captureAfter: page.captureAfter || page.afterAction || null,
          storesTo: `captured.${varName}`,
        });
      }
    }
  }

  for (const ev of obs.sessionEvents || []) {
    if (!OUTPUT_EVENTS.has(ev.type)) continue;
    const raw = ev.rawEvidence || {};
    const id = toCamel(raw.outputId || raw.label || ev.selector || ev.id || 'captured output');
    if (!outputs.some(o => o.id === id)) {
      outputs.push(cleanObject({
        id,
        label: raw.label || raw.outputId || humanize(id),
        scope: 'captured',
        source: 'captured_from_page',
        selector: ev.selector || firstSelector(raw),
        required: true,
        captureAfter: raw.triggeredBySelector || null,
        example: raw.text || raw.textPreview || '',
        storesTo: `captured.${id}`,
        selectorCandidates: raw.selectorCandidates || [],
        selectorConfidence: raw.selectorConfidence || null,
        sourceEventId: ev.id || null,
        tabId: ev.pageId || null,
      }));
    }
  }

  return dedupeById(outputs);
}

export function inferRuntimeVariables(observation) {
  const obs = normalizeObservation(observation);
  const declaredInput = asArray(obs.runtimeVariables?.input);
  const declaredCaptured = asArray(obs.runtimeVariables?.captured);
  const declaredDerived = asArray(obs.runtimeVariables?.derived);

  const inputNames = new Set(declaredInput.map(v => v.name).filter(Boolean));
  for (const field of obs.fields) {
    if (field.scope === 'global' && field.inputType !== 'file') inputNames.add(field.id);
  }

  for (const ev of obs.sessionEvents || []) {
    if (!FIELD_EVENTS.has(ev.type)) continue;
    const raw = ev.rawEvidence || {};
    const id = toCamel(raw.name || raw.id || raw.label || ev.selector || ev.id || 'field');
    inputNames.add(id);
  }

  const captured = [...declaredCaptured];
  for (const output of inferCapturedOutputs(obs)) {
    if (!captured.some(v => v.name === output.id)) {
      captured.push({
        name: output.id,
        source: output.source || 'current_url',
        regex: output.regex || undefined,
        selector: output.selector || undefined,
        attribute: output.attribute || undefined,
        required: output.required !== false,
        captureAfter: output.captureAfter || undefined,
        example: output.example || output.exampleValue || undefined,
      });
    }
  }

  const derived = [...declaredDerived];
  for (const page of obs.pages) {
    const template = page.urlTemplate || page.url;
    if (!template || !hasTemplateVars(template)) continue;
    const name = page.derivedVarName || `${toCamel(page.id || page.purpose || 'target')}Url`;
    if (!derived.some(v => v.name === name)) derived.push({ name, template });
  }

  return {
    input: [...inputNames].map(name => ({ name })),
    captured: dedupeByName(captured).map(cleanObject),
    derived: dedupeByName(derived).map(cleanObject),
  };
}

// Build a workflow package conforming to the current Browsy contract
// (see docs/workflow-package-contract.md + src/core/workflow-contract.mjs).
export function buildWorkflowPackageFromObservation(observation) {
  const obs = normalizeObservation(observation);
  const materialized = buildMaterializedDetails(obs);

  const globals = {};
  const assetsByRole = {};
  const defaults = {};
  for (const field of materialized.fields) {
    const value = field.exampleValue ?? field.value ?? placeholderValue(field);
    if (field.scope === 'asset' || field.inputType === 'file') assetsByRole[field.id] = value;
    else if (field.scope === 'default') defaults[field.id] = value;
    else globals[field.id] = value;
  }

  const repeatGroups = inferRepeatGroups(obs).map(group => ({
    id: group.id,
    label: group.label,
    itemLabel: group.itemLabel,
    source: group.source,
    addAction: group.addAction ? cleanObject({
      id: group.addAction.id,
      label: group.addAction.label,
      selectorHint: group.addAction.selectorHint,
      type: group.addAction.type || 'click',
    }) : null,
    items: [buildSampleRepeatItem(group)],
  }));

  const capturedOutputs = materialized.outputs.map(output => cleanObject({
    id: output.id,
    label: output.label,
    scope: output.scope || 'captured',
    source: output.source || 'captured_from_page',
    required: output.required !== false,
    verify: output.verify || null,
    storesTo: output.storesTo || `captured.${output.id}`,
    selector: output.selector || null,
    captureAfter: output.captureAfter || null,
  }));

  const assetEntries = [];
  for (const [role, value] of Object.entries(assetsByRole)) {
    assetEntries.push(cleanObject({ role, path: typeof value === 'string' ? value : null }));
  }
  for (const group of repeatGroups) {
    const itemAssets = (group.items && group.items[0] && group.items[0].assets) || {};
    for (const [role, value] of Object.entries(itemAssets)) {
      assetEntries.push(cleanObject({ role, repeat_group: group.id, path: typeof value === 'string' ? value : null }));
    }
  }

  const captureOutputNames = capturedOutputs.map(o => o.id).filter(Boolean);

  const canonicalPayload = stripEmpty({
    goal: obs.goal || undefined,
    globals,
    defaults,
    assets: assetsByRole,
    repeatGroups,
    capturedOutputs,
    humanCheckpoints: materialized.checkpoints || [],
    tabs: materialized.tabs,
    replayPlan: materialized.replayPlan,
    bindings: materialized.bindings,
    expectedOutputs: materialized.outputs,
    artifactExtractionRules: materialized.artifactRules,
  });

  const pkg = cleanObject({
    workflow_id: obs.workflowId,
    source_system: 'external_client',
    entity_type: 'workflow',
    entity_id: 'EXTERNAL_ENTITY_ID',
    mode: 'dry_run',
    human_gate: true,
    canonical_payload: canonicalPayload,
    assets: assetEntries,
    capture_outputs: captureOutputNames,
    tabs: materialized.tabs,
    auth: materialized.auth,
    recordedSteps: materialized.steps,
    steps: materialized.steps,
    bindings: materialized.bindings,
    variableBindings: materialized.bindings.variables,
    fileUploadBindings: materialized.fileUploadBindings,
    uploads: materialized.fileUploadBindings,
    expectedOutputs: materialized.outputs,
    outputs: materialized.outputs,
    humanApprovalCheckpoints: materialized.checkpoints,
    checkpoints: materialized.checkpoints,
    replaySettings: materialized.replaySettings,
    safetyPolicy: materialized.safetyPolicy,
    artifactPolicy: materialized.artifactPolicy,
    on_failure: 'stop_and_return_blocked_result',
    return_contract_version: RETURN_CONTRACT_VERSION,
  });

  writeLegacyMaterializedSidecars(obs, materialized);
  return pkg;
}

export function buildWorkflowConfigFromObservation(observation) {
  const obs = normalizeObservation(observation);
  const runtimeVariables = inferRuntimeVariables(obs);
  const manualOnlyActions = inferManualOnlyActions(obs);
  const targetPages = obs.pages.map(page => cleanObject({
    id: page.id,
    purpose: page.purpose,
    url: page.urlTemplate || page.url,
    exampleUrl: page.exampleUrl,
    notes: page.notes,
  }));
  const materialized = buildMaterializedDetails(obs);

  return cleanObject({
    id: obs.workflowId,
    workflowId: obs.workflowId,
    title: obs.title,
    goal: obs.goal,
    targets: { pages: targetPages },
    variables: runtimeVariables,
    runtimeVariables,
    repeatGroups: inferRepeatGroups(obs),
    capturedOutputs: inferCapturedOutputs(obs),
    humanCheckpoints: materialized.checkpoints,
    manualOnlyActions,
    safetyPolicy: materialized.safetyPolicy,
    tabs: materialized.tabs,
    auth: materialized.auth,
    navigationGraph: materialized.navigationGraph,
    recordedSteps: materialized.steps,
    steps: materialized.steps,
    bindings: materialized.bindings,
    variableBindings: materialized.bindings.variables,
    fileUploadBindings: materialized.fileUploadBindings,
    expectedOutputs: materialized.outputs,
    humanApprovalCheckpoints: materialized.checkpoints,
    replaySettings: materialized.replaySettings,
    artifactPolicy: materialized.artifactPolicy,
    requiredFiles: materialized.uploads.map(u => u.id),
    supportedModes: ['preview', 'dry_run', 'live'],
    inputSchema: materialized.manifestSchema,
    outputSchema: { type: 'object', properties: Object.fromEntries(materialized.outputs.map(o => [o.id, { type: 'string', description: o.label || o.id }])) },
  });
}

export function buildRunPlanFromObservation(observation) {
  const obs = normalizeObservation(observation);
  const pkg = buildWorkflowPackageFromObservation(obs);
  const payload = pkg.canonical_payload || {};
  const runtime = inferRuntimeVariables(obs);
  const manualOnly = inferManualOnlyActions(obs);

  const lines = [
    `# Run Plan: ${obs.title}`,
    '',
    `**Workflow ID:** \`${obs.workflowId}\``,
    obs.goal ? `**Goal:** ${obs.goal}` : null,
    '',
    '## Pages / states observed',
    '',
    ...obs.pages.map(page => `- **${page.id}**: ${page.urlTemplate || page.url || '(no URL)'}${page.exampleUrl ? ` (example: ${page.exampleUrl})` : ''}`),
    '',
    '## Inputs and assets',
    '',
    ...Object.keys(payload.globals || {}).map(k => `- Global field: \`${k}\``),
    ...Object.keys(payload.assets || {}).map(k => `- Global asset: \`${k}\``),
    ...Object.keys(payload.defaults || {}).map(k => `- Shared default: \`${k}\``),
    '',
    '## Repeat groups',
    '',
    ...(payload.repeatGroups || []).map(g => `- **${g.id}** (${g.itemLabel}) — fields: ${Object.keys(g.items?.[0]?.fields || {}).join(', ') || 'none'}; assets: ${Object.keys(g.items?.[0]?.assets || {}).join(', ') || 'none'}`),
    '',
    '## Runtime variables',
    '',
    ...runtime.captured.map(v => `- Captured \`${v.name}\` from \`${v.source}\`${v.required === false ? ' (optional)' : ''}`),
    ...runtime.derived.map(v => `- Derived \`${v.name}\` from \`${v.template}\``),
    '',
    '## Captured outputs',
    '',
    ...inferCapturedOutputs(obs).map(o => `- **${o.id}** (${o.scope || 'captured'}) → ${o.storesTo || `captured.${o.id}`}`),
    '',
    '## Human checkpoints / manual-only actions',
    '',
    ...obs.humanCheckpoints.map(c => `- Checkpoint: ${c.label || c.id}`),
    ...manualOnly.map(a => `- Manual-only action: ${a.label || a.id}`),
    '',
    '## Safety stance',
    '',
    '- Generated from observation only; selectors still require discovery/verification.',
    '- Final, payment, legal, destructive, or publishing actions must remain manual unless explicitly promoted later.',
    '',
  ];

  return lines.filter(line => line !== null).join('\n');
}

function buildMaterializedDetails(obs) {
  const tabs = inferTabs(obs);
  const fields = inferObservedFields(obs);
  const uploads = inferObservedUploads(obs);
  const actions = inferObservedActions(obs);
  const checkpoints = inferObservedCheckpoints(obs, actions);
  const outputs = inferCapturedOutputs(obs);
  const artifactRules = inferArtifactRules(obs);
  const bindings = buildBindings(fields, uploads, outputs);
  const steps = buildRecordedSteps({ tabs, fields, uploads, actions, checkpoints, outputs, artifactRules });
  const replaySettings = { defaultMode: 'dry_run', stopBeforeFinalAction: true, requireVerifiedSelectorsForLive: true, retry: { attempts: 2, backoffMs: 500 }, timing: { afterNavigationMs: 500, afterActionMs: 250 } };
  const safetyPolicy = buildSafetyPolicy([...inferManualOnlyActions(obs), ...actions.filter(a => a.manualOnly || a.dangerous)]);
  const fileUploadBindings = uploads.map(u => cleanObject({ id: u.id, role: u.id, label: u.label, selector: u.selectorHint, fallbackSelectors: u.fallbackSelectors, selectorConfidence: u.selectorConfidence, tabId: u.tabId, source: `payload.${u.id}`, required: u.required !== false }));
  const navigationGraph = buildNavigationGraph(tabs, obs.sessionEvents || []);
  const auth = asArray(obs.recordingSetup?.tabs).filter(t => t.requiresAuth || t.siteId).map(t => cleanObject({ tabId: tabs.find(tab => tab.url === t.url)?.id, siteId: t.siteId || toWorkflowId(t.title || t.url || 'site'), siteName: t.title || t.siteId, url: t.url, authCheckUrl: t.authCheckUrl || t.url, mode: t.requiresAuth ? 'human_required_if_not_authenticated' : 'optional' }));
  const manifestSchema = buildManifestSchema(fields, uploads);
  const replayPlan = cleanObject({ schemaVersion: 'browsy.replay-plan.v1', workflowId: obs.workflowId, generatedAt: new Date().toISOString(), tabs, navigationGraph, steps, bindings, outputs, checkpoints, artifactExtractionRules: artifactRules, replaySettings });
  const artifactPolicy = { captureReplayPlan: true, captureOutputs: outputs.map(o => o.id), artifactExtractionRules: artifactRules };
  return { tabs, fields, uploads, actions, checkpoints, outputs, artifactRules, bindings, steps, replaySettings, safetyPolicy, fileUploadBindings, navigationGraph, auth, manifestSchema, replayPlan, artifactPolicy };
}

function writeLegacyMaterializedSidecars(obs, materialized) {
  try {
    const dir = join(WORKFLOWS_DIR, obs.workflowId);
    writeJson(join(dir, 'manifest.schema.json'), materialized.manifestSchema);
    writeJson(join(dir, 'replay-plan.json'), materialized.replayPlan);
    writeJson(join(dir, 'bindings.json'), materialized.bindings);
    writeJson(join(dir, 'field-map.local.json'), cleanObject({
      generatedAt: new Date().toISOString(),
      generatedBy: 'browsy.legacy-observation-import',
      workflowId: obs.workflowId,
      verificationStatus: 'observed_not_verified',
      fields: Object.fromEntries(materialized.fields.map(f => [f.id, selectorEntry(f)])),
      uploads: Object.fromEntries(materialized.uploads.map(u => [u.id, selectorEntry(u, 'file')])),
      actions: Object.fromEntries(materialized.actions.map(a => [a.id, selectorEntry(a, 'click')])),
      outputs: Object.fromEntries(materialized.outputs.map(o => [o.id, selectorEntry(o, 'output')])),
    }));
    writeJson(join(dir, 'safety-policy.json'), materialized.safetyPolicy);
  } catch {
    // Sidecar generation should never break preview/import. The caller still
    // receives the core workflow/package JSON and can inspect warnings manually.
  }
}

function inferTabs(obs) {
  const tabs = [];
  const add = ({ id, pageId, title, url, siteId, requiresAuth, authCheckUrl, source }) => {
    if (!url) return;
    if (tabs.some(t => t.url === url && (t.pageId || null) === (pageId || null))) return;
    tabs.push(cleanObject({ id: id || pageId || `tab${tabs.length + 1}`, pageId, title: title || `Tab ${tabs.length + 1}`, url, order: tabs.length + 1, siteId, requiresAuth: !!requiresAuth, authCheckUrl, source }));
  };
  for (const tab of asArray(obs.recordingSetup?.tabs)) add({ ...tab, source: 'recording_setup' });
  for (const page of obs.pages || []) add({ id: page.id, title: page.purpose, url: page.urlTemplate || page.url, source: 'observation_page' });
  for (const ev of obs.sessionEvents || []) if (PAGE_EVENTS.has(ev.type)) add({ id: ev.pageId, pageId: ev.pageId, title: ev.pageTitle || ev.rawEvidence?.title, url: ev.pageUrl || ev.rawEvidence?.url, source: ev.type });
  return tabs.length ? tabs : [{ id: 'tab1', title: 'Observed tab', url: 'about:blank', order: 1, source: 'fallback' }];
}

function inferObservedFields(obs) {
  const fields = [...obs.fields.filter(f => f.inputType !== 'file' && f.scope !== 'asset')];
  for (const ev of obs.sessionEvents || []) {
    if (!FIELD_EVENTS.has(ev.type)) continue;
    const raw = ev.rawEvidence || {};
    fields.push(cleanObject({ id: toCamel(raw.name || raw.id || raw.label || ev.selector || ev.id || 'field'), label: raw.label || raw.name || ev.selector, inputType: normalizeInputType(raw.inputType || raw.targetTag || 'text'), scope: 'global', selectorHint: ev.selector || firstSelector(raw), selectorCandidates: raw.selectorCandidates || [], selectorConfidence: raw.selectorConfidence || null, exampleValue: raw.textPreview || raw.value, required: true, tabId: ev.pageId, sourceEventId: ev.id }));
  }
  return dedupeById(fields.map(enrichSelectorMeta));
}

function inferObservedUploads(obs) {
  const uploads = [...obs.fields.filter(f => f.inputType === 'file' || f.scope === 'asset')];
  for (const ev of obs.sessionEvents || []) {
    if (!UPLOAD_EVENTS.has(ev.type)) continue;
    const raw = ev.rawEvidence || {};
    uploads.push(cleanObject({ id: toCamel(raw.name || raw.id || raw.label || ev.selector || ev.id || 'asset'), label: raw.label || raw.targetLabel || 'Uploaded file', inputType: 'file', scope: 'asset', selectorHint: ev.selector || firstSelector(raw), selectorCandidates: raw.selectorCandidates || [], selectorConfidence: raw.selectorConfidence || null, exampleValue: raw.files?.[0]?.name ? `./examples/${raw.files[0].name}` : undefined, required: true, tabId: ev.pageId, sourceEventId: ev.id, accept: raw.accept, multiple: raw.multiple }));
  }
  return dedupeById(uploads.map(enrichSelectorMeta));
}

function inferObservedActions(obs) {
  const actions = [...obs.actions];
  for (const ev of obs.sessionEvents || []) {
    if (!ACTION_EVENTS.has(ev.type)) continue;
    const raw = ev.rawEvidence || {};
    actions.push(normalizeAction({ id: raw.name || raw.id || raw.label || ev.selector || ev.id, label: raw.label || raw.text || ev.selector, selectorHint: ev.selector || firstSelector(raw), selectorCandidates: raw.selectorCandidates || [], selectorConfidence: raw.selectorConfidence || null, manualOnly: ev.type !== 'action_detected', dangerous: ev.type !== 'action_detected', tabId: ev.pageId, sourceEventId: ev.id }));
  }
  return dedupeById(actions.map(enrichSelectorMeta));
}

function inferObservedCheckpoints(obs, actions) {
  const checkpoints = [...obs.humanCheckpoints];
  for (const action of actions || []) {
    if (action.manualOnly || action.dangerous || DANGEROUS_WORDS.test(action.label || '')) {
      checkpoints.push(cleanObject({ id: `${action.id}Approval`, label: `Review before ${action.label || action.id}`, beforeAction: action.id, reason: action.safetyCategory || 'manual approval required', sourceEventId: action.sourceEventId }));
    }
  }
  return dedupeById(checkpoints.map(c => ({ ...c, id: c.id || toCamel(c.label || 'checkpoint') })));
}

function inferArtifactRules(obs) {
  return (obs.sessionEvents || []).filter(ev => DOWNLOAD_EVENTS.has(ev.type)).map((ev, index) => cleanObject({ id: toWorkflowId(ev.rawEvidence?.suggestedFilename || ev.id || `artifact-${index + 1}`), kind: ev.type, pageId: ev.pageId, sourceEventId: ev.id, suggestedFilename: ev.rawEvidence?.suggestedFilename, savedPath: ev.rawEvidence?.savedPath, url: ev.rawEvidence?.url, error: ev.rawEvidence?.error }));
}

function buildBindings(fields, uploads, outputs) {
  return {
    variables: Object.fromEntries(fields.map(f => [f.id, cleanObject({ source: `payload.${f.id}`, selector: f.selectorHint, selectorCandidates: f.selectorCandidates, required: f.required !== false })])),
    files: Object.fromEntries(uploads.map(u => [u.id, cleanObject({ source: `payload.${u.id}`, selector: u.selectorHint, selectorCandidates: u.selectorCandidates, required: u.required !== false })])),
    outputs: Object.fromEntries(outputs.map(o => [o.id, cleanObject({ selector: o.selector, source: o.source, attribute: o.attribute, required: o.required !== false, storesTo: o.storesTo })])),
  };
}

function buildRecordedSteps({ tabs, fields, uploads, actions, checkpoints, outputs, artifactRules }) {
  const steps = [];
  let order = 0;
  const defaultTab = tabs[0]?.id || 'tab1';
  for (const tab of tabs) steps.push(cleanObject({ id: `navigate_${toWorkflowId(tab.id)}`, type: 'navigate', order: ++order, tabId: tab.id, url: tab.url, waitUntil: 'domcontentloaded', retry: { attempts: 2, backoffMs: 500 } }));
  for (const f of fields) steps.push(cleanObject({ id: `fill_${f.id}`, type: f.inputType === 'select' ? 'select' : 'fill', order: ++order, tabId: f.tabId || defaultTab, selector: f.selectorHint, fallbackSelectors: f.fallbackSelectors, selectorConfidence: f.selectorConfidence, binding: f.id, value: `{{inputs.${f.id}}}`, required: f.required !== false, sourceEventId: f.sourceEventId }));
  for (const u of uploads) steps.push(cleanObject({ id: `upload_${u.id}`, type: 'uploadFile', order: ++order, tabId: u.tabId || defaultTab, selector: u.selectorHint, fallbackSelectors: u.fallbackSelectors, selectorConfidence: u.selectorConfidence, binding: u.id, file: `{{files.${u.id}}}`, required: u.required !== false, sourceEventId: u.sourceEventId }));
  for (const a of actions) {
    const cp = checkpoints.find(c => c.beforeAction === a.id);
    if (cp) steps.push(cleanObject({ id: `approve_${cp.id}`, type: 'approve', order: ++order, checkpointId: cp.id, beforeAction: a.id, reason: cp.reason || cp.notes }));
    steps.push(cleanObject({ id: `click_${a.id}`, type: 'click', order: ++order, tabId: a.tabId || defaultTab, selector: a.selectorHint, fallbackSelectors: a.fallbackSelectors, selectorConfidence: a.selectorConfidence, label: a.label, requiresApproval: !!cp || a.manualOnly || a.dangerous, safetyCategory: a.safetyCategory, sourceEventId: a.sourceEventId }));
  }
  for (const o of outputs) steps.push(cleanObject({ id: `extract_${o.id}`, type: o.attribute ? 'extractAttribute' : 'extractText', order: ++order, tabId: o.tabId || defaultTab, selector: o.selector, selectorConfidence: o.selectorConfidence, output: o.id, attribute: o.attribute, storesTo: o.storesTo, required: o.required !== false, captureAfter: o.captureAfter, sourceEventId: o.sourceEventId }));
  for (const r of artifactRules) steps.push(cleanObject({ id: `artifact_${r.id}`, type: r.kind === 'download_failed' ? 'assert' : 'download', order: ++order, tabId: r.pageId || defaultTab, artifactId: r.id, suggestedFilename: r.suggestedFilename, sourceEventId: r.sourceEventId }));
  return steps;
}

function buildManifestSchema(fields, uploads) {
  const properties = {};
  const required = [];
  for (const item of [...fields, ...uploads]) {
    properties[item.id] = { type: item.inputType === 'checkbox' ? 'boolean' : 'string', title: item.label || item.id };
    if (item.required !== false) required.push(item.id);
  }
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: true, required: [...new Set(required)], properties };
}

function buildNavigationGraph(tabs, events) {
  const nodes = tabs.map(t => cleanObject({ id: t.id, url: t.url, title: t.title, pageId: t.pageId }));
  const edges = [];
  let previous = null;
  for (const ev of events || []) {
    if (!PAGE_EVENTS.has(ev.type)) continue;
    const current = tabs.find(t => t.pageId === ev.pageId || t.url === ev.pageUrl)?.id || ev.pageId;
    if (previous && current && previous !== current) edges.push({ from: previous, to: current, event: ev.type, eventId: ev.id });
    if (current) previous = current;
  }
  return { nodes, edges };
}

function enrichSelectorMeta(item) {
  const selectorCandidates = asArray(item.selectorCandidates);
  const selector = item.selectorHint || item.selector || firstSelector(item);
  return cleanObject({ ...item, selectorHint: selector, fallbackSelectors: selectorCandidates.map(c => c.selector).filter(s => s && s !== selector).slice(0, 4), selectorCandidates, selectorConfidence: item.selectorConfidence || selectorCandidates[0]?.confidence || (selector ? 'medium' : 'low') });
}

function selectorEntry(item, type = item.inputType || 'text') {
  return cleanObject({ selector: item.selectorHint || item.selector, fallbackSelectors: item.fallbackSelectors, type, source: item.id, required: item.required !== false, selectorConfidence: item.selectorConfidence, sourceEventId: item.sourceEventId });
}

function normalizePage(page = {}, index = 0) {
  const id = toCamel(page.id || page.name || page.purpose || `page ${index + 1}`);
  return cleanObject({
    id,
    purpose: page.purpose || page.label || page.name || id,
    url: page.url || page.startUrl || '',
    urlTemplate: page.urlTemplate || page.templateUrl || (hasTemplateVars(page.url || '') ? page.url : ''),
    exampleUrl: page.exampleUrl || page.example_url || '',
    captureAfter: page.captureAfter || page.afterAction || '',
    captureRegex: page.captureRegex || page.regex || '',
    notes: page.notes || '',
  });
}

function normalizeFields(fields = [], options = {}) {
  return asArray(fields).map(field => {
    const id = toCamel(field.id || field.name || field.label || field.field || 'field');
    const inputType = normalizeInputType(field.inputType || field.type || field.kind);
    const defaultScope = inputType === 'file' ? 'asset' : options.defaultScope || 'global';
    return cleanObject({
      id,
      label: field.label || field.name || humanize(id),
      inputType,
      scope: field.scope || defaultScope,
      source: field.source || field.sourcePath || id,
      selectorHint: field.selectorHint || field.selector || '',
      selectorCandidates: field.selectorCandidates || [],
      selectorConfidence: field.selectorConfidence || '',
      exampleValue: field.exampleValue ?? field.example ?? field.value,
      required: field.required !== false,
      notes: field.notes || '',
    });
  });
}

function normalizeRepeatGroups(groups = [], actions = []) {
  return asArray(groups).map(group => {
    const itemLabel = group.itemLabel || group.itemSingular || singularize(group.itemName || group.label || group.id || 'item');
    const id = toCamel(group.id || group.itemPlural || pluralize(itemLabel));
    const addActionRaw = group.addAction || actions.find(a => a.targetRepeatGroup === id || a.repeatGroupId === id || a.scope === 'repeat-add');
    return cleanObject({
      id,
      label: group.label || humanize(id),
      itemLabel,
      itemPlural: group.itemPlural || pluralize(itemLabel),
      source: group.source || null,
      addAction: addActionRaw ? normalizeAction(addActionRaw) : null,
      itemFields: normalizeFields(group.itemFields || group.fields || [], { defaultScope: 'item' }).map(f => ({ ...f, scope: 'item' })),
      itemAssets: normalizeFields(group.itemAssets || group.assets || [], { defaultScope: 'item_asset' }).map(f => ({ ...f, inputType: 'file', scope: 'item_asset' })),
    });
  });
}

function normalizeAction(action = {}) {
  const id = toCamel(action.id || action.name || action.label || action.text || 'action');
  const label = action.label || action.text || action.name || humanize(id);
  const manualOnly = action.manualOnly === true || action.manual === true || DANGEROUS_WORDS.test(label) || DANGEROUS_WORDS.test(action.safetyCategory || '');
  const safetyCategory = action.safetyCategory || action.safety_category || (FINAL_WORDS.test(label) ? 'final submission' : manualOnly ? 'manual-only' : '');
  return cleanObject({
    id,
    label,
    type: action.type || 'click',
    scope: action.scope || '',
    targetRepeatGroup: action.targetRepeatGroup || action.repeatGroupId || '',
    selectorHint: action.selectorHint || action.selector || '',
    selectorCandidates: action.selectorCandidates || [],
    selectorConfidence: action.selectorConfidence || '',
    tabId: action.tabId || action.pageId || '',
    sourceEventId: action.sourceEventId || '',
    manualOnly,
    dangerous: action.dangerous === true || manualOnly,
    safetyCategory,
    notes: action.notes || '',
  });
}

function normalizeCapturedOutputList(outputs = []) {
  return asArray(outputs).map(output => {
    const id = toCamel(output.id || output.name || output.label || 'captured output');
    return cleanObject({
      id,
      label: output.label || output.name || humanize(id),
      scope: output.scope || inferOutputScope(id),
      source: output.source || 'captured_from_page',
      regex: output.regex || '',
      selector: output.selector || '',
      attribute: output.attribute || '',
      required: output.required !== false,
      captureAfter: output.captureAfter || output.afterAction || '',
      example: output.example || output.exampleValue || '',
      verify: output.verify || null,
      storesTo: output.storesTo || `captured.${id}`,
    });
  });
}

function normalizeCheckpoints(checkpoints = []) {
  return asArray(checkpoints).map((checkpoint, index) => {
    if (typeof checkpoint === 'string') return { id: toCamel(checkpoint), label: checkpoint };
    const id = toCamel(checkpoint.id || checkpoint.name || checkpoint.label || `checkpoint ${index + 1}`);
    return cleanObject({ id, label: checkpoint.label || checkpoint.name || humanize(id), beforeAction: checkpoint.beforeAction || '', reason: checkpoint.reason || '', notes: checkpoint.notes || '' });
  });
}

function inferManualOnlyActions(obs) {
  return dedupeById(obs.actions.filter(action => action.manualOnly || action.dangerous || action.safetyCategory));
}

function buildSampleRepeatItem(group) {
  const fields = {};
  const assets = {};
  for (const field of group.itemFields || []) fields[field.id] = field.exampleValue ?? placeholderValue(field);
  for (const asset of group.itemAssets || []) assets[asset.id] = asset.exampleValue ?? placeholderValue(asset);
  return cleanObject({ fields, assets });
}

function buildSafetyPolicy(manualOnlyActions) {
  const neverClickText = [...new Set(manualOnlyActions.map(a => a.label).filter(Boolean))];
  const neverClickSelectors = [...new Set(manualOnlyActions.map(a => a.selectorHint || a.selector).filter(Boolean))];
  return {
    never_click_text: neverClickText,
    never_click_selectors: neverClickSelectors,
    manual_only_categories: ['final submission', 'payment', 'legal certification', 'destructive action'],
    dry_run_default: true,
    pause_at_end_default: true,
  };
}

function placeholderValue(field) {
  if (field.inputType === 'file') return `./${field.id}`;
  if (/date/i.test(field.id)) return '2099-01-01';
  return `Example ${field.label || humanize(field.id)}`;
}

function regexForUrlTemplate(template, varName) {
  if (!template || !template.includes(`{{${varName}}}`)) return '';
  const before = template.split(`{{${varName}}}`)[0] || '';
  const marker = before.match(/\/([^/?#/]*)$/)?.[1] || '';
  const prefix = marker ? `/${escapeRegex(marker)}` : '';
  return `${prefix}/([A-Za-z0-9_-]+)`;
}

function inferOutputScope(value = '') {
  return /url|link|page|public/i.test(String(value)) ? 'external_link' : 'captured';
}

function normalizeInputType(type = 'text') {
  const t = String(type || 'text').toLowerCase();
  return FILE_INPUT_TYPES.has(t) || t.includes('file') || t.includes('upload') ? 'file' : t;
}

function extractTemplateVars(text = '') {
  const vars = [];
  const re = /\{\{([^}]+)\}\}/g;
  let match;
  while ((match = re.exec(String(text))) !== null) vars.push(match[1].trim());
  return [...new Set(vars)];
}

function hasTemplateVars(text = '') {
  return /\{\{[^}]+\}\}/.test(String(text));
}

function toWorkflowId(value = '') {
  return String(value || 'workflow').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
}

function toCamel(value = '') {
  const parts = String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return parts.map((part, index) => {
    const lower = part.toLowerCase();
    return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join('') || 'field';
}

function humanize(value = '') {
  return String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, c => c.toUpperCase());
}

function pluralize(value = '') {
  const v = String(value || 'item');
  if (/s$/i.test(v)) return v;
  if (/y$/i.test(v)) return v.slice(0, -1) + 'ies';
  return v + 's';
}

function singularize(value = '') {
  const v = String(value || 'item');
  if (/ies$/i.test(v)) return v.slice(0, -3) + 'y';
  if (/s$/i.test(v) && v.length > 1) return v.slice(0, -1);
  return v;
}

function firstSelector(input = {}) {
  return asArray(input.selectorCandidates || input.rawEvidence?.selectorCandidates)[0]?.selector || '';
}

function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function dedupeById(items) {
  const map = new Map();
  for (const item of items) if (item?.id) map.set(item.id, item);
  return [...map.values()];
}

function dedupeByName(items) {
  const map = new Map();
  for (const item of items) if (item?.name) map.set(item.name, item);
  return [...map.values()];
}

function cleanObject(obj) {
  if (Array.isArray(obj)) return obj.map(cleanObject);
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = cleanObject(value);
  }
  return out;
}

// Like cleanObject but only at the top level: drops keys whose values are
// undefined, null, empty string, empty array, or empty plain object. Used to
// keep canonical_payload tidy without recursively rewriting nested data.
function stripEmpty(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return out;
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
