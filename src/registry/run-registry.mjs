import fs from 'fs';
import { join } from 'path';
import { REGISTRY_DIR, ensureDir, exists, readJson, writeJson } from '../core/paths.mjs';
import crypto from 'crypto';

const RUNS_DIR = join(REGISTRY_DIR, 'runs');

function runDir(runId) {
  return join(RUNS_DIR, runId);
}
function runFilePath(runId) {
  return join(runDir(runId), 'run.json');
}

export function generateRunId(workflowObjectId) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(3).toString('hex');
  const safe = workflowObjectId.replace(/[^a-z0-9-]/g, '-');
  return `run-${safe}-${ts}-${rand}`;
}

export function createRun({
  workflowObjectId,
  version,
  mode,
  payload = {},
  sessionProfileId = null,
  callerId = null,
}) {
  const runId = generateRunId(workflowObjectId);
  const now = new Date().toISOString();
  const [appId, workflowId] = workflowObjectId.split('.');

  const record = {
    runId,
    appId,
    workflowId,
    workflowObjectId,
    version,
    mode,
    payload,
    sessionProfileId,
    callerId,
    processStatus: 'running',
    workflowOutcome: null,
    startedAt: now,
    completedAt: null,
    artifacts: [],
    validationErrors: [],
    assertionResults: null,
    internalRunResult: null,
  };

  ensureDir(runDir(runId));
  writeJson(runFilePath(runId), record);
  return record;
}

export function getRun(runId) {
  const fp = runFilePath(runId);
  return exists(fp) ? readJson(fp) : null;
}

export function updateRun(runId, updates) {
  const record = getRun(runId);
  if (!record) throw new Error(`run "${runId}" not found`);
  const updated = { ...record, ...updates };
  writeJson(runFilePath(runId), updated);
  return updated;
}

export function stopRun(runId) {
  const record = getRun(runId);
  if (!record) throw new Error(`run "${runId}" not found`);
  if (record.processStatus === 'completed' || record.processStatus === 'failed') {
    return record;
  }
  return updateRun(runId, {
    processStatus: 'stopped',
    workflowOutcome: 'stopped',
    completedAt: new Date().toISOString(),
  });
}

export function getRunArtifacts(runId) {
  const record = getRun(runId);
  if (!record) return null;
  const dir = runDir(runId);
  const listed = exists(dir) ? fs.readdirSync(dir).filter(f => f !== 'run.json') : [];
  return {
    runId,
    artifacts: record.artifacts,
    files: listed.map(f => join(dir, f)),
  };
}

export function addArtifact(runId, { name, path: filePath, type = 'file' }) {
  const record = getRun(runId);
  if (!record) throw new Error(`run "${runId}" not found`);
  record.artifacts.push({ name, path: filePath, type, addedAt: new Date().toISOString() });
  writeJson(runFilePath(runId), record);
  return record;
}

export function listRuns({ workflowObjectId, limit = 50 } = {}) {
  ensureDir(RUNS_DIR);
  const dirs = fs.readdirSync(RUNS_DIR)
    .filter(d => {
      const fp = runFilePath(d);
      return exists(fp);
    })
    .map(d => readJson(runFilePath(d)))
    .filter(r => !workflowObjectId || r.workflowObjectId === workflowObjectId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
  return dirs;
}
