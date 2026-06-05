import fs from 'fs';
import path from 'path';
import { OUTPUT_DIR, ensureDir, exists, readJson, writeJson } from '../core/paths.mjs';
import { materializeWorkflowPackageFromObservation } from '../core/observation-materializer.mjs';
import { availableRuntimeVars, extractTemplateVars, flattenRuntimeVars, hasTemplateVars, normalizeReleasePayload, releaseIdFromPayload, tryResolveTemplate, unresolvedTemplateVars } from '../core/runtime-vars.mjs';
import { getWorkflowVersion } from './workflow-registry.mjs';
import { buildWorkflowContract } from './run-result.mjs';
import { upsertSitePresetsFromRecordingSetup } from './site-preset-registry.mjs';

export const RECORDINGS_DIR = path.join(OUTPUT_DIR, 'recordings');

const ID_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;

export function startRecordingSession(input = {}, { baseUrl = 'http://localhost:3001' } = {}) {
  const normalized = normalizeRecordingRequest(input);
  const now = new Date().toISOString();
  const recordingSessionId = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = recordingDir(recordingSessionId);
  ensureDir(dir);

  const session = {
    schemaVersion: 'browsy.recording-session.v1',
    recordingSessionId,
    status: 'setup_ready',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    stoppedAt: null,
    importedAt: null,
    appId: normalized.appId,
    appName: normalized.appName,
    sourceApp: normalized.sourceApp,
    workflowRef: normalized.workflowRef,
    workflowId: normalized.workflowId,
    workflowName: normalized.workflowName,
    targetUrl: normalized.targetUrl,
    releaseId: normalized.releaseId,
    packageId: normalized.packageId,
    callbackUrl: normalized.callbackUrl,
    recordingSetup: normalized.recordingSetup,
    inputSchema: normalized.inputSchema,
    payloadSchema: normalized.payloadSchema,
    requiredAssets: normalized.requiredAssets,
    samplePayload: normalized.samplePayload,
    derivedVariables: normalized.derivedVariables,
    bindingHints: normalized.bindingHints,
    fileBindings: normalized.fileBindings,
    expectedOutputs: normalized.expectedOutputs,
    humanCheckpoints: normalized.humanCheckpoints,
    fieldContractIntent: normalized.fieldContractIntent,
    completionPolicy: normalized.completionPolicy,
    writebackTargets: normalized.writebackTargets,
    auth: normalized.auth,
    wizardUrl: `${baseUrl.replace(/\/$/, '')}/recordings/${recordingSessionId}`,
    recorderUrl: normalized.recorderUrl || null,
    workflowRefPreview: `${normalized.appId}.${normalized.workflowId}`,
    events: [],
    observation: null,
    materialized: null,
    imported: null,
    launch: null,
  };

  persistSession(session);
  persistSitePresets(session);
  console.log('[browsy:recording-session] created', {
    recordingSessionId,
    appId: normalized.appId,
    workflowId: normalized.workflowId,
    releaseId: normalized.releaseId,
    callbackUrl: normalized.callbackUrl,
    variableResolution: {
      availableVariables: availableRuntimeVars(flattenRuntimeVars(normalized.samplePayload || {})),
      tabUrls: normalized.recordingSetup.tabs.map(tab => ({ id: tab.id, urlTemplate: tab.urlTemplate || null, resolvedUrl: tab.url })),
    },
    savePath: dir,
  });
  return publicSession(session);
}

export function updateRecordingSessionSetup(recordingSessionId, input = {}) {
  const session = mustReadSession(recordingSessionId);
  if (session.status === 'recording') throw new Error('cannot edit setup while recording is active');
  if (session.status === 'imported') throw new Error('cannot edit setup after workflow import; create a new recording session');
  const recordingSetup = normalizeRecordingSetup(input.recordingSetup || session.recordingSetup || {}, { vars: flattenRuntimeVars(session.samplePayload) });
  validateUsableTabs(recordingSetup.tabs, { allowUnresolvedTemplates: true });
  const updated = {
    ...session,
    callbackUrl: resolveOptionalTemplate(input.callbackUrl !== undefined ? input.callbackUrl || null : session.callbackUrl, flattenRuntimeVars(session.samplePayload || {}), 'callbackUrl'),
    recordingSetup,
    fieldContractIntent: normalizeText(input.fieldContractIntent ?? input.dataContractIntent ?? session.fieldContractIntent),
    completionPolicy: normalizeCompletionPolicy(input.completionPolicy || session.completionPolicy || {}),
    writebackTargets: asArray(input.writebackTargets !== undefined ? input.writebackTargets : session.writebackTargets).map(normalizeWritebackTarget),
    auth: buildAuthRequirements(recordingSetup),
    updatedAt: new Date().toISOString(),
    launch: null,
  };
  persistSession(updated);
  persistSitePresets(updated);
  return publicSession(updated);
}

