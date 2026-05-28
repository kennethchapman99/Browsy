// Observation compiler + workflow package materializer.
//
// Turns a recorded Browsy observation into a portable workflow package on disk.
// Generic only: no site/app-specific assumptions.

import fs from 'fs';
import path from 'path';
import { WORKFLOWS_DIR, OUTPUT_DIR, ensureDir, writeJson, writeText } from './paths.mjs';
import { RETURN_CONTRACT_VERSION } from './workflow-contract.mjs';
import {
  normalizeObservation,
  buildRunPlanFromObservation,
} from './observation-ingestion.mjs';
import { importWorkflowPackage, validateWorkflowPackageDir } from '../registry/package-importer.mjs';

const ACTION_TYPES = new Set(['action_detected', 'dangerous_action_candidate_detected', 'user_marked_dangerous_action']);
const FIELD_TYPES = new Set(['field_detected', 'editor_input', 'rich_text_changed', 'paste_detected']);
const UPLOAD_TYPES = new Set(['file_selected', 'file_dropped']);
const OUTPUT_TYPES = new Set(['output_candidate_detected', 'output_captured']);
const DOWNLOAD_TYPES = new Set(['download_started', 'download_saved', 'download_failed']);
const PAGE_TYPES = new Set(['page_seen', 'page_opened', 'page_navigated', 'popup_opened', 'page_snapshot_captured']);
const DANGEROUS = /submit|release|publish|pay|purchase|checkout|delete|remove|confirm|certify|agree|go live/i;

export function compileObservationToWorkflowPackage(observation = {}) {
  const raw = parseInput(observation);
  const obs = normalizeObservation(raw);
  const events = collectEvents(raw);
  const tabs = inferTabs(obs, raw, events);
  const fields = inferFields(obs, events);
  const uploads = inferUploads(obs, events);
  const actions = inferActions(obs, events);
  const checkpoints = inferCheckpoints(obs, actions, events);
  const outputs = inferOutputs(obs, events);
  const artifactRules = inferArtifactRules(events);
  const bindings = buildBindings(fields, uploads, outputs);
  const replaySettings = buildReplaySettings(raw);
  const steps = buildSteps({ tabs, fields, uploads, actions, checkpoints, outputs, artifactRules });
  const safetyPolicy = buildSafetyPolicy(raw, actions, checkpoints);

  const workflowJson = clean({
    schemaVersion: 'browsy.workflow.v1',
    id: obs.workflowId,
    workflowId: obs.workflowId,
    name: obs.title || obs.workflowId,
    description: obs.goal || '',
    generatedBy: 'browsy.observation-materializer',
    generatedAt: new Date().toISOString(),
    tabs,
    auth: inferAuth(raw, tabs),
    navigationGraph: buildNavigationGraph(tabs, events),
    recordedSteps: steps,
    steps,
    bindings,
    variableBindings: bindings.variables,
    fileUploadBindings: uploads.map(u => clean({
      id: u.id,
      role: u.id,
      label: u.label,
      selector: u.selector,
      fallbackSelectors: u.fallbackSelectors,
      selectorConfidence: u.selectorConfidence,
      tabId: u.tabId,
      source: `payload.${u.id}`,
      required: u.required !== false,
    })),
    expectedOutputs: outputs,
    humanApprovalCheckpoints: checkpoints,
    checkpoints,
    replaySettings,
    safetyPolicy,
    artifactPolicy: {
      captureReplayPlan: true,
      captureOutputs: outputs.map(o => o.id),
      artifactExtractionRules: artifactRules,
    },
    requiredFiles: uploads.map(u => u.id),
    supportedModes: ['preview', 'dry_run', 'live'],
    inputSchema: buildManifestSchema(fields, uploads),
    outputSchema: buildOutputSchema(outputs),
  });

  const replayPlan = clean({
    schemaVersion: 'browsy.replay-plan.v1',
    workflowId: obs.workflowId,
    generatedAt: new Date().toISOString(),
    tabs,
    navigationGraph: workflowJson.navigationGraph,
    steps,
    bindings,
    outputs,
    checkpoints,
    artifactExtractionRules: artifactRules,
    replaySettings,
  });

  const workflowPackage = clean({
    workflow_id: obs.workflowId,
    source_system: 'observation_compiler',
    entity_type: 'workflow_observation',
    entity_id: raw.sessionId || raw.manifest?.sessionId || obs.workflowId,
    mode: 'dry_run',
    human_gate: true,
    canonical_payload: {
      inputs: Object.fromEntries(fields.map(f => [f.id, f.exampleValue ?? exampleFor(f)])),
      files: Object.fromEntries(uploads.map(u => [u.id, u.exampleValue ?? `./examples/${u.id}`])),
      observation: {
        schemaVersion: raw.schemaVersion || obs.schemaVersion,
        eventCount: events.length,
        capturedAt: raw.capturedAt || raw.finishedAt || null,
      },
      tabs,
      replayPlan,
      bindings,
      expectedOutputs: outputs,
      checkpoints,
      artifactExtractionRules: artifactRules,
    },
    assets: uploads.map(u => clean({ role: u.id, path: u.exampleValue || `./examples/${u.id}`, selector: u.selector, tabId: u.tabId })),
    capture_outputs: outputs.map(o => o.id),
    tabs,
    auth: workflowJson.auth,
    recordedSteps: steps,
    steps,
    bindings,
    variableBindings: bindings.variables,
    fileUploadBindings: workflowJson.fileUploadBindings,
    uploads: workflowJson.fileUploadBindings,
    expectedOutputs: outputs,
    outputs,
    humanApprovalCheckpoints: checkpoints,
    checkpoints,
    replaySettings,
    safetyPolicy,
    artifactPolicy: workflowJson.artifactPolicy,
    on_failure: 'stop_and_return_blocked_result',
    return_contract_version: RETURN_CONTRACT_VERSION,
  });

  const fieldMap = clean({
    generatedAt: new Date().toISOString(),
    generatedBy: 'browsy.observation-materializer',
    workflowId: obs.workflowId,
    verificationStatus: 'observed_not_verified',
    fields: Object.fromEntries(fields.map(f => [f.id, selectorEntry(f)])),
    uploads: Object.fromEntries(uploads.map(u => [u.id, selectorEntry(u, 'file')])),
    actions: Object.fromEntries(actions.map(a => [a.id, selectorEntry(a, 'click')])),
    outputs: Object.fromEntries(outputs.map(o => [o.id, selectorEntry(o, 'output')])),
  });

  return {
    workflowId: obs.workflowId,
    workflowJson,
    manifestSchema: workflowJson.inputSchema,
    workflowPackage,
    replayPlan,
    bindings,
    fieldMap,
    safetyPolicy,
    runPlanMd: buildRunPlanFromObservation({ ...obs, fields: [...fields, ...uploads], actions, capturedOutputs: outputs, humanCheckpoints: checkpoints, safetyPolicy }),
  };
}

