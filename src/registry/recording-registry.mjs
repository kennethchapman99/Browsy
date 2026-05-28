import fs from 'fs';
import path from 'path';
import { OUTPUT_DIR, ensureDir, exists, readJson, writeJson } from '../core/paths.mjs';
import { materializeWorkflowPackageFromObservation } from '../core/observation-materializer.mjs';
import { getWorkflowVersion } from './workflow-registry.mjs';
import { buildWorkflowContract } from './run-result.mjs';

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
    workflowId: normalized.workflowId,
    workflowName: normalized.workflowName,
    callbackUrl: normalized.callbackUrl,
    recordingSetup: normalized.recordingSetup,
    payloadSchema: normalized.payloadSchema,
    fileBindings: normalized.fileBindings,
    expectedOutputs: normalized.expectedOutputs,
    humanCheckpoints: normalized.humanCheckpoints,
    auth: normalized.auth,
    wizardUrl: `${baseUrl.replace(/\/$/, '')}/recordings/${recordingSessionId}`,
    recorderUrl: normalized.recorderUrl || `http://localhost:3333/?recordingSessionId=${encodeURIComponent(recordingSessionId)}`,
    workflowRefPreview: `${normalized.appId}.${normalized.workflowId}`,
    events: [],
    observation: null,
    materialized: null,
    imported: null,
    launch: null,
  };

  persistSession(session);
  return publicSession(session);
}