export function validateRecordingSessionForLaunch(recordingSessionId) {
  const session = mustReadSession(recordingSessionId);
  validateUsableTabs(session.recordingSetup?.tabs || [], { vars: flattenRuntimeVars(session.samplePayload || {}) });
  validateOptionalTemplate(session.callbackUrl, { vars: flattenRuntimeVars(session.samplePayload || {}), label: 'callbackUrl' });
  return publicSession(session);
}

export function beginRecordingSession(recordingSessionId, input = {}) {
  const session = mustReadSession(recordingSessionId);
  const now = new Date().toISOString();
  const launch = input.launch || {
    createdAt: now,
    mode: input.mode || 'manual_playwright_recorder',
    recorderUrl: input.recorderUrl || session.recorderUrl || null,
    tabs: session.recordingSetup?.tabs || [],
    auth: session.auth || [],
    instructions: [
      'Use this Browsy recording session page to stop/import the recording.',
      'Use the configured tabs as the starting browser state.',
      'Record the workflow once, preserving observed selectors, uploads, outputs, and checkpoints.',
      'Stop/import the recording through this recording session.',
    ],
  };
  const updated = {
    ...session,
    status: 'recording',
    updatedAt: now,
    startedAt: session.startedAt || now,
    launch,
  };
  persistSession(updated);
  return { ...publicSession(updated), launch };
}

export function getRecordingSession(recordingSessionId) {
  const session = readSession(recordingSessionId);
  return session ? publicSession(session) : null;
}

export function stopRecordingSession(recordingSessionId, input = {}) {
  const session = mustReadSession(recordingSessionId);
  const now = new Date().toISOString();
  const events = Array.isArray(input.events) ? input.events : session.events;
  const observation = enrichObservationWithSession(input.observation || session.observation || buildObservationFromSession(session, events || []), session, events || []);
  const updated = {
    ...session,
    status: 'stopped',
    updatedAt: now,
    stoppedAt: now,
    observation,
    events,
  };
  persistSession(updated);
  writeJson(path.join(recordingDir(recordingSessionId), 'observation.json'), observation);
  writeJson(path.join(recordingDir(recordingSessionId), 'events.json'), events || []);
  return publicSession(updated);
}

export function abandonRecordingSession(recordingSessionId, input = {}) {
  const session = mustReadSession(recordingSessionId);
  const now = new Date().toISOString();
  const events = Array.isArray(input.events) ? input.events : session.events;
  const updated = {
    ...session,
    status: 'abandoned',
    updatedAt: now,
    abandonedAt: now,
    abandonReason: normalizeText(input.reason) || 'abandoned by caller',
    events,
  };
  persistSession(updated);
  writeJson(path.join(recordingDir(recordingSessionId), 'events.json'), events || []);
  return publicSession(updated);
}