export function materializeWorkflowPackageFromObservation({
  observation,
  repoRoot = path.resolve(WORKFLOWS_DIR, '..'),
  overwrite = false,
  packageKind = 'example',
  appId = null,
  appName = null,
  version = '1.0.0',
  autoRegisterApp = false,
} = {}) {
  if (!observation) throw new Error('observation is required');
  const compiled = compileObservationToWorkflowPackage(observation);
  const packageFileName = packageKind === 'local' ? 'workflow-package.local.json' : 'workflow-package.example.json';
  const workflowDir = path.join(repoRoot, 'workflows', compiled.workflowId);
  const plansDir = path.join(repoRoot, 'output', 'plans', compiled.workflowId);
  const observationDir = path.join(repoRoot, 'output', 'observations', compiled.workflowId);

  if (fs.existsSync(workflowDir) && !overwrite) {
    throw new Error(`workflow "${compiled.workflowId}" already exists; pass overwrite=true to update it`);
  }

  ensureDir(workflowDir);
  ensureDir(plansDir);
  ensureDir(observationDir);

  const files = {
    workflowJson: path.join(workflowDir, 'workflow.json'),
    manifestSchema: path.join(workflowDir, 'manifest.schema.json'),
    workflowPackage: path.join(workflowDir, packageFileName),
    replayPlan: path.join(workflowDir, 'replay-plan.json'),
    bindings: path.join(workflowDir, 'bindings.json'),
    fieldMap: path.join(workflowDir, 'field-map.local.json'),
    safetyPolicy: path.join(workflowDir, 'safety-policy.json'),
    runPlan: path.join(plansDir, 'run-plan.md'),
    observation: path.join(observationDir, 'observation.json'),
  };

  writeJson(files.workflowJson, compiled.workflowJson);
  writeJson(files.manifestSchema, compiled.manifestSchema);
  writeJson(files.workflowPackage, compiled.workflowPackage);
  writeJson(files.replayPlan, compiled.replayPlan);
  writeJson(files.bindings, compiled.bindings);
  writeJson(files.fieldMap, compiled.fieldMap);
  writeJson(files.safetyPolicy, compiled.safetyPolicy);
  writeText(files.runPlan, compiled.runPlanMd);
  writeJson(files.observation, parseInput(observation));

  const validation = validateWorkflowPackageDir(workflowDir);
  let importResult = null;
  if (appId) {
    importResult = importWorkflowPackage({
      packagePath: workflowDir,
      appId,
      workflowId: compiled.workflowId,
      version,
      autoRegisterApp,
      appName: appName || appId,
    });
  }

  return {
    ok: validation.ok && (!importResult || importResult.ok),
    workflowId: compiled.workflowId,
    workflowDir,
    packagePath: workflowDir,
    packageFile: files.workflowPackage,
    files,
    relativeFiles: Object.values(files).filter(f => fs.existsSync(f)).map(f => path.relative(repoRoot, f)),
    validation,
    importResult,
    summary: {
      tabs: compiled.workflowJson.tabs.length,
      recordedSteps: compiled.workflowJson.recordedSteps.length,
      bindings: Object.keys(compiled.bindings.variables).length,
      uploads: compiled.workflowJson.fileUploadBindings.length,
      outputs: compiled.workflowJson.expectedOutputs.length,
      checkpoints: compiled.workflowJson.humanApprovalCheckpoints.length,
    },
  };
}

