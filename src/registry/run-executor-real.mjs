import http from 'http';
import https from 'https';
import { join } from 'path';
import { REGISTRY_DIR, ensureDir, writeJson } from '../core/paths.mjs';
import { validatePayload, evaluateAssertions } from './schema-validator.mjs';
import { checkSafetyGates } from './safety-gates.mjs';
import { updateRun, getRun } from './run-registry.mjs';
import { buildRunResult } from './run-result.mjs';
import { executeRun as executeDryRun } from './run-executor.mjs';
import { runReplay } from './replay-executor.mjs';

export async function executeRun(args) {
  const { runId, workflowVersion, payload = {}, mode = 'preview', approvalToken, runRoot } = args;
  if (mode === 'dry_run' || workflowVersion.replaySettings?.disableRealReplay === true) {
    return executeDryRun(args);
  }

  const now = () => new Date().toISOString();
  updateRun(runId, { status: 'running', processStatus: 'running' });

  const payloadCheck = validatePayload(payload, workflowVersion.inputSchema);
  if (!payloadCheck.ok) {
    return finishRun(runId, {
      status: 'failed',
      processStatus: 'rejected',
      workflowOutcome: 'failed',
      completedAt: now(),
      validationErrors: payloadCheck.errors,
    });
  }

  const gateCheck = checkSafetyGates({ workflowVersion, mode, approvalToken });
  if (!gateCheck.ok) {
    return finishRun(runId, {
      status: mode === 'live' ? 'waiting_for_approval' : 'failed',
      processStatus: mode === 'live' ? 'waiting_for_approval' : 'rejected',
      workflowOutcome: mode === 'live' ? 'blocked' : 'failed',
      completedAt: mode === 'live' ? null : now(),
      blockingReason: gateCheck.errors.join('; '),
      validationErrors: gateCheck.errors,
    });
  }

  const authNeeds = Array.isArray(workflowVersion.auth) ? workflowVersion.auth : [];
  const authCheckpoint = authNeeds.find(a => a?.mode === 'human_required' || a?.mode === 'human_required_if_not_authenticated');
  if (authCheckpoint && !approvalToken && mode === 'live') {
    return finishRun(runId, {
      status: 'waiting_for_auth',
      processStatus: 'waiting_for_auth',
      workflowOutcome: 'blocked',
      blockingReason: `auth required for tab ${authCheckpoint.tabId || '(unknown)'}`,
      checkpoints: [...(getRun(runId)?.checkpoints || []), { status: 'waiting_for_auth', checkpoint: authCheckpoint, createdAt: now() }],
    });
  }

  const registryRunDir = runRoot ? join(runRoot, 'runs', runId) : join(REGISTRY_DIR, 'runs', runId);
  ensureDir(registryRunDir);

  let engineResult;
  try {
    engineResult = await runReplay({
      runId,
      workflowVersion,
      payload,
      mode,
      options: getRun(runId)?.options || {},
      runDir: registryRunDir,
    });
  } catch (err) {
    return finishRun(runId, {
      status: 'failed',
      processStatus: 'failed',
      workflowOutcome: 'failed',
      completedAt: now(),
      validationErrors: [`execution error: ${err.message}`],
    });
  }

  const assertionResults = evaluateAssertions(workflowVersion.successAssertions || [], workflowVersion.failureAssertions || [], engineResult || {});
  const artifacts = [];
  if (Array.isArray(engineResult?.artifact_paths)) {
    for (const filePath of engineResult.artifact_paths) artifacts.push({ name: String(filePath).split('/').pop(), path: filePath, type: artifactType(filePath) });
  }
  if (Array.isArray(engineResult?.artifacts)) {
    for (const artifact of engineResult.artifacts) artifacts.push({ name: artifact.name || String(artifact.path || '').split('/').pop() || 'artifact', path: artifact.path || null, type: artifact.type || artifactType(artifact.path || artifact.name || '') });
  }

  const engineResultPath = join(registryRunDir, 'engine-result.json');
  writeJson(engineResultPath, engineResult || {});
  artifacts.push({ name: 'engine-result.json', path: engineResultPath, type: 'json' });

  const blocked = engineResult?.ok === false || engineResult?.status === 'replay_failed' || assertionResults.outcome === 'failed';
  return finishRun(runId, {
    status: blocked ? 'blocked' : 'completed',
    processStatus: 'completed',
    workflowOutcome: blocked ? 'failed' : 'success',
    completedAt: now(),
    artifacts,
    assertionResults,
    internalRunResult: engineResult,
    blockingReason: blocked ? firstError(engineResult) : null,
  });
}

async function finishRun(runId, updates) {
  const updated = updateRun(runId, updates);
  const result = buildRunResult(updated);
  const final = updateRun(runId, { result });
  if (final.callbackUrl) {
    try {
      await postJson(final.callbackUrl, result);
      return updateRun(runId, { callbackDeliveredAt: new Date().toISOString() });
    } catch (err) {
      return updateRun(runId, { callbackError: err.message });
    }
  }
  return final;
}

function postJson(url, data) {
  return new Promise((resolve, reject) => {
    if (!url) return resolve({ skipped: true });
    const parsed = new URL(url);
    const body = JSON.stringify(data);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request({ method: 'POST', hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: parsed.pathname + parsed.search, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10000 }, res => {
      res.resume();
      res.on('end', () => resolve({ statusCode: res.statusCode }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('callback timeout')));
    req.write(body);
    req.end();
  });
}

function artifactType(filePath = '') {
  return /\.png$|\.jpg$|\.jpeg$|\.webp$/i.test(filePath) ? 'screenshot' : /\.json$/i.test(filePath) ? 'json' : 'file';
}

function firstError(result = {}) {
  return result.failedSteps?.[0]?.error || result.errors?.[0] || result.status || null;
}