export function beginRecordingSession(recordingSessionId, input = {}) {
  const session = mustReadSession(recordingSessionId);
  const now = new Date().toISOString();
  const launch = {
    createdAt: now,
    mode: input.mode || 'manual_playwright_recorder',
    recorderUrl: input.recorderUrl || session.recorderUrl || `http://localhost:3333/?recordingSessionId=${encodeURIComponent(recordingSessionId)}`,
    tabs: session.recordingSetup?.tabs || [],
    auth: session.auth || [],
    instructions: [
      'Open recorderUrl in the Browsy wizard/recorder.',
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
  const observation = input.observation || session.observation || buildObservationFromSession(session, events || []);
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

export function importRecordingSession(recordingSessionId, input = {}, { baseUrl = 'http://localhost:3001' } = {}) {
  const session = mustReadSession(recordingSessionId);
  const observation = input.observation || session.observation || buildObservationFromSession(session, input.events || session.events || []);
  const materialized = materializeWorkflowPackageFromObservation({
    observation,
    overwrite: input.overwrite === true,
    packageKind: input.packageKind || 'example',
    appId: input.appId || session.appId,
    appName: input.appName || session.appName || session.appId,
    version: input.version || '1.0.0',
    autoRegisterApp: input.autoRegisterApp !== false,
  });

  const workflowObjectId = `${input.appId || session.appId}.${observation.workflowId}`;
  const version = input.version || '1.0.0';
  const wv = getWorkflowVersion(workflowObjectId, version);
  const contract = wv ? buildWorkflowContract(wv, { baseUrl }) : null;
  const now = new Date().toISOString();
  const updated = {
    ...session,
    status: materialized.ok ? 'imported' : 'import_failed',
    updatedAt: now,
    importedAt: materialized.ok ? now : null,
    observation,
    materialized,
    imported: materialized.importResult || null,
    workflowRef: materialized.importResult?.workflowRef || (contract ? contract.workflowRef : null),
    contract,
  };
  persistSession(updated);
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
  return fs.readdirSync(RECORDINGS_DIR)
    .filter(name => name.startsWith('rec_'))
    .map(name => readSession(name))
    .filter(Boolean)
    .map(publicSession)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function normalizeRecordingRequest(input = {}) {
  const errors = [];
  const appId = safeId(input.appId || '');
  const workflowId = safeId(input.workflowId || '');
  if (!ID_RE.test(appId)) errors.push('appId is required and must match /^[a-z0-9][a-z0-9-_]{0,63}$/');
  if (!ID_RE.test(workflowId)) errors.push('workflowId is required and must match /^[a-z0-9][a-z0-9-_]{0,63}$/');

  const recordingSetup = normalizeRecordingSetup(input.recordingSetup || {});
  if (!recordingSetup.tabs.length) errors.push('recordingSetup.tabs must include at least one tab');

  const payloadSchema = input.payloadSchema && typeof input.payloadSchema === 'object'
    ? input.payloadSchema
    : { type: 'object', additionalProperties: true, properties: {}, required: [] };

  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.errors = errors;
    throw err;
  }

  return {
    appId,
    appName: input.appName || appId,
    workflowId,
    workflowName: input.workflowName || input.name || workflowId,
    callbackUrl: input.callbackUrl || null,
    recorderUrl: input.recorderUrl || null,
    recordingSetup,
    payloadSchema,
    fileBindings: asArray(input.fileBindings).map(normalizeBinding),
    expectedOutputs: asArray(input.expectedOutputs).map(normalizeOutput),
    humanCheckpoints: asArray(input.humanCheckpoints).map(normalizeCheckpoint),
    auth: buildAuthRequirements(recordingSetup),
  };
}

function normalizeRecordingSetup(setup = {}) {
  return {
    ...setup,
    tabs: asArray(setup.tabs).map((tab, index) => ({
      id: camelId(tab.id || `tab-${index + 1}`),
      title: tab.title || tab.name || `Tab ${index + 1}`,
      url: tab.url || tab.startUrl || '',
      siteId: tab.siteId ? safeId(tab.siteId) : null,
      requiresAuth: tab.requiresAuth === true,
      authCheckUrl: tab.authCheckUrl || tab.url || null,
      role: tab.role || null,
    })).filter(tab => tab.url),
  };
}

function normalizeBinding(binding = {}) {
  const id = camelId(binding.id || binding.role || binding.label || 'file');
  return {
    id,
    label: binding.label || binding.id || binding.role || 'File',
    source: binding.source || `payload.${id}`,
    required: binding.required !== false,
  };
}

function normalizeOutput(output = {}) {
  return {
    id: camelId(output.id || output.name || output.label || 'output'),
    label: output.label || output.name || output.id || 'Output',
    required: output.required !== false,
    selector: output.selector || null,
    source: output.source || 'captured_from_page',
  };
}

function normalizeCheckpoint(checkpoint = {}) {
  if (typeof checkpoint === 'string') return { id: camelId(checkpoint), label: checkpoint };
  return {
    id: camelId(checkpoint.id || checkpoint.name || checkpoint.label || 'checkpoint'),
    label: checkpoint.label || checkpoint.name || checkpoint.id || 'Checkpoint',
    beforeAction: checkpoint.beforeAction || checkpoint.actionId || null,
    reason: checkpoint.reason || checkpoint.notes || null,
  };
}

function buildAuthRequirements(recordingSetup) {
  return recordingSetup.tabs
    .filter(tab => tab.requiresAuth || tab.siteId)
    .map(tab => ({
      tabId: tab.id,
      siteId: tab.siteId || safeId(tab.title || tab.id),
      url: tab.url,
      authCheckUrl: tab.authCheckUrl || tab.url,
      mode: tab.requiresAuth ? 'human_required_if_not_authenticated' : 'optional',
    }));
}

function buildObservationFromSession(session, events = []) {
  const tabs = asArray(session.recordingSetup?.tabs);
  const fields = [];
  for (const [name, prop] of Object.entries(session.payloadSchema?.properties || {})) {
    fields.push({ id: name, label: prop.title || prop.description || name, inputType: prop.type === 'boolean' ? 'checkbox' : 'text', required: asArray(session.payloadSchema?.required).includes(name) });
  }
  for (const binding of session.fileBindings || []) {
    fields.push({ id: binding.id, label: binding.label, inputType: 'file', scope: 'asset', source: binding.source, required: binding.required !== false });
  }
  return {
    schemaVersion: 'browsy.observation.v1',
    workflowId: session.workflowId,
    title: session.workflowName || session.workflowId,
    goal: `Recorded workflow for app ${session.appId}`,
    recordingSetup: session.recordingSetup,
    pages: tabs.map(tab => ({ id: tab.id, purpose: tab.title, url: tab.url })),
    fields,
    capturedOutputs: session.expectedOutputs || [],
    humanCheckpoints: session.humanCheckpoints || [],
    sessionEvents: events,
  };
}

function publicSession(session) {
  return {
    recordingSessionId: session.recordingSessionId,
    status: session.status,
    appId: session.appId,
    appName: session.appName,
    workflowId: session.workflowId,
    workflowName: session.workflowName,
    workflowRefPreview: session.workflowRefPreview,
    workflowRef: session.workflowRef || null,
    wizardUrl: session.wizardUrl,
    recorderUrl: session.recorderUrl,
    callbackUrl: session.callbackUrl,
    recordingSetup: session.recordingSetup,
    payloadSchema: session.payloadSchema,
    fileBindings: session.fileBindings,
    expectedOutputs: session.expectedOutputs,
    humanCheckpoints: session.humanCheckpoints,
    auth: session.auth,
    launch: session.launch || null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    startedAt: session.startedAt || null,
    stoppedAt: session.stoppedAt,
    importedAt: session.importedAt,
    materializedSummary: session.materialized?.summary || null,
  };
}

function persistSession(session) {
  const dir = recordingDir(session.recordingSessionId);
  ensureDir(dir);
  writeJson(path.join(dir, 'session.json'), session);
  writeJson(path.join(dir, 'setup.json'), {
    appId: session.appId,
    appName: session.appName,
    workflowId: session.workflowId,
    workflowName: session.workflowName,
    callbackUrl: session.callbackUrl,
    recorderUrl: session.recorderUrl,
    recordingSetup: session.recordingSetup,
    payloadSchema: session.payloadSchema,
    fileBindings: session.fileBindings,
    expectedOutputs: session.expectedOutputs,
    humanCheckpoints: session.humanCheckpoints,
    auth: session.auth,
  });
}

function readSession(recordingSessionId) {
  const p = path.join(recordingDir(recordingSessionId), 'session.json');
  return exists(p) ? readJson(p) : null;
}

function mustReadSession(recordingSessionId) {
  const session = readSession(recordingSessionId);
  if (!session) throw new Error(`recording session not found: ${recordingSessionId}`);
  return session;
}

function recordingDir(recordingSessionId) {
  return path.join(RECORDINGS_DIR, safePathSegment(recordingSessionId));
}

function safePathSegment(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'recording';
}

function safeId(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}

function camelId(value = '') {
  const parts = String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return parts.map((part, index) => {
    const cleaned = part.replace(/[^a-zA-Z0-9]/g, '');
    if (!cleaned) return '';
    if (index === 0) return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }).join('') || 'item';
}

function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}