function parseInput(input) {
  if (typeof input === 'string') return JSON.parse(input);
  return input && typeof input === 'object' ? input : {};
}

function collectEvents(raw) {
  const events = [];
  for (const source of [raw.events, raw.sessionEvents, raw.package?.events]) {
    if (Array.isArray(source)) events.push(...source);
  }
  return events.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
}

function inferTabs(obs, raw, events) {
  const tabs = [];
  const add = ({ id, pageId, title, url, siteId, requiresAuth, authCheckUrl, source }) => {
    if (!url) return;
    if (tabs.some(t => t.url === url && (t.pageId || null) === (pageId || null))) return;
    tabs.push(clean({ id: id || pageId || `tab${tabs.length + 1}`, pageId, title: title || `Tab ${tabs.length + 1}`, url, order: tabs.length + 1, siteId, requiresAuth: !!requiresAuth, authCheckUrl, source }));
  };
  for (const tab of asArray(raw.recordingSetup?.tabs)) add({ ...tab, source: 'recording_setup' });
  for (const page of obs.pages || []) add({ id: page.id, title: page.purpose, url: page.urlTemplate || page.url, source: 'observation_page' });
  for (const ev of events || []) if (PAGE_TYPES.has(ev.type)) add({ id: ev.pageId, pageId: ev.pageId, title: ev.pageTitle || ev.rawEvidence?.title, url: ev.pageUrl || ev.rawEvidence?.url, source: ev.type });
  return tabs.length ? tabs : [{ id: 'tab1', title: 'Observed tab', url: raw.startUrl || 'about:blank', order: 1, source: 'fallback' }];
}

function inferFields(obs, events) {
  const fields = [];
  for (const f of obs.fields || []) if (f.inputType !== 'file' && f.scope !== 'asset') fields.push(role(f, 'field'));
  for (const ev of events || []) {
    if (!FIELD_TYPES.has(ev.type)) continue;
    const raw = ev.rawEvidence || {};
    fields.push(role({ id: raw.name || raw.id || raw.label || ev.selector, label: raw.label || raw.name || ev.selector, inputType: raw.inputType || raw.targetTag || 'text', selectorHint: ev.selector || firstSelector(raw), selectorCandidates: raw.selectorCandidates, selectorConfidence: raw.selectorConfidence, exampleValue: raw.textPreview || raw.value, tabId: ev.pageId, sourceEventId: ev.id }, 'field'));
  }
  return dedupe(fields);
}

function inferUploads(obs, events) {
  const uploads = [];
  for (const f of obs.fields || []) if (f.inputType === 'file' || f.scope === 'asset') uploads.push(role(f, 'asset'));
  for (const ev of events || []) {
    if (!UPLOAD_TYPES.has(ev.type)) continue;
    const raw = ev.rawEvidence || {};
    uploads.push(role({ id: raw.name || raw.id || raw.label || ev.selector, label: raw.label || raw.targetLabel || 'Uploaded file', inputType: 'file', scope: 'asset', selectorHint: ev.selector || firstSelector(raw), selectorCandidates: raw.selectorCandidates, selectorConfidence: raw.selectorConfidence, exampleValue: raw.files?.[0]?.name ? `./examples/${raw.files[0].name}` : undefined, tabId: ev.pageId, sourceEventId: ev.id, accept: raw.accept, multiple: raw.multiple }, 'asset'));
  }
  return dedupe(uploads);
}

