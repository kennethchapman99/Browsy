import fs from 'fs';
import { join } from 'path';
import { REGISTRY_DIR, ensureDir, exists, readJson, writeJson } from '../core/paths.mjs';
import { getApp } from './app-registry.mjs';

const WORKFLOWS_DIR = join(REGISTRY_DIR, 'workflows');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function workflowPath(workflowObjectId) {
  return join(WORKFLOWS_DIR, workflowObjectId + '.json');
}

function parseObjectId(workflowObjectId) {
  const dot = workflowObjectId.indexOf('.');
  if (dot < 1) throw new Error(`workflowObjectId must be "appId.workflowId", got "${workflowObjectId}"`);
  return { appId: workflowObjectId.slice(0, dot), workflowId: workflowObjectId.slice(dot + 1) };
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function latestActiveVersion(versions) {
  const active = Object.values(versions)
    .filter(v => v.status === 'active')
    .sort((a, b) => compareVersions(b.version, a.version));
  return active[0]?.version || null;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWorkflow({
  appId,
  workflowId,
  name = null,
  description = '',
  version = '1.0.0',
  inputSchema = {},
  outputSchema = {},
  requiredFiles = [],
  requiredAssets = [],
  requiredSessionProfile = null,
  supportedModes = ['preview', 'live', 'dry_run'],
  safetyPolicy = {},
  artifactPolicy = {},
  successAssertions = [],
  failureAssertions = [],
  packagePath = null,
  packageWorkflowId = null,
  tabs = [],
  auth = [],
  humanApprovalCheckpoints = [],
  recordedSteps = [],
  variableBindings = {},
  fileUploadBindings = [],
  expectedOutputs = [],
  validationRules = [],
  replaySettings = {},
}) {
  if (!appId || typeof appId !== 'string') throw new Error('appId is required');
  if (!workflowId || typeof workflowId !== 'string') throw new Error('workflowId is required');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must be semver (e.g. "1.0.0"), got "${version}"`);

  const app = getApp(appId);
  if (!app) throw new Error(`app "${appId}" is not registered. Call registerApp first.`);

  const workflowObjectId = `${appId}.${workflowId}`;
  ensureDir(WORKFLOWS_DIR);
  const filePath = workflowPath(workflowObjectId);
  const now = new Date().toISOString();

  let record = exists(filePath) ? readJson(filePath) : {
    appId,
    workflowId,
    workflowObjectId,
    registeredAt: now,
    versions: {},
    latestVersion: null,
  };

  if (record.versions[version]) {
    // Re-registering same version: freeze it so we can replace with a fresh active copy.
    const existing = record.versions[version];
    if (existing.status === 'active') {
      existing.status = 'frozen';
      existing.frozenAt = now;
    }
  } else {
    // New version: freeze all currently active versions (versions are immutable once active).
    for (const vRecord of Object.values(record.versions)) {
      if (vRecord.status === 'active') {
        vRecord.status = 'frozen';
        vRecord.frozenAt = now;
      }
    }
  }

  record.versions[version] = {
    version,
    status: 'active',
    name: name || workflowId,
    description,
    inputSchema: objectOrEmpty(inputSchema),
    outputSchema: objectOrEmpty(outputSchema),
    requiredFiles: arrayOrEmpty(requiredFiles),
    requiredAssets: arrayOrEmpty(requiredAssets),
    requiredSessionProfile,
    supportedModes: arrayOrEmpty(supportedModes).length ? arrayOrEmpty(supportedModes) : ['preview', 'live', 'dry_run'],
    safetyPolicy: objectOrEmpty(safetyPolicy),
    artifactPolicy: objectOrEmpty(artifactPolicy),
    successAssertions: arrayOrEmpty(successAssertions),
    failureAssertions: arrayOrEmpty(failureAssertions),
    packagePath: packagePath || null,
    packageWorkflowId: packageWorkflowId || null,
    tabs: arrayOrEmpty(tabs),
    auth: arrayOrEmpty(auth),
    humanApprovalCheckpoints: arrayOrEmpty(humanApprovalCheckpoints),
    recordedSteps: arrayOrEmpty(recordedSteps),
    variableBindings: objectOrEmpty(variableBindings),
    fileUploadBindings: arrayOrEmpty(fileUploadBindings),
    expectedOutputs: arrayOrEmpty(expectedOutputs),
    validationRules: arrayOrEmpty(validationRules),
    replaySettings: objectOrEmpty(replaySettings),
    registeredAt: record.versions[version]?.registeredAt || now,
    updatedAt: now,
    frozenAt: null,
  };

  record.latestVersion = latestActiveVersion(record.versions);
  record.updatedAt = now;

  writeJson(filePath, record);
  return { ...record, currentVersion: record.versions[version] };
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export function getWorkflow(workflowObjectId) {
  const filePath = workflowPath(workflowObjectId);
  return exists(filePath) ? readJson(filePath) : null;
}

// Resolve a specific version or latest active.
// Throws if workflow or version doesn't exist or is not active.
export function getWorkflowVersion(workflowObjectId, version = null) {
  const record = getWorkflow(workflowObjectId);
  if (!record) return null;

  const resolvedVersion = version || record.latestVersion;
  if (!resolvedVersion) return null;

  const wv = record.versions[resolvedVersion];
  if (!wv) return null;
  return { ...wv, appId: record.appId, workflowId: record.workflowId, workflowObjectId };
}

export function listWorkflows(appIdFilter = null) {
  ensureDir(WORKFLOWS_DIR);
  return fs.readdirSync(WORKFLOWS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => readJson(join(WORKFLOWS_DIR, f)))
    .filter(r => !appIdFilter || r.appId === appIdFilter)
    .sort((a, b) => a.workflowObjectId.localeCompare(b.workflowObjectId));
}

// Parse "appId.workflowId@version" or "appId.workflowId" into { workflowObjectId, version }.
export function parseWorkflowRef(ref) {
  const atIdx = ref.lastIndexOf('@');
  if (atIdx >= 0) {
    return {
      workflowObjectId: ref.slice(0, atIdx),
      version: ref.slice(atIdx + 1) || null,
    };
  }
  return { workflowObjectId: ref, version: null };
}