export function importRecordingSession(recordingSessionId, input = {}, { baseUrl = 'http://localhost:3001' } = {}) {
  const session = mustReadSession(recordingSessionId);
  const observation = enrichObservationWithSession(input.observation || session.observation || buildObservationFromSession(session, input.events || session.events || []), session, input.events || session.events || []);
  const materialized = materializeWorkflowPackageFromObservation({ observation, overwrite: input.overwrite === true, packageKind: input.packageKind || 'example', appId: input.appId || session.appId, appName: input.appName || session.appName || session.appId, version: input.version || '1.0.0', autoRegisterApp: input.autoRegisterApp !== false });
  const workflowObjectId = `${input.appId || session.appId}.${observation.workflowId}`;
  const version = input.version || '1.0.0';
  const wv = getWorkflowVersion(workflowObjectId, version);
  const contract = wv ? buildWorkflowContract(wv, { baseUrl }) : null;
  const now = new Date().toISOString();
  const updated = { ...session, status: materialized.ok ? 'imported' : 'import_failed', updatedAt: now, importedAt: materialized.ok ? now : null, observation, materialized, imported: materialized.importResult || null, workflowRef: materialized.importResult?.workflowRef || (contract ? contract.workflowRef : null), contract };
  persistSession(updated);
  console.log('[browsy:recording-session] imported', {
    recordingSessionId,
    appId: updated.appId,
    workflowId: updated.workflowId,
    status: updated.status,
    workflowRef: updated.workflowRef,
    savePath: materialized.workflowDir || materialized.packagePath || null,
    packageFile: materialized.packageFile || null,
    files: materialized.relativeFiles || [],
  });
  return { ...publicSession(updated), materialized, imported: updated.imported, contract };
}

export function getRecordingContract(recordingSessionId, { baseUrl = 'http://localhost:3001' } = {}) {
  const session = mustReadSession(recordingSessionId);
  if (session.contract) return session.contract;
  const workflowObjectId = `${session.appId}.${session.workflowId}`;
  const wv = getWorkflowVersion(workflowObjectId, null);
  if (!wv) return null;
  return buildWorkflowContract(wv, { baseUrl });
}