function inferActions(obs, events) {
  const actions = [];
  for (const a of obs.actions || []) actions.push(action(a));
  for (const ev of events || []) {
    if (!ACTION_TYPES.has(ev.type)) continue;
    const raw = ev.rawEvidence || {};
    actions.push(action({ id: raw.name || raw.id || raw.label || ev.selector, label: raw.label || raw.text || ev.selector, selectorHint: ev.selector || firstSelector(raw), selectorCandidates: raw.selectorCandidates, selectorConfidence: raw.selectorConfidence, manualOnly: ev.type !== 'action_detected', dangerous: ev.type !== 'action_detected', tabId: ev.pageId, sourceEventId: ev.id }));
  }
  return dedupe(actions);
}

function inferCheckpoints(obs, actions, events) {
  const cps = asArray(obs.humanCheckpoints).map(c => checkpoint(c));
  for (const a of actions || []) if (a.manualOnly || a.dangerous || DANGEROUS.test(a.label || '')) cps.push(checkpoint({ id: `${a.id}Approval`, label: `Review before ${a.label || a.id}`, beforeAction: a.id, reason: a.safetyCategory || 'manual approval required', sourceEventId: a.sourceEventId }));
  for (const ev of events || []) if (ev.type === 'user_marked_dangerous_action') cps.push(checkpoint({ id: `${ev.id}Approval`, label: 'User-marked dangerous action', reason: 'user marked dangerous action', sourceEventId: ev.id }));
  return dedupe(cps);
}

function inferOutputs(obs, events) {
  const outs = asArray(obs.capturedOutputs).map(o => output(o));
  for (const ev of events || []) {
    if (!OUTPUT_TYPES.has(ev.type)) continue;
    const raw = ev.rawEvidence || {};
    outs.push(output({ id: raw.outputId || raw.label || ev.selector, label: raw.label || raw.outputId || 'Captured output', selector: ev.selector || firstSelector(raw), selectorCandidates: raw.selectorCandidates, selectorConfidence: raw.selectorConfidence, example: raw.text || raw.textPreview, captureAfter: raw.triggeredBySelector, tabId: ev.pageId, sourceEventId: ev.id }));
  }
  return dedupe(outs);
}

function inferArtifactRules(events) {
  return events.filter(ev => DOWNLOAD_TYPES.has(ev.type)).map((ev, i) => clean({ id: safe(ev.rawEvidence?.suggestedFilename || ev.id || `artifact${i + 1}`), kind: ev.type, pageId: ev.pageId, sourceEventId: ev.id, suggestedFilename: ev.rawEvidence?.suggestedFilename, savedPath: ev.rawEvidence?.savedPath, url: ev.rawEvidence?.url, error: ev.rawEvidence?.error }));
}

function buildSteps({ tabs, fields, uploads, actions, checkpoints, outputs, artifactRules }) {
  const steps = [];
  let order = 0;
  const tabId = tabs[0]?.id || 'tab1';
  for (const t of tabs) steps.push(clean({ id: `navigate_${safe(t.id)}`, type: 'navigate', order: ++order, tabId: t.id, url: t.url, waitUntil: 'domcontentloaded', retry: { attempts: 2, backoffMs: 500 } }));
  for (const f of fields) steps.push(clean({ id: `fill_${f.id}`, type: f.inputType === 'select' ? 'select' : 'fill', order: ++order, tabId: f.tabId || tabId, selector: f.selector, fallbackSelectors: f.fallbackSelectors, selectorConfidence: f.selectorConfidence, binding: f.id, value: `{{inputs.${f.id}}}`, required: f.required !== false, sourceEventId: f.sourceEventId }));
  for (const u of uploads) steps.push(clean({ id: `upload_${u.id}`, type: 'uploadFile', order: ++order, tabId: u.tabId || tabId, selector: u.selector, fallbackSelectors: u.fallbackSelectors, selectorConfidence: u.selectorConfidence, binding: u.id, file: `{{files.${u.id}}}`, required: u.required !== false, sourceEventId: u.sourceEventId }));
  for (const a of actions) {
    const cp = checkpoints.find(c => c.beforeAction === a.id);
    if (cp) steps.push(clean({ id: `approve_${cp.id}`, type: 'approve', order: ++order, checkpointId: cp.id, beforeAction: a.id, reason: cp.reason }));
    steps.push(clean({ id: `click_${a.id}`, type: 'click', order: ++order, tabId: a.tabId || tabId, selector: a.selector, fallbackSelectors: a.fallbackSelectors, selectorConfidence: a.selectorConfidence, label: a.label, requiresApproval: !!cp || a.manualOnly || a.dangerous, safetyCategory: a.safetyCategory, sourceEventId: a.sourceEventId }));
  }
  for (const o of outputs) steps.push(clean({ id: `extract_${o.id}`, type: o.attribute ? 'extractAttribute' : 'extractText', order: ++order, tabId: o.tabId || tabId, selector: o.selector, fallbackSelectors: o.fallbackSelectors, selectorConfidence: o.selectorConfidence, output: o.id, attribute: o.attribute, storesTo: o.storesTo, required: o.required !== false, captureAfter: o.captureAfter, sourceEventId: o.sourceEventId }));
  for (const r of artifactRules) steps.push(clean({ id: `artifact_${r.id}`, type: r.kind === 'download_failed' ? 'assert' : 'download', order: ++order, tabId: r.pageId || tabId, artifactId: r.id, suggestedFilename: r.suggestedFilename, sourceEventId: r.sourceEventId }));
  return steps;
}

