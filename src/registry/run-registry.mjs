import fs from 'fs';
import { join } from 'path';
import { REGISTRY_DIR, ensureDir, exists, readJson, writeJson } from '../core/paths.mjs';
import crypto from 'crypto';
import { buildRunResult, toPublicStatus } from './run-result.mjs';

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
  options = {},
  sessionProfileId = null,
  callerId = null,
  callbackUrl = null,
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
    options,
    sessionProfileId,
    callerId,
    callbackUrl: callbackUrl || options.callbackUrl || null,
    status: 'running',
    processStatus: 'running',
    workflowOutcome: null,
    startedAt: now,
    completedAt: null,
    approvedAt: null,
    canceledAt: null,
    blockingReason: null,
    checkpoints: [],
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

export function getRunResult(runId) {
  const record = getRun(runId);
  return record ? buildRunResult(record) : null;
}

export function updateRun(runId, updates) {
  const record = getRun(runId);
  if (!record) throw new Error(`run "${runId}" not found`);
  const updated = { ...record, ...updates };
  if (!updated.status) updated.status = toPublicStatus(updated);
  writeJson(runFilePath(runId), updated);
  return updated;
}

export function waitRun(runId, checkpoint) {
  const record = getRun(runId);
  if (!record) throw new Error(`run "${runId}" not found`);
  const status = checkpoint?.status || 'waiting_for_human_review';
  const entry = {
    status,
    reason: checkpoint?.reason || null,
    createdAt: new Date().toISOString(),
    ...checkpoint,
  };
  return updateRun(runId, {
    status,
    processStatus: status,
    workflowOutcome: 'blocked',
    blockingReason: entry.reason || status,
    checkpoints: [...(record.checkpoints || []), entry],
  });
}

export function approveRun(runId, approval = {}) {
  const record = getRun(runId);
  if (!record) throw new Error(`run "${runId}" not found`);
  const now = new Date().toISOString();
  const approvalRecord = {
    approvedAt: now,
    approvedBy: approval.approvedBy || approval.user || 'human',
    approvalNote: approval.note || approval.reason || null,
  };
  return updateRun(runId, {
    status: 'running',
    processStatus: 'running',
    workflowOutcome: null,
    blockingReason: null,
    approvedAt: now,
    approval: approvalRecord,
  });
}

export function cancelRun(runId, reason = 'canceled by user') {
  const record = getRun(runId);
  if (!record) throw new Error(`run "${runId}" not found`);
  if (['completed', 'failed', 'blocked', 'canceled'].includes(toPublicStatus(record))) {
    if (toPublicStatus(record) === 'canceled') return record;
  }
  return updateRun(runId, {
    status: 'canceled',
    processStatus: 'stopped',
    workflowOutcome: 'stopped',
    blockingReason: reason,
    canceledAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });
}

export function stopRun(runId) {
  return cancelRun(runId, 'stopped by user');
}

export function getRunArtifacts(runId) {
  const record = getRun(runId);
  if (!record) return null;
  const dir = runDir(runId);
  const listed = exists(dir) ? fs.readdirSync(dir).filter(f => f !== 'run.json') : [];
  const result = buildRunResult(record);
  return {
    runId,
    artifacts: record.artifacts,
    groupedArtifacts: result.artifacts,
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