export function listRecordingSessions() {
  if (!exists(RECORDINGS_DIR)) return [];
  return fs.readdirSync(RECORDINGS_DIR).filter(name => name.startsWith('rec_')).map(name => readSession(name)).filter(Boolean).map(publicSession).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function persistSitePresets(session) {
  try {
    upsertSitePresetsFromRecordingSetup(session.recordingSetup, { appId: session.appId, workflowId: session.workflowId });
  } catch {}
}

function validateUsableTabs(tabs = [], { allowUnresolvedTemplates = false, vars = {} } = {}) {
  const errors = [];
  const available = availableRuntimeVars(vars);
  if (!tabs.length) errors.push('recordingSetup.tabs must include at least one tab');
  for (const tab of tabs) {
    const url = String(tab.url || '').trim();
    const unresolved = unresolvedTemplateVars(tab.urlTemplate || url, vars);
    if (!url) errors.push(`tab ${tab.id || tab.title || '?'} is missing a URL`);
    else if (/PASTE_|YOUR_|_HERE/i.test(url)) errors.push(`tab ${tab.id || tab.title || '?'} still has placeholder URL: ${url}`);
    else if (url === 'about:blank') errors.push(`tab ${tab.id || tab.title || '?'} cannot use about:blank`);
    else if (!(url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:'))) errors.push(`tab ${tab.id || tab.title || '?'} has invalid URL: ${url}`);
    else if (!allowUnresolvedTemplates && (hasTemplateVars(url) || unresolved.length)) {
      const names = unresolved.length ? unresolved : extractTemplateVars(url);
      errors.push(`tab ${tab.id || tab.title || '?'} has unresolved URL variable(s): ${names.join(', ')}. Available variables: ${available.join(', ') || '(none)'}`);
    }
  }
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.errors = errors;
    throw err;
  }
}

function normalizeRecordingRequest(input = {}) {
  const errors = [];
  const appId = safeId(input.appId || '');
  const workflowId = safeId(input.workflowId || '');
  input = applyRecordingDefaults(input, { appId, workflowId });
  const workflowRef = String(input.workflowRef || `${appId}.${workflowId}`).trim();
  const sourceApp = input.sourceApp || input.appId || appId;
  const targetUrl = String(input.targetUrl || inferTargetUrl(input.recordingSetup) || '').trim();
  if (!ID_RE.test(appId)) errors.push('appId is required and must match /^[a-z0-9][a-z0-9-_]{0,63}$/');
  if (!ID_RE.test(workflowId)) errors.push('workflowId is required and must match /^[a-z0-9][a-z0-9-_]{0,63}$/');
  if (!targetUrl) errors.push('targetUrl is required');
  if (targetUrl === 'about:blank') errors.push('targetUrl cannot be about:blank');
  const samplePayload = input.samplePayload ? normalizeReleasePayload(input.samplePayload, { releaseId: input.releaseId }) : null;
  const releaseId = input.releaseId || releaseIdFromPayload(samplePayload) || null;
  const recordingSetup = normalizeRecordingSetup(input.recordingSetup || {}, { vars: flattenRuntimeVars(samplePayload) });
  if (!recordingSetup.tabs.length) errors.push('recordingSetup.tabs must include at least one tab');
  const inputSchema = input.inputSchema && typeof input.inputSchema === 'object' ? input.inputSchema : input.payloadSchema;
  if (requiresStructuredRecordingContext(input)) {
    validateStructuredRecordingContext({ inputSchema, samplePayload: input.samplePayload, requiredAssets: input.requiredAssets }, errors);
  }
  const payloadSchema = inputSchema && typeof inputSchema === 'object' ? inputSchema : { type: 'object', additionalProperties: true, properties: {}, required: [] };
  if (errors.length) { const err = new Error(errors.join('; ')); err.errors = errors; throw err; }
  const runtimeVars = flattenRuntimeVars(samplePayload || {});
  const callbackUrl = resolveOptionalTemplate(input.callbackUrl || null, runtimeVars, 'callbackUrl');
  return { appId, appName: input.appName || appId, sourceApp, workflowRef, workflowId, workflowName: input.workflowName || input.name || workflowId, targetUrl, releaseId, packageId: input.packageId || null, callbackUrl, recorderUrl: input.recorderUrl || null, recordingSetup, inputSchema: payloadSchema, payloadSchema, requiredAssets: asArray(input.requiredAssets), samplePayload, derivedVariables: input.derivedVariables || {}, bindingHints: withTemplateBindingHints(asArray(input.bindingHints), recordingSetup), fileBindings: asArray(input.fileBindings).map(normalizeBinding), expectedOutputs: asArray(input.expectedOutputs).map(normalizeOutput), humanCheckpoints: asArray(input.humanCheckpoints).map(normalizeCheckpoint), fieldContractIntent: normalizeText(input.fieldContractIntent ?? input.dataContractIntent), completionPolicy: normalizeCompletionPolicy(input.completionPolicy || {}), writebackTargets: asArray(input.writebackTargets).map(normalizeWritebackTarget), auth: buildAuthRequirements(recordingSetup) };
}

function normalizeRecordingSetup(setup = {}, { vars = {} } = {}) {
  return { ...setup, tabs: asArray(setup.tabs).map((tab, index) => {
    const rawUrl = tab.url || tab.startUrl || tab.urlTemplate || '';
    const urlTemplate = tab.urlTemplate || (hasTemplateVars(rawUrl) ? rawUrl : null);
    const resolvedUrl = tryResolveTemplate(rawUrl, vars) || rawUrl;
    const authCheckRaw = tab.authCheckUrl || rawUrl;
    return cleanObject({
      id: camelId(tab.id || `tab-${index + 1}`),
      title: tab.title || tab.name || `Tab ${index + 1}`,
      url: resolvedUrl,
      urlTemplate,
      siteId: tab.siteId ? safeId(tab.siteId) : null,
      requiresAuth: tab.requiresAuth === true,
      authCheckUrl: tryResolveTemplate(authCheckRaw, vars) || authCheckRaw || null,
      authProfileId: tab.authProfileId || setup.authProfileId || setup.authGroupId || setup.ssoProfileId || null,
      role: tab.role || null,
    });
  }).filter(tab => tab.url || tab.title || tab.siteId) };
}

function normalizeBinding(binding = {}) { const id = camelId(binding.id || binding.role || binding.label || 'file'); return { id, label: binding.label || binding.id || binding.role || 'File', source: binding.source || `payload.${id}`, binding: binding.binding || null, required: binding.required !== false }; }
function normalizeOutput(output = {}) { return { id: camelId(output.id || output.name || output.label || 'output'), label: output.label || output.name || output.id || 'Output', required: output.required !== false, selector: output.selector || null, source: output.source || 'captured_from_page' }; }
function normalizeCheckpoint(checkpoint = {}) { if (typeof checkpoint === 'string') return { id: camelId(checkpoint), label: checkpoint }; return { id: camelId(checkpoint.id || checkpoint.name || checkpoint.label || 'checkpoint'), label: checkpoint.label || checkpoint.name || checkpoint.id || 'Checkpoint', beforeAction: checkpoint.beforeAction || checkpoint.actionId || null, reason: checkpoint.reason || checkpoint.notes || null }; }
function normalizeCompletionPolicy(policy = {}) { if (typeof policy === 'string') return { action: policy, notes: '' }; return { action: policy.action || 'wait_for_human_submission', notes: normalizeText(policy.notes), closeBrowser: policy.closeBrowser === true, requireApprovalBeforeSubmit: policy.requireApprovalBeforeSubmit !== false }; }
function normalizeWritebackTarget(target = {}) { if (typeof target === 'string') return { id: camelId(target), source: target, destination: target, required: false }; return { id: camelId(target.id || target.destination || target.source || 'writeback'), source: target.source || target.output || '', destination: target.destination || target.field || '', label: target.label || target.destination || target.source || 'Writeback', required: target.required === true }; }
function buildAuthRequirements(recordingSetup) { return recordingSetup.tabs.filter(tab => tab.requiresAuth || tab.siteId).map(tab => ({ tabId: tab.id, siteId: tab.siteId || safeId(tab.title || tab.id), url: tab.url, authCheckUrl: tab.authCheckUrl || tab.url, authProfileId: tab.authProfileId || recordingSetup.authProfileId || recordingSetup.authGroupId || null, mode: tab.requiresAuth ? 'human_required_if_not_authenticated' : 'optional' })); }
function buildObservationFromSession(session, events = []) { const tabs = asArray(session.recordingSetup?.tabs); return { schemaVersion: 'browsy.observation.v1', workflowId: session.workflowId, title: session.workflowName || session.workflowId, goal: `Recorded workflow for app ${session.appId}`, workflowContext: pickWorkflowContext(session), recordingSetup: session.recordingSetup, pages: tabs.map(tab => ({ id: tab.id, purpose: tab.title, url: tab.url })), fields: [], availableBindings: session.bindingHints || [], requiredAssets: session.requiredAssets || [], capturedOutputs: session.expectedOutputs || [], humanCheckpoints: session.humanCheckpoints || [], completionPolicy: session.completionPolicy || null, writebackTargets: session.writebackTargets || [], fieldContractIntent: session.fieldContractIntent || '', sessionEvents: events }; }
function enrichObservationWithSession(observation = {}, session, events = []) { const base = observation && typeof observation === 'object' ? observation : {}; const tabs = asArray(session.recordingSetup?.tabs); return { ...base, schemaVersion: base.schemaVersion || 'browsy.observation.v1', workflowId: base.workflowId || session.workflowId, title: base.title || session.workflowName || session.workflowId, workflowContext: { ...pickWorkflowContext(session), ...(base.workflowContext || {}) }, recordingSetup: base.recordingSetup || session.recordingSetup, pages: asArray(base.pages).length ? base.pages : tabs.map(tab => ({ id: tab.id, purpose: tab.title, url: tab.url })), availableBindings: asArray(base.availableBindings).length ? base.availableBindings : session.bindingHints || [], requiredAssets: asArray(base.requiredAssets).length ? base.requiredAssets : session.requiredAssets || [], capturedOutputs: asArray(base.capturedOutputs).length ? base.capturedOutputs : session.expectedOutputs || [], humanCheckpoints: asArray(base.humanCheckpoints).length ? base.humanCheckpoints : session.humanCheckpoints || [], completionPolicy: base.completionPolicy || session.completionPolicy || null, writebackTargets: asArray(base.writebackTargets).length ? base.writebackTargets : session.writebackTargets || [], fieldContractIntent: base.fieldContractIntent || session.fieldContractIntent || '', sessionEvents: asArray(base.sessionEvents).length ? base.sessionEvents : events }; }
function publicSession(session) { return { recordingSessionId: session.recordingSessionId, status: session.status, appId: session.appId, appName: session.appName, sourceApp: session.sourceApp || null, workflowId: session.workflowId, workflowName: session.workflowName, workflowRefPreview: session.workflowRefPreview, workflowRef: session.workflowRef || null, targetUrl: session.targetUrl || null, releaseId: session.releaseId || null, packageId: session.packageId || null, wizardUrl: session.wizardUrl, recordAutomationControl: { label: 'Record Automation', href: session.wizardUrl, action: 'open_browsy_new_automation_wizard', recordingSessionId: session.recordingSessionId }, recorderUrl: session.recorderUrl, callbackUrl: session.callbackUrl, recordingSetup: session.recordingSetup, inputSchema: session.inputSchema || session.payloadSchema, payloadSchema: session.payloadSchema, requiredAssets: session.requiredAssets || [], samplePayload: session.samplePayload || null, derivedVariables: session.derivedVariables || {}, bindingHints: session.bindingHints || [], fileBindings: session.fileBindings, expectedOutputs: session.expectedOutputs, humanCheckpoints: session.humanCheckpoints, fieldContractIntent: session.fieldContractIntent || '', completionPolicy: session.completionPolicy || normalizeCompletionPolicy(), writebackTargets: session.writebackTargets || [], auth: session.auth, launch: session.launch || null, createdAt: session.createdAt, updatedAt: session.updatedAt, startedAt: session.startedAt || null, stoppedAt: session.stoppedAt, importedAt: session.importedAt, materializedSummary: session.materialized?.summary || null }; }
function persistSession(session) { const dir = recordingDir(session.recordingSessionId); ensureDir(dir); writeJson(path.join(dir, 'session.json'), session); writeJson(path.join(dir, 'setup.json'), { ...pickWorkflowContext(session), callbackUrl: session.callbackUrl, recorderUrl: session.recorderUrl, recordingSetup: session.recordingSetup, payloadSchema: session.payloadSchema, fileBindings: session.fileBindings, expectedOutputs: session.expectedOutputs, humanCheckpoints: session.humanCheckpoints, fieldContractIntent: session.fieldContractIntent || '', completionPolicy: session.completionPolicy || null, writebackTargets: session.writebackTargets || [], auth: session.auth }); }
function pickWorkflowContext(session) { return { appId: session.appId, appName: session.appName, sourceApp: session.sourceApp || null, workflowRef: session.workflowRef || null, workflowId: session.workflowId, workflowName: session.workflowName, targetUrl: session.targetUrl || null, releaseId: session.releaseId || null, packageId: session.packageId || null, inputSchema: session.inputSchema || session.payloadSchema, sourcePayloadSchema: session.inputSchema || session.payloadSchema, sourceFieldMappings: session.bindingHints || [], tabUrlTemplates: asArray(session.recordingSetup?.tabs).map(t => ({ id: t.id, urlTemplate: t.urlTemplate || t.url, siteId: t.siteId || null, role: t.role || null })), authProfileRef: session.recordingSetup?.authProfileId || session.recordingSetup?.authGroupId || session.recordingSetup?.ssoProfileId || null, requiredAssets: session.requiredAssets || [], samplePayload: session.samplePayload || null, derivedVariables: session.derivedVariables || {}, bindingHints: session.bindingHints || [], fieldContractIntent: session.fieldContractIntent || '', completionPolicy: session.completionPolicy || null, writebackTargets: session.writebackTargets || [] }; }
function inferTargetUrl(recordingSetup = {}) { const tabs = asArray(recordingSetup.tabs); return tabs.find(tab => tab.role === 'target')?.url || tabs.find(tab => tab.requiresAuth)?.url || tabs[tabs.length - 1]?.url || ''; }
function requiresStructuredRecordingContext(input = {}) { return !!(input.samplePayload || asArray(input.requiredAssets).length || asArray(input.bindingHints).length); }
function validateStructuredRecordingContext({ inputSchema, samplePayload, requiredAssets }, errors) { if (!inputSchema || typeof inputSchema !== 'object') errors.push('inputSchema is required for structured recording context'); const album = samplePayload?.album || null; const tracks = Array.isArray(samplePayload?.tracks) ? samplePayload.tracks : null; if (!samplePayload) errors.push('samplePayload is required for structured recording context'); if (album) { if (!album.releaseDate) errors.push('samplePayload.album.releaseDate is required'); if (!album.coverArtPath) errors.push('samplePayload.album.coverArtPath is required'); } if (tracks) { if (!tracks.length) errors.push('samplePayload.tracks must include at least one track'); tracks.forEach((track, index) => { if (!track.audioPath) errors.push(`samplePayload.tracks[${index}].audioPath is required`); }); } if (!asArray(requiredAssets).length) errors.push('requiredAssets are required for structured recording context'); }
function applyRecordingDefaults(input = {}, { appId, workflowId } = {}) { const defaults = readRecordingDefaults(appId, workflowId); return defaults ? mergeDefaults(defaults, input) : input; }
function readRecordingDefaults(appId, workflowId) {
  const roots = [path.resolve(process.cwd(), 'templates', 'source-app-defaults')];
  const names = [`${appId}.${workflowId}.json`, path.join(appId || '', `${workflowId}.json`), path.join(appId || '', 'default.json')].filter(Boolean);
  for (const root of roots) for (const name of names) {
    const file = path.join(root, name);
    if (exists(file)) return readJson(file);
  }
  return null;
}
function mergeDefaults(defaults = {}, input = {}) {
  const merged = { ...defaults, ...input };
  merged.recordingSetup = mergeRecordingSetup(defaults.recordingSetup, input.recordingSetup);
  for (const key of ['requiredAssets', 'bindingHints', 'fileBindings', 'expectedOutputs', 'humanCheckpoints', 'writebackTargets']) {
    merged[key] = asArray(input[key]).length ? input[key] : defaults[key];
  }
  for (const key of ['inputSchema', 'payloadSchema', 'samplePayload', 'derivedVariables', 'fieldContractIntent', 'completionPolicy']) {
    if (input[key] === undefined || input[key] === null || input[key] === '') merged[key] = defaults[key];
  }
  return merged;
}
function mergeRecordingSetup(defaultSetup = {}, inputSetup = {}) {
  const setup = { ...defaultSetup, ...inputSetup };
  setup.tabs = asArray(inputSetup.tabs).length ? inputSetup.tabs : defaultSetup.tabs;
  return setup;
}
function resolveOptionalTemplate(value, vars = {}, label = 'template') {
  if (!value) return null;
  const raw = String(value).trim();
  const resolved = tryResolveTemplate(raw, vars);
  if (resolved) return resolved;
  validateOptionalTemplate(raw, { vars, label });
  return raw;
}
function validateOptionalTemplate(value, { vars = {}, label = 'template' } = {}) {
  if (!value || !hasTemplateVars(value)) return;
  const unresolved = unresolvedTemplateVars(value, vars);
  if (!unresolved.length) return;
  const available = availableRuntimeVars(vars);
  const err = new Error(`${label} has unresolved variable(s): ${unresolved.join(', ')}. Available variables: ${available.join(', ') || '(none)'}`);
  err.errors = [err.message];
  throw err;
}
function withTemplateBindingHints(hints = [], recordingSetup = {}) {
  const seen = new Set(hints.map(h => h.path || h.label || String(h)));
  const result = [...hints];
  for (const tab of asArray(recordingSetup.tabs)) {
    for (const name of extractTemplateVars(tab.urlTemplate || '')) {
      if (!seen.has(name)) { result.push({ path: name, source: 'tab_url_template', tabId: tab.id }); seen.add(name); }
    }
  }
  return result;
}
function cleanObject(obj = {}) { return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== '')); }
function readSession(recordingSessionId) { const p = path.join(recordingDir(recordingSessionId), 'session.json'); return exists(p) ? readJson(p) : null; }
function mustReadSession(recordingSessionId) { const session = readSession(recordingSessionId); if (!session) throw new Error(`recording session not found: ${recordingSessionId}`); return session; }
function recordingDir(recordingSessionId) { return path.join(RECORDINGS_DIR, safePathSegment(recordingSessionId)); }
function safePathSegment(value = '') { return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'recording'; }
function safeId(value = '') { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, ''); }
function camelId(value = '') { const parts = String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean); return parts.map((part, index) => { const cleaned = part.replace(/[^a-zA-Z0-9]/g, ''); if (!cleaned) return ''; if (index === 0) return cleaned.charAt(0).toLowerCase() + cleaned.slice(1); return cleaned.charAt(0).toUpperCase() + cleaned.slice(1); }).join('') || 'item'; }
function normalizeText(value = '') { return String(value || '').trim(); }
function asArray(value) { return Array.isArray(value) ? value : value ? [value] : []; }