function buildBindings(fields, uploads, outputs) {
  return {
    variables: Object.fromEntries(fields.map(f => [f.id, clean({ source: `payload.${f.id}`, selector: f.selector, selectorCandidates: f.selectorCandidates, required: f.required !== false })])),
    files: Object.fromEntries(uploads.map(u => [u.id, clean({ source: `payload.${u.id}`, selector: u.selector, selectorCandidates: u.selectorCandidates, required: u.required !== false })])),
    outputs: Object.fromEntries(outputs.map(o => [o.id, clean({ selector: o.selector, source: o.source, attribute: o.attribute, required: o.required !== false, storesTo: o.storesTo })])),
  };
}

function buildManifestSchema(fields, uploads) {
  const properties = {};
  const required = [];
  for (const item of [...fields, ...uploads]) {
    properties[item.id] = { type: item.kind === 'asset' || item.inputType === 'file' ? 'string' : item.inputType === 'checkbox' ? 'boolean' : 'string', title: item.label };
    if (item.required !== false) required.push(item.id);
  }
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: true, required: [...new Set(required)], properties };
}

function buildOutputSchema(outputs) {
  return { type: 'object', properties: Object.fromEntries(outputs.map(o => [o.id, { type: 'string', description: o.label || o.id }])) };
}

function buildReplaySettings(raw) {
  return { ...(raw.replaySettings || {}), defaultMode: 'dry_run', stopBeforeFinalAction: true, requireVerifiedSelectorsForLive: true, retry: { attempts: 2, backoffMs: 500 }, timing: { afterNavigationMs: 500, afterActionMs: 250 } };
}

function buildSafetyPolicy(raw, actions, checkpoints) {
  const policy = raw.safetyPolicy || {};
  const neverClickText = new Set(policy.never_click_text || []);
  const neverClickSelectors = new Set(policy.never_click_selectors || []);
  for (const a of actions) if (a.manualOnly || a.dangerous) { if (a.label) neverClickText.add(a.label); if (a.selector) neverClickSelectors.add(a.selector); }
  return { ...policy, requiresLiveApproval: policy.requiresLiveApproval !== false, dry_run_default: true, pause_at_end_default: true, never_click_text: [...neverClickText], never_click_selectors: [...neverClickSelectors], manual_only_categories: [...new Set([...(policy.manual_only_categories || []), 'final submission', 'payment', 'legal certification', 'destructive action'])], checkpoints: checkpoints.map(c => c.id) };
}

function inferAuth(raw, tabs) {
  return asArray(raw.recordingSetup?.tabs).filter(t => t.requiresAuth || t.siteId).map(t => clean({ tabId: tabs.find(tab => tab.url === t.url)?.id, siteId: t.siteId || safe(t.title || t.url || 'site'), siteName: t.title || t.siteId, url: t.url, authCheckUrl: t.authCheckUrl || t.url, mode: t.requiresAuth ? 'human_required_if_not_authenticated' : 'optional' }));
}

