// Convert a narrated/browser-observed workflow into generic Browsy artifacts.
// This module intentionally avoids vendor-specific assumptions.

import { RETURN_CONTRACT_VERSION } from './workflow-contract.mjs';

const FILE_INPUT_TYPES = new Set(['file', 'file path', 'upload', 'asset']);
const DANGEROUS_WORDS = /submit|release|publish|pay|purchase|checkout|delete|remove|confirm|certify|agree/i;
const FINAL_WORDS = /final|submit|release|publish|upload to stores|go live/i;

export function normalizeObservation(input = {}) {
  const raw = typeof input === 'string' ? JSON.parse(input) : (input || {});
  const workflowId = toWorkflowId(raw.workflowId || raw.id || raw.name || raw.title || 'observed-workflow');
  const actions = asArray(raw.actions).map(normalizeAction);
  const repeatGroups = normalizeRepeatGroups(raw.repeatGroups || raw.repeatables || raw.repeatedGroups || [], actions);

  return {
    schemaVersion: raw.schemaVersion || 'browsy.observation.v1',
    workflowId,
    title: raw.title || raw.name || workflowId,
    goal: raw.goal || raw.description || '',
    pages: asArray(raw.pages || raw.targetPages || raw.targets).map(normalizePage),
    fields: normalizeFields(raw.fields || raw.globalFields || [], { defaultScope: 'global' }),
    actions,
    repeatGroups,
    capturedOutputs: normalizeCapturedOutputList(raw.capturedOutputs || raw.outputs || raw.captures || []),
    humanCheckpoints: normalizeCheckpoints(raw.humanCheckpoints || raw.checkpoints || []),
    safetyPolicy: raw.safetyPolicy || null,
    notes: raw.notes || '',
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
//
// Required envelope fields (workflow_id, source_system, entity_type,
// entity_id, mode) are populated with generic, contract-valid defaults so the
// emitted package validates and dry-runs immediately after materialization.
// Observation-derived structure (globals, defaults, repeatGroups,
// capturedOutputs, humanCheckpoints) lives inside `canonical_payload`, which
// Browsy passes to the reusable workflow without inspection.
//
// `assets` is an ARRAY of { role, path?, repeat_group? } as the contract
// requires — never an id→path object.
export function buildWorkflowPackageFromObservation(observation) {
  const obs = normalizeObservation(observation);

  const globals = {};
  const assetsByRole = {};
  const defaults = {};
  for (const field of obs.fields) {
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

  const capturedOutputs = inferCapturedOutputs(obs).map(output => cleanObject({
    id: output.id,
    label: output.label,
    scope: output.scope || 'captured',
    source: output.source || 'captured_from_page',
    required: output.required !== false,
    verify: output.verify || null,
    storesTo: output.storesTo || `captured.${output.id}`,
  }));

  // Flatten observation-derived assets (global + per-repeat-item) into the
  // contract's array form: each entry is { role, path?, repeat_group? }.
  const assetEntries = [];
  for (const [role, value] of Object.entries(assetsByRole)) {
    assetEntries.push(cleanObject({
      role,
      path: typeof value === 'string' ? value : null,
    }));
  }
  for (const group of repeatGroups) {
    const itemAssets = (group.items && group.items[0] && group.items[0].assets) || {};
    for (const [role, value] of Object.entries(itemAssets)) {
      assetEntries.push(cleanObject({
        role,
        repeat_group: group.id,
        path: typeof value === 'string' ? value : null,
      }));
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
    humanCheckpoints: obs.humanCheckpoints || [],
  });

  return {
    workflow_id: obs.workflowId,
    source_system: 'external_client',
    entity_type: 'workflow',
    entity_id: 'EXTERNAL_ENTITY_ID',
    mode: 'dry_run',
    human_gate: true,
    canonical_payload: canonicalPayload,
    assets: assetEntries,
    capture_outputs: captureOutputNames,
    on_failure: 'stop_and_return_blocked_result',
    return_contract_version: RETURN_CONTRACT_VERSION,
  };
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
    humanCheckpoints: obs.humanCheckpoints,
    manualOnlyActions,
    safetyPolicy: obs.safetyPolicy || buildSafetyPolicy(manualOnlyActions),
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
    return cleanObject({ id, label: checkpoint.label || checkpoint.name || humanize(id), beforeAction: checkpoint.beforeAction || '', notes: checkpoint.notes || '' });
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
  return {
    never_click_text: neverClickText,
    manual_only_categories: ['final submission', 'payment', 'legal certification', 'destructive action'],
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