function buildNavigationGraph(tabs, events) {
  const nodes = tabs.map(t => clean({ id: t.id, url: t.url, title: t.title, pageId: t.pageId }));
  const edges = [];
  let prev = null;
  for (const ev of events || []) {
    if (!PAGE_TYPES.has(ev.type)) continue;
    const current = tabs.find(t => t.pageId === ev.pageId || t.url === ev.pageUrl)?.id || ev.pageId;
    if (prev && current && prev !== current) edges.push({ from: prev, to: current, event: ev.type, eventId: ev.id });
    if (current) prev = current;
  }
  return { nodes, edges };
}

function role(input, kind) {
  const id = safe(toCamel(input.id || input.name || input.label || input.field || input.selectorHint || input.selector || kind));
  const selectorCandidates = asArray(input.selectorCandidates);
  const selector = input.selector || input.selectorHint || firstSelector(input);
  return clean({ id, label: input.label || input.name || human(id), kind, inputType: normType(input.inputType || input.type || input.kind), scope: kind === 'asset' ? 'asset' : input.scope || 'global', selector, fallbackSelectors: selectorCandidates.map(c => c.selector).filter(s => s && s !== selector).slice(0, 4), selectorCandidates, selectorConfidence: input.selectorConfidence || selectorCandidates[0]?.confidence || (selector ? 'medium' : 'low'), exampleValue: input.exampleValue ?? input.example ?? input.value, required: input.required !== false, tabId: input.tabId || input.pageId, sourceEventId: input.sourceEventId, accept: input.accept, multiple: !!input.multiple });
}

function action(input) {
  const out = role(input, 'action');
  out.type = 'click';
  out.manualOnly = input.manualOnly === true || input.manual === true || input.dangerous === true || DANGEROUS.test(out.label || '');
  out.dangerous = input.dangerous === true || out.manualOnly;
  out.safetyCategory = input.safetyCategory || input.safety_category || (out.manualOnly ? 'manual-only' : null);
  return clean(out);
}

function output(input) {
  const out = role(input, 'output');
  out.source = input.source || 'captured_from_page';
  out.attribute = input.attribute || null;
  out.example = input.example || input.exampleValue || null;
  out.captureAfter = input.captureAfter || input.afterAction || null;
  out.storesTo = input.storesTo || `captured.${out.id}`;
  return clean(out);
}

function checkpoint(input) {
  if (typeof input === 'string') return { id: safe(toCamel(input)), label: input };
  return clean({ id: safe(toCamel(input.id || input.name || input.label || 'checkpoint')), label: input.label || input.name || human(input.id || 'checkpoint'), beforeAction: input.beforeAction || input.actionId, reason: input.reason || input.notes, sourceEventId: input.sourceEventId });
}

function selectorEntry(item, type = item.inputType || 'text') {
  return clean({ selector: item.selector, fallbackSelectors: item.fallbackSelectors, type, source: item.id, required: item.required !== false, selectorConfidence: item.selectorConfidence, sourceEventId: item.sourceEventId });
}

function firstSelector(input = {}) { return asArray(input.selectorCandidates || input.rawEvidence?.selectorCandidates)[0]?.selector || null; }
function asArray(v) { return Array.isArray(v) ? v : v ? [v] : []; }
function dedupe(items) { const map = new Map(); for (const item of items) if (item?.id) map.set(item.id, { ...(map.get(item.id) || {}), ...item }); return [...map.values()]; }
function normType(t = 'text') { const x = String(t || 'text').toLowerCase(); if (x.includes('file') || x.includes('upload') || x === 'asset') return 'file'; if (x.includes('select')) return 'select'; if (x.includes('checkbox')) return 'checkbox'; return x || 'text'; }
function exampleFor(item) { if (item.kind === 'asset' || item.inputType === 'file') return `./examples/${item.id}`; if (/date/i.test(item.id)) return '2099-01-01'; return `Example ${item.label || item.id}`; }
function toCamel(v = '') { const parts = String(v || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean); return parts.map((p, i) => { const l = p.toLowerCase(); return i ? l[0].toUpperCase() + l.slice(1) : l; }).join('') || 'field'; }
function safe(v = '') { return String(v || '').trim().replace(/[^a-zA-Z0-9_\-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'; }
function human(v = '') { return String(v || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, c => c.toUpperCase()); }
function clean(obj) { if (Array.isArray(obj)) return obj.map(clean); if (!obj || typeof obj !== 'object') return obj; const out = {}; for (const [k, v] of Object.entries(obj)) { if (v === undefined || v === null || v === '') continue; if (Array.isArray(v) && v.length === 0) continue; out[k] = clean(v); } return out; }
